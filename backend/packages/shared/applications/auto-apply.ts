import { supportsRecordedJob } from './workflow-support.js';
import { getPgPool, getRedisClient } from '../db/index.js';
import { getBool, getNumber } from '../config/settings.js';
import { profileService } from '../profile/index.js';
import { profileGaps } from '../profile/gaps.js';
import { recommendJobs } from '../jobs/matcher.js';
import { creditsService, InsufficientCreditsError } from '../credits/index.js';
import { notificationsService } from '../notifications/index.js';
import { createLogger } from '../logger/index.js';
import { ApplyError, startApplication } from './apply.js';
import { LimitError } from './index.js';
import { campaignsService, type Campaign } from './campaigns.js';

// ============================================================
// AUTO APPLY — applies to the user's best new matches on a schedule.
// Per user: on/off, daily cap, minimum match score, excluded companies.
// A run takes the top matches above the score, on applicant systems with a
// dedicated workflow (never the generic form filler), as many as the daily
// cap, free run slots, credits and the user's daily limit allow. The user's
// "review before submit" setting still applies: those runs wait for approval.
// ============================================================

const logger = createLogger('auto-apply');
const OPEN = ['queued', 'running', 'needs_input', 'awaiting_review'];

export interface AutoApplySettings {
  enabled: boolean;
  dailyCap: number;
  minScore: number;
  excludeCompanies: string[];
  /** Send without a review when nothing was guessed; otherwise the application waits for the person. */
  autoSubmit: boolean;
  lastRunAt: string | null;
}

export type RunTrigger = 'schedule' | 'manual' | 'admin';

export interface AutoApplyPlan {
  /** Why nothing can start right now (empty when it can). */
  blockers: string[];
  /** How many it may start now, and the parts of that number. */
  capacity: { now: number; leftToday: number; freeSlots: number; affordable: number | null; dailyLimitLeft: number };
  candidates: { jobId: string; title: string; company: string; score: number; atsType: string }[];
  /** Matches the guard rules held back, so the screen can say why a good match isn't being applied to. */
  /** The "apply to N" campaign this plan serves; it replaces the daily cap while it is active. */
  campaign?: Campaign;
  guards?: { companyCooldown: number; repeatedFailures: number; unhealthySystem: string[] };
}

const toSettings = (r: Record<string, unknown> | undefined): AutoApplySettings => ({
  enabled: (r?.enabled as boolean) ?? false,
  dailyCap: (r?.daily_cap as number) ?? 10,
  minScore: (r?.min_score as number) ?? 75,
  excludeCompanies: (r?.exclude_companies as string[]) ?? [],
  autoSubmit: (r?.auto_submit as boolean) ?? true,
  lastRunAt: r?.last_run_at ? new Date(r.last_run_at as string).toISOString() : null,
});

/** Applicant systems with their own published apply workflow. */
async function dedicatedWorkflows(): Promise<Array<{ ats: string; patterns: string[] }>> {
  const { rows } = await getPgPool().query(
    `SELECT metadata->>'atsType' AS ats, page_url_patterns AS patterns FROM site_workflows
      WHERE status = 'published' AND is_active AND metadata->>'kind' = 'job-apply'
        AND metadata->>'atsType' IS NOT NULL AND metadata->>'atsType' <> 'generic'`,
  );
  return rows;
}

// ─── Guard rules ──────────────────────────────────────────────
// Protect the user's name, credits and the platform's reputation with employers:
//  • one live/sent application per company per cooldown (no spamming a recruiter's inbox),
//  • a job that failed twice is not retried by the bot (a person must look at it),
//  • an applicant system failing for everyone is paused until it recovers.
const COMPANY_COOLDOWN_DAYS = 30;
const MAX_FAILED_PER_JOB = 2;
const ATS_MIN_SAMPLE = 5;
const ATS_MAX_FAIL_RATE = 0.8;

interface Guards {
  busyCompanies: Set<string>;
  failedJobs: Set<string>;
  unhealthyAts: Set<string>;
}

const HUMAN_CHECK_ATS = new Set(['smartrecruiters']);

