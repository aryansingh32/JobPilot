import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { getPgPool, getRedisClient, cacheDelete, CacheKeys } from '../shared/db/index.js';
import { enqueueJob } from '../shared/queue/index.js';
import { pickWorker, sendCommand } from '../shared/control-bus/index.js';
import { workflowLoader } from '../shared/workflow-loader.js';
import { compileRecordingDetailed } from '../shared/workflows/compile-recording.js';
import { profileService, type ProfileData } from '../shared/profile/index.js';
import { ApplyError, startApplication } from '../shared/applications/apply.js';
import { LimitError } from '../shared/applications/index.js';
import { buildAnswerBook } from '../execution-service/form-filler.js';
import { userFileStore } from '../execution-service/user-file-store.js';
import type { ExecuteJob } from '../shared/types/index.js';
import { adminAuth, type AdminRequest } from './admin-auth.js';

// ============================================================
// AUTOMATION CONTROLS — everything an admin needs to build and prove a
// workflow without a deploy: import/export, duplicate, version history,
// runs, a test profile, test runs on a real URL (watched live), and the
// remote-controlled recorder.
// ============================================================

/** The profile test runs and recordings use — never a real user's data. */
export const TEST_USER_ID = 'admin-test';

const SAMPLE_PROFILE: ProfileData = {
  personal: {
    fullName: 'Test Applicant', firstName: 'Test', lastName: 'Applicant',
    email: 'test.applicant@example.com', phone: '+1 415 555 0100',
    city: 'San Francisco', state: 'CA', country: 'US',
    linkedin: 'https://www.linkedin.com/in/test-applicant', github: 'https://github.com/test-applicant',
  },
  work: { currentEmployer: 'Example Corp', currentTitle: 'Software Engineer', yearsOfExperience: 4, noticePeriod: '2 weeks' },
  authorization: { needsSponsorship: false, countries: ['US'] },
  education: [{ school: 'State University', degree: "Bachelor's", field: 'Computer Science', end: '2020' }],
  skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  settings: { reviewBeforeSubmit: true },
};

export async function invalidateWorkflowCache(siteId?: string | null): Promise<void> {
  await cacheDelete('workflows:all');
  if (siteId) await cacheDelete(`workflows:site:${siteId}`);
}

async function testProfile() {
  const p = await profileService.get(TEST_USER_ID);
  if (!p.data.personal?.email) return profileService.patch(TEST_USER_ID, SAMPLE_PROFILE, 'admin');
  return p;
}

const toDefinition = (w: Record<string, any>) => ({
  id: w.workflow_key ?? w.id,
  category: w.category,
  name: w.name,
  trigger: w.trigger,
  triggerPhrases: w.trigger_phrases ?? [],
  portalType: w.portal_type ?? undefined,
  siteSection: w.site_section ?? undefined,
  entryUrl: w.entry_url,
  pageUrl: w.page_url ?? undefined,
  pageUrlPatterns: w.page_url_patterns ?? [],
  requiredInputs: w.required_inputs ?? [],
  requiredFiles: w.required_files ?? [],
  instructions: w.instructions,
  starterActionPlan: w.starter_action_plan ?? [],
  errorRecoveryPlan: w.error_recovery_plan ?? [],
  completionArtifact: w.completion_artifact ?? undefined,
  version: w.version ?? 1,
  isActive: w.is_active,
  metadata: w.metadata ?? {},
});

