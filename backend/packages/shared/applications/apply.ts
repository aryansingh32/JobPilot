import { learnAnswer } from '../profile/learned.js';
import { randomUUID } from 'crypto';
import { getPgPool, getRedisClient, CacheKeys } from '../db/index.js';
import { enqueueJob, acquireTaskLock, releaseTaskLock, DuplicateTaskError } from '../queue/index.js';
import { detectBoard } from '../jobs/sources.js';
import { createLogger } from '../logger/index.js';
import type { ActionStep, ExecuteJob } from '../types/index.js';
import { applicationsService, type ApplicationSource } from './index.js';
import { creditsService } from '../credits/index.js';
import { answerMemory } from '../profile/index.js';
import { inferCountry, profileGaps } from '../profile/gaps.js';
import { profileService } from '../profile/index.js';

// ============================================================
// APPLY ENGINE — "Apply for me" without the chat LLM.
// job (or URL) → applicant system → the published job-apply workflow for
// that system (or for a URL pattern an admin recorded) → execute job.
// Workflows are rows in site_workflows with metadata.kind = 'job-apply';
// admins add new sites by publishing another one, no deploy needed.
// ============================================================

const logger = createLogger('apply-engine');

export class ApplyError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

interface JobTarget {
  jobId: string | null;
  url: string;
  title: string;
  company: string | null;
  country: string | null;
  atsType: string | null;
  boardToken: string | null;
  externalId: string | null;
}

