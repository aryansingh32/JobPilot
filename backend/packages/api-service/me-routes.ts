import { randomUUID, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import { enqueueJob } from '../shared/queue/index.js';
import { profileService, answerMemory, type ProfileData } from '../shared/profile/index.js';
import { recommendJobs, jobPulse, type JobPulse, searchJobs, getJob, scoreJob, toListing, type JobRow } from '../shared/jobs/matcher.js';
import { applicationsService, LimitError } from '../shared/applications/index.js';
import { ApplyError, pendingInput, respondToApplication, startApplication } from '../shared/applications/apply.js';
import { inboxService } from '../shared/inbox/index.js';
import { gmailService } from '../shared/gmail/index.js';
import { portalPassword, passwordProblem } from '../shared/profile/portal-password.js';
import { profileGaps, gapPatch } from '../shared/profile/gaps.js';
import { getBool, getNumber } from '../shared/config/settings.js';
import { creditsService, InsufficientCreditsError } from '../shared/credits/index.js';
import { notificationsService } from '../shared/notifications/index.js';
import { accountsService } from '../shared/accounts/index.js';
import { autoApplyService } from '../shared/applications/auto-apply.js';
import { getRedisClient } from '../shared/db/index.js';
import type { ParseResumeJob } from '../shared/types/index.js';
import { fileStorageService } from './file-storage.service.js';
import { userAccountService } from './user-account.service.js';
import { requireUser, revokeSessions } from './auth-routes.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// USER API (Tsenta-style) — profile, resume, jobs feed, applications, inbox.
// Every route is scoped to the signed-in user; nothing trusts a client id.
// ============================================================

const logger = createLogger('me-routes');
type Authed = FastifyRequest & { userId: string };
const uid = (req: FastifyRequest) => (req as Authed).userId;

const RESUME_TYPES = /\.(pdf|docx|txt|md)$/i;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export function registerMeRoutes(app: FastifyInstance, apiKeyAuth: preHandlerHookHandler): void {
  const auth = { preHandler: [apiKeyAuth, requireUser as preHandlerHookHandler] };

  // ── Bootstrap ───────────────────────────────────────────
  app.get('/me', auth, async (req) => {
    const userId = uid(req);
    const [user, profile, counts, unread, inbox, credits, notifications] = await Promise.all([
      userAccountService.findById(userId),
      profileService.get(userId),
      applicationsService.counts(userId),
      inboxService.unreadCount(userId),
      inboxService.getAddress(userId),
      creditsBlock(userId),
      notificationsService.unreadCount(userId),
    ]);
    return {
      user,
      profile: {
        completeness: profile.completeness,
        onboardingStatus: profile.onboardingStatus,
        fullName: profile.data.personal?.fullName ?? user?.displayName ?? null,
        hasResume: !!profile.data.documents?.resumeFileId,
      },
      applications: counts,
      inbox: { address: inbox, unread },
      credits,
      notifications: { unread: notifications },
    };
  });

  // ── Credits ─────────────────────────────────────────────
  app.get('/me/credits', auth, async (req) => {
    const userId = uid(req);
    const [block, ledger] = await Promise.all([creditsBlock(userId), creditsService.ledger(userId, 100)]);
    return { ...block, ledger };
  });

  // ── Auto Apply ──────────────────────────────────────────
  app.get('/me/auto-apply', auth, async (req) => {
    const userId = uid(req);
    const [settings, runs] = await Promise.all([autoApplyService.get(userId), autoApplyService.runs(userId, 1)]);
    return { settings, lastRun: runs[0] ?? null };
  });
  app.put('/me/auto-apply', auth, async (req, reply) => {
    const b = (req.body ?? {}) as { enabled?: unknown; dailyCap?: unknown; minScore?: unknown; excludeCompanies?: unknown };
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be true or false' });
    if (b.excludeCompanies !== undefined && !Array.isArray(b.excludeCompanies)) return reply.status(400).send({ error: 'excludeCompanies must be a list' });
    return {
      settings: await autoApplyService.update(uid(req), {
        enabled: b.enabled as boolean | undefined,
        dailyCap: b.dailyCap as number | undefined,
        minScore: b.minScore as number | undefined,
        excludeCompanies: b.excludeCompanies as string[] | undefined,
      }),
    };
  });
  // What it would apply to right now (and why it can't, if it can't).
  app.get('/me/auto-apply/preview', auth, async (req) => {
    const plan = await autoApplyService.plan(uid(req));
    return { ...plan, candidates: plan.candidates.slice(0, 20), total: plan.candidates.length };
  });
  app.post('/me/auto-apply/run', auth, async (req, reply) => {
    const userId = uid(req);
    // "Run now" at most every 5 minutes per user.
    const redis = await getRedisClient();
    if ((await redis.set(`autoapply:manual:${userId}`, '1', { NX: true, EX: 300 })) !== 'OK') {
      return reply.status(429).send({ error: 'Auto Apply just ran — try again in a few minutes' });
    }
    const run = await autoApplyService.runForUser(userId, 'manual');
    return run ?? reply.status(409).send({ error: 'Auto Apply is already running' });
  });
  app.get('/me/auto-apply/runs', auth, async (req) => ({ runs: await autoApplyService.runs(uid(req), 30) }));

  // ── Notifications (bell + push) ─────────────────────────
  app.get('/me/notifications', auth, async (req) => {
    const userId = uid(req);
    const [notifications, unread] = await Promise.all([notificationsService.list(userId), notificationsService.unreadCount(userId)]);
    return { notifications, unread };
  });
  app.post('/me/notifications/read', auth, async (req) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    const marked = await notificationsService.markRead(uid(req), Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : undefined);
    return { marked };
  });
  // The phone's FCM token, sent by the app after sign-in (and whenever it rotates).
  app.post('/me/devices', auth, async (req, reply) => {
    const { token, platform = 'android', appVersion } = (req.body ?? {}) as { token?: string; platform?: string; appVersion?: string };
    if (!token || typeof token !== 'string' || token.length > 4096) return reply.status(400).send({ error: 'token is required' });
    if (!['android', 'ios', 'web'].includes(platform)) return reply.status(400).send({ error: 'platform must be android, ios or web' });
    await notificationsService.registerDevice(uid(req), token, platform, typeof appVersion === 'string' ? appVersion.slice(0, 40) : undefined);
    return { ok: true };
  });
  // Sign-out on the phone: stop pushing to it.
  app.post('/me/devices/remove', auth, async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (!token) return reply.status(400).send({ error: 'token is required' });
    return { removed: await notificationsService.unregisterDevice(uid(req), token) };
  });

  // ── Account: export + delete (app-store requirements) ───
  app.get('/me/export', auth, async (req, reply) => {
    const data = await accountsService.exportData(uid(req));
    reply.header('Content-Disposition', `attachment; filename="jobpilot-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });
  app.delete('/me', auth, async (req) => {
    const userId = uid(req);
    await revokeSessions(userId);
    const { files } = await accountsService.deleteAccount(userId);
    logger.info('account:deleted', { userId, files });
    return { deleted: true };
  });

  // ── Profile ─────────────────────────────────────────────
  app.get('/me/profile', auth, async (req) => profileService.get(uid(req)));

  app.put('/me/profile', auth, async (req, reply) => {
    const patch = req.body as ProfileData;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return reply.status(400).send({ error: 'Profile object required' });
    return profileService.patch(uid(req), patch);
  });

  app.get('/me/profile/versions', auth, async (req) => ({ versions: await profileService.versions(uid(req)) }));

  app.post('/me/onboarding', auth, async (req, reply) => {
    const { status } = (req.body ?? {}) as { status?: string };
    if (status !== 'done' && status !== 'skipped' && status !== 'pending') {
      return reply.status(400).send({ error: 'status must be done, skipped or pending' });
    }
    const profile = await profileService.setOnboarding(uid(req), status);
    // Every onboarded user gets a private application inbox.
    if (status === 'done' || status === 'skipped') await inboxService.ensureAddress(uid(req), profile.data.personal?.fullName).catch(() => {});
    return profile;
  });

  // ── Resume ──────────────────────────────────────────────
  app.post('/me/resume', auth, async (req, reply) => {
    const userId = uid(req);
    const { originalName, mimeType, base64Data } = (req.body ?? {}) as {
      originalName?: string;
      mimeType?: string;
      base64Data?: string;
    };
    if (!originalName || !base64Data) return reply.status(400).send({ error: 'originalName and base64Data are required' });
    if (!RESUME_TYPES.test(originalName)) return reply.status(400).send({ error: 'Upload a PDF, DOCX or TXT file' });
    if (Buffer.byteLength(base64Data, 'base64') > MAX_RESUME_BYTES) return reply.status(413).send({ error: 'Resume must be under 10 MB' });

    const file = await fileStorageService.uploadBase64({
      userId,
      originalName,
      mimeType: mimeType || 'application/octet-stream',
      base64Data,
      category: 'resume',
      profileName: 'default',
    });
    await profileService.patch(userId, { documents: { resumeFileId: file.id, resumeFileName: file.originalName } }, 'resume-upload');

    let parse = null;
    if (await getBool('features.resume_parse')) {
      const { rows } = await getPgPool().query(
        `INSERT INTO resume_parses (user_id, file_id) VALUES ($1, $2) RETURNING id, status, created_at`,
        [userId, file.id],
      );
      parse = rows[0];
      const job: ParseResumeJob = {
        id: randomUUID(),
        type: 'parse',
        priority: 'high',
        createdAt: new Date(),
        userId,
        payload: { parseId: parse.id },
      };
      await enqueueJob(job);
    }
    return { file: { id: file.id, name: file.originalName }, parse };
  });

  app.get('/me/resume/parses/latest', auth, async (req) => {
    const { rows } = await getPgPool().query(
      `SELECT id, status, result, error, model, created_at, completed_at FROM resume_parses
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [uid(req)],
    );
    return { parse: rows[0] ?? null };
  });

  /** User confirmed the parsed draft: merge it into the profile (their edits win). */
  app.post('/me/resume/parses/:id/apply', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const overrides = (req.body ?? {}) as ProfileData;
    const { rows } = await getPgPool().query(
      `SELECT result FROM resume_parses WHERE id = $1 AND user_id = $2 AND status = 'done'`,
      [id, uid(req)],
    );
    if (!rows[0]) return reply.status(404).send({ error: 'No finished parse with that id' });
    const current = await profileService.get(uid(req));
    // Don't overwrite what the user already typed: parsed values only fill gaps.
    const { mergeProfile } = await import('../shared/profile/index.js');
    const filled = mergeProfile(rows[0].result as ProfileData, current.data);
    return profileService.patch(uid(req), mergeProfile(filled, overrides), 'resume-parse');
  });

  // ── Answer memory ───────────────────────────────────────
  app.get('/me/answers', auth, async (req) => ({ answers: await answerMemory.list(uid(req)) }));
  app.post('/me/answers', auth, async (req, reply) => {
    const { question, answer } = (req.body ?? {}) as { question?: string; answer?: string };
    if (!question?.trim() || !answer?.trim()) return reply.status(400).send({ error: 'question and answer are required' });
    return { answer: await answerMemory.remember(uid(req), question, answer) };
  });
  app.delete('/me/answers/:id', auth, async (req, reply) => {
    const ok = await answerMemory.forget(uid(req), Number((req.params as { id: string }).id));
    return ok ? { deleted: true } : reply.status(404).send({ error: 'Not found' });
  });

  // ── Jobs feed ───────────────────────────────────────────
  app.get('/jobboard/recommendations', auth, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 20) || 20, 50);
    const profile = await profileService.get(uid(req));
    const recs = await recommendJobs(uid(req), profile.data, limit);
    return {
      jobs: recs.map((r) => toListing(r.job, r.score, r.reasons, r.matchedSkills)),
      profileCompleteness: profile.completeness,
    };
  });

  // The live line on the jobs screen ("312 roles fit you — 41 since yesterday"); polled, cached briefly.
  const pulseCache = new Map<string, { at: number; value: JobPulse }>();
  app.get('/jobboard/pulse', auth, async (req) => {
    const userId = uid(req);
    const hit = pulseCache.get(userId);
    if (hit && Date.now() - hit.at < 90_000) return hit.value;
    const value = await jobPulse(userId, (await profileService.get(userId)).data);
    pulseCache.set(userId, { at: Date.now(), value });
    if (pulseCache.size > 5000) pulseCache.delete(pulseCache.keys().next().value!);
    return value;
  });

  app.get('/jobboard/search', auth, async (req) => {
    const q = req.query as { q?: string; country?: string; workplace?: string; location?: string; type?: string; page?: string };
    const res = await searchJobs({
      text: q.q, country: q.country, workplace: q.workplace, location: q.location, employmentType: q.type, page: Number(q.page) || 1,
    });
    return { ...res, jobs: res.jobs.map((j) => toListing(j)) };
  });

  app.get('/jobboard/jobs/:id', auth, async (req, reply) => {
    const job = await getJob((req.params as { id: string }).id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    const saved = await getPgPool().query('SELECT 1 FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [uid(req), job.id]);
    // How this role fits the signed-in user, so the detail view can say why.
    const profile = await profileService.get(uid(req));
    const fit = scoreJob(profile.data, job as JobRow);
    const j = job as JobRow & { description?: string; department?: string };
    return {
      job: {
        ...toListing(j, fit.score, fit.reasons, fit.matchedSkills),
        description: j.description ?? '',
        department: j.department ?? undefined,
        skills: j.skills ?? [],
        seniority: j.seniority ?? undefined,
        experienceMin: j.experience_min ? Number(j.experience_min) : undefined,
        experienceMax: j.experience_max ? Number(j.experience_max) : undefined,
        country: j.country ?? undefined,
      },
      saved: saved.rows.length > 0,
    };
  });

  app.post('/jobboard/jobs/:id/save', auth, async (req) => {
    await getPgPool().query('INSERT INTO saved_jobs (user_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      uid(req),
      (req.params as { id: string }).id,
    ]);
    return { saved: true };
  });
  app.delete('/jobboard/jobs/:id/save', auth, async (req) => {
    await getPgPool().query('DELETE FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [uid(req), (req.params as { id: string }).id]);
    return { saved: false };
  });
  app.get('/me/saved-jobs', auth, async (req) => {
    const { rows } = await getPgPool().query<JobRow>(
      `SELECT j.id, j.title, c.name AS company, j.url, j.location, j.country, j.workplace, j.employment_type,
              j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.posted_at, j.skills, j.seniority, b.ats_type
         FROM saved_jobs s JOIN jobs j ON j.id = s.job_id JOIN job_boards b ON b.id = j.board_id
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [uid(req)],
    );
    return { jobs: rows.map((j) => toListing(j)) };
  });

  app.post('/jobboard/jobs/:id/feedback', auth, async (req, reply) => {
    const { action } = (req.body ?? {}) as { action?: string };
    if (action !== 'pass' && action !== 'not_interested') return reply.status(400).send({ error: 'action must be pass or not_interested' });
    await getPgPool().query(
      `INSERT INTO job_feedback (user_id, job_id, action) VALUES ($1,$2,$3) ON CONFLICT (user_id, job_id) DO UPDATE SET action = EXCLUDED.action`,
      [uid(req), (req.params as { id: string }).id, action],
    );
    return { ok: true };
  });

  // ── Applications ────────────────────────────────────────
  app.get('/me/applications', auth, async (req) => {
    const q = req.query as { filter?: string; limit?: string; offset?: string };
    return {
      applications: await applicationsService.list(uid(req), q.filter ?? 'all', Number(q.limit) || 50, Number(q.offset) || 0),
    };
  });
  app.get('/me/applications/counts', auth, async (req) => applicationsService.counts(uid(req)));
  // Start one: { jobId } from the feed, or { url } for a pasted link. No LLM involved.
  app.post('/me/applications', auth, async (req, reply) => {
    const body = (req.body ?? {}) as { jobId?: string; url?: string };
    try {
      const started = await startApplication(uid(req), { jobId: body.jobId, url: body.url, source: 'manual', checkProfile: true });
      return reply.status(201).send(started);
    } catch (err) {
      if (err instanceof ApplyError || err instanceof LimitError || err instanceof InsufficientCreditsError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });
  app.get('/me/applications/:id', auth, async (req, reply) => {
    const a = await applicationsService.get(uid(req), (req.params as { id: string }).id);
    if (!a) return reply.status(404).send({ error: 'Not found' });
    const pending = ['needs_input', 'awaiting_review'].includes(a.status) ? await pendingInput(a.exec_job_id) : null;
    return { ...a, pending };
  });
  // Answer the question it's paused on, or approve the review ({"action":"approve","values":{…}}).
  app.post('/me/applications/:id/respond', auth, async (req, reply) => {
    const { value } = (req.body ?? {}) as { value?: unknown };
    if (typeof value !== 'string' || !value.trim()) return reply.status(400).send({ error: 'value is required' });
    const ok = await respondToApplication(uid(req), (req.params as { id: string }).id, value);
    return ok ? { ok: true } : reply.status(409).send({ error: 'This application is not waiting for anything' });
  });
  app.post('/me/applications/:id/cancel', auth, async (req, reply) => {
    const a = await applicationsService.cancel(uid(req), (req.params as { id: string }).id);
    return a ?? reply.status(404).send({ error: 'Not found' });
  });

  // The person finished it on the company's site ("applied") or doesn't want it ("skip").
  app.post('/me/applications/:id/manual', auth, async (req, reply) => {
    const { action } = (req.body ?? {}) as { action?: string };
    if (action !== 'applied' && action !== 'skip') return reply.status(400).send({ error: 'action must be "applied" or "skip"' });
    const a = await applicationsService.resolveManually(uid(req), (req.params as { id: string }).id, action);
    return a ?? reply.status(404).send({ error: 'Not found' });
  });

  // ── Inbox ───────────────────────────────────────────────
  app.get('/me/inbox', auth, async (req) => {
    const { category } = req.query as { category?: string };
    const userId = uid(req);
    // Allocated on first visit, so users who skipped onboarding still get one.
    const ensure = async () =>
      (await inboxService.getAddress(userId)) ??
      inboxService.ensureAddress(userId, (await profileService.get(userId)).data.personal?.fullName);
    const [emails, address, unread] = await Promise.all([
      inboxService.list(userId, category && category !== 'all' ? category : undefined),
      ensure(),
      inboxService.unreadCount(userId),
    ]);
    return { address, unread, emails };
  });
  app.get('/me/inbox/:id', auth, async (req, reply) => {
    const e = await inboxService.get(uid(req), (req.params as { id: string }).id);
    return e ?? reply.status(404).send({ error: 'Not found' });
  });
  app.post('/me/inbox/:id/read', auth, async (req, reply) => {
    const { read = true } = (req.body ?? {}) as { read?: boolean };
    const ok = await inboxService.markRead(uid(req), (req.params as { id: string }).id, read);
    return ok ? { ok: true } : reply.status(404).send({ error: 'Not found' });
  });

  // ── Profile gaps: what this person still owes nearly every form (asked once, up front) ──
  app.get('/me/profile-gaps', auth, async (req) => {
    const { jobId } = (req.query ?? {}) as { jobId?: string };
    let country: string | null = null;
    if (jobId && /^[0-9a-f-]{36}$/i.test(jobId)) {
      const { rows } = await getPgPool().query('SELECT country FROM jobs WHERE id = $1', [jobId]);
      country = rows[0]?.country ?? null;
    }
    const profile = await profileService.get(uid(req));
    return { gaps: profileGaps(profile.data, { country }) };
  });
  app.put('/me/profile-gaps', auth, async (req, reply) => {
    const { answers } = (req.body ?? {}) as { answers?: Record<string, unknown> };
    if (!answers || typeof answers !== 'object') return reply.status(400).send({ error: 'answers are required' });
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) if (typeof v === 'string') clean[k] = v;
    const current = await profileService.get(uid(req));
    const profile = await profileService.patch(uid(req), gapPatch(current.data, clean), 'profile-gaps');
    return { gaps: profileGaps(profile.data), completeness: profile.completeness };
  });

  // ── Portal password: the one password the user sets for employer portals the bot signs up to ──
  // Write-only: the API says whether one is set, never what it is.
  app.get('/me/portal-password', auth, async (req) => ({ set: await portalPassword.has(uid(req)) }));
  app.put('/me/portal-password', auth, async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== 'string') return reply.status(400).send({ error: 'A password is required' });
    const problem = passwordProblem(password);
    if (problem) return reply.status(400).send({ error: problem });
    await portalPassword.set(uid(req), password);
    return { set: true };
  });
  app.delete('/me/portal-password', auth, async (req) => {
    await portalPassword.clear(uid(req));
    return { set: false };
  });

  // ── Gmail (read-only: codes, verification links, employer replies) ──
  app.get('/me/integrations', auth, async (req) => ({ gmail: await gmailService.status(uid(req)) }));
  app.post('/me/integrations/gmail/connect', auth, async (req) => {
    const user = await userAccountService.findById(uid(req));
    return { url: await gmailService.connectUrl(uid(req), user?.email) };
  });
  app.post('/me/integrations/gmail/sync', auth, async (req) => ({ kept: await gmailService.sync(uid(req), undefined, 30) }));
  app.delete('/me/integrations/gmail', auth, async (req, reply) =>
    (await gmailService.disconnect(uid(req))) ? { ok: true } : reply.status(404).send({ error: 'Gmail is not connected' }));
  // Google sends the browser back here (no session header on a redirect: the signed state names the user).
  app.get('/integrations/gmail/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const appUrl = (process.env.PUBLIC_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    if (error || !code || !state) return reply.redirect(`${appUrl}/?gmail=${encodeURIComponent(error ?? 'cancelled')}`);
    try {
      await gmailService.complete(code, state);
      return reply.redirect(`${appUrl}/?gmail=connected`);
    } catch (err) {
      logger.warn('gmail:callback-failed', { error: (err as Error).message });
      return reply.redirect(`${appUrl}/?gmail=failed`);
    }
  });

  // ── Inbound mail webhook (Cloudflare Email Worker / SES → JSON POST) ──
  app.post('/inbound/email', async (req, reply) => {
    const secret = process.env.INBOUND_EMAIL_SECRET;
    const given = String(req.headers['x-inbound-secret'] ?? '');
    if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const b = (req.body ?? {}) as { to?: string; from?: string; fromName?: string; subject?: string; text?: string };
    if (!b.to || !b.from) return reply.status(400).send({ error: 'to and from are required' });
    const email = await inboxService.ingest({ to: b.to, fromAddress: b.from, fromName: b.fromName, subject: b.subject, text: b.text });
    logger.info('inbound:received', { accepted: !!email, category: email?.category });
    return { accepted: !!email };
  });
}

/** Balance + price, for the header pill and before starting an application. */
async function creditsBlock(userId: string) {
  const [enabled, cost] = await Promise.all([creditsService.enabled(), getNumber('credits.cost_per_application')]);
  return { enabled, balance: enabled ? await creditsService.balance(userId) : null, costPerApplication: cost };
}

/** Ownership guard for the legacy job-level resume/cancel routes. */
export async function assertOwnsExecJob(req: FastifyRequest, reply: FastifyReply, jobId: string): Promise<boolean> {
  const userId = (req as Partial<Authed>).userId;
  if (!userId || !(await applicationsService.ownsExecJob(userId, jobId))) {
    // Fall back to runtime state for jobs started before applications existed.
    const { getRedisClient, CacheKeys } = await import('../shared/db/index.js');
    const raw = await (await getRedisClient()).get(CacheKeys.jobRuntime(jobId));
    const owner = raw ? (JSON.parse(raw) as { userId?: string }).userId : undefined;
    if (!userId || owner !== userId) {
      reply.status(404).send({ error: 'Job not found' });
      return false;
    }
  }
  return true;
}
