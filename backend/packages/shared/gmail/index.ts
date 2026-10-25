import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getPgPool } from '../db/index.js';
import { getBool, getNumber } from '../config/settings.js';
import { cryptoService } from '../crypto/index.js';
import { createLogger } from '../logger/index.js';
import { inboxService } from '../inbox/index.js';

// ============================================================
// GMAIL — read-only connection for users who apply with their own Gmail:
// sign-in codes, verification links and employer replies reach the apply
// engine and the tracker the same way the private inbox does.
//
// Privacy: the search only asks Gmail for mail that mentions one of the
// user's recent applications (company names, applicant-system senders), and
// of what comes back only mail that matches an application is kept
// (inboxService.ingestForUser strict mode). Nothing is sent, labelled or
// deleted. Tokens are stored encrypted; disconnecting revokes them.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_API_URL (or
// GMAIL_REDIRECT_URI). GOOGLE_OAUTH_AUTH_URL / GOOGLE_OAUTH_TOKEN_URL /
// GOOGLE_OAUTH_REVOKE_URL / GMAIL_API_BASE point elsewhere for tests.
// ============================================================

const logger = createLogger('gmail');

const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';
const env = {
  authUrl: () => process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: () => process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revokeUrl: () => process.env.GOOGLE_OAUTH_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: () => (process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, ''),
  redirect: () =>
    process.env.GMAIL_REDIRECT_URI || `${(process.env.PUBLIC_API_URL || 'http://localhost:3300').replace(/\/$/, '')}/integrations/gmail/callback`,
};

/** Applicant systems whose mail carries codes and links (their mail rarely names the company). */
const ATS_FROM = ['greenhouse-mail.io', 'myworkday.com', 'myworkdayjobs.com', 'successfactors.com', 'successfactors.eu', 'sapsf.eu', 'oraclecloud.com', 'taleo.net',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'zohorecruit.com', 'zohorecruit.in', 'freshteam.com', 'keka.com', 'icims.com',
  // Workday also mails from workday.com (otp.workday.com); the rest of the common applicant systems.
  'workday.com', 'jobvite.com', 'workable.com', 'recruitee.com', 'bamboohr.com', 'teamtailor.com', 'darwinbox.in', 'darwinbox.com',
  'eightfold.ai', 'phenom.com', 'ats.rippling.com', 'breezy.hr', 'pinpointhq.com', 'jazzhr.com', 'nic.in', 'gov.in'];

export const gmailConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// ─── OAuth state: signed, short-lived, bound to the user ───────────────────

const stateKey = () => process.env.SESSION_JWT_SECRET || process.env.APP_SECRET_KEY || '';