async function resolveTarget(input: { jobId?: string; url?: string }): Promise<JobTarget> {
  const pool = getPgPool();
  if (input.jobId) {
    const { rows } = await pool.query(
      `SELECT j.id, j.url, j.title, j.country, j.external_id, c.name AS company, b.ats_type, b.board_token
         FROM jobs j JOIN job_boards b ON b.id = j.board_id LEFT JOIN companies c ON c.id = j.company_id
        WHERE j.id = $1`,
      [input.jobId],
    );
    const j = rows[0];
    if (!j) throw new ApplyError('Job not found', 404);
    return {
      jobId: j.id, url: j.url, title: j.title, company: j.company, country: j.country,
      atsType: j.ats_type, boardToken: j.board_token, externalId: j.external_id,
    };
  }
  const url = input.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new ApplyError('A job id or a job link is required');
  const { rows } = await pool.query(
    `SELECT j.id FROM jobs j WHERE j.url = $1 LIMIT 1`,
    [url],
  );
  if (rows[0]) return resolveTarget({ jobId: rows[0].id });
  const board = detectBoard(url);
  // Every pasted link grows the registry: its company's board becomes a candidate.
  if (board) {
    void import('../jobs/discovery.js').then((d) => d.addCandidates(board.atsType, [board.token], 'link')).catch(() => {});
  }
  // A pasted Greenhouse link: its public API names the role and where it is, so the right country-specific
  // answers (work authorization, sponsorship) are used and the application has a real title from the start.
  const gh = board?.atsType === 'greenhouse' ? url.match(/\/jobs\/(\d+)/)?.[1] ?? url.match(/[?&]gh_jid=(\d+)/)?.[1] : undefined;
  if (board && gh) {
    const info = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs/${gh}`, { signal: AbortSignal.timeout(4_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ title?: string; company_name?: string; location?: { name?: string } }>) : null))
      .catch(() => null);
    if (info?.title) {
      return {
        jobId: null, url, title: info.title, company: info.company_name ?? null, country: inferCountry(info.location?.name),
        atsType: 'greenhouse', boardToken: board.token, externalId: gh,
      };
    }
  }
  return {
    jobId: null, url, title: 'Job application', company: null, country: null,
    atsType: board?.atsType ?? null, boardToken: board?.token ?? null, externalId: null,
  };
}

/** Where the form actually lives, per applicant system. */
export function applyUrlFor(t: Pick<JobTarget, 'url' | 'atsType' | 'boardToken' | 'externalId'>): string {
  const base = t.url.replace(/[?#].*$/, '').replace(/\/$/, '');
  switch (t.atsType) {
    case 'greenhouse':
      // Company career sites often wrap Greenhouse in an iframe; the embed URL is the form itself.
      return t.boardToken && t.externalId
        ? `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(t.boardToken)}&token=${encodeURIComponent(t.externalId)}`
        : t.url;
    case 'lever':
      return base.endsWith('/apply') ? base : `${base}/apply`;
    case 'ashby':
      return base.endsWith('/application') ? base : `${base}/application`;
    case 'workable':
      return base.endsWith('/apply') ? `${base}/` : `${base}/apply/`;
    case 'recruitee':
      return base.endsWith('/c/new') ? base : `${base}/c/new`;
    // SmartRecruiters: the posting page; the form opens from "I'm interested".
    default:
      return t.url;
  }
}

export interface ApplyWorkflow {
  id: string;
  workflowKey: string | null;
  siteId: string;
  name: string;
  plan: ActionStep[];
  /** The any-form fallback (no site-specific workflow matched). */
  generic?: boolean;
}

/**
 * Most specific first: a workflow whose URL patterns match this job, then the
 * one for its applicant system, then the generic form filler.
 */
export async function pickApplyWorkflow(url: string, atsType: string | null): Promise<ApplyWorkflow | null> {
  const { rows } = await getPgPool().query(
    `SELECT id, workflow_key, site_id, name, starter_action_plan, page_url_patterns, metadata
       FROM site_workflows
      WHERE status = 'published' AND is_active AND metadata->>'kind' = 'job-apply'
      ORDER BY updated_at DESC`,
  );
  const byPattern = rows.find((r) =>
    (r.page_url_patterns ?? []).some((p: string) => {
      try {
        return new RegExp(p, 'i').test(url);
      } catch {
        return false;
      }
    }) && r.metadata?.atsType !== 'generic',
  );
  // Government notices (source "sarkari") with no portal-specific match use the department-portal flow.
  const byAts = atsType
    ? rows.find((r) => r.metadata?.atsType === atsType) ?? (atsType === 'sarkari' ? rows.find((r) => r.metadata?.atsType === 'gov-gov') : undefined)
    : undefined;
  const generic = rows.find((r) => r.metadata?.atsType === 'generic');
  const w = byPattern ?? byAts ?? generic;
  return w
    ? { id: w.id, workflowKey: w.workflow_key, siteId: w.site_id, name: w.name, plan: w.starter_action_plan, generic: w.metadata?.atsType === 'generic' }
    : null;
}

export async function startApplication(
  userId: string,
  input: {
    jobId?: string;
    url?: string;
    sessionId?: string;
    stopBeforeSubmit?: boolean;
    workflowId?: string;
    skipLimits?: boolean;
    source?: ApplicationSource;
    /** Auto Apply: only systems with their own workflow, never the generic form filler. */
    requireDedicatedWorkflow?: boolean;
    /** Refuse (422) when the profile lacks details nearly every form requires — asked up front instead of mid-run. */
    checkProfile?: boolean;
  },
) {
  const target = await resolveTarget(input);
  if (target.jobId) {
    const dup = await getPgPool().query(
      `SELECT id, status FROM applications
        WHERE user_id = $1 AND job_id = $2 AND status <> ALL(ARRAY['failed','cancelled']) LIMIT 1`,
      [userId, target.jobId],
    );
    if (dup.rows[0] && !input.stopBeforeSubmit) {
      throw new ApplyError('You already have an application for this job', 409);
    }
  }
  // A pasted link has no job row: the same posting is recognised by its URL (query and hash don't change the job).
  if (!target.jobId && !input.stopBeforeSubmit) {
    const bare = target.url.replace(/[?#].*$/, '').replace(/\/+$/, '');
    const dup = await getPgPool().query(
      `SELECT id, status FROM applications
        WHERE user_id = $1 AND status <> ALL(ARRAY['failed','cancelled'])
          AND regexp_replace(regexp_replace(url, '[?#].*$', ''), '/+$', '') = $2 LIMIT 1`,
      [userId, bare],
    );
    if (dup.rows[0]) {
      throw new ApplyError(
        dup.rows[0].status === 'submitted' || dup.rows[0].status === 'completed'
          ? 'You already applied to this job'
          : 'You already have an application for this job in progress',
        409,
      );
    }
  }
  if (input.checkProfile) {
    const gaps = profileGaps((await profileService.get(userId)).data, { country: target.country }).filter((g) => g.blocking);
    if (gaps.length) throw new ApplyError(`Add a few details first: ${gaps.map((g) => g.label.replace(/\?$/, '')).join(', ')}`, 422);
  }
  // Admin test runs don't count against a user's daily/concurrent limits or credits.
  if (!input.skipLimits) {
    await applicationsService.assertCanStart(userId);
    await creditsService.assertCanAfford(userId);
  }

  const applyUrl = applyUrlFor(target);
  let workflow: ApplyWorkflow | null;
  if (input.workflowId) {
    const { rows } = await getPgPool().query(
      'SELECT id, workflow_key, site_id, name, starter_action_plan FROM site_workflows WHERE id = $1',
      [input.workflowId],
    );
    workflow = rows[0]
      ? { id: rows[0].id, workflowKey: rows[0].workflow_key, siteId: rows[0].site_id, name: rows[0].name, plan: rows[0].starter_action_plan }
      : null;
  } else {
    workflow = await pickApplyWorkflow(applyUrl, target.atsType);
  }
  if (!workflow?.plan?.length) throw new ApplyError('No application workflow is published for this site yet', 422);
  if (input.requireDedicatedWorkflow && workflow.generic) {
    throw new ApplyError('Auto Apply only uses sites with a dedicated workflow', 422);
  }

  const sessionId = input.sessionId ?? `apply-${randomUUID()}`;
  const job: ExecuteJob = {
    id: randomUUID(),
    type: 'execute',
    priority: 'normal',
    createdAt: new Date(),
    userId,
    sessionId,
    payload: {
      siteId: workflow.siteId,
      task: `Apply to ${target.title}${target.company ? ` at ${target.company}` : ''}`,
      workflowKey: workflow.workflowKey ?? undefined,
      actionPlan: workflow.plan,
      sessionId,
      useCache: false,
      maxAttempts: 1,
      stopBeforeSubmit: input.stopBeforeSubmit,
      context: {
        url: target.url,
        applyUrl,
        title: target.title,
        company: target.company ?? '',
        country: target.country ?? '',
      },
    },
    metadata: { planSource: 'structured-workflow', matchedWorkflowId: workflow.id, matchedWorkflowName: workflow.name },
  };

  // Claim the posting before any row or credit exists, so a double click
  // can't leave a second application (or a charge) behind.
  try {
    await acquireTaskLock(job);
  } catch (err) {
    if (err instanceof DuplicateTaskError) throw new ApplyError('This application is already in progress', 409);
    throw err;
  }
  job.metadata = { ...job.metadata, taskLocked: true };

  const application = await applicationsService.create({
    userId,
    title: target.title,
    company: target.company,
    url: target.url,
    jobId: target.jobId,
    execJobId: job.id,
    sessionId,
    source: input.source ?? (input.stopBeforeSubmit ? 'admin_test' : 'manual'),
  });
  if (!input.skipLimits) {
    try {
      await creditsService.reserve(userId, application.id);
    } catch (err) {
      // Lost a race for the last credit — nothing was queued.
      await getPgPool().query('DELETE FROM applications WHERE id = $1', [application.id]).catch(() => {});
      await releaseTaskLock(job).catch(() => {});
      throw err;
    }
  }
  // Runtime state lets the pause relay (chat:pause) find the owner even
  // when no chat session is open — the Applications screen answers instead.
  const redis = await getRedisClient();
  const now = new Date().toISOString();
  await redis.setEx(
    CacheKeys.jobRuntime(job.id),
    86400,
    JSON.stringify({ jobId: job.id, userId, sessionId, siteId: workflow.siteId, task: job.payload.task, status: 'queued', createdAt: now, updatedAt: now }),
  );
  await enqueueJob(job);
  logger.info('apply:started', { userId, applicationId: application.id, workflow: workflow.name, ats: target.atsType });
  return { application, workflow: { id: workflow.id, name: workflow.name }, applyUrl };
}

/**
 * Recovery for background (Auto Apply) runs that died before anything was sent — a slow page, a network blip,
 * a crashed browser. One fresh attempt, never after the run reached the final check (the submit may have gone
 * through) and never for a run that is itself a retry. Returns the new application id.
 */
export async function retryTransient(failedId: string): Promise<string | null> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT user_id, job_id, url, source FROM applications WHERE id = $1 AND status = 'failed' AND source = 'auto'`,
    [failedId],
  );
  const a = rows[0];
  if (!a?.url) return null;
  const blocked = await pool.query(
    `SELECT 1 FROM application_events WHERE application_id = $1 AND phase = ANY(ARRAY['verified','submitted','retry_of']) LIMIT 1`,
    [failedId],
  );
  if (blocked.rows.length) return null;
  try {
    const r = await startApplication(a.user_id as string, {
      jobId: (a.job_id as string | null) ?? undefined,
      url: a.job_id ? undefined : (a.url as string),
      source: 'auto',
      requireDedicatedWorkflow: true,
    });
    await applicationsService.event(r.application.id, 'retry_of', { from: failedId });
    await applicationsService.event(failedId, 'auto_retry', { next: r.application.id });
    logger.info('apply:auto-retry', { failedId, next: r.application.id });
    return r.application.id as string;
  } catch (err) {
    logger.warn('apply:auto-retry-skipped', { failedId, reason: (err as Error).message });
    return null;
  }
}

