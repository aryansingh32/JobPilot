import type { FastifyInstance } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import { enqueueJob } from '../shared/queue/index.js';
import { applicationsService, type ApplicationStatus } from '../shared/applications/index.js';
import { profileService } from '../shared/profile/index.js';
import { pendingInput } from '../shared/applications/apply.js';
import { addBoard, seedBoardsIfEmpty, SEED_BOARDS } from '../shared/jobs/poller.js';
import { enqueueDiscovery, registryStats } from '../shared/jobs/discovery.js';
import { isAtsType, SOURCES, SOURCE_INFO, validateCustomConfig } from '../shared/jobs/sources.js';
import type { PollBoardJob } from '../shared/types/index.js';
import { adminAuth } from './admin-auth.js';

// ============================================================
// PRODUCT CONTROLS — applications, jobs feed (boards + jobs), user profiles,
// inbox and resume parsing. Read = viewer; writes follow the role policy.
// ============================================================

const STATUSES: ApplicationStatus[] = ['queued', 'running', 'needs_input', 'awaiting_review', 'submitted', 'completed', 'failed', 'cancelled'];
const n = (v: unknown, d: number, max = 500) => Math.min(Math.max(parseInt(String(v ?? d), 10) || d, 1), max);

export async function registerProductRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPgPool();

  // ── Applications ────────────────────────────────────────
  app.get('/admin/applications', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { status?: string; userId?: string; q?: string; limit?: string; offset?: string };
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) {
      params.push(q.status.split(','));
      where.push(`a.status = ANY($${params.length})`);
    }
    if (q.userId) {
      params.push(q.userId);
      where.push(`a.user_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(a.title ILIKE $${params.length} OR a.company ILIKE $${params.length} OR a.url ILIKE $${params.length})`);
    }
    params.push(n(q.limit, 50), Number(q.offset) || 0);
    const { rows } = await pool.query(
      `SELECT a.*, u.email AS user_email, u.display_name AS user_name
         FROM applications a LEFT JOIN users u ON u.id::text = a.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const stats = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM applications WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY status`,
    );
    return { applications: rows, last7Days: Object.fromEntries(stats.rows.map((r) => [r.status, r.n])) };
  });

  // Success rate per applicant system (or site, for pasted links): where applications work and where they break.
  app.get('/admin/applications/by-site', { preHandler: adminAuth }, async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 7, 1), 90);
    const site = `COALESCE(b.ats_type, substring(a.url from '^https?://(?:www\\.)?([^/:?#]+)'), 'unknown')`;
    const base = `FROM applications a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN job_boards b ON b.id = j.board_id
                  WHERE a.created_at > NOW() - ($1 || ' days')::interval AND COALESCE(a.source, '') <> 'admin_test'`;
    const [rates, errors] = await Promise.all([
      pool.query(
        `SELECT ${site} AS site,
                COUNT(*) FILTER (WHERE a.status IN ('submitted','completed','failed'))::int AS attempts,
                COUNT(*) FILTER (WHERE a.status IN ('submitted','completed'))::int AS submitted,
                COUNT(*) FILTER (WHERE a.status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE a.status IN ('needs_input','awaiting_review'))::int AS waiting,
                COUNT(*) FILTER (WHERE a.status IN ('submitted','completed') AND a.status_detail = 'You applied on the company site')::int AS by_user,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.finished_at - a.created_at)))
                   FILTER (WHERE a.status IN ('submitted','completed') AND a.finished_at IS NOT NULL AND a.status_detail IS DISTINCT FROM 'You applied on the company site'))::int AS median_seconds
           ${base} GROUP BY 1 HAVING COUNT(*) FILTER (WHERE a.status IN ('submitted','completed','failed')) > 0
          ORDER BY attempts DESC LIMIT 100`,
        [String(days)],
      ),
      pool.query(
        `SELECT site, error, n FROM (
           SELECT ${site} AS site, left(a.error, 160) AS error, COUNT(*)::int AS n,
                  ROW_NUMBER() OVER (PARTITION BY ${site} ORDER BY COUNT(*) DESC) AS rk
             ${base} AND a.status = 'failed' AND a.error IS NOT NULL GROUP BY 1, 2) t
          WHERE rk <= 3`,
        [String(days)],
      ),
    ]);
    const top = new Map<string, { error: string; n: number }[]>();
    for (const r of errors.rows) top.set(r.site, [...(top.get(r.site) ?? []), { error: r.error, n: r.n }]);
    return {
      days,
      sites: rates.rows.map((r) => ({
        ...r,
        successRate: r.attempts ? r.submitted / r.attempts : null,
        topErrors: top.get(r.site) ?? [],
      })),
    };
  });

  app.get('/admin/applications/:id', { preHandler: adminAuth }, async (req, reply) => {
    const a = await applicationsService.get(null, (req.params as { id: string }).id);
    if (!a) return reply.status(404).send({ error: 'Not found' });
    return { ...a, pending: await pendingInput(a.exec_job_id) };
  });

  app.post('/admin/applications/:id/cancel', { preHandler: adminAuth }, async (req, reply) => {
    const a = await applicationsService.cancel(null, (req.params as { id: string }).id);
    return a ?? reply.status(404).send({ error: 'Not found' });
  });

  /** Manually correct a status (e.g. the employer confirmed by phone). */
  app.post('/admin/applications/:id/mark', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, note } = (req.body ?? {}) as { status?: ApplicationStatus; note?: string };
    if (!status || !STATUSES.includes(status)) return reply.status(400).send({ error: `status must be one of ${STATUSES.join(', ')}` });
    const { rows } = await pool.query(
      `UPDATE applications SET status = $2, status_detail = COALESCE($3, status_detail), updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id, status, note ?? null],
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
    await applicationsService.event(id, `admin:${status}`, { note });
    return applicationsService.get(null, id);
  });

  // ── Jobs feed: boards ───────────────────────────────────
  app.get('/admin/jobs-feed/stats', { preHandler: adminAuth }, async () => {
    const [boards, jobs, freshness] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS enabled,
                COUNT(*) FILTER (WHERE last_status = 'error' AND status <> 'dead')::int AS erroring,
                COUNT(*) FILTER (WHERE last_status = 'stale' AND enabled)::int AS stale,
                COUNT(*) FILTER (WHERE last_polled_at IS NULL)::int AS never_polled
           FROM job_boards`,
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
                COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden,
                COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '24 hours')::int AS new_24h,
                COUNT(*) FILTER (WHERE status = 'active' AND country = 'IN')::int AS active_india,
                COUNT(*) FILTER (WHERE status = 'active' AND country = 'US')::int AS active_us,
                COUNT(*) FILTER (WHERE status = 'active' AND workplace = 'Remote')::int AS active_remote
           FROM jobs`,
      ),
      pool.query(`SELECT ats_type, COUNT(*)::int AS boards, SUM(job_count)::int AS jobs FROM job_boards GROUP BY ats_type`),
    ]);
    return { boards: boards.rows[0], jobs: jobs.rows[0], bySystem: freshness.rows };
  });

  app.get('/admin/jobs-feed/boards', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { status?: string; q?: string };
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status === 'stale') where.push(`b.last_status = 'stale'`);
    if (q.status === 'error') where.push(`b.last_status = 'error' AND b.status <> 'dead'`);
    if (q.status === 'disabled') where.push('NOT b.enabled');
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(c.name ILIKE $${params.length} OR b.board_token ILIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT b.*, c.name AS company FROM job_boards b LEFT JOIN companies c ON c.id = b.company_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name NULLS LAST`,
      params,
    );
    return { boards: rows };
  });

  app.get('/admin/jobs-feed/source-types', { preHandler: adminAuth }, async () => ({ types: SOURCE_INFO }));

  // Registry at scale: boards per system and status, focus-country coverage, discovery runs.
  app.get('/admin/jobs-feed/registry', { preHandler: adminAuth }, async () => registryStats());

  /**
   * Find more company boards. Runs in the background (Common Crawl takes
   * minutes); progress is in the registry's discovery runs.
   */
  app.post('/admin/jobs-feed/discover', { preHandler: adminAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { source?: string; crawls?: string[]; systems?: string[]; maxBlocks?: number };
    if (b.source !== 'dataset' && b.source !== 'commoncrawl' && b.source !== 'seed') {
      return reply.status(400).send({ error: 'source must be dataset, commoncrawl or seed' });
    }
    const job = await enqueueDiscovery({ source: b.source, crawls: b.crawls, systems: b.systems?.filter(isAtsType), maxBlocks: b.maxBlocks });
    return reply.status(202).send({ queued: job });
  });

  // Try a source without saving it: how many jobs, and a sample.
  app.post('/admin/jobs-feed/sources/test', { preHandler: adminAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { atsType?: string; token?: string; config?: Record<string, unknown> };
    if (!b.atsType || !isAtsType(b.atsType) || !b.token?.trim()) return reply.status(400).send({ error: 'atsType and token are required' });
    const t0 = Date.now();
    try {
      const { company, jobs } = await SOURCES[b.atsType](b.token.trim(), b.config);
      return {
        ok: true, company: company ?? null, count: jobs.length, ms: Date.now() - t0,
        sample: jobs.slice(0, 5).map((j) => ({ title: j.title, url: j.url, location: j.location, country: j.country, workplace: j.workplace, postedAt: j.postedAt })),
      };
    } catch (err) {
      return reply.status(422).send({ ok: false, error: (err as Error).message, ms: Date.now() - t0 });
    }
  });

  app.post('/admin/jobs-feed/boards', { preHandler: adminAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      atsType?: string; token?: string; company?: string; country?: string; pollIntervalMinutes?: number; config?: Record<string, unknown>;
    };
    if (!b.atsType || !isAtsType(b.atsType) || !b.token?.trim() || !b.company?.trim()) {
      return reply.status(400).send({ error: `atsType (${Object.keys(SOURCE_INFO).join('|')}), token and company are required` });
    }
    const board = await addBoard({
      atsType: b.atsType, token: b.token, company: b.company, country: b.country, pollIntervalMinutes: b.pollIntervalMinutes, config: b.config,
    });
    await enqueuePoll(board.id);
    return { board };
  });

  app.put('/admin/jobs-feed/boards/:id', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { enabled?: boolean; pollIntervalMinutes?: number; country?: string | null; config?: Record<string, unknown> };
    if (b.config) {
      const cur = await pool.query('SELECT ats_type FROM job_boards WHERE id = $1', [id]);
      if (cur.rows[0]?.ats_type === 'custom') validateCustomConfig(b.config);
    }
    const { rows } = await pool.query(
      `UPDATE job_boards SET enabled = COALESCE($2, enabled),
              poll_interval_minutes = COALESCE($3, poll_interval_minutes),
              country = CASE WHEN $4::boolean THEN $5 ELSE country END,
              config = COALESCE($6::jsonb, config)
        WHERE id = $1 RETURNING *`,
      [id, b.enabled ?? null, b.pollIntervalMinutes ? Math.max(15, b.pollIntervalMinutes) : null, 'country' in b, b.country ?? null,
        b.config ? JSON.stringify(b.config) : null],
    );
    return rows[0] ? { board: rows[0] } : reply.status(404).send({ error: 'Not found' });
  });

  app.delete('/admin/jobs-feed/boards/:id', { preHandler: adminAuth }, async (req) => {
    await pool.query('DELETE FROM job_boards WHERE id = $1', [(req.params as { id: string }).id]);
    return { deleted: true };
  });

  app.post('/admin/jobs-feed/boards/:id/poll', { preHandler: adminAuth }, async (req) => {
    return { queued: await enqueuePoll((req.params as { id: string }).id) };
  });

  app.post('/admin/jobs-feed/seed', { preHandler: adminAuth }, async () => {
    const added = await seedBoardsIfEmpty();
    return { added, seedSize: SEED_BOARDS.length };
  });

  // ── Jobs feed: jobs ─────────────────────────────────────
  app.get('/admin/jobs-feed/jobs', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { q?: string; status?: string; country?: string; limit?: string; offset?: string };
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) {
      params.push(q.status);
      where.push(`j.status = $${params.length}`);
    }
    if (q.country) {
      params.push(q.country.toUpperCase());
      where.push(`j.country = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(j.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
    }
    params.push(n(q.limit, 50), Number(q.offset) || 0);
    const { rows } = await pool.query(
      `SELECT j.id, j.title, c.name AS company, j.location, j.country, j.workplace, j.seniority, j.status,
              j.posted_at, j.first_seen_at, j.url, b.ats_type
         FROM jobs j JOIN job_boards b ON b.id = j.board_id LEFT JOIN companies c ON c.id = j.company_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY j.posted_at DESC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { jobs: rows };
  });

  app.post('/admin/jobs-feed/jobs/:id/hide', { preHandler: adminAuth }, async (req) => {
    await pool.query(`UPDATE jobs SET status = 'hidden' WHERE id = $1`, [(req.params as { id: string }).id]);
    return { hidden: true };
  });
  app.post('/admin/jobs-feed/jobs/:id/unhide', { preHandler: adminAuth }, async (req) => {
    await pool.query(`UPDATE jobs SET status = 'active' WHERE id = $1 AND status = 'hidden'`, [(req.params as { id: string }).id]);
    return { hidden: false };
  });

  // ── Users: profile / applications / inbox ───────────────
  app.get('/admin/users/:userId/profile', { preHandler: adminAuth }, async (req) => {
    const { userId } = req.params as { userId: string };
    const [profile, versions, parses] = await Promise.all([
      profileService.get(userId),
      profileService.versions(userId, 10),
      pool.query(
        'SELECT id, status, error, model, created_at, completed_at FROM resume_parses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId],
      ),
    ]);
    return { profile, versions, resumeParses: parses.rows };
  });

  app.post('/admin/users/:userId/reset-onboarding', { preHandler: adminAuth }, async (req) => {
    return profileService.setOnboarding((req.params as { userId: string }).userId, 'pending');
  });

  app.get('/admin/users/:userId/applications', { preHandler: adminAuth }, async (req) => ({
    applications: await applicationsService.list((req.params as { userId: string }).userId, 'all', 100),
  }));

  // ── Inbox ───────────────────────────────────────────────
  app.get('/admin/emails', { preHandler: adminAuth }, async (req) => {
    const q = req.query as { unmatched?: string; userId?: string; limit?: string };
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.unmatched === 'true') where.push('e.application_id IS NULL');
    if (q.userId) {
      params.push(q.userId);
      where.push(`e.user_id = $${params.length}`);
    }
    params.push(n(q.limit, 50, 200));
    const { rows } = await pool.query(
      `SELECT e.id, e.user_id, e.to_address, e.from_name, e.from_address, e.subject, e.snippet, e.category,
              e.extracted_code IS NOT NULL AS has_code, e.application_id, e.match_method, e.received_at
         FROM emails e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.received_at DESC LIMIT $${params.length}`,
      params,
    );
    return { emails: rows };
  });

  app.post('/admin/emails/:id/match', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { applicationId } = (req.body ?? {}) as { applicationId?: string };
    const { rows } = await pool.query(
      `UPDATE emails e SET application_id = a.id, match_method = 'admin'
         FROM applications a WHERE e.id = $1 AND a.id = $2 AND a.user_id = e.user_id RETURNING e.id`,
      [id, applicationId ?? null],
    );
    return rows[0] ? { matched: true } : reply.status(400).send({ error: 'Email and application must belong to the same user' });
  });

  // ── Resume parsing ──────────────────────────────────────
  app.get('/admin/resume-parses', { preHandler: adminAuth }, async (req) => {
    const { status } = req.query as { status?: string };
    const { rows } = await pool.query(
      `SELECT id, user_id, status, text_chars, model, error, created_at, completed_at FROM resume_parses
        WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 100`,
      [status ?? null],
    );
    return { parses: rows };
  });
}

async function enqueuePoll(boardId: string): Promise<string> {
  const job: PollBoardJob = {
    id: `poll-${boardId}-manual-${Date.now()}`,
    type: 'jobs-poll',
    priority: 'high',
    createdAt: new Date(),
    userId: 'admin',
    payload: { boardId },
  };
  return enqueueJob(job);
}