async function loadGuards(userId: string): Promise<Guards> {
  const pool = getPgPool();
  const [busy, failed, ats] = await Promise.all([
    pool.query(
      `SELECT DISTINCT lower(company) AS c FROM applications
        WHERE user_id = $1 AND company IS NOT NULL AND status <> ALL(ARRAY['failed','cancelled'])
          AND created_at > NOW() - ($2 || ' days')::interval`,
      [userId, String(COMPANY_COOLDOWN_DAYS)],
    ),
    pool.query(
      `SELECT job_id::text AS id FROM applications
        WHERE user_id = $1 AND job_id IS NOT NULL AND status = 'failed'
        GROUP BY job_id HAVING COUNT(*) >= $2`,
      [userId, MAX_FAILED_PER_JOB],
    ),
    pool.query(
      `SELECT b.ats_type AS ats,
              COUNT(*) FILTER (WHERE a.status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE a.status IN ('submitted','completed'))::int AS ok
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN job_boards b ON b.id = j.board_id
        WHERE a.created_at > NOW() - INTERVAL '48 hours'
        GROUP BY b.ats_type`,
    ),
  ]);
  return {
    busyCompanies: new Set(busy.rows.map((r) => r.c as string)),
    failedJobs: new Set(failed.rows.map((r) => r.id as string)),
    unhealthyAts: new Set(
      ats.rows
        .filter((r) => r.failed + r.ok >= ATS_MIN_SAMPLE && r.failed / (r.failed + r.ok) >= ATS_MAX_FAIL_RATE)
        .map((r) => r.ats as string),
    ),
  };
}

