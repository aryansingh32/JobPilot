import type { FastifyInstance } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import { creditsService } from '../shared/credits/index.js';
import { notificationsService } from '../shared/notifications/index.js';
import { accountsService } from '../shared/accounts/index.js';
import { respondToApplication } from '../shared/applications/apply.js';
import { autoApplyService } from '../shared/applications/auto-apply.js';
import { paymentsService } from '../shared/payments/index.js';
import { gmailConfigured, gmailService } from '../shared/gmail/index.js';
import { adminAuth, type AdminRequest } from './admin-auth.js';

// ============================================================
// ACCOUNT CONTROLS — credits, suspension, sign-out, export/delete, push
// notifications and parked applications. Role policy lives in admin-auth
// (suspend/delete → super-admin, sign-out → support, the rest → editor).
// ============================================================

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPgPool();
  const actor = (req: unknown) => (req as AdminRequest).admin?.id ?? 'admin';

  // ── Credits ─────────────────────────────────────────────
  app.get('/admin/credits/summary', { preHandler: adminAuth }, async () => creditsService.summary());

  app.get('/admin/users/:userId/credits', { preHandler: adminAuth }, async (req) => {
    const { userId } = req.params as { userId: string };
    const [balance, ledger] = await Promise.all([creditsService.balance(userId), creditsService.ledger(userId, 200)]);
    return { balance, ledger };
  });

  app.post('/admin/users/:userId/credits', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { delta, note } = (req.body ?? {}) as { delta?: number; note?: string };
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta!) > 100_000) {
      return reply.status(400).send({ error: 'delta must be a non-zero whole number' });
    }
    if (!note?.trim()) return reply.status(400).send({ error: 'note is required (why the change)' });
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id::text = $1', [userId]);
    if (!rows.length) return reply.status(404).send({ error: 'User not found' });
    const balance = await creditsService.adjust(userId, delta!, note.trim().slice(0, 200), actor(req));
    return { balance };
  });

  // ── Account state ───────────────────────────────────────
  app.post('/admin/users/:userId/suspend', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { suspended = true } = (req.body ?? {}) as { suspended?: boolean };
    const { rows } = await pool.query(
      `UPDATE users SET suspended_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
              sessions_valid_after = CASE WHEN $2 THEN NOW() ELSE sessions_valid_after END
        WHERE id::text = $1 RETURNING (suspended_at IS NOT NULL) AS suspended`,
      [userId, suspended === true],
    );
    if (!rows[0]) return reply.status(404).send({ error: 'User not found' });
    return rows[0];
  });

  /** Sign the user out on every device (their tokens stop working within a minute). */
  app.post('/admin/users/:userId/logout', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { rowCount } = await pool.query('UPDATE users SET sessions_valid_after = NOW() WHERE id::text = $1', [userId]);
    return rowCount ? { loggedOut: true } : reply.status(404).send({ error: 'User not found' });
  });

  app.get('/admin/users/:userId/export', { preHandler: adminAuth }, async (req) =>
    accountsService.exportData((req.params as { userId: string }).userId),
  );

  app.post('/admin/users/:userId/delete', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { confirm } = (req.body ?? {}) as { confirm?: string };
    if (confirm !== userId) return reply.status(400).send({ error: 'Send { "confirm": "<userId>" } to delete permanently' });
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id::text = $1', [userId]);
    if (!rows.length) return reply.status(404).send({ error: 'User not found' });
    return { deleted: true, ...(await accountsService.deleteAccount(userId)) };
  });

  // ── Notifications ───────────────────────────────────────
  app.get('/admin/notifications/stats', { preHandler: adminAuth }, async () => notificationsService.stats());

  app.get('/admin/users/:userId/notifications', { preHandler: adminAuth }, async (req) => {
    const { userId } = req.params as { userId: string };
    const devices = await pool.query(
      'SELECT platform, app_version, created_at, last_seen_at FROM push_devices WHERE user_id = $1 ORDER BY last_seen_at DESC',
      [userId],
    );
    return { notifications: await notificationsService.list(userId, 100), devices: devices.rows };
  });

  /** Announcement to everyone, or to the listed users. */
  app.post('/admin/notifications/broadcast', { preHandler: adminAuth }, async (req, reply) => {
    const { title, body, userIds } = (req.body ?? {}) as { title?: string; body?: string; userIds?: string[] };
    if (!title?.trim()) return reply.status(400).send({ error: 'title is required' });
    const users = await notificationsService.broadcast(
      { title: title.trim(), body: body?.trim() },
      Array.isArray(userIds) ? userIds.filter((x) => typeof x === 'string') : undefined,
    );
    return { users };
  });

  // ── Payments ────────────────────────────────────────────
  app.get('/admin/payments', { preHandler: adminAuth }, async () => paymentsService.adminList());

  // ── Connected mailboxes (Gmail, read-only) ──
  app.get('/admin/mail-connections', { preHandler: adminAuth }, async () => ({
    available: await gmailService.available(),
    configured: gmailConfigured(),
    connections: await gmailService.list(),
  }));
  app.post('/admin/users/:userId/gmail/sync', { preHandler: adminAuth }, async (req) =>
    ({ kept: await gmailService.sync((req.params as { userId: string }).userId) }));
  // Revokes the token at Google too; the user can connect again.
  app.post('/admin/users/:userId/gmail/disconnect', { preHandler: adminAuth }, async (req, reply) =>
    (await gmailService.disconnect((req.params as { userId: string }).userId)) ? { ok: true } : reply.status(404).send({ error: 'Not connected' }));

  // ── Auto Apply ──────────────────────────────────────────
  app.get('/admin/auto-apply', { preHandler: adminAuth }, async () => {
    const [users, runs] = await Promise.all([autoApplyService.overview(), autoApplyService.runs(null, 50)]);
    return { users, runs };
  });
  app.get('/admin/auto-apply/:userId/preview', { preHandler: adminAuth }, async (req) =>
    autoApplyService.plan((req.params as { userId: string }).userId),
  );
  app.put('/admin/auto-apply/:userId', { preHandler: adminAuth }, async (req) => {
    const b = (req.body ?? {}) as { enabled?: boolean; dailyCap?: number; minScore?: number };
    return { settings: await autoApplyService.update((req.params as { userId: string }).userId, b) };
  });
  app.post('/admin/auto-apply/:userId/run', { preHandler: adminAuth }, async (req, reply) => {
    const run = await autoApplyService.runForUser((req.params as { userId: string }).userId, 'admin');
    return run ?? reply.status(409).send({ error: 'Auto Apply is already running for this user' });
  });

  // ── Parked applications (waiting on the user, no browser held) ──
  app.get('/admin/applications-parked', { preHandler: adminAuth }, async () => {
    const { rows } = await pool.query(
      `SELECT a.id, a.user_id, a.title, a.company, a.status, a.parked_at, a.resume_state->>'kind' AS waiting_for,
              u.email AS user_email
         FROM applications a LEFT JOIN users u ON u.id::text = a.user_id
        WHERE a.parked_at IS NOT NULL ORDER BY a.parked_at DESC LIMIT 200`,
    );
    return { applications: rows };
  });

  /** Answer on the user's behalf (support) — same path as the user's answer, live or parked. */
  app.post('/admin/applications/:id/respond', { preHandler: adminAuth }, async (req, reply) => {
    const { value } = (req.body ?? {}) as { value?: string };
    if (typeof value !== 'string' || !value.trim()) return reply.status(400).send({ error: 'value is required' });
    const ok = await respondToApplication(null, (req.params as { id: string }).id, value);
    return ok ? { ok: true } : reply.status(409).send({ error: 'This application is not waiting for anything' });
  });
}
