// ============================================================
// ADMIN ROUTES — /admin/*
// Separate module registered into the main Fastify app.
// All routes require x-admin-key header matching ADMIN_API_KEY.
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPgPool, getRedisClient, CacheKeys } from '../shared/db/index.js';
import { getBrowserPool } from '../execution-service/browser-pool.js';
import { recorderService } from '../execution-service/recorder.js';
import { dryRunService } from '../execution-service/dry-run-service.js';
import { generalizeSteps } from '../execution-service/llm-generalizer.js';
import { getAllQueueStats } from '../shared/queue/index.js';
import { register as promRegister } from 'prom-client';
import { createLogger } from '../shared/logger/index.js';
import os from 'os';
import fs from 'fs';

const logger = createLogger('admin-routes');

const JOB_ERROR_SQL = `
  COALESCE(
    NULLIF(error, ''),
    result->>'error',
    (
      SELECT step->>'error'
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(result->'steps') = 'array' THEN result->'steps'
          ELSE '[]'::jsonb
        END
      ) AS step
      WHERE step ? 'error' AND NULLIF(step->>'error', '') IS NOT NULL
      LIMIT 1
    )
  ) AS error
`;

// ── Admin Auth Middleware ──────────────────────────────────
async function adminAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-admin-key'] as string;
  if (!key) {
    logger.warn('admin:auth-missing-key', { ip: req.ip, url: req.url });
    reply.status(401).send({ error: 'Unauthorized — admin key required' });
    return;
  }

  const pool = getPgPool();
  try {
    const { rows } = await pool.query('SELECT id, role FROM admins WHERE api_key = $1', [key]);
    if (!rows.length) {
      logger.warn('admin:auth-failed', { ip: req.ip, url: req.url });
      reply.status(401).send({ error: 'Unauthorized — invalid admin key' });
      return;
    }
    
    const admin = rows[0];
    (req as any).admin = admin;

    const method = req.method.toUpperCase();
    if (method === 'DELETE' && admin.role !== 'super-admin') {
      reply.status(403).send({ error: 'Forbidden — super-admin required for DELETE' });
      return;
    }
    if ((method === 'POST' || method === 'PUT') && admin.role === 'viewer') {
      reply.status(403).send({ error: 'Forbidden — editor or super-admin required for POST/PUT' });
      return;
    }
  } catch (err) {
    logger.error('admin:auth-error', err);
    reply.status(500).send({ error: 'Internal Server Error' });
    return;
  }
}

// ── Helpers ────────────────────────────────────────────────
async function getSystemHealth() {
  const pool = getPgPool();
  let dbOk = false;
  let dbLatencyMs = -1;
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch {}

  const redis = await getRedisClient().catch(() => null);
  let redisOk = false;
  let redisLatencyMs = -1;
  if (redis) {
    try {
      const t0 = Date.now();
      await redis.ping();
      redisLatencyMs = Date.now() - t0;
      redisOk = true;
    } catch {}
  }

  const browserStats = getBrowserPool().getStats();
  const mem = process.memoryUsage();
  const sysMem = { total: os.totalmem(), free: os.freemem() };

  return {
    status: dbOk && redisOk ? 'healthy' : 'degraded',
    db: { status: dbOk ? 'ok' : 'error', latencyMs: dbLatencyMs },
    redis: { status: redisOk ? 'ok' : 'error', latencyMs: redisLatencyMs },
    browsers: browserStats,
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      systemTotal: sysMem.total,
      systemFree: sysMem.free,
    },
    cpu: os.loadavg(),
    nodeVersion: process.version,
    platform: process.platform,
    timestamp: new Date().toISOString(),
  };
}

