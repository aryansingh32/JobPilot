import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import {
  signSession,
  verifySession,
  verifyGoogleIdToken,
  generateAndStoreOtp,
  verifyOtp,
} from '../shared/auth/index.js';
import { sendOtpEmail } from '../shared/email/index.js';
import { sendOtpSms } from '../shared/sms/index.js';
import { userAccountService } from './user-account.service.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// AUTH ROUTES — real end-user identity (Google Sign-In, email
// OTP, mobile OTP). Admin login lives in admin-service. Every
// route elsewhere that used to trust a client-supplied `userId`
// now goes through `requireUser` below instead.
// ============================================================

const logger = createLogger('auth-routes');

export const SESSION_COOKIE = 'jp_session';
const isProd = process.env.NODE_ENV === 'production';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?[0-9]{10,15}$/;

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * The Android/iOS app can't rely on cross-site cookies inside its WebView, so
 * it identifies itself with `x-jp-client: android|ios` and gets the session
 * token in the body, then sends it as `Authorization: Bearer`. Browsers never
 * see the token (cookie stays httpOnly).
 */
function isNativeClient(req: FastifyRequest): boolean {
  const client = String(req.headers['x-jp-client'] ?? '').toLowerCase();
  return client === 'android' || client === 'ios';
}

/** Cookie for browsers; also the token in the body for the native app. */
function issueSession(req: FastifyRequest, reply: FastifyReply, token: string): { token?: string } {
  setSessionCookie(reply, SESSION_COOKIE, token, SESSION_MAX_AGE);
  return isNativeClient(req) ? { token } : {};
}

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

    if (user.suspended) return reply.status(403).send({ error: 'This account is suspended' });
    const token = await signSession({ sub: user.id, email: user.email ?? undefined });
    return { user, ...issueSession(req, reply, token) };
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
    if (user.suspended) return reply.status(403).send({ error: 'This account is suspended' });
    const token = await signSession({ sub: user.id, email: user.email ?? undefined });
    return { user, ...issueSession(req, reply, token) };
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
    if (user.suspended) return reply.status(403).send({ error: 'This account is suspended' });
    const token = await signSession({ sub: user.id, mobileNumber });
    return { user, ...issueSession(req, reply, token) };
  });

  // Link a mobile number to the signed-in account (onboarding) — unlike
  // /auth/mobile/verify, this never switches to or creates another account.
  app.post('/auth/mobile/link', async (req, reply) => {
    const userId = await resolveUserId(req);
    if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
    const { mobileNumber, code } = req.body as { mobileNumber?: string; code?: string };
    if (!mobileNumber || !MOBILE_RE.test(mobileNumber) || !code) {
      return reply.status(400).send({ error: 'Valid mobileNumber and code are required' });
    }
    const ok = await verifyOtp('mobile', mobileNumber, code);
    if (!ok) return reply.status(401).send({ error: 'Invalid or expired code' });
    const user = await userAccountService.linkMobile(userId, mobileNumber);
    if (!user) return reply.status(409).send({ error: 'This number is already linked to another account' });
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

  // Sliding session for the app: a still-valid token buys a fresh 30 days.
  app.post('/auth/refresh', async (req, reply) => {
    const userId = await resolveUserId(req);
    if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
    const user = await userAccountService.findById(userId);
    if (!user) return reply.status(401).send({ error: 'Not authenticated' });
    const token = await signSession({ sub: user.id, email: user.email ?? undefined, mobileNumber: user.mobileNumber ?? undefined });
    return { user, ...issueSession(req, reply, token) };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  });

  // Every session on every device stops working (lost phone, shared computer).
  app.post('/auth/logout-all', async (req, reply) => {
    const userId = await resolveUserId(req);
    if (!userId) return reply.status(401).send({ error: 'Not authenticated' });
    await revokeSessions(userId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  });
}

/** Invalidate every token issued so far for this user. */
export async function revokeSessions(userId: string): Promise<void> {
  await getPgPool().query('UPDATE users SET sessions_valid_after = NOW() WHERE id::text = $1', [userId]);
  knownUsers.delete(userId);
}

// ─── Helpers for other route modules ─────────────────────────

// A session token stays cryptographically valid after its user is deleted (or
// the database is reset) — it must also name an existing, active account and
// be newer than the user's last "sign out everywhere".
interface KnownUser { at: number; suspended: boolean; validAfter: number }
const knownUsers = new Map<string, KnownUser>();
async function lookupUser(userId: string): Promise<KnownUser | null> {
  const seen = knownUsers.get(userId);
  if (seen && Date.now() - seen.at < 60_000) return seen;
  const { rows } = await getPgPool().query(
    'SELECT suspended_at, sessions_valid_after FROM users WHERE id::text = $1',
    [userId],
  );
  if (!rows.length) {
    knownUsers.delete(userId);
    return null;
  }
  const known = {
    at: Date.now(),
    suspended: rows[0].suspended_at != null,
    validAfter: rows[0].sessions_valid_after ? Math.floor(new Date(rows[0].sessions_valid_after).getTime() / 1000) : 0,
  };
  knownUsers.set(userId, known);
  return known;
}

export async function userExists(userId: string): Promise<boolean> {
  return (await lookupUser(userId)) !== null;
}

/** Signed-in user id from a session token: valid signature AND an existing, active account. */
export async function userFromSessionToken(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const claims = await verifySession(token);
  if (!claims?.sub) return null;
  const user = await lookupUser(claims.sub);
  if (!user || user.suspended) return null;
  if (user.validAfter && (claims.iat ?? 0) < user.validAfter) return null;
  return claims.sub;
}

/** `Authorization: Bearer <token>` (native app), if present. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const m = value?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Resolves the authenticated user id from the session cookie or a bearer token, or null. */
export async function resolveUserId(req: FastifyRequest): Promise<string | null> {
  const token = bearerToken(req.headers.authorization) ?? (req as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  return userFromSessionToken(token);
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
