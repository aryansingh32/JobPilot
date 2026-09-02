// ============================================================
// ADMIN ROUTES — /admin/*
// Separate module registered into the main Fastify app.
// All routes require x-admin-key header matching ADMIN_API_KEY.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { getPgPool, getRedisClient, CacheKeys } from '../shared/db/index.js';
import { getBrowserPool } from '../execution-service/browser-pool.js';
import { recorderService } from '../execution-service/recorder.js';
import { dryRunService } from '../execution-service/dry-run-service.js';
import { generalizeSteps } from '../execution-service/llm-generalizer.js';
import { getAllQueueStats } from '../shared/queue/index.js';
import { getSelectorHealthReport } from '../execution-service/selector-engine.js';
import { getCaptchaMetrics } from '../execution-service/captcha/events.js';
import { listAllProviders } from '../execution-service/captcha/provider-registry.js';
import { canUsePaidProvider } from '../execution-service/captcha/plan-gate.js';
import { register as promRegister } from 'prom-client';
import { createLogger } from '../shared/logger/index.js';
import { adminAuth } from './admin-auth.js';
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
  // A job only gets an `job_logs` row once it reaches a terminal state (see
  // executor.ts logResult / worker.ts logUnhandledExecutionFailure) — until
  // then its only record is the `job-runtime:<id>` Redis key the worker
  // updates as it progresses. Queued/running/paused jobs therefore have to
  // be read from there, not Postgres.
  const IN_FLIGHT_STATUSES = new Set(['queued', 'running', 'paused']);

  async function listInFlightJobs(status?: string, userId?: string) {
    if (status && !IN_FLIGHT_STATUSES.has(status)) return [];
    const redis = await getRedisClient();
    const keys: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: 'job-runtime:*', COUNT: 200 })) {
      keys.push(key as unknown as string);
    }
    if (!keys.length) return [];
    const raw = await Promise.all(keys.map((k) => redis.get(k).catch(() => null)));
    return raw
      .map((r) => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter((r): r is Record<string, any> => !!r && IN_FLIGHT_STATUSES.has(r.status))
      .filter((r) => !status || r.status === status)
      .filter((r) => !userId || r.userId === userId)
      .map((r) => ({
        job_id: r.jobId,
        user_id: r.userId,
        session_id: r.sessionId,
        type: 'execute',
        site_id: r.siteId,
        status: r.status,
        started_at: r.createdAt,
        completed_at: null,
        success: null,
        error: r.error ?? null,
        task: r.task ?? null,
        result: null,
      }))
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
  }

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
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    try {
      // In-flight jobs are surfaced on the first page only — they're
      // re-fetched every poll (see JobsPanel's 10s interval) so they don't
      // need stable offset-based pagination the way historical rows do.
      const inFlight = offsetNum === 0 ? await listInFlightJobs(status, userId) : [];

      const { rows } = await pool.query(
        `SELECT *, ${JOB_ERROR_SQL} FROM job_logs ${where} ORDER BY started_at DESC LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limitNum, offsetNum]
      );
      const countRes = await pool.query(`SELECT COUNT(*) FROM job_logs ${where}`, params);

      const historicalIds = new Set(rows.map((r: any) => r.job_id));
      const dedupedInFlight = inFlight.filter((j) => !historicalIds.has(j.job_id));
      const jobs = [...dedupedInFlight, ...rows].slice(0, limitNum);

      return reply.send({
        jobs,
        total: Number(countRes.rows[0].count) + dedupedInFlight.length,
      });
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
      const row = rows[0];
      if (!row.task) {
        return reply.status(422).send({
          error: 'This job predates task tracking and cannot be automatically retried. Ask the user to send the request again.',
        });
      }

      const { enqueueJob } = await import('../shared/queue/index.js');
      const { randomUUID } = await import('crypto');
      const newJobId = randomUUID();
      await enqueueJob({
        id: newJobId,
        type: 'execute',
        priority: 'high',
        createdAt: new Date(),
        userId: row.user_id,
        sessionId: row.session_id,
        metadata: { retryOf: jobId },
        payload: {
          siteId: row.site_id,
          task: row.task,
          workflowKey: row.workflow_key ?? undefined,
          sessionId: row.session_id,
          useCache: false,
        },
      });

      await pool.query(`UPDATE job_logs SET status = 'retrying', updated_at = NOW() WHERE job_id = $1`, [jobId]);
      logger.info('admin:job-retry', { jobId, newJobId });
      return reply.send({ jobId: newJobId, retrying: true });
    } catch (e) {
      logger.error('admin:job-retry-failed', e as Error, { jobId });
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
        // trigger_phrases / page_url_patterns / required_inputs / required_files
        // are TEXT[] columns — the pg driver serializes a plain JS array into
        // the correct Postgres array literal on its own; JSON.stringify()-ing
        // them produces a JSON string like ["x"], which Postgres rejects with
        // "malformed array literal". Only the genuinely JSONB columns below
        // (starter_action_plan, error_recovery_plan, metadata) need it.
        body.siteId, body.workflowKey, body.category, body.name,
        body.trigger, body.triggerPhrases ?? [],
        body.portalType, body.siteSection, body.entryUrl, body.pageUrl,
        body.pageUrlPattern, body.pageUrlPatterns ?? [],
        body.requiredInputs ?? [],
        body.requiredFiles ?? [],
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
        status: body.status, starter_action_plan: body.starterActionPlan !== undefined ? JSON.stringify(body.starterActionPlan) : undefined,
        // TEXT[] columns — pass the plain array, not JSON.stringify(), same
        // reasoning as the POST /admin/workflows insert above.
        trigger_phrases: body.triggerPhrases, page_url_patterns: body.pageUrlPatterns,
        required_inputs: body.requiredInputs, required_files: body.requiredFiles,
      };
      for (const [col, val] of Object.entries(map)) {
        if (val !== undefined) { sets.push(`${col} = $${pi++}`); params.push(val); }
      }
      if (!sets.length) return reply.status(400).send({ error: 'No fields to update' });

      // Auto-bump the version on any real edit the caller didn't already
      // version explicitly — otherwise `version` is just a static field
      // nobody ever moves, not real revision tracking.
      if (body.version === undefined) {
        sets.push('version = COALESCE(version, 0) + 1');
      }
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
    const { steps, starterActionPlan } = req.body as { steps: any[]; starterActionPlan?: string };
    try {
      const generalized = await generalizeSteps(steps, starterActionPlan);
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

  // captchaId is the paused job's id — the pending queue mirrors whatever
  // job is currently blocked on pauseForUserInput/clickCaptcha, and
  // resolving it here publishes to the exact same job:resume channel the
  // end user's chat pause listens on, so an admin can stand in for them.
  app.post('/admin/captcha/:captchaId/solve', { preHandler: adminAuth }, async (req, reply) => {
    const { captchaId } = req.params as { captchaId: string };
    const { solution } = req.body as { solution: string };
    try {
      const redis = await getRedisClient();
      await redis.publish(`job:resume:${captchaId}`, JSON.stringify({ __hieAdmin: true, solution }));
      await redis.del(`captcha:pending:${captchaId}`);
      return reply.send({ captchaId, solved: true, resolvedBy: 'human_admin' });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Per-Workflow Analytics ──────────────────────────────
  app.get('/admin/analytics/workflows', { preHandler: adminAuth }, async (req, reply) => {
    const { days = '30' } = req.query as { days?: string };
    const sinceDays = Math.max(1, parseInt(days, 10) || 30);
    const pool = getPgPool();
    try {
      const { rows } = await pool.query(
        `
        WITH job_stats AS (
          SELECT
            workflow_key,
            COUNT(*) AS total_runs,
            COUNT(*) FILTER (WHERE success) AS successful_runs,
            AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS avg_duration_ms
          FROM job_logs
          WHERE workflow_key IS NOT NULL AND started_at > NOW() - ($1 || ' days')::interval
          GROUP BY workflow_key
        ),
        failure_steps AS (
          SELECT workflow_key, step_id, COUNT(*) AS failure_count
          FROM (
            SELECT jl.workflow_key, step->>'stepId' AS step_id
            FROM job_logs jl,
              jsonb_array_elements(
                CASE WHEN jsonb_typeof(jl.result->'steps') = 'array' THEN jl.result->'steps' ELSE '[]'::jsonb END
              ) AS step
            WHERE jl.workflow_key IS NOT NULL
              AND jl.started_at > NOW() - ($1 || ' days')::interval
              AND step ? 'error'
              AND NULLIF(step->>'error', '') IS NOT NULL
          ) sub
          GROUP BY workflow_key, step_id
        ),
        top_failure_step AS (
          SELECT DISTINCT ON (workflow_key) workflow_key, step_id, failure_count
          FROM failure_steps
          ORDER BY workflow_key, failure_count DESC
        )
        SELECT
          js.workflow_key AS "workflowKey",
          sw.name,
          sw.site_id AS "siteId",
          js.total_runs AS "totalRuns",
          js.successful_runs AS "successfulRuns",
          ROUND((js.successful_runs::numeric / NULLIF(js.total_runs, 0)) * 100, 1) AS "successRatePct",
          ROUND(js.avg_duration_ms::numeric, 0) AS "avgDurationMs",
          tfs.step_id AS "mostCommonFailureStep",
          tfs.failure_count AS "mostCommonFailureCount"
        FROM job_stats js
        LEFT JOIN site_workflows sw ON sw.workflow_key = js.workflow_key
        LEFT JOIN top_failure_step tfs ON tfs.workflow_key = js.workflow_key
        ORDER BY js.total_runs DESC
        `,
        [sinceDays]
      );
      return reply.send({ days: sinceDays, workflows: rows });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── LLM Call Volume (cost proxy — no per-token pricing tracked) ──
  app.get('/admin/analytics/llm-usage', { preHandler: adminAuth }, async (req, reply) => {
    const { days = '30' } = req.query as { days?: string };
    const sinceDays = Math.max(1, parseInt(days, 10) || 30);
    const pool = getPgPool();
    try {
      const [totalsRes, dailyRes, byWorkflowRes] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total_jobs, COALESCE(SUM(ai_call_count), 0) AS total_ai_calls
           FROM job_logs WHERE started_at > NOW() - ($1 || ' days')::interval`,
          [sinceDays]
        ),
        pool.query(
          `SELECT DATE_TRUNC('day', started_at) AS day,
                  COALESCE(SUM(ai_call_count), 0) AS ai_calls,
                  COUNT(*) AS jobs
           FROM job_logs
           WHERE started_at > NOW() - ($1 || ' days')::interval
           GROUP BY day ORDER BY day ASC`,
          [sinceDays]
        ),
        pool.query(
          `SELECT
             COALESCE(jl.workflow_key, jl.site_id::text, 'unknown') AS key,
             sw.name,
             COALESCE(SUM(jl.ai_call_count), 0) AS ai_calls,
             COUNT(*) AS jobs
           FROM job_logs jl
           LEFT JOIN site_workflows sw ON sw.workflow_key = jl.workflow_key
           WHERE jl.started_at > NOW() - ($1 || ' days')::interval
           GROUP BY key, sw.name
           ORDER BY ai_calls DESC
           LIMIT 20`,
          [sinceDays]
        ),
      ]);

      const totalJobs = Number(totalsRes.rows[0]?.total_jobs ?? 0);
      const totalAiCalls = Number(totalsRes.rows[0]?.total_ai_calls ?? 0);

      return reply.send({
        days: sinceDays,
        totalJobs,
        totalAiCalls,
        avgAiCallsPerJob: totalJobs ? Number((totalAiCalls / totalJobs).toFixed(2)) : 0,
        daily: dailyRes.rows,
        byWorkflow: byWorkflowRes.rows,
        models: {
          plannerModel: process.env.AI_PLANNER_MODEL || process.env.LLM_MODEL || null,
          selectorModel: process.env.AI_SELECTOR_MODEL || process.env.AI_PLANNER_MODEL || process.env.LLM_MODEL || null,
          recoveryModel: process.env.AI_RECOVERY_MODEL || process.env.AI_PLANNER_MODEL || process.env.LLM_MODEL || null,
          chatModel: process.env.CHAT_LLM_MODEL || process.env.LLM_MODEL || null,
        },
      });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Captcha Spend (monthly premium-solver budget) ───────
  // Sourced from user_captcha_usage (the per-user ledger recordPaidProviderUsage
  // writes to) rather than a single global Redis counter, so this reflects
  // real per-plan spend across every user, not just a legacy global cap.
  app.get('/admin/captcha/spend', { preHandler: adminAuth }, async (_req, reply) => {
    const pool = getPgPool();
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const maxMonthlySpend = parseFloat(process.env.PREMIUM_PLAN_MONTHLY_SPEND_CAP_USD ?? process.env.MAX_CAPTCHA_SPEND ?? '5.0');
      const { rows } = await pool.query(
        `SELECT month, SUM(spend_usd) AS spend FROM user_captcha_usage GROUP BY month ORDER BY month DESC LIMIT 12`
      );
      const months = rows.map((r) => ({ month: r.month, spend: parseFloat(r.spend) }));
      const currentSpend = months.find((m) => m.month === currentMonth)?.spend ?? 0;
      return reply.send({
        currentMonth,
        currentSpend,
        maxMonthlySpend,
        remaining: Math.max(0, maxMonthlySpend - currentSpend),
        premiumConfigured: listAllProviders().some((p) => p.isConfigured()),
        history: months,
      });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── CAPTCHA / Human-Intervention Metrics ────────────────
  app.get('/admin/captcha/metrics', { preHandler: adminAuth }, async (req, reply) => {
    const { days = '30' } = req.query as { days?: string };
    const sinceDays = Math.max(1, parseInt(days, 10) || 30);
    try {
      const metrics = await getCaptchaMetrics(sinceDays);
      return reply.send(metrics);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Solver Provider Status (which providers are configured) ─
  app.get('/admin/captcha/providers', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const providers = listAllProviders().map((p) => ({
        id: p.id,
        configured: p.isConfigured(),
        supports: Array.from(p.supports),
      }));
      return reply.send({ providers });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── User Plan (free/premium — gates automated CAPTCHA solving) ─
  app.get('/admin/users/:userId/plan', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    try {
      const [userRes, gate] = await Promise.all([
        getPgPool().query('SELECT id, plan FROM users WHERE id = $1', [userId]),
        canUsePaidProvider(userId),
      ]);
      if (!userRes.rows.length) return reply.status(404).send({ error: 'User not found' });
      return reply.send({ userId, plan: userRes.rows[0].plan, usage: gate });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/users/:userId/plan', { preHandler: adminAuth }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { plan } = req.body as { plan: string };
    if (plan !== 'free' && plan !== 'premium') {
      return reply.status(400).send({ error: "plan must be 'free' or 'premium'" });
    }
    try {
      const { rows } = await getPgPool().query(
        'UPDATE users SET plan = $2 WHERE id = $1 RETURNING id, plan',
        [userId, plan]
      );
      if (!rows.length) return reply.status(404).send({ error: 'User not found' });
      return reply.send({ userId: rows[0].id, plan: rows[0].plan });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Zero-Shot History (AI-discovered task attempts — the learning
  //    flywheel's audit trail; see also cached_flows.promoted_workflow_id
  //    once one of these has been promoted into a real workflow) ────
  app.get('/admin/zero-shot-history', { preHandler: adminAuth }, async (req, reply) => {
    const { days = '30', limit = '50' } = req.query as { days?: string; limit?: string };
    const sinceDays = Math.max(1, parseInt(days, 10) || 30);
    const rowLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    try {
      const { rows } = await getPgPool().query(
        `SELECT id, url, prompt, success, created_at
         FROM zero_shot_history
         WHERE created_at > NOW() - ($1 || ' days')::interval
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, rowLimit]
      );
      return reply.send({ days: sinceDays, attempts: rows });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Selector Health Report ──────────────────────────────
  app.get('/admin/selectors/health', { preHandler: adminAuth }, async (req, reply) => {
    const { siteId } = req.query as { siteId?: string };
    if (!siteId) return reply.status(400).send({ error: 'siteId query param is required' });
    try {
      const report = await getSelectorHealthReport(siteId);
      return reply.send({ siteId, report });
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── Circuit Breaker State ───────────────────────────────
  app.get('/admin/circuit-breakers', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const redis = await getRedisClient();
      const keys = await redis.keys('cb:open:*');
      const breakers = await Promise.all(
        keys.map(async (k) => ({
          siteId: k.replace('cb:open:', ''),
          open: true,
          resetInSeconds: await redis.ttl(k).catch(() => -1),
        }))
      );
      return reply.send({ breakers });
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