/** What a paused application is waiting for (question / review), if anything. */
export async function pendingInput(execJobId: string | null): Promise<Record<string, unknown> | null> {
  if (!execJobId) return null;
  const redis = await getRedisClient();
  const raw = await redis.get(`captcha:pending:${execJobId}`);
  if (raw) {
    const p = JSON.parse(raw) as { type?: string; payload?: Record<string, unknown> };
    return { type: p.type ?? 'text', ...(p.payload ?? {}) };
  }
  // Parked: the run is gone, the question/review is kept on the row.
  const { rows } = await getPgPool().query(
    `SELECT resume_state->'pending' AS pending FROM applications WHERE exec_job_id = $1 AND parked_at IS NOT NULL`,
    [execJobId],
  );
  return (rows[0]?.pending as Record<string, unknown> | null) ?? null;
}

// ─── Parking ──────────────────────────────────────────────────
// A run waiting on the user (a question, or the review before submit) keeps
// its browser for `apply.park_after_seconds`, then parks: the row keeps what
// it was waiting for plus the job to re-run, and the browser is released.
// The answer starts a continuation run of the same workflow — autofill is
// deterministic (profile + remembered answers, the new answer included), and
// an approved review is applied verbatim instead of being asked again.

export interface ParkState {
  kind: 'question' | 'review';
  stepId: string;
  /** Exactly what pendingInput() showed while the run was live. */
  pending: Record<string, unknown>;
  question?: string;
  /** One form of several questions (answers come back as JSON keyed by id). */
  questions?: { id: string; question: string }[];
  reviewFields?: { id: string; label: string; value: string }[];
  job: ExecuteJob;
}

