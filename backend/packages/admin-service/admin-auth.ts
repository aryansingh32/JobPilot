import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import { resolveAdminSession } from './admin-auth-routes.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// ADMIN AUTH + ROLE POLICY — every admin route uses `adminAuth`.
//
// Credentials: admin session cookie (admin panel) or `x-admin-key` (scripts/CI).
// Authorization: one central policy (`requiredRole`) by method + path, so a
// new route is safe by default (reads → viewer, writes → editor) and the
// sensitive areas are listed in one place.
// ============================================================

const logger = createLogger('admin-auth');

export type AdminRole = 'viewer' | 'support' | 'editor' | 'super-admin';

const RANK: Record<AdminRole, number> = { viewer: 0, support: 1, editor: 2, 'super-admin': 3 };

export interface AuthedAdmin {
  id: string;
  role: AdminRole;
}

export type AdminRequest = FastifyRequest & { admin: AuthedAdmin };

/** Writes support staff may do (helping a user), beyond read access. */
const SUPPORT_WRITES: RegExp[] = [
  /^\/admin\/jobs\/[^/]+\/(cancel|retry)$/,
  /^\/admin\/applications\/[^/]+\/(cancel|retry|mark)$/,
  /^\/admin\/users\/[^/]+\/(unlock|reset-onboarding|logout)$/,
  /^\/admin\/applications\/[^/]+\/respond$/,
  /^\/admin\/emails\/[^/]+\/match$/,
];

/** Areas only super-admins may change. */
const SUPER_ADMIN_WRITES: RegExp[] = [
  /^\/admin\/settings(\/|$)/,
  /^\/admin\/admins(\/|$)/,
  /^\/admin\/cache\/flush$/,
  /^\/admin\/users\/[^/]+\/(plan|suspend|delete)$/,
  /^\/admin\/workers\/[^/]+\/(drain|resume)$/,
];

export function requiredRole(method: string, path: string): AdminRole {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'viewer';
  if (m === 'DELETE') return 'super-admin';
  if (SUPER_ADMIN_WRITES.some((r) => r.test(path))) return 'super-admin';
  if (SUPPORT_WRITES.some((r) => r.test(path))) return 'support';
  return 'editor';
}

export function hasRole(role: AdminRole, needed: AdminRole): boolean {
  return (RANK[role] ?? -1) >= RANK[needed];
}

export async function adminAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await resolveAdminSession(req);
  let admin: AuthedAdmin | null = null;

  if (session) {
    admin = { id: session.adminId, role: session.role as AdminRole };
  } else {
    const key = req.headers['x-admin-key'] as string | undefined;
    if (!key) {
      logger.warn('admin:auth-missing-credentials', { ip: req.ip, url: req.url });
      reply.status(401).send({ error: 'Unauthorized — admin session or admin key required' });
      return;
    }
    try {
      const { rows } = await getPgPool().query('SELECT id, role FROM admins WHERE api_key = $1', [key]);
      if (!rows.length) {
        logger.warn('admin:auth-failed', { ip: req.ip, url: req.url });
        reply.status(401).send({ error: 'Unauthorized — invalid admin key' });
        return;
      }
      admin = rows[0];
    } catch (err) {
      logger.error('admin:auth-error', err);
      reply.status(500).send({ error: 'Internal Server Error' });
      return;
    }
  }

  (req as AdminRequest).admin = admin!;

  const path = req.url.split('?')[0];
  const needed = requiredRole(req.method, path);
  if (!hasRole(admin!.role, needed)) {
    logger.warn('admin:forbidden', { adminId: admin!.id, role: admin!.role, needed, method: req.method, path });
    reply.status(403).send({ error: `Forbidden — ${needed} role required` });
  }
}

const REDACT = /pass(word)?|secret|token|api[_-]?key|otp|code/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

/** Record every admin write (after it ran) in admin_audit_log. */
export function registerAuditLog(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (!path.startsWith('/admin')) return;
    const admin = (req as Partial<AdminRequest>).admin;
    try {
      await getPgPool().query(
        `INSERT INTO admin_audit_log (admin_id, role, method, path, status, ip, body) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [admin?.id ?? null, admin?.role ?? null, method, path, reply.statusCode, req.ip, JSON.stringify(redact(req.body ?? null))],
      );
    } catch (err) {
      logger.warn('audit:write-failed', { error: (err as Error).message, path });
    }
  });
}
