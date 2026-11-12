import { getPgPool, getRedisClient, CacheKeys } from '../db/index.js';
import { getNumber } from '../config/settings.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('applications');
import { creditsService } from '../credits/index.js';
import { notificationsService, type NotificationInput } from '../notifications/index.js';

// ============================================================
// APPLICATIONS — one row per thing the user asked us to apply to / submit,
// linked to the execute job running it. Status + an event timeline drive the
// "Your applications" row, Tasks, receipts and the admin views.
// ============================================================

export type ApplicationSource = 'manual' | 'chat' | 'auto' | 'admin_test';

export type ApplicationStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'awaiting_review'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'cancelled';

const OPEN: ApplicationStatus[] = ['queued', 'running', 'needs_input', 'awaiting_review'];
const FINAL: ApplicationStatus[] = ['submitted', 'completed', 'failed', 'cancelled'];

export const FILTERS: Record<string, ApplicationStatus[] | null> = {
  all: null,
  needs: ['needs_input', 'awaiting_review'],
  active: ['queued', 'running'],
  done: ['submitted', 'completed'],
  failed: ['failed', 'cancelled'],
};

/**
 * What really happened to the form, in three honest states (not just done / failed):
 *  confirmed   — the site said it received it
 *  unconfirmed — it was (or may have been) sent but nothing confirmed it: check the inbox before applying again
 *  not_sent    — it never went out
 */
export type SubmissionState = 'confirmed' | 'unconfirmed' | 'not_sent' | 'in_progress';
export const UNCONFIRMED_ERROR = /never confirmed the application|site didn't confirm|may have gone through|stopped while submitting/i;
/** The site itself refused the form — the one failure after the click that proves nothing was accepted. */
const REJECTED_ERROR = /site rejected the form/i;
export function submissionState(app: { status: string; error?: string | null; status_detail?: string | null; submit_attempted_at?: unknown }): SubmissionState {
  // A test run that stopped before the click finishes "completed" but sent nothing.
  if (app.status === 'completed' && /stopped before submit|test run/i.test(app.status_detail ?? '')) return 'not_sent';
  if (app.status === 'submitted' || app.status === 'completed') return 'confirmed';
  if (app.status === 'failed' && app.error && UNCONFIRMED_ERROR.test(app.error)) return 'unconfirmed';
  // Evidence, not the absence of an exception: once the click was made, any other failure (browser died, timeout,
  // lost worker) leaves the outcome unknown until someone checks.
  if ((app.status === 'failed' || app.status === 'cancelled') && app.submit_attempted_at && !REJECTED_ERROR.test(app.error ?? '')) return 'unconfirmed';
  if (app.status === 'failed' || app.status === 'cancelled') return 'not_sent';
  return 'in_progress';
}

/** Marker the engine puts on an error when the posting itself is gone. */
export const JOB_CLOSED = 'JOB_CLOSED:';

