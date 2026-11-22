import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { randomInt, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { getRedisClient } from '../db/index.js';
import { createLogger } from '../logger/index.js';

const scrypt = promisify(scryptCallback);

// ============================================================
// AUTH — session issuance/verification, Google ID token
// verification, and OTP generation/validation for email + mobile.
// This is the single source of truth for "who is the caller" —
// every route that needs a real user identity goes through here
// instead of trusting a client-supplied userId.
// ============================================================

const logger = createLogger('shared-auth');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: SESSION_JWT_SECRET environment variable is missing.');
  }
  return new TextEncoder().encode(secret);
}

// ─── End-user sessions ─────────────────────────────────────────

export interface SessionClaims {
  sub: string; // users.id
  email?: string;
  mobileNumber?: string;
  /** Issued-at (seconds) — tokens older than users.sessions_valid_after are rejected. */
  iat?: number;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ typ: 'user', email: claims.email, mobileNumber: claims.mobileNumber })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    if (payload.typ !== 'user' || typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      mobileNumber: typeof payload.mobileNumber === 'string' ? payload.mobileNumber : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    };
  } catch (err) {
    logger.warn('session:verify-failed', { error: (err as Error).message });
    return null;
  }
}

// ─── Admin sessions (separate claim namespace so a user session can never be replayed as admin) ──

export interface AdminSessionClaims {
  adminId: string;
  role: string;
}

export async function signAdminSession(claims: AdminSessionClaims): Promise<string> {
  return new SignJWT({ typ: 'admin', role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.adminId)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret());
}

export async function verifyAdminSession(token: string): Promise<AdminSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    if (payload.typ !== 'admin' || typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
      return null;
    }
    return { adminId: payload.sub, role: payload.role };
  } catch (err) {
    logger.warn('admin-session:verify-failed', { error: (err as Error).message });
    return null;
  }
}

// ─── Google Sign-In (ID token verification via Google's published JWKS — no client secret needed) ──

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    logger.error('google-auth:client-id-missing');
    return null;
  }
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch (err) {
    logger.warn('google-auth:verify-failed', { error: (err as Error).message });
    return null;
  }
}

// ─── OTP (email + mobile) ──────────────────────────────────────

export type OtpChannel = 'email' | 'mobile';

const OTP_TTL_SECONDS = 300; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

function otpKey(channel: OtpChannel, identifier: string): string {
  return `otp:${channel}:${identifier.trim().toLowerCase()}`;
}

function otpCooldownKey(channel: OtpChannel, identifier: string): string {
  return `otp-cooldown:${channel}:${identifier.trim().toLowerCase()}`;
}

interface StoredOtp {
  code: string;
  attempts: number;
}

/** Returns the generated code, or null if a resend was requested too soon. */
export async function generateAndStoreOtp(channel: OtpChannel, identifier: string): Promise<string | null> {
  const redis = await getRedisClient();
  const otp = otpKey(channel, identifier);
  const cooldownKey = otpCooldownKey(channel, identifier);
  const code = randomInt(100000, 999999).toString();
  const record: StoredOtp = { code, attempts: 0 };
  const created = await redis.eval(
    `if redis.call('exists', KEYS[2]) == 1 then return 0 end
     redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
     redis.call('set', KEYS[2], '1', 'EX', ARGV[3])
     return 1`,
    { keys: [otp, cooldownKey], arguments: [JSON.stringify(record), String(OTP_TTL_SECONDS), String(OTP_RESEND_COOLDOWN_SECONDS)] },
  );
  if (Number(created) !== 1) return null;
  return code;
}

// ─── Admin password hashing (scrypt — no external dependency) ──

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function verifyOtp(channel: OtpChannel, identifier: string, submitted: string): Promise<boolean> {
  const redis = await getRedisClient();
  const key = otpKey(channel, identifier);
  const verified = await redis.eval(
    `local raw = redis.call('get', KEYS[1])
     if not raw then return 0 end
     local ok, record = pcall(cjson.decode, raw)
     if not ok or type(record) ~= 'table' then redis.call('del', KEYS[1]); return 0 end
     if tonumber(record.attempts or 0) >= tonumber(ARGV[2]) then redis.call('del', KEYS[1]); return 0 end
     if tostring(record.code or '') ~= ARGV[1] then
       record.attempts = tonumber(record.attempts or 0) + 1
       redis.call('set', KEYS[1], cjson.encode(record), 'EX', ARGV[3])
       return 0
     end
     redis.call('del', KEYS[1])
     return 1`,
    { keys: [key], arguments: [submitted.trim(), String(OTP_MAX_ATTEMPTS), String(OTP_TTL_SECONDS)] },
  );
  return Number(verified) === 1;
}