function signState(userId: string): string {
  const body = Buffer.from(JSON.stringify({ u: userId, n: randomBytes(8).toString('hex'), e: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}

function readState(state: string): string | null {
  const [body, sig] = state.split('.');
  if (!body || !sig || !stateKey()) return null;
  const want = createHmac('sha256', stateKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { u: string; e: number };
    return e > Date.now() ? u : null;
  } catch {
    return null;
  }
}

// ─── Tokens ───────────────────────────────────────────────────────────────

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string; scope?: string }> {
  const res = await fetch(env.tokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw Object.assign(new Error(`Google token error: ${data.error ?? res.status}`), { code: data.error });
  return data as never;
}

interface Connection {
  id: string;
  user_id: string;
  address: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: Date | null;
  last_sync_at: Date | null;
}

async function accessToken(c: Connection): Promise<string> {
  if (c.access_token && c.expires_at && c.expires_at.getTime() > Date.now() + 60_000) return cryptoService.decrypt(c.access_token);
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cryptoService.decrypt(c.refresh_token) });
    await getPgPool().query('UPDATE mail_connections SET access_token = $2, expires_at = $3 WHERE id = $1', [
      c.id, cryptoService.encrypt(t.access_token), new Date(Date.now() + t.expires_in * 1000),
    ]);
    return t.access_token;
  } catch (err) {
    // The user removed our access in their Google account: stop trying.
    if ((err as { code?: string }).code === 'invalid_grant') {
      await getPgPool().query(`UPDATE mail_connections SET status = 'revoked', last_error = 'Access was removed in Google' WHERE id = $1`, [c.id]);
    }
    throw err;
  }
}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${env.api()}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail ${res.status} on ${path.split('?')[0]}`);
  return (await res.json()) as T;
}

// ─── Messages ─────────────────────────────────────────────────────────────

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }

const b64 = (s?: string) => (s ? Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '');

/** The message's text: its text/plain part, else its HTML without tags (links kept). */
export function messageText(payload: Part): string {
  const all: Part[] = [];
  const walk = (p: Part) => { all.push(p); (p.parts ?? []).forEach(walk); };
  walk(payload);
  const plain = all.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return b64(plain.body!.data);
  const html = all.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (!html) return '';
  return b64(html.body!.data)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, '$2 $1')
    .replace(/<(script|style)[^>]*>.*?<\/\1>/gis, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** "Mock Co <careers@x.com>" → { name, address } */
export function parseFrom(v: string): { name?: string; address: string } {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, address: m[2].trim() } : { address: v.trim() };
}

/** Gmail search for mail about the user's recent applications only. */
export function searchQuery(companies: string[], since: Date): string {
  const names = [...new Set(companies.map((c) => c.replace(/["()]/g, '').trim()).filter((c) => c.length >= 3))].slice(0, 25);
  // Subject phrases catch employers writing from their own domain without naming themselves in the body.
  const phrases = ['"thank you for applying"', '"your application"', '"application received"', '"interview"', '"verify your"'].map((p) => `subject:${p}`);
  const terms = [...ATS_FROM.map((d) => `from:${d}`), ...names.map((n) => `"${n}"`), ...phrases];
  return `after:${Math.floor(since.getTime() / 1000)} -category:promotions -category:social {${terms.join(' ')}}`;
}

/** A run is waiting on a code / link from one site: look only for that site's mail, in the last few minutes. */
export function urgentQuery(since: Date, allowFrom: string[], broad = false): string {
  const after = `after:${Math.floor(since.getTime() / 1000)}`;
  const from = allowFrom.filter(Boolean).map((d) => `from:${d}`).join(' ');
  // Broad: the site mails from a domain we don't know — any fresh mail that looks like a code or a verification.
  const looks = '{subject:verify subject:verification subject:code subject:confirm subject:"security code" subject:"one-time" subject:activate}';
  return broad || !from ? `${after} ${looks}` : `${after} {${from}}`;
}

// ─── Service ──────────────────────────────────────────────────────────────

export const gmailService = {
  async available(): Promise<boolean> {
    return gmailConfigured() && (await getBool('features.gmail'));
  },

  async status(userId: string) {
    const { rows } = await getPgPool().query(
      `SELECT address, status, last_sync_at, last_error, messages_kept, created_at FROM mail_connections WHERE user_id = $1 AND provider = 'gmail'`,
      [userId],
    );
    return { available: await this.available(), connection: rows[0] ?? null };
  },

  /** Google's consent page for this user (read-only Gmail). */
  async connectUrl(userId: string, loginHint?: string | null): Promise<string> {
    if (!(await this.available())) throw Object.assign(new Error('Gmail connection is not available'), { statusCode: 503 });
    const q = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: env.redirect(),
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: signState(userId),
    });
    if (loginHint) q.set('login_hint', loginHint);
    return `${env.authUrl()}?${q}`;
  },

  /** Google redirected back: exchange the code, store the tokens, make Gmail the application email. */
  async complete(code: string, state: string): Promise<{ userId: string; address: string }> {
    const userId = readState(state);
    if (!userId) throw Object.assign(new Error('This link expired — connect Gmail again'), { statusCode: 400 });
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env.redirect() });
    if (!t.refresh_token) throw Object.assign(new Error('Google did not grant offline access'), { statusCode: 400 });
    if (t.scope && !t.scope.includes('gmail.readonly')) throw Object.assign(new Error('Gmail access was not granted'), { statusCode: 400 });
    const profile = await api<{ emailAddress: string }>(t.access_token, '/users/me/profile');
    await getPgPool().query(
      `INSERT INTO mail_connections (user_id, provider, address, refresh_token, access_token, expires_at, status, last_sync_at, last_error)
       VALUES ($1, 'gmail', $2, $3, $4, $5, 'active', NOW(), NULL)
       ON CONFLICT (user_id, provider) DO UPDATE SET address = EXCLUDED.address, refresh_token = EXCLUDED.refresh_token,
         access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at, status = 'active', last_sync_at = NOW(), last_error = NULL`,
      [userId, profile.emailAddress, cryptoService.encrypt(t.refresh_token), cryptoService.encrypt(t.access_token), new Date(Date.now() + t.expires_in * 1000)],
    );
    const { profileService } = await import('../profile/index.js');
    await profileService.patch(userId, { settings: { applicationEmailMode: 'gmail' } }, 'gmail').catch(() => {});
    logger.info('gmail:connected', { userId });
    return { userId, address: profile.emailAddress };
  },

  async disconnect(userId: string): Promise<boolean> {
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT refresh_token FROM mail_connections WHERE user_id = $1 AND provider = 'gmail'`, [userId]);
    if (!rows[0]) return false;
    // Revoke at Google too, so the access is gone there, not only forgotten here.
    await fetch(`${env.revokeUrl()}?token=${encodeURIComponent(cryptoService.decrypt(rows[0].refresh_token))}`, { method: 'POST' }).catch(() => {});
    await pool.query(`DELETE FROM mail_connections WHERE user_id = $1 AND provider = 'gmail'`, [userId]);
    const { profileService } = await import('../profile/index.js');
    const p = await profileService.get(userId).catch(() => null);
    if (p?.data.settings?.applicationEmailMode === 'gmail') await profileService.patch(userId, { settings: { applicationEmailMode: 'personal' } }, 'gmail').catch(() => {});
    logger.info('gmail:disconnected', { userId });
    return true;
  },

  /** Read new job mail for one user. Returns how many were kept. */
  async sync(userId: string, urgent?: { since: Date; allowFrom: string[]; broad?: boolean }, backfillDays?: number): Promise<number> {
    const pool = getPgPool();
    const { rows } = await pool.query<Connection>(
      `SELECT * FROM mail_connections WHERE user_id = $1 AND provider = 'gmail' AND status = 'active'`, [userId]);
    const c = rows[0];
    if (!c) return 0;
    const apps = await pool.query(
      `SELECT DISTINCT company, MAX(created_at) OVER () AS newest FROM applications WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '30 days' AND company IS NOT NULL`, [userId]);
    // No applications lately: nothing of ours can be in the mailbox, so don't look.
    if (!apps.rowCount) {
      await pool.query('UPDATE mail_connections SET last_sync_at = NOW() WHERE id = $1', [c.id]);
      return 0;
    }
    // Normally only what arrived since the last look. But mail about an application can predate a look made
    // before that application existed (or while it was being created), so the window reaches back to
    // just before the newest application; a manual sync can reach further.
    const newestApp = (apps.rows[0]?.newest as Date | undefined)?.getTime() ?? Date.now();
    const incremental = Math.min((c.last_sync_at?.getTime() ?? Date.now()) - 10 * 60_000, newestApp - 3_600_000);
    const since = urgent?.since ?? new Date(Math.max(backfillDays ? Date.now() - backfillDays * 86_400_000 : incremental, Date.now() - 30 * 86_400_000));
    let kept = 0;
    try {
      const token = await accessToken(c);
      const list = await api<{ messages?: { id: string }[] }>(token,
        `/users/me/messages?maxResults=100&q=${encodeURIComponent(urgent ? urgentQuery(since, urgent.allowFrom, urgent.broad) : searchQuery(apps.rows.map((r) => r.company), since))}`);
      for (const { id } of list.messages ?? []) {
        const seen = await pool.query(`SELECT 1 FROM emails WHERE user_id = $1 AND source = 'gmail' AND external_id = $2`, [userId, id]);
        if (seen.rowCount) continue;
        const msg = await api<{ payload: Part; internalDate?: string }>(token, `/users/me/messages/${id}?format=full`);
        const h = (n: string) => msg.payload.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
        const from = parseFrom(h('from'));
        const email = await inboxService.ingestForUser(userId, {
          to: c.address, fromAddress: from.address, fromName: from.name, subject: h('subject'), text: messageText(msg.payload),
        }, { source: 'gmail', externalId: id, strict: true, allowFrom: urgent?.allowFrom, broad: urgent?.broad, receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : undefined });
        if (email) kept++;
      }
      await pool.query('UPDATE mail_connections SET last_sync_at = NOW(), last_error = NULL, messages_kept = messages_kept + $2 WHERE id = $1', [c.id, kept]);
    } catch (err) {
      await pool.query('UPDATE mail_connections SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [c.id, (err as Error).message.slice(0, 300)]);
      logger.warn('gmail:sync-failed', { userId, error: (err as Error).message });
    }
    return kept;
  },

  /**
   * Scheduler tick: every connection on its interval, and every minute the
   * ones with an application waiting (a code or link may be on its way).
   */
  async syncDue(limit = 50): Promise<number> {
    if (!(await this.available())) return 0;
    const minutes = await getNumber('gmail.sync_minutes');
    const { rows } = await getPgPool().query(
      `SELECT m.user_id FROM mail_connections m
        WHERE m.status = 'active' AND m.provider = 'gmail'
          AND (m.last_sync_at IS NULL OR m.last_sync_at < NOW() - make_interval(mins => $1)
               OR (m.last_sync_at < NOW() - INTERVAL '50 seconds'
                   AND EXISTS (SELECT 1 FROM applications a WHERE a.user_id = m.user_id AND a.status IN ('needs_input', 'running'))))
        ORDER BY m.last_sync_at NULLS FIRST LIMIT $2`,
      [minutes, limit],
    );
    let kept = 0;
    for (const r of rows) kept += await this.sync(r.user_id);
    return kept;
  },

  /** Admin: every connection, newest first. */
  async list(limit = 200) {
    const { rows } = await getPgPool().query(
      `SELECT m.id, m.user_id, m.address, m.status, m.last_sync_at, m.last_error, m.messages_kept, m.created_at, u.email AS user_email
         FROM mail_connections m LEFT JOIN users u ON u.id::text = m.user_id
        ORDER BY m.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  },
};