/** Browser/engine errors → one sentence a person can act on. */
const FRIENDLY: [RegExp, string][] = [
  [/JOB_CLOSED:/, 'This role has closed on the company site, so there was nothing to apply to. Try another one.'],
  // A page that won't load is the site's fault; a control we waited on is ours (the form changed or has a widget we don't know yet).
  [/page\.goto|Navigation timeout|net::ERR_TIMED_OUT|waiting until "(load|domcontentloaded|networkidle)"/i, "The company's site was too slow to load. Nothing was sent — try again in a moment."],
  [/locator\.|waiting for (locator|selector|getBy)|Timeout \d+ms exceeded/i, "I couldn't operate one of the form's controls (it didn't respond in time). Nothing was sent — it's been logged so the form can be taught."],
  [/timed out/i, 'A step took too long. Nothing was sent — try again in a moment.'],
  [/Invalid Username\/Password/i, "The saved sign-in for this company's portal no longer works. Nothing was sent — reset the portal password in Settings and try again."],
  // Lever shows this stock line (with a 100 MB limit) whenever its upload step fails, even for a one-page résumé; in practice
  // the send was blocked by the site's bot check, so a smaller file is not the fix.
  [/File exceeds the maximum upload size of 100\s*MB/i, "The site refused the send with a file-size message that isn't about your résumé (it's well under the limit) — its bot check most likely blocked it. Nothing was sent. Apply on the company's page yourself, then mark it as applied."],
  [/File exceeds the maximum upload size/i, 'The résumé is larger than this site accepts. Upload a smaller PDF (under 2 MB) in your profile and try again.'],
  [/Circuit breaker open/i, 'This site has been failing repeatedly, so I paused it to protect your account. It will be retried automatically shortly.'],
  [/DATADOME_BLOCK|captcha-delivery/i, 'This site shows a human check before its form that I can\'t pass. Open the page and apply yourself, then mark it as applied.'],
  [/No application form found/i, "I couldn't find an application form on that page — the posting may have moved or need a sign-in. Nothing was sent."],
  [/never confirmed the application/i, "The form was submitted but the site didn't confirm it. Check your email for a confirmation before applying again — I won't resend automatically."],
  [/outside of the viewport|not visible|intercepts pointer|detached from the DOM/i, 'The form changed while I was filling it in. Nothing was sent — try again.'],
  [/net::ERR_|ECONNREFUSED|ENOTFOUND|socket hang up/i, "Couldn't reach the company's site. Nothing was sent — try again shortly."],
  [/Target (page|closed)|browser has been closed|Execution context was destroyed/i, 'The browser session ended unexpectedly. Nothing was sent — try again.'],
  [/captcha/i, "The site asked for a check I couldn't complete. Nothing was sent."],
];

/** Failures where nothing was sent and a fresh attempt is likely to work (not site rejections, not captchas). */
const TRANSIENT = /Timeout \d+ms exceeded|timed out|net::ERR_|ECONNREFUSED|ENOTFOUND|socket hang up|Target (page|closed)|browser has been closed|Execution context was destroyed/i;