export const autoApplyService = {
  async get(userId: string): Promise<AutoApplySettings> {
    const { rows } = await getPgPool().query('SELECT * FROM auto_apply_settings WHERE user_id = $1', [userId]);
    return toSettings(rows[0]);
  },

  /** Validated update; the cap and score are clamped to the admin limits. */
  async update(userId: string, patch: Partial<Pick<AutoApplySettings, 'enabled' | 'dailyCap' | 'minScore' | 'excludeCompanies' | 'autoSubmit'>>) {
    const [maxCap, floor] = await Promise.all([getNumber('autoapply.max_daily_cap'), getNumber('autoapply.min_score_floor')]);
    const cur = await this.get(userId);
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      autoSubmit: typeof patch.autoSubmit === 'boolean' ? patch.autoSubmit : cur.autoSubmit,
      dailyCap: Math.min(Math.max(Math.round(Number(patch.dailyCap ?? cur.dailyCap)) || 1, 1), maxCap),
      minScore: Math.min(Math.max(Math.round(Number(patch.minScore ?? cur.minScore)) || floor, floor), 100),
      excludeCompanies: Array.isArray(patch.excludeCompanies)
        ? [...new Set(patch.excludeCompanies.map((c) => String(c).trim()).filter(Boolean))].slice(0, 100)
        : cur.excludeCompanies,
    };
    await getPgPool().query(
      `INSERT INTO auto_apply_settings (user_id, enabled, daily_cap, min_score, exclude_companies, auto_submit, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id) DO UPDATE SET enabled = $2, daily_cap = $3, min_score = $4, exclude_companies = $5, auto_submit = $6, updated_at = NOW()`,
      [userId, next.enabled, next.dailyCap, next.minScore, next.excludeCompanies, next.autoSubmit],
    );
    return this.get(userId);
  },

  /** What a run would do right now — also the "could already be applying to N jobs" preview. */
  async plan(userId: string, settings?: AutoApplySettings): Promise<AutoApplyPlan> {
    const base = settings ?? (await this.get(userId));
    const campaign = await campaignsService.active(userId);
    // A campaign has its own score floor and its own quota: the number still to fill, not a daily cap.
    const s = campaign ? { ...base, minScore: campaign.minScore } : base;
    const pool = getPgPool();
    const blockers: string[] = [];
    const [profile, globalOn, maxConcurrent, dailyLimit, creditsOn, cost] = await Promise.all([
      profileService.get(userId),
      getBool('autoapply.enabled'),
      getNumber('apply.max_concurrent_per_user'),
      getNumber('apply.daily_limit_per_user'),
      creditsService.enabled(),
      getNumber('credits.cost_per_application'),
    ]);
    if (!globalOn) blockers.push('Auto Apply is paused for everyone right now');
    if (profile.onboardingStatus === 'pending') blockers.push('Finish setting up your profile first');
    if (!profile.data.documents?.resumeFileId) blockers.push('Upload your resume first');
    if (!profile.data.preferences?.roles?.length) blockers.push('Add the roles you want');
    // Forms refuse to submit without these, and a background run has nobody to ask.
    const missingFacts = profileGaps(profile.data).filter((g) => g.blocking);
    if (missingFacts.length) blockers.push(`Add to your profile before Auto Apply can start: ${missingFacts.map((g) => g.label).join(', ')}`);

    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE source = 'auto' AND created_at > date_trunc('day', NOW()))::int AS auto_today,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS all_today,
              COUNT(*) FILTER (WHERE status = ANY($2) AND parked_at IS NULL)::int AS running
         FROM applications WHERE user_id = $1`,
      [userId, OPEN],
    );
    const leftToday = campaign ? campaign.remaining : Math.max(0, s.dailyCap - rows[0].auto_today);
    const freeSlots = Math.max(0, maxConcurrent - rows[0].running);
    const dailyLimitLeft = dailyLimit > 0 ? Math.max(0, dailyLimit - rows[0].all_today) : Number.POSITIVE_INFINITY;
    const affordable = creditsOn && cost > 0 ? Math.floor((await creditsService.balance(userId)) / cost) : null;
    if (leftToday === 0) blockers.push(campaign ? 'Every place in your campaign is taken by an application that is running or already sent' : `Today's Auto Apply cap (${s.dailyCap}) is used up`);
    if (affordable === 0) blockers.push('Out of credits');
    const now = Math.min(leftToday, freeSlots, dailyLimitLeft, affordable ?? Number.POSITIVE_INFINITY);

    // SmartRecruiters puts a human check (DataDome) in front of its form: it needs a person, never the background bot.
    const supported = await dedicatedWorkflows();
    const excluded = new Set(s.excludeCompanies.map((c) => c.toLowerCase()));
    const recs = await recommendJobs(userId, profile.data, 100);
    const guards = await loadGuards(userId);
    const held = { companyCooldown: 0, repeatedFailures: 0, unhealthySystem: [] as string[] };
    const candidates = recs
      .filter((r) => r.score >= s.minScore && !HUMAN_CHECK_ATS.has(r.job.ats_type) && supportsRecordedJob(r.job.url, r.job.ats_type, supported) && !excluded.has((r.job.company ?? '').toLowerCase()))
      .filter((r) => {
        if (guards.failedJobs.has(r.job.id)) { held.repeatedFailures++; return false; }
        if (guards.unhealthyAts.has(r.job.ats_type)) {
          if (!held.unhealthySystem.includes(r.job.ats_type)) held.unhealthySystem.push(r.job.ats_type);
          return false;
        }
        if (guards.busyCompanies.has((r.job.company ?? '').toLowerCase())) { held.companyCooldown++; return false; }
        return true;
      })
      .map((r) => ({ jobId: r.job.id, title: r.job.title, company: r.job.company, score: r.score, atsType: r.job.ats_type }));
    if (!candidates.length) {
      const why = [
        held.companyCooldown ? `${held.companyCooldown} at companies you already applied to in the last ${COMPANY_COOLDOWN_DAYS} days` : '',
        held.repeatedFailures ? `${held.repeatedFailures} that failed twice already` : '',
        held.unhealthySystem.length ? `${held.unhealthySystem.join(', ')} is failing for everyone right now (paused)` : '',
      ].filter(Boolean);
      blockers.push(`No new matches at ${s.minScore}% or above${why.length ? ` — held back: ${why.join('; ')}` : ''}`);
    }

    return {
      campaign: campaign ?? undefined,
      guards: held,
      blockers,
      capacity: { now: blockers.length ? 0 : now, leftToday, freeSlots, affordable, dailyLimitLeft: Number.isFinite(dailyLimitLeft) ? dailyLimitLeft : -1 },
      candidates,
    };
  },

  /** One run for one user. Never throws; the outcome is the run row. */
  async runForUser(userId: string, trigger: RunTrigger) {
    const pool = getPgPool();
    const redis = await getRedisClient();
    // One run per user at a time, across scheduler/API/admin processes.
    const lock = `autoapply:lock:${userId}`;
    if ((await redis.set(lock, '1', { NX: true, EX: 600 })) !== 'OK') return null;
    const { rows } = await pool.query(
      `INSERT INTO auto_apply_runs (user_id, trigger) VALUES ($1,$2) RETURNING id`,
      [userId, trigger],
    );
    const runId = rows[0].id as string;
    const started: string[] = [];
    let considered = 0;
    let note: string | null = null;
    let status: 'done' | 'skipped' | 'failed' = 'done';
    let campaignEnd: string | null = null;
    try {
      const settings = await this.get(userId);
      const plan = await this.plan(userId, settings);
      considered = plan.candidates.length;
      if (plan.blockers.length) {
        status = 'skipped';
        note = plan.blockers.join('; ');
        // Only "no more matches" ends a campaign short; a cap, credits or setup gap is temporary.
        if (plan.campaign && plan.blockers.length === 1) {
          if (!plan.candidates.length && /^No new matches/.test(plan.blockers[0])) campaignEnd = plan.blockers[0];
          else if (plan.campaign.remaining === 0) campaignEnd = `${plan.campaign.progress.unconfirmed} application(s) may have been sent but were never confirmed — check your email`;
        }
      } else {
        const companiesThisRun = new Set<string>();
        for (const c of plan.candidates) {
          if (started.length >= plan.capacity.now) break;
          // One application per company per run: a second role there waits for the next cooldown.
          const co = (c.company ?? '').toLowerCase();
          if (co && companiesThisRun.has(co)) continue;
          try {
            const r = await startApplication(userId, { jobId: c.jobId, source: 'auto', requireDedicatedWorkflow: true, autoSubmit: settings.autoSubmit, campaignId: plan.campaign?.id });
            started.push(r.application.id);
            if (co) companiesThisRun.add(co);
          } catch (err) {
            // Already applied / no workflow: next job. Limits or credits: stop here.
            if (err instanceof ApplyError) continue;
            if (err instanceof LimitError || err instanceof InsufficientCreditsError) {
              note = err.message;
              break;
            }
            throw err;
          }
        }
        if (!started.length && !note) note = 'Nothing new to apply to';
      }
    } catch (err) {
      status = 'failed';
      note = (err as Error).message.slice(0, 300);
      logger.error('auto-apply:run-failed', err, { userId, runId });
    } finally {
      await pool.query(
        `UPDATE auto_apply_runs SET status = $2, considered = $3, started = $4, application_ids = $5, note = $6, finished_at = NOW()
          WHERE id = $1`,
        [runId, status, considered, started.length, started, note],
      );
      await pool.query(
        `INSERT INTO auto_apply_settings (user_id, last_run_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_run_at = NOW()`,
        [userId],
      );
      await campaignsService.settle(userId, campaignEnd).catch((err) => logger.error('auto-apply:campaign-settle-failed', err, { userId, runId }));
      await redis.del(lock).catch(() => {});
    }
    if (started.length) {
      await notificationsService.notify(userId, {
        kind: 'auto_apply.run',
        title: `Auto Apply started ${started.length} application${started.length === 1 ? '' : 's'}`,
        body: 'Your best new matches — check the ones waiting for your review.',
        data: { runId },
      });
    }
    logger.info('auto-apply:run', { userId, trigger, status, considered, started: started.length });
    return this.run(runId);
  },

  /** Scheduler tick: every enabled user whose last run is older than the interval. */
  async runDue(): Promise<number> {
    if (!(await getBool('autoapply.enabled'))) return 0;
    const [interval, batch] = await Promise.all([getNumber('autoapply.interval_minutes'), getNumber('autoapply.users_per_tick')]);
    const { rows } = await getPgPool().query(
      `SELECT u.id::text AS user_id FROM users u
         LEFT JOIN auto_apply_settings s ON s.user_id = u.id::text
        WHERE u.suspended_at IS NULL
          AND (s.enabled OR EXISTS (SELECT 1 FROM campaigns c WHERE c.user_id = u.id::text AND c.status = 'active'))
          AND (s.last_run_at IS NULL OR s.last_run_at < NOW() - ($1 || ' minutes')::interval)
        ORDER BY s.last_run_at NULLS FIRST LIMIT $2`,
      [String(interval), batch],
    );
    for (const r of rows) await this.runForUser(r.user_id, 'schedule');
    return rows.length;
  },

  async run(runId: string) {
    const { rows } = await getPgPool().query('SELECT * FROM auto_apply_runs WHERE id = $1', [runId]);
    return rows[0] ?? null;
  },

  async runs(userId: string | null, limit = 20) {
    const { rows } = await getPgPool().query(
      `SELECT r.*, u.email AS user_email FROM auto_apply_runs r LEFT JOIN users u ON u.id::text = r.user_id
        WHERE ($1::text IS NULL OR r.user_id = $1) ORDER BY r.started_at DESC LIMIT $2`,
      [userId, Math.min(limit, 200)],
    );
    return rows;
  },

  /** Admin overview: who has it on, today's numbers. */
  async overview() {
    const { rows } = await getPgPool().query(
      `SELECT s.user_id, u.email, s.enabled, s.daily_cap, s.min_score, s.last_run_at,
              (SELECT COUNT(*)::int FROM applications a WHERE a.user_id = s.user_id AND a.source = 'auto'
                  AND a.created_at > date_trunc('day', NOW())) AS started_today
         FROM auto_apply_settings s LEFT JOIN users u ON u.id::text = s.user_id
        ORDER BY s.enabled DESC, s.last_run_at DESC NULLS LAST LIMIT 500`,
    );
    return rows;
  },
};