/** Called by the worker when a wait times out. Returns the application id, or null if it can't park. */
export async function parkApplication(execJobId: string, state: ParkState): Promise<string | null> {
  const { rows } = await getPgPool().query(
    `UPDATE applications SET parked_at = NOW(), resume_state = $2, updated_at = NOW()
      WHERE exec_job_id = $1 AND parked_at IS NULL AND status = ANY(ARRAY['needs_input','awaiting_review','running'])
      RETURNING id`,
    [execJobId, JSON.stringify(state)],
  );
  if (!rows[0]) return null;
  // A parked review/question must still look like one even if the pause relay lagged.
  await getPgPool().query(
    `UPDATE applications SET status = $2 WHERE id = $1 AND status = 'running'`,
    [rows[0].id, state.kind === 'review' ? 'awaiting_review' : 'needs_input'],
  );
  await applicationsService.event(rows[0].id, 'parked', { waitingFor: state.kind });
  logger.info('apply:parked', { applicationId: rows[0].id, kind: state.kind });
  return rows[0].id;
}

/** The user answered a parked application: queue the continuation run. */
export async function continueParked(applicationId: string, value: string): Promise<boolean> {
  const pool = getPgPool();
  const { rows } = await pool.query('SELECT user_id, resume_state FROM applications WHERE id = $1 AND parked_at IS NOT NULL', [applicationId]);
  if (!rows[0]?.resume_state) return false;
  const userId = rows[0].user_id as string;
  const state = rows[0].resume_state as ParkState;

  let approved: Record<string, string> | undefined;
  if (state.kind === 'review') {
    let msg: { action?: string; values?: Record<string, string> };
    try {
      msg = JSON.parse(value);
    } catch {
      msg = { action: 'approve' };
    }
    if (msg.action && msg.action !== 'approve') {
      await applicationsService.cancel(null, applicationId);
      return true;
    }
    approved = {};
    for (const f of state.reviewFields ?? []) approved[f.label] = msg.values?.[f.id] ?? f.value;
  } else if (state.questions?.length) {
    // Several questions answered together: each is remembered under its own wording.
    try {
      const given = JSON.parse(value) as Record<string, string>;
      for (const q of state.questions) if (given[q.id]?.trim()) {
        await answerMemory.remember(userId, q.question, given[q.id].trim());
        await learnAnswer(userId, q.question, given[q.id].trim()).catch(() => {});
      }
    } catch { /* not JSON: nothing to remember */ }
  } else if (state.question && value.trim()) {
    // Autofill recalls it on the re-run, like any remembered answer.
    await answerMemory.remember(userId, state.question, value.trim());
    await learnAnswer(userId, state.question, value.trim()).catch(() => {});
  }

  const job: ExecuteJob = {
    ...state.job,
    id: randomUUID(),
    createdAt: new Date(),
    payload: { ...state.job.payload, approved },
  };
  const claimed = await pool.query(
    `UPDATE applications SET parked_at = NULL, resume_state = NULL, exec_job_id = $2, status = 'running',
            status_detail = $3, updated_at = NOW()
      WHERE id = $1 AND parked_at IS NOT NULL RETURNING id`,
    [applicationId, job.id, state.kind === 'review' ? 'Submitting' : 'Continuing with your answer'],
  );
  if (!claimed.rows[0]) return false; // someone else already continued it
  await applicationsService.event(applicationId, 'resumed', { after: state.kind });
  const redis = await getRedisClient();
  const now = new Date().toISOString();
  await redis.setEx(
    CacheKeys.jobRuntime(job.id),
    86400,
    JSON.stringify({ jobId: job.id, userId, sessionId: job.payload.sessionId, siteId: job.payload.siteId, task: job.payload.task, status: 'queued', createdAt: now, updatedAt: now }),
  );
  await enqueueJob(job);
  logger.info('apply:continued', { applicationId, kind: state.kind, execJobId: job.id });
  return true;
}

