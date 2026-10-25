import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPgPool, getRedisClient } from '../shared/db/index.js';
import { signAdminSession, verifyAdminSession, verifyPassword } from '../shared/auth/index.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// ADMIN AUTH — username/password login for the admin service only.
// Lives here (not in the user API) so the admin surface is fully separate.
// ============================================================

const logger = createLogger('admin-auth-routes');

export const ADMIN_SESSION_COOKIE = 'jp_admin_session';
const isProd = process.env.NODE_ENV === 'production';
const SESSION_HOURS = 12;

// Brute-force guard: per IP+username, 5 failures lock the pair for 15 minutes.
const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const failKey = (ip: string, username: string) => `admin-login-fail:${ip}:${username.toLowerCase()}`;

function setAdminCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

/** Resolves the authenticated admin (id + role) from the admin session cookie, or null. */
export async function resolveAdminSession(req: FastifyRequest): Promise<{ adminId: string; role: string } | null> {
  const token = (req as { cookies?: Record<string, string> }).cookies?.[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  return (await verifyAdminSession(token)) ?? null;
}

export function registerAdminAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/admin/login', async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.status(400).send({ error: 'username and password are required' });

    const redis = await getRedisClient();
    const key = failKey(req.ip, username);
    const failures = Number((await redis.get(key)) ?? 0);
    if (failures >= MAX_FAILURES) {
      logger.warn('admin-login:locked', { username, ip: req.ip });
      return reply.status(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }

    const { rows } = await getPgPool().query(
      `SELECT id, role, password_hash FROM admins WHERE username = $1`,
      [username],
    );
    const admin = rows[0];
    const ok = !!admin?.password_hash && (await verifyPassword(password, admin.password_hash));
    if (!ok) {
      await redis.multi().incr(key).expire(key, LOCK_SECONDS).exec();
      logger.warn('admin-login:failed', { username, ip: req.ip, failures: failures + 1 });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    await redis.del(key);
    const token = await signAdminSession({ adminId: admin.id, role: admin.role });
    setAdminCookie(reply, token);
    logger.info('admin-login:ok', { adminId: admin.id, ip: req.ip });
    return { role: admin.role };
  });

  app.post('/auth/admin/logout', async (_req, reply) => {
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  });

  app.get('/auth/admin/me', async (req, reply) => {
    const session = await resolveAdminSession(req);
    if (!session) return reply.status(401).send({ error: 'Not authenticated' });
    const { rows } = await getPgPool().query(`SELECT id, username, role FROM admins WHERE id = $1`, [session.adminId]);
    if (!rows[0]) return reply.status(401).send({ error: 'Not authenticated' });
    return { admin: rows[0] };
  });
}
