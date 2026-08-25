import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import {
  signSession,
  verifySession,
  signAdminSession,
  verifyAdminSession,
  verifyGoogleIdToken,
  generateAndStoreOtp,
  verifyOtp,
  verifyPassword,
} from '../shared/auth/index.js';
import { sendOtpEmail } from '../shared/email/index.js';
import { sendOtpSms } from '../shared/sms/index.js';
import { userAccountService } from './user-account.service.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// AUTH ROUTES — real end-user identity (Google Sign-In, email
// OTP, mobile OTP) plus an admin username/password login. Every
// route elsewhere that used to trust a client-supplied `userId`
// now goes through `requireUser` below instead.
// ============================================================

const logger = createLogger('auth-routes');

export const SESSION_COOKIE = 'jp_session';
export const ADMIN_SESSION_COOKIE = 'jp_admin_session';
const isProd = process.env.NODE_ENV === 'production';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?[0-9]{10,15}$/;

function setSessionCookie(reply: FastifyReply, name: string, token: string, maxAgeSeconds: number): void {
  reply.setCookie(name, token, {
    httpOnly: true,
    secure: isProd,
    // Frontend and backend are typically different origins in this app, so the
    // cookie must be sendable cross-site; that's only valid with Secure in
    // production. In dev (http, same-ish origin via the Vite proxy) fall back
    // to Lax so cookies still work over plain HTTP.
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // ─── Google Sign-In ───────────────────────────────────────
  app.post('/auth/google', async (req, reply) => {
    const { idToken } = req.body as { idToken?: string };
    if (!idToken) return reply.status(400).send({ error: 'idToken is required' });

    const profile = await verifyGoogleIdToken(idToken);
    if (!profile) return reply.status(401).send({ error: 'Invalid Google token' });

    const user = await userAccountService.upsertGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.name,
    });

    const token = await signSession({ sub: user.id, email: user.email ?? undefined });
    setSessionCookie(reply, SESSION_COOKIE, token, 60 * 60 * 24 * 30);
    return { user };
  });

  // ─── Email OTP ────────────────────────────────────────────
  app.post('/auth/email/request-otp', async (req, reply) => {
    const { email } = req.body as { email?: string };
    if (!email || !EMAIL_RE.test(email)) return reply.status(400).send({ error: 'Valid email is required' });

    const code = await generateAndStoreOtp('email', email);
    if (!code) return reply.status(429).send({ error: 'A code was already sent recently. Please wait before retrying.' });

    await sendOtpEmail(email, code);
    return { sent: true };
  });

  app.post('/auth/email/verify', async (req, reply) => {
    const { email, code } = req.body as { email?: string; code?: string };
    if (!email || !code) return reply.status(400).send({ error: 'email and code are required' });

    const ok = await verifyOtp('email', email, code);
    if (!ok) return reply.status(401).send({ error: 'Invalid or expired code' });

    const user = await userAccountService.upsertEmailUser(email);
    const token = await signSession({ sub: user.id, email: user.email ?? undefined });
    setSessionCookie(reply, SESSION_COOKIE, token, 60 * 60 * 24 * 30);
    return { user };
  });

  // ─── Mobile OTP ───────────────────────────────────────────
  app.post('/auth/mobile/request-otp', async (req, reply) => {
    const { mobileNumber } = req.body as { mobileNumber?: string };
    if (!mobileNumber || !MOBILE_RE.test(mobileNumber)) {
      return reply.status(400).send({ error: 'Valid mobile number is required' });
    }

    const code = await generateAndStoreOtp('mobile', mobileNumber);
    if (!code) return reply.status(429).send({ error: 'A code was already sent recently. Please wait before retrying.' });

    await sendOtpSms(mobileNumber, code);
    return { sent: true };
  });

  app.post('/auth/mobile/verify', async (req, reply) => {
    const { mobileNumber, code } = req.body as { mobileNumber?: string; code?: string };
    if (!mobileNumber || !code) return reply.status(400).send({ error: 'mobileNumber and code are required' });

    const ok = await verifyOtp('mobile', mobileNumber, code);
    if (!ok) return reply.status(401).send({ error: 'Invalid or expired code' });

    const user = await userAccountService.upsertMobileUser(mobileNumber);
    const token = await signSession({ sub: user.id, mobileNumber });
    setSessionCookie(reply, SESSION_COOKIE, token, 60 * 60 * 24 * 30);
    return { user };
  });

  // ─── Current user / logout ────────────────────────────────
  app.get('/auth/me', async (req, reply) => {
    const userId = await resolveUserId(req);
    if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
    const user = await userAccountService.findById(userId);
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    return { user };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  });

  // ─── Admin login (username + password) ────────────────────
  app.post('/auth/admin/login', async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.status(400).send({ error: 'username and password are required' });

    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT id, role, password_hash FROM admins WHERE username = $1`,
      [username]
    );
    const admin = rows[0];
    if (!admin || !admin.password_hash) {
      logger.warn('admin-login:failed', { username, ip: req.ip });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const ok = await verifyPassword(password, admin.password_hash);
    if (!ok) {
      logger.warn('admin-login:failed', { username, ip: req.ip });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = await signAdminSession({ adminId: admin.id, role: admin.role });
    setSessionCookie(reply, ADMIN_SESSION_COOKIE, token, 60 * 60 * 12);
    return { role: admin.role };
  });

  app.post('/auth/admin/logout', async (_req, reply) => {
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  });
}

// ─── Helpers for other route modules ─────────────────────────

/** Resolves the authenticated user id from the session cookie, or null. */
export async function resolveUserId(req: FastifyRequest): Promise<string | null> {
  const token = (req as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const claims = await verifySession(token);
  return claims?.sub ?? null;
}

/** Fastify preHandler: rejects the request unless a valid user session is present, and attaches the resolved id to `req.userId`. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = await resolveUserId(req);
  if (!userId) {
    reply.status(401).send({ error: 'Unauthorized — please sign in' });
    return;
  }
  (req as FastifyRequest & { userId: string }).userId = userId;
}

/** Resolves the authenticated admin (id + role) from the admin session cookie, or null. */
export async function resolveAdminSession(req: FastifyRequest): Promise<{ adminId: string; role: string } | null> {
  const token = (req as { cookies?: Record<string, string> }).cookies?.[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  const claims = await verifyAdminSession(token);
  if (!claims) return null;
  return claims;
}