/** Browser errors carry ANSI colours and call logs — users get one plain sentence. */
export function readableError(error: string | null | undefined): string | null {
  if (!error) return null;
  const clean = error.replace(/\u001b\[[0-9;]*m/g, '');
  for (const [re, text] of FRIENDLY) if (re.test(clean)) return text;
  const line = clean.split('\n')[0].trim();
  return line.replace(/^locator\.\w+: /, '').slice(0, 300) || null;
}

export class LimitError extends Error {
  statusCode = 429;
}

function label(app: { title: string; company: string | null }): string {
  return app.company ? `${app.title} · ${app.company}` : app.title;
}

/** What the user hears about when an application changes status (push + bell). */
function notificationFor(
  status: ApplicationStatus,
  app: { id: string; title: string; company: string | null; status_detail?: string | null; error?: string | null },
): NotificationInput | null {
  const data = { applicationId: app.id };
  switch (status) {
    case 'needs_input':
      return { kind: 'application.needs_input', title: 'A question needs your answer', body: `${label(app)} — ${app.status_detail ?? 'tap to answer'}`, data };
    case 'awaiting_review':
      return { kind: 'application.awaiting_review', title: 'Ready to submit — review it', body: label(app), data };
    case 'submitted':
      return { kind: 'application.submitted', title: 'Application sent', body: `${label(app)} — the site confirmed it. A PDF summary is in your email and in Applications.`, data };
    case 'failed':
      return { kind: 'application.failed', title: "Couldn't finish an application", body: `${label(app)}${app.error ? ` — ${app.error}` : ''}`, data };
    default:
      return null;
  }
}

/** Side effects of a status change: credits and notifications. Best effort. */
async function afterStatusChange(
  row: { id: string; user_id: string; title: string; company: string | null; status_detail: string | null; error: string | null; prev: string },
  status: ApplicationStatus,
): Promise<void> {
  if (row.prev === status) return;
  if (status === 'submitted' || status === 'completed') await creditsService.settle(row.id, 'commit').catch(() => {});
  if (status === 'failed' || status === 'cancelled') await creditsService.settle(row.id, 'refund').catch(() => {});
  const n = notificationFor(status, row);
  if (n) await notificationsService.notify(row.user_id, n);
}

/** Another live application for the same job already exists (the database refused the second one). */
export class DuplicateApplicationError extends Error {
  constructor() {
    super('You already have an application for this job');
  }
}

export const applicationsService = {
  /** Enforce admin-set limits before starting anything. */
  async assertCanStart(userId: string): Promise<void> {
    const [daily, concurrent] = await Promise.all([
      getNumber('apply.daily_limit_per_user'),
      getNumber('apply.max_concurrent_per_user'),
    ]);
    const { rows } = await getPgPool().query(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS today,
              COUNT(*) FILTER (WHERE status = ANY($2) AND parked_at IS NULL)::int AS open
         FROM applications WHERE user_id = $1`,
      [userId, OPEN],
    );
    if (daily > 0 && rows[0].today >= daily) throw new LimitError(`Daily limit reached (${daily} applications). Try again tomorrow.`);
    // Parked ones (waiting on the user, no browser) don't count as running.
    if (rows[0].open >= concurrent) {
      throw new LimitError(`You already have ${rows[0].open} applications running. Wait for one to finish.`);
    }
  },

  async create(input: {
    userId: string;
    title: string;
    company?: string | null;
    url?: string | null;
    jobId?: string | null;
    execJobId?: string | null;
    sessionId?: string | null;
    source?: ApplicationSource;
    campaignId?: string | null;
  }) {
    const pool = getPgPool();
    let jobId = input.jobId ?? null;
    let company = input.company ?? null;
    if (!jobId && input.url) {
      const { rows } = await pool.query(
        `SELECT j.id, c.name FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.url = $1 LIMIT 1`,
        [input.url],
      );
      jobId = rows[0]?.id ?? null;
      company = company ?? rows[0]?.name ?? null;
    }
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO applications (user_id, job_id, exec_job_id, session_id, title, company, url, source, campaign_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [input.userId, jobId, input.execJobId ?? null, input.sessionId ?? null, input.title.slice(0, 300), company, input.url ?? null, input.source ?? 'manual', input.campaignId ?? null],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && /uq_applications_live_job/.test(String((err as { constraint?: string }).constraint ?? (err as Error).message))) throw new DuplicateApplicationError();
      throw err;
    }
    await this.event(rows[0].id, 'queued');
    return rows[0];
  },

  /**
   * Called right before the submit click is made. Persisted first, so whatever happens next (a crash, a lost
   * worker, a timeout) the application is known to have been at the point of no return.
   */
  async markSubmitAttempt(execJobId: string, detail: { url: string }) {
    const { rows } = await getPgPool().query(
      `UPDATE applications SET submit_attempted_at = COALESCE(submit_attempted_at, NOW()), updated_at = NOW()
        WHERE exec_job_id = $1 RETURNING id`,
      [execJobId],
    );
    if (rows[0]) await this.event(rows[0].id, 'submit_attempt', { url: detail.url.split('?')[0].slice(0, 300) });
  },

  async event(applicationId: string, phase: string, detail: Record<string, unknown> = {}) {
    await getPgPool().query('INSERT INTO application_events (application_id, phase, detail) VALUES ($1,$2,$3)', [
      applicationId,
      phase,
      JSON.stringify(detail),
    ]);
  },

  /** Applications started from a bare link get their real title once the page is open. */
  async nameFromPage(execJobId: string, pageTitle: string) {
    const [title, company] = pageTitle.split(/\s+[-|–—]\s+|\s+at\s+/).map((x) => x.trim()).filter(Boolean);
    if (!title) return;
    await getPgPool().query(
      `UPDATE applications SET title = $2, company = COALESCE(company, $3)
        WHERE exec_job_id = $1 AND title = 'Job application'`,
      [execJobId, title.slice(0, 300), company?.slice(0, 200) ?? null],
    );
  },

  /** Timeline entry for the application an execute job belongs to (pipeline stages). */
  async eventByExecJob(execJobId: string, phase: string, detail: Record<string, unknown> = {}) {
    const { rows } = await getPgPool().query('SELECT id FROM applications WHERE exec_job_id = $1', [execJobId]);
    if (rows[0]) await this.event(rows[0].id, phase, detail);
  },

  /** The live one-liner shown in the island while a run is working. Only touches runs still in motion. */
  async noteByExecJob(execJobId: string, detail: string) {
    await getPgPool().query(
      `UPDATE applications SET status_detail = $2, updated_at = NOW()
        WHERE exec_job_id = $1 AND status IN ('queued','running') AND status_detail IS DISTINCT FROM $2`,
      [execJobId, detail.slice(0, 120)],
    );
  },

  /** Called from worker/relay events, keyed by the execute job id. Final states never go back. */
  async updateByExecJob(
    execJobId: string,
    patch: { status: ApplicationStatus; detail?: string | null; reference?: string | null; error?: string | null },
  ) {
    if (patch.error) logger.warn('application:failed', { execJobId, rawError: String(patch.error).slice(0, 500) });
    // Stopped by the user after the click: the page may already have accepted it.
    if (patch.status === 'cancelled') {
      const t = await getPgPool().query('SELECT 1 FROM applications WHERE exec_job_id = $1 AND submit_attempted_at IS NOT NULL', [execJobId]);
      if (t.rows[0]) patch = { ...patch, detail: 'Cancelled while submitting — it may have gone through, check your inbox' };
    }
    // A failure after the click is not "nothing was sent": say so, whatever the engine's raw error was.
    if (patch.status === 'failed' && patch.error && !UNCONFIRMED_ERROR.test(patch.error) && !REJECTED_ERROR.test(patch.error)) {
      const t = await getPgPool().query('SELECT 1 FROM applications WHERE exec_job_id = $1 AND submit_attempted_at IS NOT NULL', [execJobId]);
      if (t.rows[0]) patch = { ...patch, error: 'The run stopped while submitting. It may have gone through — check your inbox for a confirmation before trying again.' };
    }
    const { rows } = await getPgPool().query(
      `WITH old AS (SELECT id, status FROM applications WHERE exec_job_id = $1 FOR UPDATE)
       UPDATE applications a SET
          status = $2,
          status_detail = $3,
          reference = COALESCE($4, a.reference),
          error = COALESCE($5, a.error),
          updated_at = NOW(),
          finished_at = CASE WHEN $2 = ANY($6) THEN NOW() ELSE a.finished_at END
         FROM old
        WHERE a.id = old.id AND NOT (old.status = ANY($6))
        RETURNING a.id, a.user_id, a.title, a.company, a.status_detail, a.error, a.source, old.status AS prev`,
      [execJobId, patch.status, patch.detail ?? null, patch.reference ?? null, readableError(patch.error), FINAL],
    );
    if (rows[0]) {
      // A posting that is gone shouldn't keep showing up in anyone's matches.
      if (patch.error?.includes(JOB_CLOSED)) {
        await getPgPool()
          .query(`UPDATE jobs SET status = 'closed' WHERE id = (SELECT job_id FROM applications WHERE id = $1)`, [rows[0].id])
          .catch(() => {});
      }
      await this.event(rows[0].id, patch.status, { detail: patch.detail ?? undefined, error: readableError(patch.error) ?? undefined });
      await afterStatusChange(rows[0], patch.status);
      // Background runs nobody is watching get one fresh attempt after a transient failure (nothing was sent).
      if (patch.status === 'failed' && rows[0].source === 'auto' && TRANSIENT.test(String(patch.error ?? ''))) {
        const failedId = rows[0].id as string;
        setTimeout(() => {
          void import('./apply.js').then((m) => m.retryTransient(failedId)).catch(() => {});
        }, 90_000).unref?.();
      }
    }
    return rows[0]?.id ?? null;
  },

  async list(userId: string, filter = 'all', limit = 50, offset = 0) {
    const statuses = FILTERS[filter] ?? null;
    const { rows } = await getPgPool().query(
      `SELECT a.id, a.title, a.company, a.url, a.status, a.status_detail, a.reference, a.error, a.source, a.outcome,
              a.job_id, a.exec_job_id, a.session_id, a.created_at, a.updated_at, a.finished_at, a.submit_attempted_at
         FROM applications a
        WHERE a.user_id = $1 AND ($2::text[] IS NULL OR a.status = ANY($2))
        ORDER BY a.updated_at DESC LIMIT $3 OFFSET $4`,
      [userId, statuses, Math.min(limit, 200), offset],
    );
    return rows.map((r) => ({ ...r, submission: submissionState(r) }));
  },

  async counts(userId: string) {
    const { rows } = await getPgPool().query(
      `SELECT COUNT(*)::int AS all,
              COUNT(*) FILTER (WHERE status IN ('needs_input','awaiting_review'))::int AS needs,
              COUNT(*) FILTER (WHERE status IN ('queued','running'))::int AS active,
              COUNT(*) FILTER (WHERE status IN ('submitted','completed'))::int AS done,
              COUNT(*) FILTER (WHERE status IN ('failed','cancelled'))::int AS failed
         FROM applications WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  },

  async get(userId: string | null, id: string) {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT * FROM applications WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)`,
      [id, userId],
    );
    if (!rows[0]) return null;
    const events = await pool.query(
      'SELECT phase, detail, at FROM application_events WHERE application_id = $1 ORDER BY at',
      [id],
    );
    // resume_state carries the run's internal plan — admins only.
    const { resume_state, ...app } = rows[0];
    // What the run cost in model calls, by purpose — admins only (users see credits, not our spend).
    let usage: { calls: number; tokens: number; costUsd: number; byPurpose: Record<string, number> } | undefined;
    if (userId === null && app.exec_job_id) {
      const u = await pool.query(
        `SELECT purpose, COUNT(*)::int AS calls, COALESCE(SUM(prompt_tokens + completion_tokens), 0)::int AS tokens, COALESCE(SUM(cost_usd), 0)::float AS cost
           FROM llm_usage WHERE job_id = $1 GROUP BY purpose`,
        [app.exec_job_id],
      );
      usage = {
        calls: u.rows.reduce((n, r) => n + r.calls, 0),
        tokens: u.rows.reduce((n, r) => n + r.tokens, 0),
        costUsd: Math.round(u.rows.reduce((n, r) => n + r.cost, 0) * 1e6) / 1e6,
        byPurpose: Object.fromEntries(u.rows.map((r) => [r.purpose, r.cost])),
      };
    }
    return { ...app, submission: submissionState(app), ...(usage ? { usage } : {}), ...(userId === null ? { resume_state } : {}), events: events.rows };
  },

  async cancel(userId: string | null, id: string) {
    const app = await this.get(userId, id);
    if (!app) return null;
    if (FINAL.includes(app.status)) return app;
    if (app.exec_job_id) {
      const redis = await getRedisClient();
      await redis.setEx(CacheKeys.jobCancel(app.exec_job_id), 86400, '1');
      await redis.publish(`job:cancel:${app.exec_job_id}`, 'cancel');
    }
    if (app.parked_at && app.exec_job_id) {
      const redis = await getRedisClient();
      await redis.del(`captcha:pending:${app.exec_job_id}`).catch(() => {});
    }
    await getPgPool().query(
      `UPDATE applications SET status = 'cancelled',
              status_detail = CASE WHEN submit_attempted_at IS NOT NULL THEN 'Cancelled while submitting — it may have gone through, check your inbox' ELSE 'Cancelled — nothing was sent' END,
              parked_at = NULL,
              resume_state = NULL, updated_at = NOW(), finished_at = NOW() WHERE id = $1`,
      [id],
    );
    await this.event(id, 'cancelled');
    await creditsService.settle(id, 'refund').catch(() => {});
    return this.get(userId, id);
  },

  /**
   * "I'll finish it myself": the person completes (or drops) an application the engine
   * couldn't — a captcha it can't solve, a portal that wants a sign-in. 'applied' records it as
   * submitted by them (nothing is charged: the engine sent nothing), 'skip' closes it for good.
   */
  async resolveManually(userId: string, id: string, action: 'applied' | 'skip') {
    const app = await this.get(userId, id);
    if (!app) return null;
    if (app.status === 'submitted' || app.status === 'completed') return app;
    if (OPEN.includes(app.status)) await this.cancel(userId, id); // stops the run, frees its lock, refunds
    const applied = action === 'applied';
    await getPgPool().query(
      `UPDATE applications SET status = $2, status_detail = $3, error = NULL, parked_at = NULL, resume_state = NULL,
              updated_at = NOW(), finished_at = COALESCE(finished_at, NOW())
        WHERE id = $1`,
      [id, applied ? 'submitted' : 'cancelled', applied ? 'You applied on the company site' : 'Skipped — nothing was sent'],
    );
    await this.event(id, applied ? 'manual_applied' : 'manual_skipped');
    await creditsService.settle(id, 'refund').catch(() => {});
    return this.get(userId, id);
  },

  /**
   * Applications still "open" whose run is gone (worker restarted/crashed,
   * job finished without reporting). Marks them failed so the user can retry
   * instead of waiting forever. Returns how many were closed.
   */
  async reconcileOrphans(olderThanMinutes = 10): Promise<number> {
    const { getQueue } = await import('../queue/index.js');
    const queue = getQueue('execute');
    // Parked ones have no run on purpose — they only close when nobody answers for days.
    const expiryDays = await getNumber('apply.park_expiry_days');
    const expired = await getPgPool().query(
      `SELECT exec_job_id FROM applications
        WHERE parked_at IS NOT NULL AND status = ANY($1) AND parked_at < NOW() - ($2 || ' days')::interval
        LIMIT 200`,
      [OPEN, String(expiryDays)],
    );
    let closed = 0;
    for (const r of expired.rows) {
      await getPgPool().query('UPDATE applications SET parked_at = NULL, resume_state = NULL WHERE exec_job_id = $1', [r.exec_job_id]);
      await this.updateByExecJob(r.exec_job_id, {
        status: 'failed',
        detail: 'Expired',
        error: `Nobody answered for ${expiryDays} days, so it was closed. Nothing was sent — you can try again.`,
      });
      closed++;
    }

    const { rows } = await getPgPool().query(
      `SELECT id, exec_job_id FROM applications
        WHERE status = ANY($1) AND exec_job_id IS NOT NULL AND parked_at IS NULL
          AND updated_at < NOW() - ($2 || ' minutes')::interval
        LIMIT 200`,
      [OPEN, String(olderThanMinutes)],
    );
    for (const r of rows) {
      const job = await queue.getJob(r.exec_job_id);
      const state = job ? await job.getState() : 'missing';
      if (['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) continue;
      // Past the final check, the submit click may already have gone through.
      const reachedSubmit = await getPgPool().query(
        `SELECT 1 FROM applications WHERE id = $1 AND submit_attempted_at IS NOT NULL
         UNION ALL SELECT 1 FROM application_events WHERE application_id = $1 AND phase = 'verified' LIMIT 1`,
        [r.id],
      );
      await this.updateByExecJob(r.exec_job_id, {
        status: 'failed',
        detail: 'Interrupted',
        error: reachedSubmit.rows.length
          ? 'The run stopped while submitting. It may have gone through — check your inbox for a confirmation before trying again.'
          : 'The run stopped unexpectedly before submitting. Nothing was sent — you can try again.',
      });
      closed++;
    }
    return closed;
  },

  /** Owner check for job-level actions (resume/cancel by execute job id). */
  async ownsExecJob(userId: string, execJobId: string): Promise<boolean> {
    const { rows } = await getPgPool().query('SELECT 1 FROM applications WHERE exec_job_id = $1 AND user_id = $2', [
      execJobId,
      userId,
    ]);
    return rows.length > 0;
  },
};
