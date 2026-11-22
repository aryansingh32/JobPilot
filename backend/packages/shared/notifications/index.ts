import { readFileSync } from 'fs';
import { SignJWT, importPKCS8 } from 'jose';
import { getPgPool } from '../db/index.js';
import { getBool } from '../config/settings.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// NOTIFICATIONS — one row per thing the user should know about (the in-app
// bell), pushed to their phones through Firebase Cloud Messaging (HTTP v1).
// Push is optional: without FCM credentials rows are still stored.
//
// FCM credentials: FCM_SERVICE_ACCOUNT (the service-account JSON) or
// FCM_SERVICE_ACCOUNT_FILE (a path to it).
// ============================================================

const logger = createLogger('notifications');

export type NotificationKind =
  | 'application.needs_input'
  | 'application.awaiting_review'
  | 'application.submitted'
  | 'application.failed'
  | 'inbox.email'
  | 'auto_apply.run'
  | 'announcement';

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Deep-link data for the app, e.g. { applicationId }. Values become strings for FCM. */
  data?: Record<string, string | number | boolean | null | undefined>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let account: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT ?? (process.env.FCM_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : '');
    account = raw ? (JSON.parse(raw) as ServiceAccount) : null;
  } catch (err) {
    logger.error('fcm:bad-service-account', err);
    account = null;
  }
  return account;
}

export function pushConfigured(): boolean {
  return serviceAccount() !== null;
}

let accessToken: { value: string; expiresAt: number } | null = null;
async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return accessToken.value;
}

/** Sends to every device of the user; drops tokens FCM says are gone. Returns how many got it. */
async function push(userId: string, n: NotificationInput & { id: string }): Promise<number> {
  const sa = serviceAccount();
  if (!sa || !(await getBool('notifications.push_enabled'))) return 0;
  const { rows } = await getPgPool().query<{ token: string }>('SELECT token FROM push_devices WHERE user_id = $1', [userId]);
  if (!rows.length) return 0;
  const bearer = await fcmAccessToken(sa);
  const data: Record<string, string> = { notificationId: n.id, kind: n.kind };
  for (const [k, v] of Object.entries(n.data ?? {})) if (v !== null && v !== undefined) data[k] = String(v);
  let sent = 0;
  await Promise.all(
    rows.map(async ({ token }) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: n.title, body: n.body ?? '' },
            data,
            android: { priority: 'high', notification: { channel_id: 'applications', tag: data.applicationId ?? n.id } },
          },
        }),
      }).catch((err: Error) => {
        logger.warn('fcm:send-error', { error: err.message });
        return null;
      });
      if (!res) return;
      if (res.ok) {
        sent++;
        return;
      }
      const body = await res.text().catch(() => '');
      // The app was uninstalled or the token rotated.
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body)) {
        await getPgPool().query('DELETE FROM push_devices WHERE token = $1', [token]).catch(() => {});
      } else {
        logger.warn('fcm:send-failed', { status: res.status, body: body.slice(0, 300) });
      }
    }),
  );
  return sent;
}

export const notificationsService = {
  /** Store the notification and push it. Never throws — notifying is best effort. */
  async notify(userId: string, n: NotificationInput): Promise<void> {
    try {
      const { rows } = await getPgPool().query(
        `INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [userId, n.kind, n.title.slice(0, 200), (n.body ?? '').slice(0, 500), JSON.stringify(n.data ?? {})],
      );
      const id = rows[0].id as string;
      const sent = await push(userId, { ...n, id });
      if (sent) await getPgPool().query('UPDATE notifications SET pushed = $2 WHERE id = $1', [id, sent]);
    } catch (err) {
      logger.warn('notify:failed', { userId, kind: n.kind, error: (err as Error).message });
    }
  },

  async list(userId: string, limit = 50) {
    const { rows } = await getPgPool().query(
      `SELECT id, kind, title, body, data, read, created_at FROM notifications
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(limit, 200)],
    );
    return rows;
  },

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await getPgPool().query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [userId]);
    return rows[0].n;
  },

  /** Mark some (ids) or all of the user's notifications read. */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const { rowCount } = await getPgPool().query(
      `UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read AND ($2::uuid[] IS NULL OR id = ANY($2))`,
      [userId, ids?.length ? ids : null],
    );
    return rowCount ?? 0;
  },

  async registerDevice(userId: string, token: string, platform: string, appVersion?: string): Promise<void> {
    // A token belongs to one phone; if another account signs in on it, it moves.
    await getPgPool().query(
      `INSERT INTO push_devices (token, user_id, platform, app_version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version, last_seen_at = NOW()`,
      [token, userId, platform, appVersion ?? null],
    );
  },

  async unregisterDevice(userId: string, token: string): Promise<boolean> {
    const { rowCount } = await getPgPool().query('DELETE FROM push_devices WHERE token = $1 AND user_id = $2', [token, userId]);
    return (rowCount ?? 0) > 0;
  },

  /** Admin announcement to everyone (or a list of users). Returns how many users. */
  async broadcast(n: Omit<NotificationInput, 'kind'>, userIds?: string[]): Promise<number> {
    const { rows } = await getPgPool().query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE suspended_at IS NULL AND ($1::text[] IS NULL OR id::text = ANY($1))`,
      [userIds?.length ? userIds : null],
    );
    for (const r of rows) await this.notify(r.id, { ...n, kind: 'announcement' });
    return rows.length;
  },

  async stats() {
    const { rows } = await getPgPool().query(
      `SELECT (SELECT COUNT(*)::int FROM push_devices) AS devices,
              (SELECT COUNT(DISTINCT user_id)::int FROM push_devices) AS users_with_devices,
              (SELECT COUNT(*)::int FROM notifications WHERE created_at > NOW() - INTERVAL '1 day') AS sent_24h,
              (SELECT COUNT(*)::int FROM notifications WHERE created_at > NOW() - INTERVAL '1 day' AND pushed > 0) AS pushed_24h`,
    );
    return { ...rows[0], pushConfigured: pushConfigured() };
  },
};
