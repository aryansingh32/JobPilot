import type { FastifyInstance } from 'fastify';
import { getPgPool, getRedisClient } from '../shared/db/index.js';
import { hashPassword } from '../shared/auth/index.js';
import { listSettings, resetSetting, setSetting, getBool, getNumber } from '../shared/config/settings.js';
import { BUILTIN_RULES, loadAnswerDefaults, validateDefaults } from '../shared/answers/defaults.js';
import { buildAnswerBook, planAnswers, type FormField } from '../execution-service/form-filler.js';
import { adminAuth, type AdminRequest, type AdminRole } from './admin-auth.js';

// ============================================================
// PLATFORM CONTROLS — runtime settings, admin accounts, audit log, AI usage.
// ============================================================

const ROLES: AdminRole[] = ['viewer', 'support', 'editor', 'super-admin'];
const clampInt = (v: unknown, def: number, min: number, max: number) =>
  Math.min(max, Math.max(min, parseInt(String(v ?? def), 10) || def));

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  // ── Default answers: what is answered without asking ────────────────
  app.get('/admin/answer-defaults', { preHandler: adminAuth }, async () => ({ builtin: BUILTIN_RULES, config: await loadAnswerDefaults() }));

  app.put('/admin/answer-defaults', { preHandler: adminAuth }, async (req, reply) => {
    const v = validateDefaults((req.body ?? {}) as unknown);
    if (!v.ok) return reply.status(400).send({ error: v.error });
    await setSetting('answers.defaults', v.value, (req as AdminRequest).admin.id);
    return { config: v.value };
  });

  /** Runs the real planner on one question, with an empty profile, so "what would happen" is never a guess. */
  app.get('/admin/answer-defaults/test', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { question?: string; options?: string; type?: string };
    const question = String(q.question ?? '').trim().slice(0, 400);
    if (!question) return { result: null };
    const options = String(q.options ?? '').split('|').map((o) => o.trim()).filter(Boolean).slice(0, 40);
    const type = q.type === 'checkbox' ? 'checkbox' : options.length ? 'radio' : 'text';
    const field: FormField = { idx: 0, tag: 'input', type, label: question, name: '', required: true, options, value: '', selector: null };
    const { answers, missing } = await planAnswers([field], buildAnswerBook({}), async () => null, undefined, await loadAnswerDefaults());
    const a = answers[0];
    return { result: a ? { answered: true, value: a.value, source: a.source, rule: a.rule ?? a.key } : { answered: false, reason: missing.length ? 'Would be asked' : 'Left blank (optional)' } };
  });

  // ── Settings ────────────────────────────────────────────
  app.get('/admin/settings', { preHandler: adminAuth }, async () => ({ settings: await listSettings() }));

  app.put('/admin/settings/:key', { preHandler: adminAuth }, async (req) => {
    const { key } = req.params as { key: string };
    const { value } = (req.body ?? {}) as { value?: unknown };
    await setSetting(key, value, (req as AdminRequest).admin.id);
    return { key, value };
  });

  app.delete('/admin/settings/:key', { preHandler: adminAuth }, async (req) => {
    const { key } = req.params as { key: string };
    await resetSetting(key, (req as AdminRequest).admin.id);
    return { key, reset: true };
  });

  app.get('/admin/settings/:key/history', { preHandler: adminAuth }, async (req) => {
    const { key } = req.params as { key: string };
    const { rows } = await getPgPool().query(
      `SELECT h.old_value, h.new_value, h.changed_at, a.username AS changed_by
         FROM app_settings_history h LEFT JOIN admins a ON a.id::text = h.changed_by
        WHERE h.key = $1 ORDER BY h.changed_at DESC LIMIT 100`,
      [key],
    );
    return { key, history: rows };
  });

  // ── Audit log ───────────────────────────────────────────
  app.get('/admin/audit', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { limit?: string; before?: string; adminId?: string; path?: string };
    const params: unknown[] = [clampInt(q.limit, 100, 1, 500)];
    const where: string[] = [];
    if (q.before) {
      params.push(q.before);
      where.push(`l.id < $${params.length}`);
    }
    if (q.adminId) {
      params.push(q.adminId);
      where.push(`l.admin_id = $${params.length}`);
    }
    if (q.path) {
      params.push(`%${q.path}%`);
      where.push(`l.path ILIKE $${params.length}`);
    }
    const { rows } = await getPgPool().query(
      `SELECT l.id, l.at, l.admin_id, a.username, l.role, l.method, l.path, l.status, l.ip, l.body
         FROM admin_audit_log l LEFT JOIN admins a ON a.id::text = l.admin_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.id DESC LIMIT $1`,
      params,
    );
    return { entries: rows, nextBefore: rows.length ? rows[rows.length - 1].id : null };
  });

  // ── Admin accounts ──────────────────────────────────────
  app.get('/admin/admins', { preHandler: adminAuth }, async () => {
    const { rows } = await getPgPool().query(
      `SELECT id, username, role, created_at, (api_key IS NOT NULL) AS has_api_key FROM admins ORDER BY created_at`,
    );
    return { admins: rows };
  });

  app.post('/admin/admins', { preHandler: adminAuth }, async (req, reply) => {
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: AdminRole };
    if (!username?.trim() || !password || password.length < 10) {
      return reply.status(400).send({ error: 'username and a password of at least 10 characters are required' });
    }
    if (!role || !ROLES.includes(role)) return reply.status(400).send({ error: `role must be one of ${ROLES.join(', ')}` });
    try {
      const { rows } = await getPgPool().query(
        `INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at`,
        [username.trim(), await hashPassword(password), role],
      );
      return { admin: rows[0] };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.status(409).send({ error: 'That username is taken' });
      throw err;
    }
  });

  app.put('/admin/admins/:id', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, password } = (req.body ?? {}) as { role?: AdminRole; password?: string };
    const me = (req as AdminRequest).admin;
    const pool = getPgPool();
    if (role) {
      if (!ROLES.includes(role)) return reply.status(400).send({ error: `role must be one of ${ROLES.join(', ')}` });
      if (id === me.id && role !== 'super-admin') return reply.status(400).send({ error: "You can't demote yourself" });
      await pool.query('UPDATE admins SET role = $2 WHERE id = $1', [id, role]);
    }
    if (password) {
      if (password.length < 10) return reply.status(400).send({ error: 'Password must be at least 10 characters' });
      await pool.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [id, await hashPassword(password)]);
    }
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM admins WHERE id = $1', [id]);
    if (!rows[0]) return reply.status(404).send({ error: 'Admin not found' });
    return { admin: rows[0] };
  });

  app.delete('/admin/admins/:id', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === (req as AdminRequest).admin.id) return reply.status(400).send({ error: "You can't delete yourself" });
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT role, (SELECT COUNT(*) FROM admins WHERE role = 'super-admin')::int AS supers FROM admins WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Admin not found' });
    if (rows[0].role === 'super-admin' && rows[0].supers <= 1) {
      return reply.status(400).send({ error: "Can't delete the last super-admin" });
    }
    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    return { deleted: true };
  });

  // ── AI usage & status ───────────────────────────────────
  app.get('/admin/ai/usage', { preHandler: adminAuth }, async (req) => {
    const days = clampInt((req.query as { days?: string }).days, 7, 1, 90);
    const pool = getPgPool();
    const since = `NOW() - ($1 || ' days')::interval`;
    const [totals, byPurpose, byModel, byDay, topUsers] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS calls, COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens,
                COALESCE(SUM(cached_tokens),0)::bigint AS cached_tokens,
                COALESCE(SUM(cache_write_tokens),0)::bigint AS cache_write_tokens,
                COALESCE(SUM(cost_usd),0)::float AS cost_usd,
                COUNT(*) FILTER (WHERE NOT ok)::int AS errors,
                COALESCE(AVG(latency_ms),0)::int AS avg_latency_ms
           FROM llm_usage WHERE at > ${since}`,
        [days],
      ),
      pool.query(
        `SELECT purpose, COUNT(*)::int AS calls, SUM(prompt_tokens + completion_tokens)::bigint AS tokens,
                SUM(cached_tokens)::bigint AS cached_tokens, SUM(cache_write_tokens)::bigint AS cache_write_tokens,
                SUM(cost_usd)::float AS cost_usd, COUNT(*) FILTER (WHERE NOT ok)::int AS errors
           FROM llm_usage WHERE at > ${since} GROUP BY purpose ORDER BY tokens DESC`,
        [days],
      ),
      pool.query(
        `SELECT model, COUNT(*)::int AS calls, SUM(prompt_tokens + completion_tokens)::bigint AS tokens,
                SUM(cached_tokens)::bigint AS cached_tokens, SUM(cache_write_tokens)::bigint AS cache_write_tokens,
                SUM(cost_usd)::float AS cost_usd
           FROM llm_usage WHERE at > ${since} GROUP BY model ORDER BY tokens DESC`,
        [days],
      ),
      pool.query(
        `SELECT DATE_TRUNC('day', at) AS day, COUNT(*)::int AS calls,
                SUM(prompt_tokens + completion_tokens)::bigint AS tokens, SUM(cost_usd)::float AS cost_usd
           FROM llm_usage WHERE at > ${since} GROUP BY day ORDER BY day`,
        [days],
      ),
      pool.query(
        `SELECT user_id, COUNT(*)::int AS calls, SUM(prompt_tokens + completion_tokens)::bigint AS tokens,
                SUM(cost_usd)::float AS cost_usd
           FROM llm_usage WHERE at > ${since} AND user_id IS NOT NULL
          GROUP BY user_id ORDER BY tokens DESC LIMIT 20`,
        [days],
      ),
    ]);
    return {
      days,
      totals: totals.rows[0],
      byPurpose: byPurpose.rows,
      byModel: byModel.rows,
      byDay: byDay.rows,
      topUsers: topUsers.rows,
    };
  });

  app.get('/admin/ai/status', { preHandler: adminAuth }, async () => {
    const redis = await getRedisClient();
    const today = new Date().toISOString().slice(0, 10);
    return {
      killswitch: await getBool('llm.killswitch'),
      reasoningEnabled: await getBool('llm.reasoning.enabled'),
      todaySpendUsd: Number((await redis.get(`llm:usd:${today}`)) ?? 0),
      globalDailyBudgetUsd: await getNumber('llm.budget.global_daily_usd'),
      userDailyTokenBudget: await getNumber('llm.budget.user_daily_tokens'),
    };
  });
}