// ── Register All Admin Routes ──────────────────────────────
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {

  // ── Health ──────────────────────────────────────────────
  app.get('/admin/health', { preHandler: adminAuth }, async (_req, reply) => {
    const health = await getSystemHealth();
    return reply.send(health);
  });

  // ── System Overview (dashboard) ─────────────────────────
  app.get('/admin/overview', { preHandler: adminAuth }, async (_req, reply) => {
    const [health, queues] = await Promise.all([
      getSystemHealth(),
      getAllQueueStats().catch(() => ({})),
    ]);

    const pool = getPgPool();
    let jobStats = { total: 0, completed: 0, failed: 0, running: 0 };
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE true) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed,
          COUNT(*) FILTER (WHERE status = 'running') AS running
        FROM job_logs
        WHERE started_at > NOW() - INTERVAL '24 hours'
      `);
      if (rows[0]) {
        jobStats = {
          total: Number(rows[0].total),
          completed: Number(rows[0].completed),
          failed: Number(rows[0].failed),
          running: Number(rows[0].running),
        };
      }
    } catch {}

    let userCount = 0;
    try {
      const redis = await getRedisClient();
      const keys = await redis.keys('session:*');
      userCount = keys.length;
    } catch {}

    return reply.send({ health, queues, jobStats, userCount });
  });

  // ── Prometheus Metrics ──────────────────────────────────
  app.get('/admin/metrics', { preHandler: adminAuth }, async (_req, reply) => {
    reply.header('Content-Type', promRegister.contentType);
    return promRegister.metrics();
  });

  // ── Queue Stats ─────────────────────────────────────────
  app.get('/admin/queues', { preHandler: adminAuth }, async (_req, reply) => {
    const stats = await getAllQueueStats();
    return reply.send({ queues: stats });
  });

  // ── All Jobs (paginated) ────────────────────────────────
  app.get('/admin/jobs', { preHandler: adminAuth }, async (req, reply) => {
    const { status, userId, limit = '50', offset = '0', from, to } = req.query as {
      status?: string; userId?: string; limit?: string; offset?: string; from?: string; to?: string;
    };

    const pool = getPgPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (status) { conditions.push(`status = $${pi++}`); params.push(status); }
    if (userId) { conditions.push(`user_id = $${pi++}`); params.push(userId); }
    if (from)   { conditions.push(`started_at >= $${pi++}`); params.push(new Date(from)); }
    if (to)     { conditions.push(`started_at <= $${pi++}`); params.push(new Date(to)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));

    try {
      const { rows } = await pool.query(
        `SELECT *, ${JOB_ERROR_SQL} FROM job_logs ${where} ORDER BY started_at DESC LIMIT $${pi} OFFSET $${pi+1}`,
        params
      );
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM job_logs ${where}`,
        params.slice(0, -2)
      );
      return reply.send({ jobs: rows, total: Number(countRes.rows[0].count) });
    } catch (e) {
      logger.error('admin:jobs-query-failed', e);
      return reply.status(500).send({ error: 'Failed to fetch jobs' });
    }
  });

  // ── Job Details ─────────────────────────────────────────
  app.get('/admin/jobs/:jobId', { preHandler: adminAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const pool = getPgPool();
    try {
      const [jobRes, runtimeRes] = await Promise.all([
        pool.query(`SELECT *, ${JOB_ERROR_SQL} FROM job_logs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 1`, [jobId]),
        getRedisClient().then(r => r.get(CacheKeys.jobRuntime(jobId))).catch(() => null),
      ]);
      if (!jobRes.rows.length && !runtimeRes) return reply.status(404).send({ error: 'Job not found' });
      
      const parsedRuntime = runtimeRes ? JSON.parse(runtimeRes) : null;
      
      let jobData = jobRes.rows[0];
      if (!jobData && parsedRuntime) {
        jobData = {
          job_id: jobId,
          user_id: parsedRuntime.userId,
          session_id: parsedRuntime.sessionId,
          site_id: parsedRuntime.siteId,
          type: 'execute',
          status: parsedRuntime.status,
          started_at: parsedRuntime.createdAt,
          success: false,
          error: parsedRuntime.error ?? null,
          result: {}
        };
      }
      if (jobData && !jobData.error && parsedRuntime?.error) {
        jobData = { ...jobData, error: parsedRuntime.error };
      }

      return reply.send({
        job: jobData,
        runtime: parsedRuntime,
      });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to fetch job' });
    }
  });

  // ── Cancel Job ──────────────────────────────────────────
  app.post('/admin/jobs/:jobId/cancel', { preHandler: adminAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const redis = await getRedisClient();
    await redis.setEx(CacheKeys.jobCancel(jobId), 86400, '1');
    await redis.publish(`job:cancel:${jobId}`, 'cancel');
    logger.warn('admin:job-force-cancel', { jobId });
    return reply.send({ jobId, cancelled: true });
  });

  // ── Retry Job ───────────────────────────────────────────
  app.post('/admin/jobs/:jobId/retry', { preHandler: adminAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const pool = getPgPool();
    try {
      const { rows } = await pool.query(`SELECT * FROM job_logs WHERE job_id = $1`, [jobId]);
      if (!rows.length) return reply.status(404).send({ error: 'Job not found' });
      // Mark it as retrying
      await pool.query(`UPDATE job_logs SET status = 'retrying', updated_at = NOW() WHERE job_id = $1`, [jobId]);
      logger.info('admin:job-retry', { jobId });
      return reply.send({ jobId, retrying: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to retry job' });
    }
  });

  // ── Users / Sessions ────────────────────────────────────
  app.get('/admin/users', { preHandler: adminAuth }, async (req, reply) => {
    const { limit = '100', offset = '0' } = req.query as { limit?: string; offset?: string };
    const pool = getPgPool();
    try {
      // Derive users from memory profiles and job_logs (no auth users table yet)
      const { rows } = await pool.query(`
        SELECT
          user_id,
          COUNT(*) AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
          MAX(started_at) AS last_active,
          MIN(started_at) AS first_seen
        FROM job_logs
        GROUP BY user_id
        ORDER BY last_active DESC
        LIMIT $1 OFFSET $2
      `, [parseInt(limit), parseInt(offset)]);

      const countRes = await pool.query(`SELECT COUNT(DISTINCT user_id) FROM job_logs`);
      return reply.send({ users: rows, total: Number(countRes.rows[0].count) });
    } catch (e) {
      logger.error('admin:users-query-failed', e);
      return reply.status(500).send({ error: 'Failed to fetch users' });
    }
  });

  // ── User Detail ─────────────────────────────────────────
  app.get('/admin/users/:userId', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const pool = getPgPool();
    try {
      const [jobs, profiles, files] = await Promise.all([
        pool.query(`
          SELECT job_id, type, status, started_at, completed_at, ${JOB_ERROR_SQL}
          FROM job_logs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50
        `, [userId]),
        pool.query(`SELECT profile_name, created_at, updated_at FROM user_memory_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
        pool.query(`SELECT id, original_name, category, mime_type, file_size_bytes, created_at FROM user_files WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]).catch(() => ({ rows: [] })),
      ]);
      return reply.send({
        userId,
        jobs: jobs.rows,
        profiles: profiles.rows,
        files: files.rows,
      });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to fetch user details' });
    }
  });

  // ── User Prompts / Chat History ─────────────────────────
  app.get('/admin/users/:userId/prompts', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string };
    const pool = getPgPool();
    try {
      const { rows } = await pool.query(`
        SELECT job_id, task AS prompt, status, started_at
        FROM job_logs
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, parseInt(limit), parseInt(offset)]);
      return reply.send({ prompts: rows });
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch prompts' });
    }
  });

  // ── Workflows CRUD ──────────────────────────────────────
  app.get('/admin/workflows', { preHandler: adminAuth }, async (req, reply) => {
    const { siteId, isActive, limit = '100', offset = '0' } = req.query as {
      siteId?: string; isActive?: string; limit?: string; offset?: string;
    };
    const pool = getPgPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    if (siteId)   { conditions.push(`site_id = $${pi++}`); params.push(siteId); }
    if (isActive !== undefined) { conditions.push(`is_active = $${pi++}`); params.push(isActive === 'true'); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));
    try {
      const { rows } = await pool.query(
        `SELECT * FROM site_workflows ${where} ORDER BY created_at DESC LIMIT $${pi} OFFSET $${pi+1}`,
        params
      );
      const countRes = await pool.query(`SELECT COUNT(*) FROM site_workflows ${where}`, params.slice(0,-2));
      return reply.send({ workflows: rows, total: Number(countRes.rows[0].count) });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to fetch workflows' });
    }
  });

  app.post('/admin/workflows', { preHandler: adminAuth }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const isActive = body.isActive ?? true;
    const starterActionPlan = body.starterActionPlan as any[] ?? [];
    if (isActive && starterActionPlan.length === 0) {
      return reply.status(400).send({ error: 'starterActionPlan cannot be empty when workflow is active' });
    }
    const pool = getPgPool();
    try {
      const { rows } = await pool.query(`
        INSERT INTO site_workflows
          (site_id, workflow_key, category, name, trigger, trigger_phrases, portal_type,
           site_section, entry_url, page_url, page_url_pattern, page_url_patterns,
           required_inputs, required_files, instructions, default_profile_name,
           starter_action_plan, error_recovery_plan, version, is_active,
           completion_artifact, metadata, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        RETURNING *
      `, [
        body.siteId, body.workflowKey, body.category, body.name,
        body.trigger, JSON.stringify(body.triggerPhrases ?? []),
        body.portalType, body.siteSection, body.entryUrl, body.pageUrl,
        body.pageUrlPattern, JSON.stringify(body.pageUrlPatterns ?? []),
        JSON.stringify(body.requiredInputs ?? []),
        JSON.stringify(body.requiredFiles ?? []),
        body.instructions, body.defaultProfileName,
        JSON.stringify(starterActionPlan),
        JSON.stringify(body.errorRecoveryPlan ?? []),
        body.version ?? 1, isActive,
        body.completionArtifact, JSON.stringify(body.metadata ?? {}),
        body.status ?? 'draft'
      ]);
      const admin = (req as any).admin;
      if (admin) {
        await pool.query(
          `INSERT INTO workflow_audit_log (admin_id, workflow_id, action, diff) VALUES ($1, $2, $3, $4)`,
          [admin.id, rows[0].id, 'CREATE', JSON.stringify({ new: rows[0] })]
        );
      }
      return reply.status(201).send({ workflow: rows[0] });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.put('/admin/workflows/:workflowId', { preHandler: adminAuth }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const body = req.body as Record<string, unknown>;
    const pool = getPgPool();
    try {
      const oldRows = await pool.query('SELECT * FROM site_workflows WHERE id = $1', [workflowId]);
      if (!oldRows.rows.length) return reply.status(404).send({ error: 'Workflow not found' });
      const oldWorkflow = oldRows.rows[0];

      const isActive = body.isActive !== undefined ? body.isActive : oldWorkflow.is_active;
      const starterActionPlan = body.starterActionPlan !== undefined ? body.starterActionPlan as any[] : oldWorkflow.starter_action_plan;
      if (isActive && (!starterActionPlan || starterActionPlan.length === 0)) {
        return reply.status(400).send({ error: 'starterActionPlan cannot be empty when workflow is active' });
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      let pi = 1;
      const map: Record<string, unknown> = {
        name: body.name, trigger: body.trigger, instructions: body.instructions,
        is_active: body.isActive, portal_type: body.portalType,
        entry_url: body.entryUrl, page_url: body.pageUrl,
        category: body.category, version: body.version,
        status: body.status, starter_action_plan: body.starterActionPlan !== undefined ? JSON.stringify(body.starterActionPlan) : undefined
      };
      for (const [col, val] of Object.entries(map)) {
        if (val !== undefined) { sets.push(`${col} = $${pi++}`); params.push(val); }
      }
      if (!sets.length) return reply.status(400).send({ error: 'No fields to update' });
      params.push(workflowId);
      

      const { rows } = await pool.query(
        `UPDATE site_workflows SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${pi} RETURNING *`,
        params
      );
      if (!rows.length) return reply.status(404).send({ error: 'Workflow not found' });
      
      const admin = (req as any).admin;
      if (admin && oldRows.rows.length) {
        await pool.query(
          `INSERT INTO workflow_audit_log (admin_id, workflow_id, action, diff) VALUES ($1, $2, $3, $4)`,
          [admin.id, workflowId, 'UPDATE', JSON.stringify({ old: oldRows.rows[0], new: rows[0] })]
        );
      }
      
      return reply.send({ workflow: rows[0] });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.delete('/admin/workflows/:workflowId', { preHandler: adminAuth }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const pool = getPgPool();
    try {
      const oldRows = await pool.query('SELECT * FROM site_workflows WHERE id = $1', [workflowId]);
      if (!oldRows.rows.length) return reply.status(404).send({ error: 'Workflow not found' });
      
      const admin = (req as any).admin;
      if (admin) {
        await pool.query(
          `INSERT INTO workflow_audit_log (admin_id, workflow_id, action, diff) VALUES ($1, $2, $3, $4)`,
          [admin.id, workflowId, 'DELETE', JSON.stringify({ old: oldRows.rows[0] })]
        );
      }
      
      const { rowCount } = await pool.query(`DELETE FROM site_workflows WHERE id = $1`, [workflowId]);
      if (!rowCount) return reply.status(404).send({ error: 'Workflow not found' });
      return reply.send({ deleted: true, workflowId });
    } catch {
      return reply.status(500).send({ error: 'Failed to delete workflow' });
    }
  });

  // ── Workflow Recorder ───────────────────────────────────
  app.post('/admin/record/start', { preHandler: adminAuth }, async (req, reply) => {
    const { url, sessionId } = req.body as { url: string; sessionId: string };
    try {
      await recorderService.startRecording(sessionId, url);
      return reply.send({ success: true, sessionId, url });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/record/stop', { preHandler: adminAuth }, async (req, reply) => {
    const { sessionId } = req.body as { sessionId: string };
    try {
      const steps = await recorderService.stopRecording(sessionId);
      return reply.send({ success: true, steps });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/record/generalize', { preHandler: adminAuth }, async (req, reply) => {
    const { steps } = req.body as { steps: any[] };
    try {
      const generalized = await generalizeSteps(steps);
      return reply.send({ success: true, generalized });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/record/dry-run', { preHandler: adminAuth }, async (req, reply) => {
    const { url, steps } = req.body as { url: string; steps: any[] };
    try {
      const result = await dryRunService.runDryRun(url, steps);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Browser Pool Control ────────────────────────────────
  app.get('/admin/browsers', { preHandler: adminAuth }, async (_req, reply) => {
    const stats = getBrowserPool().getStats();
    return reply.send({ browsers: stats });
  });

  app.post('/admin/browsers/recycle', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      await getBrowserPool().reclaimIdleBrowsers?.();
      logger.warn('admin:browser-pool-recycled');
      return reply.send({ recycled: true });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Webhook Target for n8n Background Cleanup ───────────
  app.delete('/admin/files/cleanup', { preHandler: adminAuth }, async (req, reply) => {
    // This endpoint is meant to be called by n8n scheduled workflows
    const pool = getPgPool();
    // Delete files older than 30 minutes
    const { rows } = await pool.query(`
      SELECT id, storage_path FROM user_files 
      WHERE created_at < NOW() - INTERVAL '30 minutes'
    `);
    
    let deletedCount = 0;
    for (const file of rows) {
      try {
        await fs.promises.unlink(file.storage_path).catch(() => {});
        await pool.query(`DELETE FROM user_files WHERE id = $1`, [file.id]);
        deletedCount++;
      } catch (e) {
        logger.error(`Failed to cleanup file ${file.id}`, e);
      }
    }
    return reply.send({ success: true, cleanedFiles: deletedCount });
  });

  // ── Cache Control ───────────────────────────────────────
  app.post('/admin/cache/flush', { preHandler: adminAuth }, async (req, reply) => {
    const { pattern } = req.body as { pattern?: string };
    try {
      const redis = await getRedisClient();
      const keys = await redis.keys(pattern ?? 'session:*');
      if (keys.length) await redis.del(keys);
      logger.warn('admin:cache-flush', { pattern, count: keys.length });
      return reply.send({ flushed: keys.length });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Captcha Queue ───────────────────────────────────────
  app.get('/admin/captcha/pending', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const redis = await getRedisClient();
      const keys = await redis.keys('captcha:pending:*');
      const items = await Promise.all(
        keys.map(async (k) => {
          const v = await redis.get(k);
          return v ? JSON.parse(v) : null;
        })
      );
      return reply.send({ captchas: items.filter(Boolean) });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/captcha/:captchaId/solve', { preHandler: adminAuth }, async (req, reply) => {
    const { captchaId } = req.params as { captchaId: string };
    const { solution } = req.body as { solution: string };
    try {
      const redis = await getRedisClient();
      await redis.publish(`captcha:solved:${captchaId}`, JSON.stringify({ captchaId, solution, source: 'admin' }));
      await redis.del(`captcha:pending:${captchaId}`);
      return reply.send({ captchaId, solved: true });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Log Tail (last N lines from Redis log stream) ───────
  app.get('/admin/logs', { preHandler: adminAuth }, async (req, reply) => {
    const { service = 'api', limit = '200' } = req.query as { service?: string; limit?: string };
    try {
      const redis = await getRedisClient();
      const key = `logs:${service}`;
      const raw = await redis.lRange(key, -parseInt(limit), -1).catch(() => [] as string[]);
      const entries = raw.map((r) => { try { return JSON.parse(r); } catch { return { msg: r }; } });
      return reply.send({ service, entries: entries.reverse() });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Network / Request Stats ─────────────────────────────
  app.get('/admin/network/stats', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const redis = await getRedisClient();
      const [reqTotal, reqFailed, avgLatency] = await Promise.all([
        redis.get('stats:requests:total').catch(() => '0'),
        redis.get('stats:requests:failed').catch(() => '0'),
        redis.get('stats:latency:avg').catch(() => '0'),
      ]);
      return reply.send({
        requestsTotal: Number(reqTotal),
        requestsFailed: Number(reqFailed),
        avgLatencyMs: Number(avgLatency),
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Error Tracker ───────────────────────────────────────
  app.get('/admin/errors', { preHandler: adminAuth }, async (req, reply) => {
    const { limit = '100' } = req.query as { limit?: string };
    try {
      const redis = await getRedisClient();
      const raw = await redis.lRange('logs:errors', -parseInt(limit), -1).catch(() => [] as string[]);
      const entries = raw.map((r) => { try { return JSON.parse(r); } catch { return { msg: r }; } });
      return reply.send({ errors: entries.reverse() });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Sites ───────────────────────────────────────────────
  app.get('/admin/sites', { preHandler: adminAuth }, async (req, reply) => {
    const { limit = '100', offset = '0' } = req.query as { limit?: string; offset?: string };
    const pool = getPgPool();
    try {
      const { rows } = await pool.query(
        `SELECT id, domain, page_count, status, created_at, updated_at FROM sites ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [parseInt(limit), parseInt(offset)]
      );
      const countRes = await pool.query(`SELECT COUNT(*) FROM sites`);
      return reply.send({ sites: rows, total: Number(countRes.rows[0].count) });
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch sites' });
    }
  });

  logger.info('admin-routes:registered', { prefix: '/admin' });
}