async function isParked(applicationId: string): Promise<boolean> {
  const { rows } = await getPgPool().query('SELECT 1 FROM applications WHERE id = $1 AND parked_at IS NOT NULL', [applicationId]);
  return rows.length > 0;
}

/** Answer a paused application (a question, or approve a review) — live or parked. */
export async function respondToApplication(userId: string | null, id: string, value: string): Promise<boolean> {
  const app = await applicationsService.get(userId, id);
  if (!app?.exec_job_id || !['needs_input', 'awaiting_review'].includes(app.status)) return false;
  if (app.parked_at) return continueParked(app.id, value);

  const redis = await getRedisClient();
  const receivers = await redis.publish(`job:resume:${app.exec_job_id}`, value);
  if (receivers === 0) {
    // Nobody is listening: the run is parking right now. Wait for it, then continue.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isParked(app.id)) return continueParked(app.id, value);
    }
    return false;
  }
  await applicationsService.updateByExecJob(app.exec_job_id, {
    status: 'running',
    detail: app.status === 'awaiting_review' ? 'Submitting' : 'Continuing with your answer',
  });
  return true;
}

/**
 * Resume by execute job id (chat / legacy /jobs/:id/resume). Applications go
 * through respondToApplication so parked ones continue; other runs get the
 * raw value on the resume channel.
 */
export async function resumeExecJob(execJobId: string, value: string): Promise<boolean> {
  const { rows } = await getPgPool().query('SELECT id FROM applications WHERE exec_job_id = $1', [execJobId]);
  if (rows[0]) return respondToApplication(null, rows[0].id, value);
  const redis = await getRedisClient();
  await redis.publish(`job:resume:${execJobId}`, value);
  return true;
}