export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPgPool();
  const adminId = (req: unknown) => (req as AdminRequest).admin?.id ?? null;
  const audit = async (req: unknown, workflowId: string | null, action: string, diff: unknown) => {
    const id = adminId(req);
    if (id) {
      await pool
        .query('INSERT INTO workflow_audit_log (admin_id, workflow_id, action, diff) VALUES ($1,$2,$3,$4)', [id, workflowId, action, JSON.stringify(diff)])
        .catch(() => {});
    }
  };

  // ── Workflow import / export / duplicate / history / runs ──
  app.post('/admin/workflows/import', { preHandler: adminAuth }, async (req, reply) => {
    const body = req.body as { workflow?: unknown } | unknown[];
    const defs = Array.isArray(body) ? body : [(body as { workflow?: unknown }).workflow ?? body];
    const results: Array<{ id?: string; dbId?: string; ok: boolean; error?: string }> = [];
    for (const def of defs) {
      try {
        const w = await workflowLoader.upsertDefinition(
          { ...(def as object), metadata: { ...((def as { metadata?: object }).metadata ?? {}), editedInAdmin: true } },
          { force: true },
        );
        results.push({ id: w.id, dbId: w.dbId, ok: true });
        await audit(req, w.dbId ?? null, 'IMPORT', { definition: def });
      } catch (err) {
        results.push({ id: (def as { id?: string })?.id, ok: false, error: (err as Error).message });
      }
    }
    await invalidateWorkflowCache();
    return reply.status(results.every((r) => r.ok) ? 201 : 207).send({ results });
  });

  app.get('/admin/workflows/:id/export', { preHandler: adminAuth }, async (req, reply) => {
    const { rows } = await pool.query('SELECT * FROM site_workflows WHERE id = $1', [(req.params as { id: string }).id]);
    if (!rows[0]) return reply.status(404).send({ error: 'Workflow not found' });
    return toDefinition(rows[0]);
  });

  app.post('/admin/workflows/:id/duplicate', { preHandler: adminAuth }, async (req, reply) => {
    const { rows } = await pool.query('SELECT * FROM site_workflows WHERE id = $1', [(req.params as { id: string }).id]);
    if (!rows[0]) return reply.status(404).send({ error: 'Workflow not found' });
    const def = toDefinition(rows[0]);
    const copy = await workflowLoader.upsertDefinition(
      { ...def, id: `${def.id}-copy-${randomUUID().slice(0, 6)}`, name: `${def.name} (copy)`, isActive: false, metadata: { ...def.metadata, editedInAdmin: true } },
      { force: true },
    );
    await audit(req, copy.dbId ?? null, 'DUPLICATE', { from: rows[0].id });
    await invalidateWorkflowCache();
    return reply.status(201).send({ id: copy.dbId, workflowKey: copy.id });
  });

  app.get('/admin/workflows/:id/history', { preHandler: adminAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.diff, l.timestamp, a.username
         FROM workflow_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
        WHERE l.workflow_id = $1 ORDER BY l.timestamp DESC LIMIT 50`,
      [(req.params as { id: string }).id],
    );
    return { history: rows };
  });

  app.post('/admin/workflows/:id/restore/:entryId', { preHandler: adminAuth }, async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    const { rows } = await pool.query('SELECT diff FROM workflow_audit_log WHERE id = $1 AND workflow_id = $2', [entryId, id]);
    const old = rows[0]?.diff?.old ?? rows[0]?.diff?.new;
    if (!old) return reply.status(404).send({ error: 'Nothing to restore in that entry' });
    const def = toDefinition(old);
    await workflowLoader.upsertDefinition({ ...def, metadata: { ...def.metadata, editedInAdmin: true } }, { force: true });
    await audit(req, id, 'RESTORE', { entryId });
    await invalidateWorkflowCache(old.site_id);
    return { ok: true };
  });

  app.get('/admin/workflows/:id/runs', { preHandler: adminAuth }, async (req, reply) => {
    const { rows: w } = await pool.query('SELECT workflow_key FROM site_workflows WHERE id = $1', [(req.params as { id: string }).id]);
    if (!w[0]) return reply.status(404).send({ error: 'Workflow not found' });
    const { rows } = await pool.query(
      `SELECT job_id, user_id, status, success, verified, duration_ms, error, created_at, completed_at
         FROM job_logs WHERE workflow_key = $1 ORDER BY created_at DESC LIMIT 50`,
      [w[0].workflow_key],
    );
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE success)::int AS ok,
              ROUND(AVG(duration_ms))::int AS avg_ms
         FROM job_logs WHERE workflow_key = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [w[0].workflow_key],
    );
    return { runs: rows, stats: stats.rows[0] };
  });

  // ── Test profile (used by test runs and to tokenize recordings) ──
  app.get('/admin/test-profile', { preHandler: adminAuth }, async () => {
    const p = await testProfile();
    const resume = await userFileStore.getLatestByCategory(TEST_USER_ID, 'resume').catch(() => null);
    return { userId: TEST_USER_ID, profile: p.data, resume: resume ? { id: resume.id, name: resume.originalName } : null };
  });

  app.put('/admin/test-profile', { preHandler: adminAuth }, async (req) => {
    const body = (req.body ?? {}) as { profile?: ProfileData; resume?: { name: string; base64: string } };
    let p = await testProfile();
    if (body.profile) p = await profileService.patch(TEST_USER_ID, body.profile, 'admin');
    if (body.resume?.base64) {
      const buffer = Buffer.from(body.resume.base64, 'base64');
      if (buffer.length > 10 * 1024 * 1024) throw Object.assign(new Error('Resume must be under 10 MB'), { statusCode: 400 });
      const file = await userFileStore.persistDownloadedFile({
        userId: TEST_USER_ID, category: 'resume', originalName: body.resume.name || 'resume.pdf', buffer,
      });
      p = await profileService.patch(TEST_USER_ID, { documents: { resumeFileId: file.id, resumeFileName: file.originalName } }, 'admin');
    }
    return { userId: TEST_USER_ID, profile: p.data };
  });

  // ── Test run: execute a workflow on a real URL, watched live ──
  // Job-apply workflows stop before submit unless `submit: true` is sent.
  app.post('/admin/workflows/:id/test-run', { preHandler: adminAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { url?: string; jobId?: string; submit?: boolean; userId?: string };
    const { rows } = await pool.query('SELECT * FROM site_workflows WHERE id = $1', [id]);
    const w = rows[0];
    if (!w) return reply.status(404).send({ error: 'Workflow not found' });
    const userId = body.userId || TEST_USER_ID;
    if (userId === TEST_USER_ID) await testProfile();

    if (w.metadata?.kind === 'job-apply') {
      try {
        const started = await startApplication(userId, {
          jobId: body.jobId, url: body.url, workflowId: id, stopBeforeSubmit: body.submit !== true, skipLimits: true, source: 'admin_test',
        });
        await audit(req, id, 'TEST_RUN', { url: body.url, jobId: body.jobId, submit: body.submit === true, userId });
        return reply.status(201).send({ execJobId: started.application.exec_job_id, applicationId: started.application.id, applyUrl: started.applyUrl });
      } catch (err) {
        if (err instanceof ApplyError || err instanceof LimitError) return reply.status(err.statusCode).send({ error: err.message });
        throw err;
      }
    }

    const url = body.url || w.entry_url;
    const sessionId = `admin-test-${randomUUID()}`;
    const job: ExecuteJob = {
      id: randomUUID(), type: 'execute', priority: 'high', createdAt: new Date(), userId, sessionId,
      payload: {
        siteId: w.site_id, task: `[test] ${w.name}`, workflowKey: w.workflow_key, actionPlan: w.starter_action_plan,
        sessionId, useCache: false, maxAttempts: 1, stopBeforeSubmit: body.submit !== true,
        context: { url, applyUrl: url },
      },
      metadata: { planSource: 'structured-workflow', matchedWorkflowId: w.id, matchedWorkflowName: w.name, adminTest: true },
    };
    const redis = await getRedisClient();
    const now = new Date().toISOString();
    await redis.setEx(CacheKeys.jobRuntime(job.id), 86400, JSON.stringify({ jobId: job.id, userId, sessionId, siteId: w.site_id, task: job.payload.task, status: 'queued', createdAt: now, updatedAt: now }));
    await enqueueJob(job);
    await audit(req, id, 'TEST_RUN', { url, userId });
    return reply.status(201).send({ execJobId: job.id });
  });

  // Answer a paused test run (question, review approval, captcha) from the admin panel.
  app.post('/admin/jobs/:jobId/respond', { preHandler: adminAuth }, async (req, reply) => {
    const { value } = (req.body ?? {}) as { value?: string };
    if (typeof value !== 'string') return reply.status(400).send({ error: 'value is required' });
    const redis = await getRedisClient();
    await redis.publish(`job:resume:${(req.params as { jobId: string }).jobId}`, value);
    return { ok: true };
  });

  app.get('/admin/jobs/:jobId/pending', { preHandler: adminAuth }, async (req) => {
    const redis = await getRedisClient();
    const jobId = (req.params as { jobId: string }).jobId;
    const [pending, runtime] = await Promise.all([redis.get(`captcha:pending:${jobId}`), redis.get(CacheKeys.jobRuntime(jobId))]);
    return { pending: pending ? JSON.parse(pending) : null, runtime: runtime ? JSON.parse(runtime) : null };
  });

  // ── Recorder (remote-controlled browser on a worker) ──────
  const recordKey = (sessionId: string) => `admin:record:${sessionId}`;

  // bodyLimit: 'upload' inputs carry a base64 file (up to 10 MB).
  app.post('/admin/record/input', { preHandler: adminAuth, bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { sessionId, input } = (req.body ?? {}) as { sessionId?: string; input?: unknown };
    if (!sessionId || !input) return reply.status(400).send({ error: 'sessionId and input are required' });
    const redis = await getRedisClient();
    const workerId = await redis.get(recordKey(sessionId));
    if (!workerId) return reply.status(404).send({ error: 'No active recording for that session' });
    const [res] = await sendCommand<{ url: string }>('record.input', { sessionId, input }, { target: workerId, timeoutMs: 45_000 });
    if (!res?.ok) return reply.status(500).send({ error: res?.error ?? 'Input failed' });
    return res.result;
  });

  /** Raw recording → executor steps. Typed values matching the test profile become {{profile:*}} tokens. */
  app.post('/admin/record/compile', { preHandler: adminAuth }, async (req) => {
    const { steps, jobApply } = (req.body ?? {}) as { steps?: unknown[]; jobApply?: boolean };
    const p = await testProfile();
    const book = buildAnswerBook(p.data);
    return compileRecordingDetailed((steps ?? []) as never[], { profileValues: book, jobApply: jobApply === true });
  });

  app.get('/admin/record/status', { preHandler: adminAuth }, async () => {
    const worker = await pickWorker();
    return { workerOnline: !!worker, workerId: worker?.workerId ?? null };
  });
}
