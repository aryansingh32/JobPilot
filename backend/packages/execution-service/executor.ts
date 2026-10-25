import type { Page, Locator } from 'playwright';
import { copyFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import type {
  ActionStep,
  ExecutionResult,
  StepResult,
  ExecuteJob,
  JobRuntimeState,
} from '../shared/types/index.js';
import { getBrowserPool, localeForUrl } from './browser-pool.js';
import { SelectorEngine, type AIResolver } from './selector-engine.js';
import { SessionManager } from './session-manager.js';
import { getPgPool, CacheKeys } from '../shared/db/index.js';
import { humanDelay, humanClick, humanType, humanScroll } from './human-behavior.js';
import { getRedisClient } from '../shared/db/index.js';
import { userFileStore } from './user-file-store.js';
import { createLogger } from '../shared/logger/index.js';
import { cryptoService } from './crypto-service.js';
import { beginChallenge, attemptAutomatedResolution, finalizeResolution } from './captcha/orchestrator.js';
import { profileService, answerMemory, type ProfileData } from '../shared/profile/index.js';
import { portalPassword } from '../shared/profile/portal-password.js';
import { applicationsService, JOB_CLOSED } from '../shared/applications/index.js';
import { applicationEmail } from '../shared/inbox/index.js';
import { gmailService } from '../shared/gmail/index.js';
import { coverLetterFile, coverLetterText } from './cover-letter.js';
import { aiAnswers } from './ai-answers.js';
import { govRuleFor, imageRule, identityFieldKind, IDENTITY_GO, IDENTITY_SEND, isIdentityGate, isLoginIdField, isOtpField, isSecretField } from './gov-forms.js';
import { fitImage, nearbyText, pressOtpButton } from './gov-runtime.js';
import { parkApplication, continueParked, type ParkState } from '../shared/applications/apply.js';
import { getNumber } from '../shared/config/settings.js';
import { randomBytes } from 'crypto';
import { classifyIntents } from './intent.js';
import {
  buildAnswerBook, captchaImageFor, fillField, pickOption, untickedCheckbox, visibleClickChallenge, planAnswers, readComboOptions, readFormErrors, realOptions, ruleFor, scanForm,
  type FieldAnswer, type FormField,
  pageDiagnostic,
} from './form-filler.js';

const logger = createLogger('execution-engine');

class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled by the user`);
    this.name = 'JobCancelledError';
  }
}

/**
 * A wait on the user ran past apply.park_after_seconds: the run ends without
 * failing, the application keeps the state, and the browser is released.
 * `lateAnswer` is an answer that arrived while the run was parking.
 */
class JobParkedError extends Error {
  constructor(public state: Omit<ParkState, 'job'>, public lateAnswer: () => string | undefined) {
    super('Parked while waiting for the user');
    this.name = 'JobParkedError';
  }
}

/** Pause steps that can park instead of holding the browser (apply runs only). */
interface ParkSpec {
  kind: ParkState['kind'];
  question?: string;
  questions?: ParkState['questions'];
  reviewFields?: ParkState['reviewFields'];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message?.trim() || error.name || 'Unknown execution error';
  }
  if (typeof error === 'string') {
    return error.trim() || 'Unknown execution error';
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'Unknown execution error';
  } catch {
    return String(error) || 'Unknown execution error';
  }
}

export interface ExecutionContext {
  page: Page;
  contextId: string;
  selectorEngine: SelectorEngine;
  screenshots: string[];
  jobId: string;
  userId: string;
  sessionId: string;
  siteId: string;
  workflowKey?: string;
  task: string;
  runtimeInputs: Record<string, string>;
  extractedData: Record<string, unknown>;
  workflowStack: string[];
  workflowRecoveryPlan?: ActionStep[];
  metrics: {
    aiCallCount: number;
    selectorFallbackCount: number;
    retryCount: number;
  };
  cancellation: {
    cancelled: boolean;
  };
  /** Values for {{job:*}} tokens. */
  jobContext?: Record<string, string>;
  /** Loaded on first {{profile:*}} / autofill use. */
  profile?: ProfileData;
  /** What autofillForm filled, for reviewForm / submitForm. */
  form?: { fields: FormField[]; answers: FieldAnswer[]; missing: FormField[]; pages?: string[] };
  stopBeforeSubmit?: boolean;
  /** Apply runs: long waits park instead of holding this browser. */
  parkable?: boolean;
  /** Continuation of a parked review: label → approved value, applied without asking again. */
  approved?: Record<string, string>;
  /** Apply runs: which address the application uses (private inbox / connected Gmail / own email). */
  emailVia?: 'inbox' | 'gmail' | 'personal';
}

type ActionHandler = (step: ActionStep, ctx: ExecutionContext) => Promise<void>;

async function streamLiveView(ctx: ExecutionContext, jobId: string, initialFps = 1): Promise<{ stop: () => void, setFps: (fps: number) => void }> {
  let active = true;
  let currentFps = initialFps;
  let lastScreenshotHash: string | null = null;
  const redis = await getRedisClient();

  const loop = async () => {
    while (active) {
      const intervalMs = 1000 / Math.max(0.1, currentFps);
      const startTime = Date.now();

      try {
        // Frames are only produced while an admin watches this run (live view is
        // admin-only; users see cropped captcha images instead) — saves a
        // screenshot per second on every run.
        const watched = (await redis.exists(`live:watch:${jobId}`)) === 1;
        if (watched && !ctx.page.isClosed()) {
          const buffer = await ctx.page.screenshot({ 
            type: 'jpeg', 
            quality: currentFps > 2 ? 60 : 40, // Slightly better quality for CAPTCHA
            scale: 'css' 
          });
          
          const base64 = buffer.toString('base64');
          // Simple bandwidth optimization: don't send identical frames
          if (base64 !== lastScreenshotHash) {
            await redis.publish(`live-stream:${jobId}`, base64);
            lastScreenshotHash = base64;
          }
        }
      } catch (err) {
        // Error recovery: if screenshot fails, just wait and retry
        console.warn(`[Streaming] Screenshot failed for job ${jobId}: ${(err as Error).message}`);
      }

      const elapsed = Date.now() - startTime;
      const sleepTime = Math.max(10, intervalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  };

  loop();
  return {
    stop: () => { active = false; },
    setFps: (fps: number) => { currentFps = fps; }
  };
}

function normalizeStep(step: ActionStep): ActionStep {
  return {
    ...step,
    order: step.order ?? 0,
    timeout: step.timeout ?? 10_000,
    retries: step.retries ?? 1,
    description: step.description ?? `${step.action} step ${step.id}`,
    humanDelay: step.humanDelay ?? false,
    humanType: step.humanType ?? false,
  };
}

function resolveRuntimeValue(value: string | undefined, ctx: ExecutionContext): string {
  if (!value) return '';

  return value
    .replace(/\{\{(lastUserInput|userInput:([^}]+))\}\}/g, (_match, token, stepId) => {
      if (token === 'lastUserInput') {
        const lastKey = Object.keys(ctx.runtimeInputs).at(-1);
        return lastKey ? ctx.runtimeInputs[lastKey] ?? '' : '';
      }
      return ctx.runtimeInputs[stepId] ?? '';
    })
    .replace(/\{\{extracted:([^}]+)\}\}/g, (_match, key) => String(ctx.extractedData[key] ?? ''))
    .replace(/\{\{job:([^}]+)\}\}/g, (_match, key) => ctx.jobContext?.[key] ?? '')
    .replace(/\{\{profile:([^}]+)\}\}/g, (_match, key: string) => {
      if (!ctx.profile) return '';
      const book = buildAnswerBook(ctx.profile, { country: ctx.jobContext?.country });
      if (key in book) return book[key];
      const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx.profile);
      return v === undefined || v === null ? '' : String(v);
    });
}

async function resolveAutomationValue(value: string | undefined, ctx: ExecutionContext): Promise<string> {
  const resolved = resolveRuntimeValue(value, ctx);
  if (
    resolved.startsWith('file:')
    || resolved.startsWith('file-category:')
    || resolved.includes('{{userFile:')
  ) {
    return userFileStore.resolveInputReference(ctx.userId, resolved);
  }
  return resolved;
}

function parseManagedDownloadTarget(rawValue: string | undefined): {
  category: 'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other';
  originalName: string;
} | null {
  if (!rawValue?.startsWith('user-file-download:')) return null;
  const [, category, ...nameParts] = rawValue.split(':');
  return {
    category: (category || 'document') as any,
    originalName: nameParts.join(':') || 'download.bin',
  };
}

async function updateJobRuntimeState(ctx: ExecutionContext, patch: Partial<JobRuntimeState>): Promise<void> {
  const redis = await getRedisClient();
  const existing = await redis.get(CacheKeys.jobRuntime(ctx.jobId));
  const base: JobRuntimeState = existing
    ? JSON.parse(existing)
    : {
        jobId: ctx.jobId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        siteId: ctx.siteId,
        task: ctx.task,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  await redis.setEx(
    CacheKeys.jobRuntime(ctx.jobId),
    86400,
    JSON.stringify({
      ...base,
      ...patch,
      updatedAt: new Date().toISOString(),
    })
  );
}

/**
 * `success` only means every step ran without throwing — it says nothing
 * about whether a step meant to produce something actually did. This is
 * a bounded, deliberately lightweight check: any extract/extractData step
 * in the top-level action plan that came back empty flips `verified` to
 * false even though the job is otherwise "successful". Nested steps
 * (conditional/retryLoop branches, sub-workflows) aren't walked — this is
 * a smoke check, not a full semantic result validator.
 */
function computeVerified(actionPlan: ActionStep[] | undefined, ctx: ExecutionContext, allSucceeded: boolean): boolean {
  if (!allSucceeded) return false;
  if (!actionPlan?.length) return true;

  for (const step of actionPlan) {
    if (step.action !== 'extract' && step.action !== 'extractData') continue;
    const key = step.action === 'extractData' ? String(step.metadata?.key ?? step.id) : step.id;
    const value = ctx.extractedData[key];
    if (value === null || value === undefined || value === '') return false;
  }
  return true;
}

async function markJobCancelled(jobId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.setEx(CacheKeys.jobCancel(jobId), 86400, '1');
  await redis.publish(`job:cancel:${jobId}`, 'cancel');
}

async function isJobCancelled(ctx: ExecutionContext): Promise<boolean> {
  if (ctx.cancellation.cancelled) return true;
  const redis = await getRedisClient();
  const cancelled = await redis.get(CacheKeys.jobCancel(ctx.jobId));
  if (cancelled === '1') {
    ctx.cancellation.cancelled = true;
    return true;
  }
  return false;
}

async function ensureNotCancelled(ctx: ExecutionContext): Promise<void> {
  if (await isJobCancelled(ctx)) {
    throw new JobCancelledError(ctx.jobId);
  }
}

function buildLocator(step: ActionStep, candidate: string, ctx: ExecutionContext): Locator {
  const selectorType = step.target?.type ?? 'css';

  switch (selectorType) {
    case 'text':
      return candidate.startsWith('text=') ? ctx.page.locator(candidate) : ctx.page.getByText(candidate, { exact: false });
    case 'testid':
      return ctx.page.getByTestId(candidate);
    case 'xpath':
      return ctx.page.locator(candidate.startsWith('xpath=') ? candidate : `xpath=${candidate}`);
    case 'role': {
      const role = (step.target?.roleName ?? candidate.split(':')[0] ?? 'button') as any;
      const name = step.target?.roleName ? candidate : candidate.split(':').slice(1).join(':') || undefined;
      return name
        ? ctx.page.getByRole(role, { name, ...(step.target?.roleOptions ?? {}) } as any)
        : ctx.page.getByRole(role, step.target?.roleOptions as any);
    }
    case 'url':
      return ctx.page.locator(`a[href*="${candidate}"]`);
    case 'css':
    default:
      return ctx.page.locator(candidate);
  }
}

export async function resolveLocator(step: ActionStep, ctx: ExecutionContext): Promise<Locator> {
  if (step.target?.value) {
    const candidates = [step.target.value, ...(step.target.fallbackSelectors ?? [])];
    for (const candidate of candidates) {
      const locator = buildLocator(step, candidate, ctx);
      try {
        if (await locator.first().count()) return locator;
      } catch {}
    }
    return buildLocator(step, candidates[0], ctx);
  }

  const resolution = await ctx.selectorEngine.resolve({
    page: ctx.page,
    elementId: step.id,
    label: step.description ?? step.id,
    elementType: 'button',
  });

  if (!resolution.found) {
    throw new Error(resolution.error);
  }

  if (resolution.method !== 'css' && resolution.method !== 'aria') {
    ctx.metrics.selectorFallbackCount++;
  }

  return ctx.page.locator(resolution.selector);
}

async function evaluateCondition(step: ActionStep, ctx: ExecutionContext): Promise<boolean> {
  const condition = step.condition;
  if (!condition) return false;

  switch (condition.type) {
    case 'exists': {
      const target = condition.target || step.target?.value;
      if (!target) return false;
      return (await ctx.page.locator(target).count()) > 0;
    }
    case 'contains_text': {
      const target = condition.target || 'body';
      const text = await ctx.page.locator(target).first().textContent().catch(() => '');
      return text?.includes(condition.value ?? '') ?? false;
    }
    case 'url_contains':
      return ctx.page.url().includes(condition.value ?? '');
    case 'status':
      return (condition.value ?? '').toLowerCase() === 'running';
    default:
      return false;
  }
}

async function loadWorkflowForExecution(siteId: string, workflowIdOrName: string) {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT
       workflow_key as "workflowKey",
       name,
       starter_action_plan as "starterActionPlan"
     FROM site_workflows
     WHERE site_id = $1
       AND is_active = true
       AND (workflow_key = $2 OR name = $2)
     LIMIT 1`,
    [siteId, workflowIdOrName]
  );

  return rows[0] ?? null;
}

async function executeNestedSteps(steps: ActionStep[] | undefined, ctx: ExecutionContext): Promise<void> {
  for (const rawStep of [...(steps ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    await ensureNotCancelled(ctx);
    const step = normalizeStep(rawStep);
    const handler = ACTION_HANDLERS[step.action];
    if (!handler) throw new Error(`Unknown nested action: ${step.action}`);
    await handler(step, ctx);
  }
}

const PAYMENT_COPY: Record<NonNullable<ActionStep['paymentMethod']>, string> = {
  upi: 'Please complete the payment on your UPI app and confirm when done.',
  card: 'Please complete the card payment and confirm when done.',
  generic: 'Please complete the payment and confirm when done.',
};

/** Shared by the `payment` and `paymentGateway` action types — same click-then-pause-for-confirmation
 *  flow, differing only in the button/link they click and the message shown to the user. */
const handlePaymentStep: ActionHandler = async (step, ctx) => {
  const stream = (ctx as any).activeStream;
  if (stream) stream.setFps(5); // High FPS for payment screens
  await ensureNotCancelled(ctx);

  await humanClick(ctx.page, await resolveLocator(step, ctx));

  const redis = await getRedisClient();
  await updateJobRuntimeState(ctx, {
    status: 'paused',
    activeStepId: step.id,
    lastInputType: 'confirmation',
  });

  const contextMessage = step.contextMessage || PAYMENT_COPY[step.paymentMethod ?? 'generic'];

  await redis.publish('chat:pause', JSON.stringify({
    jobId: ctx.jobId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    stepId: step.id,
    type: 'confirmation',
    contextMessage,
  }));

  await new Promise<void>((resolve, reject) => {
    const subRedis = redis.duplicate();
    // A Redis blip on this subscriber must never crash the process — an
    // unhandled 'error' event on any EventEmitter is fatal in Node.
    subRedis.on('error', (err) => logger.warn('redis:sub-client-error', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message }));
    const idleTimeoutMs = step.timeout || 5 * 60 * 1000; // 5 minutes for payments
    let settled = false;

    subRedis.connect().then(() => {
      const cleanup = async () => {
        settled = true;
        clearTimeout(idleTimer);
        try {
          await subRedis.unsubscribe(`job:resume:${ctx.jobId}`);
          await subRedis.unsubscribe(`job:cancel:${ctx.jobId}`);
        } catch {}
        await subRedis.quit().catch(() => {});
      };

      const idleTimer = setTimeout(() => {
        if (settled) return;
        console.warn(`[Executor] Payment idle timeout (${idleTimeoutMs / 1000}s) for job ${ctx.jobId}`);
        ctx.cancellation.cancelled = true;
        updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
        if (stream) stream.setFps(1);
        cleanup().catch(() => {});
        reject(new JobCancelledError(ctx.jobId));
      }, idleTimeoutMs);

      subRedis.subscribe(`job:resume:${ctx.jobId}`, () => {
        if (settled) return;
        updateJobRuntimeState(ctx, { status: 'running', activeStepId: step.id }).catch(() => {});
        if (stream) stream.setFps(1); // Reset FPS
        cleanup().catch(() => {});
        resolve();
      });
      subRedis.subscribe(`job:cancel:${ctx.jobId}`, () => {
        if (settled) return;
        ctx.cancellation.cancelled = true;
        updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
        if (stream) stream.setFps(1);
        cleanup().catch(() => {});
        reject(new JobCancelledError(ctx.jobId));
      });
    });
  });
};

// Exported (in addition to being used internally below) so integration
// tests can exercise the exact production pause/resume/captcha-fallback
// code path instead of re-implementing it against a mock.
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  navigate: async (step, ctx) => {
    if (!step.value) throw new Error('navigate action requires a URL value');
    const target = resolveRuntimeValue(step.value, ctx);
    try {
      await ctx.page.goto(target, { waitUntil: 'domcontentloaded', timeout: step.timeout });
    } catch (err) {
      // A slow company site (heavy scripts) can miss the deadline while the page itself is already up: carry on if it is.
      if (!/Timeout/i.test(String(err))) throw err;
      const up = ctx.page.url().startsWith('http') && (await ctx.page.evaluate(() => (document.body?.innerText ?? '').trim().length > 50).catch(() => false));
      if (!up) {
        await ctx.page.goto(target, { waitUntil: 'commit', timeout: 60_000 });
        await ctx.page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
      }
    }
    await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await humanDelay(300, 800);
  },

  click: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await humanClick(ctx.page, locator);
    await humanDelay(200, 500);
    if (step.waitFor) {
      await ctx.page.waitForSelector(step.waitFor, { timeout: step.timeout }).catch(() => {});
    }
  },

  fill: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    const value = resolveRuntimeValue(step.value, ctx);
    if (step.humanType === false) {
      await locator.first().fill(value, { timeout: step.timeout });
      return;
    }
    await humanType(ctx.page, locator, value);
  },

  humanType: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await humanType(ctx.page, locator, resolveRuntimeValue(step.value, ctx));
  },

  select: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await humanDelay(100, 200);
    await locator.first().selectOption({ label: resolveRuntimeValue(step.value, ctx) } as any);
    await humanDelay(150, 300);
  },

  check: async (step, ctx) => {
    await (await resolveLocator(step, ctx)).first().check({ timeout: step.timeout });
  },

  uncheck: async (step, ctx) => {
    await (await resolveLocator(step, ctx)).first().uncheck({ timeout: step.timeout });
  },

  upload: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    if (!step.value) throw new Error('upload requires a file path value');
    await locator.first().setInputFiles(await resolveAutomationValue(step.value, ctx));
    await humanDelay(500, 1000);
  },

  download: async (step, ctx) => {
    const [download] = await Promise.all([
      ctx.page.waitForEvent('download', { timeout: step.timeout }),
      step.target ? (await resolveLocator(step, ctx)).first().click() : Promise.resolve(),
    ]);
    const managedTarget = parseManagedDownloadTarget(resolveRuntimeValue(step.value, ctx));
    if (managedTarget) {
      const tempPath = userFileStore.getTempPath('downloads', download.suggestedFilename());
      await download.saveAs(tempPath);
      const buffer = await readFile(tempPath);

      const persistedFile = await userFileStore.persistDownloadedFile({
        userId: ctx.userId,
        category: managedTarget.category,
        originalName: managedTarget.originalName,
        buffer,
        metadata: {
          jobId: ctx.jobId,
          stepId: step.id,
          sourceFilename: download.suggestedFilename(),
        },
      });

      const redis = await getRedisClient();
      await redis.publish('chat:file', JSON.stringify({
        jobId: ctx.jobId,
        fileId: persistedFile.id,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        category: managedTarget.category,
        originalName: managedTarget.originalName,
        sourceFilename: download.suggestedFilename(),
      }));
      return;
    }

    const path = await resolveAutomationValue(step.value, ctx) || userFileStore.getTempPath('downloads', download.suggestedFilename());
    await download.saveAs(path);
  },

  wait: async (step) => {
    await new Promise((resolve) => setTimeout(resolve, parseInt(step.value ?? '1000', 10)));
  },

  waitForTimeout: async (step) => {
    await new Promise((resolve) => setTimeout(resolve, parseInt(step.value ?? '1000', 10)));
  },

  waitForSelector: async (step, ctx) => {
    await (await resolveLocator(step, ctx)).first().waitFor({ timeout: step.timeout });
  },

  waitForNavigation: async (step, ctx) => {
    const targetUrl = resolveRuntimeValue(step.value, ctx);
    if (targetUrl) {
      await ctx.page.waitForURL((url) => url.toString().includes(targetUrl), { timeout: step.timeout });
      return;
    }
    await ctx.page.waitForLoadState('networkidle', { timeout: step.timeout });
  },

  scroll: async (step, ctx) => {
    const locator = step.target?.value ? await resolveLocator(step, ctx) : undefined;
    await humanScroll(ctx.page, locator, step.value === 'up' ? 'up' : 'down');
  },

  mouseMove: async (step, ctx) => {
    if (step.target?.value) {
      await (await resolveLocator(step, ctx)).first().hover({ timeout: step.timeout });
      return;
    }
    await ctx.page.mouse.move(Number(step.metadata?.x ?? 100), Number(step.metadata?.y ?? 100));
    await humanDelay(50, 150);
  },

  screenshot: async (step, ctx) => {
    const name = step.value ?? `screenshot-${ctx.jobId}-${Date.now()}.png`;
    const path = userFileStore.getTempPath('screenshots', name);
    await ctx.page.screenshot({ path, fullPage: false });
    ctx.screenshots.push(path);
  },

  extract: async (step, ctx) => {
    if (!step.target?.value) return;
    const text = await (await resolveLocator(step, ctx)).first().textContent();
    ctx.extractedData[step.id] = text;
  },

  extractData: async (step, ctx) => {
    const key = String(step.metadata?.key ?? step.id);
    const mode = String(step.metadata?.mode ?? 'text');
    if (mode === 'url') {
      ctx.extractedData[key] = ctx.page.url();
      return;
    }

    const locator = await resolveLocator(step, ctx);
    if (mode === 'attribute') {
      ctx.extractedData[key] = await locator.first().getAttribute(String(step.metadata?.attribute ?? 'value'));
      return;
    }
    if (mode === 'value') {
      ctx.extractedData[key] = await locator.first().inputValue();
      return;
    }
    ctx.extractedData[key] = await locator.first().textContent();
  },

  pauseForUserInput: async (step, ctx) => {
    const startedAt = Date.now();
    // Classify + open a metrics event for whatever this pause turns out to
    // be (captcha / otp / mfa / login-verification / security-block /
    // generic). Pure DOM inspection — no LLM call.
    const { detection, eventId } = await beginChallenge(ctx.page, ctx, step);

    // Tiers 1+2: free in-browser auto-solve, then a plan-gated paid
    // provider. Bounded attempts, and a security block is never
    // auto-attempted — it always falls through to the human tier below.
    //
    // This try/catch is deliberate, not defensive boilerplate: free-plan
    // users always land on the human tier below (their plan limit keeps
    // tier 2 closed), and premium users must land there too whenever
    // auto-solve doesn't pan out — including the rare case where this
    // call throws instead of returning `resolved: false` (a provider bug,
    // an unexpected network error, anything). Without this catch, that
    // exception would propagate out of the step and fail the job instead
    // of falling back to a human — exactly the outcome the fallback tier
    // exists to prevent.
    let autoAttempts = 0;
    if (detection.eventType === 'captcha') {
      try {
        const auto = await attemptAutomatedResolution(ctx.page, ctx, detection);
        autoAttempts = auto.attempts;
        if (auto.resolved) {
          logger.info('captcha:auto-resolved', { jobId: ctx.jobId, stepId: step.id, resolvedBy: auto.resolvedBy, provider: auto.provider });
          if (auto.token) ctx.runtimeInputs[step.id] = auto.token;
          await finalizeResolution(eventId, ctx, step, detection, {
            status: 'resolved', resolvedBy: auto.resolvedBy, provider: auto.provider,
            attempts: auto.attempts, costUsd: auto.costUsd, durationMs: Date.now() - startedAt,
          });
          return;
        }
        logger.info('captcha:auto-resolve-exhausted', { jobId: ctx.jobId, stepId: step.id, error: auto.error });
      } catch (err) {
        logger.warn('captcha:auto-resolve-threw', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message });
      }
    }

    // Tier 3: human-in-the-loop via the live chat/browser-view pause — the
    // "live Human-in-the-Loop CAPTCHA interface" for free users (always
    // reached, since their plan keeps tier 2 closed), and the fallback for
    // premium users whenever automated solve doesn't succeed — the rare
    // case, but never a dead end (or for anything a solver was never meant
    // to touch, like a security block, OTP, MFA, or login-verification
    // checkpoint).
    const redis = await getRedisClient();
    await ensureNotCancelled(ctx);

    const stream = (ctx as any).activeStream;
    if (stream && detection.eventType === 'captcha') {
      stream.setFps(3);
    }

    let captchaUrl = '';
    let rect: { x: number, y: number, w: number, h: number } | undefined = undefined;

    if (detection.eventType === 'captcha' && step.target) {
      try {
        const locator = await resolveLocator(step, ctx);
        if (locator) {
          const src = await locator.first().getAttribute('src');
          if (src && src.startsWith('data:')) {
            captchaUrl = src;
          } else {
            const buffer = await locator.first().screenshot({ type: 'jpeg', quality: 80 });
            captchaUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          }
        }
      } catch (err) {
        // Ignore if we can't capture the specific captcha image
      }
    } else if (step.target) {
      try {
        const locator = await resolveLocator(step, ctx);
        if (locator) {
          const box = await locator.first().boundingBox();
          const pageW = await ctx.page.evaluate(() => window.innerWidth);
          const pageH = await ctx.page.evaluate(() => window.innerHeight);
          if (box && pageW && pageH) {
            rect = {
              x: (box.x / pageW) * 100,
              y: (box.y / pageH) * 100,
              w: (box.width / pageW) * 100,
              h: (box.height / pageH) * 100
            };
          }
        }
      } catch (err) {}
    }

    await updateJobRuntimeState(ctx, {
      status: 'paused',
      activeStepId: step.id,
      lastInputType: step.expectedInput || 'text',
    });

    const pauseMessage = detection.eventType === 'security_block'
      ? (step.contextMessage ?? `This site is showing a security check (${detection.type.replace(/-/g, ' ')}) rather than a solvable CAPTCHA. Please resolve it manually in the live view below, then continue.`)
      : (step.contextMessage ?? step.description);

    await redis.publish('chat:pause', JSON.stringify({
      jobId: ctx.jobId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      stepId: step.id,
      type: step.expectedInput || 'text',
      contextMessage: pauseMessage,
      data: { captchaUrl, rect, ...(step.metadata?.pauseData ?? {}) }
    }));

    // Mirror into the admin pending-queue so an admin can resolve this
    // pause from the admin panel as an alternative to the end user.
    const idleTimeoutMs = step.timeout || 3 * 60 * 1000; // 3 minutes default
    const pendingType = step.expectedInput || detection.type;
    const pendingPayload = { captchaUrl, rect, contextMessage: pauseMessage, ...(step.metadata?.pauseData ?? {}) };
    await redis.setEx(`captcha:pending:${ctx.jobId}`, Math.ceil(idleTimeoutMs / 1000), JSON.stringify({
      id: ctx.jobId,
      siteId: ctx.siteId,
      type: pendingType,
      payload: pendingPayload,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })).catch(() => {});

    // Apply runs don't hold a browser for a slow answer: past the park
    // window the run parks and a continuation run picks the answer up.
    const park = ctx.parkable ? (step.metadata?.park as ParkSpec | undefined) : undefined;
    const waitMs = park
      ? Math.min(idleTimeoutMs, (await getNumber('apply.park_after_seconds').catch(() => 120)) * 1000)
      : idleTimeoutMs;
    let parking = false;
    let lateAnswer: string | undefined;

    return new Promise<void>((resolve, reject) => {
      const subRedis = redis.duplicate();
      subRedis.on('error', (err) => logger.warn('redis:sub-client-error', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message }));
      let settled = false;

      subRedis.connect().then(() => {
        const cleanup = async () => {
          settled = true;
          clearTimeout(idleTimer);
          try {
            await subRedis.unsubscribe(`job:resume:${ctx.jobId}`);
            await subRedis.unsubscribe(`job:cancel:${ctx.jobId}`);
          } catch {}
          await subRedis.quit().catch(() => {});
          await redis.del(`captcha:pending:${ctx.jobId}`).catch(() => {});
        };

        // Idle timeout — auto-cancel if user doesn't respond. This is the
        // hard ceiling that stops a stuck checkpoint from hanging forever.
        //
        // Every branch below awaits finalizeResolution() and cleanup()
        // BEFORE settling the promise. That ordering is deliberate: a step
        // this pause returns from is a step whose event row is already
        // written and whose captcha:pending entry is already gone — never
        // a race where the workflow moves on (or a test/caller observes
        // "resolved") while the audit trail is still catching up.
        const idleTimer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          if (park) {
            parking = true;
            logger.info('pause:parking', { jobId: ctx.jobId, stepId: step.id, kind: park.kind, waitedMs: waitMs });
            await finalizeResolution(eventId, ctx, step, detection, {
              status: 'timeout', resolvedBy: 'failed', attempts: autoAttempts, durationMs: Date.now() - startedAt, error: 'parked',
            }).catch(() => {});
            await cleanup().catch(() => {});
            reject(new JobParkedError(
              { kind: park.kind, stepId: step.id, pending: { type: pendingType, ...pendingPayload }, question: park.question, questions: park.questions, reviewFields: park.reviewFields },
              () => lateAnswer,
            ));
            return;
          }
          console.warn(`[Executor] Idle timeout (${idleTimeoutMs / 1000}s) for job ${ctx.jobId} step ${step.id}`);
          ctx.cancellation.cancelled = true;
          updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
          if (stream && detection.eventType === 'captcha') {
            stream.setFps(1);
          }
          await finalizeResolution(eventId, ctx, step, detection, {
            status: 'timeout', resolvedBy: 'failed', attempts: autoAttempts, durationMs: Date.now() - startedAt, error: 'idle timeout',
          }).catch(() => {});
          await cleanup().catch(() => {});
          reject(new JobCancelledError(ctx.jobId));
        }, waitMs);

        subRedis.subscribe(`job:resume:${ctx.jobId}`, async (message: string) => {
          if (settled) {
            // Answered while parking: the continuation run gets it.
            if (parking) lateAnswer = message;
            return;
          }
          settled = true;
          clearTimeout(idleTimer);

          // The admin-panel solve endpoint wraps its answer in a small
          // envelope so metrics can tell "an admin solved this" apart from
          // "the requesting user solved this" — the real chat/live-view
          // resume path always publishes the raw typed value, never JSON
          // shaped like this, so this check can't misfire on it.
          let value = message;
          let resolvedByHuman: 'human_user' | 'human_admin' = 'human_user';
          try {
            const parsed = JSON.parse(message);
            if (parsed && typeof parsed === 'object' && parsed.__hieAdmin) {
              value = String(parsed.solution ?? '');
              resolvedByHuman = 'human_admin';
            }
          } catch {
            // Not JSON — it's the plain value the user typed, as expected.
          }

          ctx.runtimeInputs[step.id] = value;
          updateJobRuntimeState(ctx, { status: 'running', activeStepId: step.id }).catch(() => {});

          // Reset FPS if it was boosted
          if (stream && detection.eventType === 'captcha') {
            stream.setFps(1);
          }
          await finalizeResolution(eventId, ctx, step, detection, {
            status: 'resolved', resolvedBy: resolvedByHuman, attempts: autoAttempts + 1, durationMs: Date.now() - startedAt,
          }).catch(() => {});
          await cleanup().catch(() => {});
          resolve();
        });
        subRedis.subscribe(`job:cancel:${ctx.jobId}`, async () => {
          if (settled) return;
          settled = true;
          clearTimeout(idleTimer);
          ctx.cancellation.cancelled = true;
          updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
          if (stream && detection.eventType === 'captcha') {
            stream.setFps(1);
          }
          await finalizeResolution(eventId, ctx, step, detection, {
            status: 'failed', resolvedBy: 'failed', attempts: autoAttempts, durationMs: Date.now() - startedAt, error: 'cancelled',
          }).catch(() => {});
          await cleanup().catch(() => {});
          reject(new JobCancelledError(ctx.jobId));
        });
      });
    });
  },

  payment: handlePaymentStep,

  conditional: async (step, ctx) => {
    const branch = (await evaluateCondition(step, ctx)) ? step.trueSteps : step.falseSteps;
    await executeNestedSteps(branch, ctx);
  },

  retryLoop: async (step, ctx) => {
    const maxRetries = step.retries ?? 5; // Default dynamic limit
    let attempts = 0;
    while (attempts < maxRetries) {
      const conditionMet = await evaluateCondition(step, ctx);
      if (!conditionMet) break; // Error condition no longer met, success!
      
      await executeNestedSteps(step.trueSteps, ctx);
      attempts++;
    }
    if (attempts >= maxRetries && await evaluateCondition(step, ctx)) {
      throw new Error(`Retry loop failed after ${maxRetries} attempts`);
    }
  },

  runSubWorkflow: async (step, ctx) => {
    const workflowId = resolveRuntimeValue(step.value, ctx);
    if (!workflowId) throw new Error('runSubWorkflow requires a workflow id or name');
    if (ctx.workflowStack.includes(workflowId)) {
      throw new Error(`Recursive sub-workflow detected: ${workflowId}`);
    }

    const workflow = await loadWorkflowForExecution(ctx.siteId, workflowId);
    if (!workflow?.starterActionPlan?.length) {
      throw new Error(`Sub-workflow not found: ${workflowId}`);
    }

    ctx.workflowStack.push(workflowId);
    try {
      await executeNestedSteps(workflow.starterActionPlan, ctx);
    } finally {
      ctx.workflowStack.pop();
    }
  },

  customJS: async (step, ctx) => {
    const script = resolveRuntimeValue(step.value, ctx) || String(step.metadata?.script ?? '');
    if (!script) throw new Error('customJS requires step.value or metadata.script');

    const result = await ctx.page.evaluate(
      ({ userScript, runtimeInputs, extractedData }) => {
        const fn = new Function('runtimeInputs', 'extractedData', userScript);
        return fn(runtimeInputs, extractedData);
      },
      {
        userScript: script,
        runtimeInputs: ctx.runtimeInputs,
        extractedData: ctx.extractedData,
      }
    );

    if (step.metadata?.resultKey) {
      ctx.extractedData[String(step.metadata.resultKey)] = result;
    }
  },

  refresh: async (step, ctx) => {
    await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: step.timeout });
    await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  },

  clickCaptcha: async (step, ctx) => {
    // This handler waits for the user to click coordinates on an image
    // then replays those clicks on the browser page. Grid/click captchas
    // aren't token-based, so there's no automated-provider tier here —
    // this is always a human checkpoint; we still log it for metrics and
    // so the workflow retains the checkpoint for next time.
    const startedAt = Date.now();
    const { detection, eventId } = await beginChallenge(ctx.page, ctx, step);
    const redis = await getRedisClient();
    await updateJobRuntimeState(ctx, {
      status: 'paused',
      activeStepId: step.id,
      lastInputType: 'clickCaptcha',
    });

    // Capture the captcha container screenshot if possible
    let captchaUrl = '';
    try {
      const locator = await resolveLocator(step, ctx);
      const buffer = await locator.first().screenshot({ type: 'jpeg', quality: 80 });
      captchaUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch {}

    await redis.publish('chat:pause', JSON.stringify({
      jobId: ctx.jobId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      stepId: step.id,
      type: 'clickCaptcha',
      contextMessage: step.contextMessage || 'Please click the correct images in the captcha below.',
      data: { captchaUrl }
    }));

    const idleTimeoutMs = step.timeout || 3 * 60 * 1000;
    await redis.setEx(`captcha:pending:${ctx.jobId}`, Math.ceil(idleTimeoutMs / 1000), JSON.stringify({
      id: ctx.jobId,
      siteId: ctx.siteId,
      type: 'clickCaptcha',
      payload: { captchaUrl, contextMessage: step.contextMessage },
      status: 'pending',
      createdAt: new Date().toISOString(),
    })).catch(() => {});

    return new Promise<void>((resolve, reject) => {
      const subRedis = redis.duplicate();
      subRedis.on('error', (err) => logger.warn('redis:sub-client-error', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message }));
      const idleTimer = setTimeout(async () => {
        await finalizeResolution(eventId, ctx, step, detection, {
          status: 'timeout', resolvedBy: 'failed', attempts: 0, durationMs: Date.now() - startedAt, error: 'idle timeout',
        }).catch(() => {});
        await redis.del(`captcha:pending:${ctx.jobId}`).catch(() => {});
        await subRedis.quit().catch(() => {});
        reject(new JobCancelledError(ctx.jobId));
      }, idleTimeoutMs);

      subRedis.connect().then(() => {
        subRedis.subscribe(`job:resume:${ctx.jobId}`, async (message) => {
          clearTimeout(idleTimer);
          try {
            // Accepts {points:[{x,y}]} in pixels (legacy), {x,y} as fractions of the
            // image, or "x,y" pixels — the chat card sends the latter.
            let points: Array<{ x: number; y: number; frac?: boolean }> = [];
            try {
              const parsed = JSON.parse(message);
              if (Array.isArray(parsed?.points)) points = parsed.points;
              else if (typeof parsed?.x === 'number') points = [{ x: parsed.x, y: parsed.y, frac: parsed.x <= 1 && parsed.y <= 1 }];
            } catch {
              const [x, y] = message.split(',').map(Number);
              if (Number.isFinite(x) && Number.isFinite(y)) points = [{ x, y }];
            }
            const locator = await resolveLocator(step, ctx);
            const box = await locator.first().boundingBox();
            if (box) {
              for (const pt of points) {
                await ctx.page.mouse.click(box.x + (pt.frac ? pt.x * box.width : pt.x), box.y + (pt.frac ? pt.y * box.height : pt.y));
                await humanDelay(100, 300);
              }
            }
            await finalizeResolution(eventId, ctx, step, detection, {
              status: 'resolved', resolvedBy: 'human_user', attempts: 1, durationMs: Date.now() - startedAt,
            });
            await redis.del(`captcha:pending:${ctx.jobId}`).catch(() => {});
            await subRedis.quit();
            resolve();
          } catch (err) {
            await finalizeResolution(eventId, ctx, step, detection, {
              status: 'failed', resolvedBy: 'failed', attempts: 1, durationMs: Date.now() - startedAt, error: (err as Error).message,
            });
            await redis.del(`captcha:pending:${ctx.jobId}`).catch(() => {});
            await subRedis.quit();
            reject(err);
          }
        });
      });
    });
  },

  // ── New Universal Actions ──────────────────────────────────

  credentialFill: async (step, ctx) => {
    const keyName = step.metadata?.keyName || step.id;
    const pool = getPgPool();
    const redis = await getRedisClient();

    const res = await pool.query(
      'SELECT encrypted_value FROM user_secrets WHERE user_id = $1 AND site_id = $2 AND key_name = $3',
      [ctx.userId, ctx.siteId, keyName]
    );

    let plainText = '';
    if (res.rows.length > 0) {
      plainText = cryptoService.decrypt(res.rows[0].encrypted_value);
    } else {
      await updateJobRuntimeState(ctx, {
        status: 'paused',
        activeStepId: step.id,
        lastInputType: 'credentialFill',
      });
      await redis.publish('chat:pause', JSON.stringify({
        jobId: ctx.jobId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        stepId: step.id,
        type: 'credentialFill',
        contextMessage: step.contextMessage || 'Please provide your credential.',
      }));

      plainText = await new Promise<string>((resolve, reject) => {
        const subRedis = redis.duplicate();
        subRedis.on('error', (err) => logger.warn('redis:sub-client-error', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message }));
        const idleTimeoutMs = step.timeout || 3 * 60 * 1000;
        let settled = false;

        subRedis.connect().then(() => {
          const cleanup = async () => {
            settled = true;
            clearTimeout(idleTimer);
            try {
              await subRedis.unsubscribe(`job:resume:${ctx.jobId}`);
              await subRedis.unsubscribe(`job:cancel:${ctx.jobId}`);
            } catch {}
            await subRedis.quit().catch(() => {});
          };

          const idleTimer = setTimeout(() => {
            if (settled) return;
            ctx.cancellation.cancelled = true;
            updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
            cleanup().catch(() => {});
            reject(new JobCancelledError(ctx.jobId));
          }, idleTimeoutMs);

          subRedis.subscribe(`job:resume:${ctx.jobId}`, async (message) => {
            if (settled) return;
            updateJobRuntimeState(ctx, { status: 'running', activeStepId: step.id }).catch(() => {});
            cleanup().catch(() => {});
            resolve(message);
          });
          
          subRedis.subscribe(`job:cancel:${ctx.jobId}`, () => {
            if (settled) return;
            ctx.cancellation.cancelled = true;
            updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
            cleanup().catch(() => {});
            reject(new JobCancelledError(ctx.jobId));
          });
        });
      });

      const encrypted = cryptoService.encrypt(plainText);
      await pool.query(
        `INSERT INTO user_secrets (user_id, site_id, key_name, encrypted_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, site_id, key_name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
        [ctx.userId, ctx.siteId, keyName, encrypted]
      );
    }

    const locator = await resolveLocator(step, ctx);
    await locator.first().fill(plainText, { timeout: step.timeout });
    plainText = '********'; 
  },

  paymentGateway: handlePaymentStep,

  pressKey: async (step, ctx) => {
    const key = resolveRuntimeValue(step.value, ctx) || 'Enter';
    if (step.target?.value) {
      const locator = await resolveLocator(step, ctx);
      await locator.first().press(key);
    } else {
      await ctx.page.keyboard.press(key);
    }
    await humanDelay(50, 150);
  },

  doubleClick: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await locator.first().dblclick({ timeout: step.timeout });
    await humanDelay(200, 400);
  },

  hover: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await locator.first().hover({ timeout: step.timeout });
    await humanDelay(100, 300);
  },

  rightClick: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await locator.first().click({ button: 'right', timeout: step.timeout });
    await humanDelay(200, 400);
  },

  clearField: async (step, ctx) => {
    const locator = await resolveLocator(step, ctx);
    await locator.first().fill('', { timeout: step.timeout });
    await humanDelay(50, 100);
  },

  switchTab: async (step, ctx) => {
    // Wait for a new page (popup/tab) and switch to it
    const context = ctx.page.context();
    const pages = context.pages();
    const tabIndex = parseInt(step.value ?? '-1', 10);

    if (tabIndex >= 0 && tabIndex < pages.length) {
      const targetPage = pages[tabIndex];
      await targetPage.bringToFront();
      (ctx as any).page = targetPage;
    } else {
      // Wait for a new tab to open
      const newPage = await context.waitForEvent('page', { timeout: step.timeout ?? 15000 });
      await newPage.waitForLoadState('domcontentloaded');
      await newPage.bringToFront();
      (ctx as any).page = newPage;
    }
    await humanDelay(300, 600);
  },

  closeTab: async (step, ctx) => {
    const context = ctx.page.context();
    const pages = context.pages();
    if (pages.length > 1) {
      await ctx.page.close();
      const remaining = context.pages();
      if (remaining.length > 0) {
        (ctx as any).page = remaining[remaining.length - 1];
        await remaining[remaining.length - 1].bringToFront();
      }
    }
  },

  acceptDialog: async (step, ctx) => {
    const promptValue = resolveRuntimeValue(step.value, ctx);
    ctx.page.once('dialog', async (dialog) => {
      await dialog.accept(promptValue || undefined);
    });
    await humanDelay(100, 200);
  },

  dismissDialog: async (step, ctx) => {
    ctx.page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await humanDelay(100, 200);
  },

  assertText: async (step, ctx) => {
    const target = step.target?.value ?? 'body';
    const expected = resolveRuntimeValue(step.value, ctx);
    const text = await ctx.page.locator(target).first().textContent({ timeout: step.timeout });
    if (!text?.includes(expected)) {
      throw new Error(`assertText failed: "${expected}" not found in "${text?.slice(0, 100)}"`);
    }
  },

  assertURL: async (step, ctx) => {
    const expected = resolveRuntimeValue(step.value, ctx);
    const currentUrl = ctx.page.url();
    if (!currentUrl.includes(expected)) {
      throw new Error(`assertURL failed: expected URL to contain "${expected}", got "${currentUrl}"`);
    }
  },

  iframe: async (step, ctx) => {
    // Switch into an iframe and execute nested steps
    const selector = step.target?.value ?? 'iframe';
    const frameLocator = ctx.page.frameLocator(selector);
    const frame = ctx.page.frame({ url: step.value ? new RegExp(step.value) : undefined }) ?? ctx.page.frames()[1];
    if (!frame) throw new Error(`iframe not found: ${selector}`);

    // Create a temporary context with the iframe's page-like interface
    const originalPage = ctx.page;
    (ctx as any).page = frame;
    try {
      await executeNestedSteps(step.trueSteps, ctx);
    } finally {
      (ctx as any).page = originalPage;
    }
  },

  loop: async (step, ctx) => {
    // Generic loop: iterate N times or over extracted data
    const iterations = parseInt(step.value ?? '1', 10);
    for (let i = 0; i < iterations; i++) {
      ctx.extractedData[`${step.id}_index`] = i;
      await executeNestedSteps(step.trueSteps, ctx);
    }
  },

  dragDrop: async (step, ctx) => {
    if (!step.target?.value || !step.value) {
      throw new Error('dragDrop requires target (source) and value (destination selector)');
    }
    const source = await resolveLocator(step, ctx);
    const dest = ctx.page.locator(resolveRuntimeValue(step.value, ctx));
    await source.first().dragTo(dest.first(), { timeout: step.timeout });
    await humanDelay(200, 500);
  },

  goBack: async (step, ctx) => {
    await ctx.page.goBack({ waitUntil: 'domcontentloaded', timeout: step.timeout });
    await humanDelay(300, 600);
  },

  goForward: async (step, ctx) => {
    await ctx.page.goForward({ waitUntil: 'domcontentloaded', timeout: step.timeout });
    await humanDelay(300, 600);
  },

  // ─── Job applications ──────────────────────────────────────
  // autofillForm → reviewForm → submitForm. Values come from the user's
  // profile and remembered answers; required questions nobody has answered
  // are asked (and remembered), never guessed.

  autofillForm: async (step, ctx) => {
    await loadProfile(ctx);
    // A consent banner can cover the Apply button (Zoho): the privacy-preserving choice.
    await declineCookieBanner(ctx.page);
    const scope = step.target?.value;
    // Many ATS pages (Ashby, Workday…) render the form client-side after load.
    let fields = await scanForm(ctx.page, scope);
    for (let waited = 0; !fields.some((f) => f.type !== 'file') && waited < 15_000; waited += 1000) {
      await ctx.page.waitForTimeout(1000);
      fields = await scanForm(ctx.page, scope).catch(() => []);
    }
    // Job pages often show the description first, with an Apply button.
    if (!fields.some((f) => f.type !== 'file') && step.metadata?.openApplyButton !== false) {
      const apply = ctx.page.locator('a, button').filter({ hasText: APPLY_BUTTON }).first();
      if (await apply.count()) {
        // Links often open the form in a new tab — follow them in this one.
        const href = await apply.getAttribute('href').catch(() => null);
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
          await ctx.page.goto(new URL(href, ctx.page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } else {
          await apply.click({ timeout: 10_000 });
        }
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
        await ctx.page.waitForTimeout(1500);
        fields = await scanForm(ctx.page, scope);
        // Single-page forms (SmartRecruiters, Workable) render after load.
        for (let waited = 0; !fields.some((f) => f.type !== 'file') && waited < 15_000; waited += 1000) {
          await ctx.page.waitForTimeout(1000);
          fields = await scanForm(ctx.page, scope).catch(() => []);
        }
      }
    }
    // Company career sites embed Greenhouse (Databricks redirects job-boards.greenhouse.io/<board>/jobs/<id>
    // to its own page): open the hosted form the iframe points at instead.
    if (!fields.length) {
      const embed = await ctx.page.evaluate(() => {
        const src = Array.from(document.querySelectorAll('iframe')).map((f) => f.src).find((s) => /greenhouse\.io\/embed\/job_app/.test(s));
        if (src) return src;
        const jid = new URL(location.href).searchParams.get('gh_jid');
        const board = Array.from(document.querySelectorAll('a[href*="greenhouse.io"], script[src*="greenhouse.io"]'))
          .map((e) => (e.getAttribute('href') ?? e.getAttribute('src') ?? '').match(/[?&]for=([\w-]+)|greenhouse\.io\/([\w-]+)\/jobs/))
          .find(Boolean);
        const slug = board?.[1] ?? board?.[2];
        return jid && slug ? `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${jid}` : null;
      }).catch(() => null);
      if (embed) {
        await ctx.page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        fields = await scanForm(ctx.page, scope);
        for (let waited = 0; !fields.some((f) => f.type !== 'file') && waited < 10_000; waited += 1000) {
          await ctx.page.waitForTimeout(1000);
          fields = await scanForm(ctx.page, scope).catch(() => []);
        }
      }
    }
    if (!fields.length) {
      // A bot-wall (DataDome etc.) in front of the form is a person's job, not a missing form.
      if (ctx.page.frames().some((f) => /captcha-delivery\.com|datadome/i.test(f.url()))) throw new Error('DATADOME_BLOCK: a human check stands in front of the form');
      throw new Error('No application form found on this page');
    }
    await stage(ctx, 'parse', { fields: fields.length, required: fields.filter((f) => f.required).length, url: ctx.page.url() });
    if (!ctx.jobContext?.title || ctx.jobContext.title === 'Job application') {
      await applicationsService.nameFromPage(ctx.jobId, await ctx.page.title().catch(() => '')).catch(() => {});
    }

    const { filled, stillMissing } = await fillPage(step, ctx, fields, `${step.id}_ask`);

    ctx.form = { fields, answers: filled, missing: stillMissing };
    // Every answer keeps its provenance (profile / memory / user / default), like a receipt.
    await stage(ctx, 'answers', {
      filled: filled.length,
      missing: stillMissing.map((f) => f.label),
      answers: filled.map((a) => ({ label: a.field.label || a.field.name, source: a.source, required: a.field.required, kind: a.field.type })),
    });
    ctx.extractedData.fieldsFilled = filled.length;
    if (stillMissing.length) ctx.extractedData.fieldsMissing = stillMissing.map((f) => f.label).join('; ');
    logger.info('autofill:done', { jobId: ctx.jobId, fields: fields.length, filled: filled.length, missing: stillMissing.length });
  },

  // ─── Multi-page applicant systems (Workday…) ──────────────
  // openApplication → siteAccount → fillWizard → reviewForm → submitForm.

  /** Click through the entry buttons (e.g. "Apply" then "Apply Manually"); each one is optional. */
  openApplication: async (step, ctx) => {
    await declineCookieBanner(ctx.page);
    await assertPostingOpen(ctx);
    const buttons = (step.metadata?.buttons as string[] | undefined) ?? [];
    for (const [idx, sel] of buttons.entries()) {
      const loc = ctx.page.locator(sel).first();
      const following = buttons.slice(idx + 1).map((b) => ctx.page.locator(b).first());
      const shown = await loc.waitFor({ state: 'visible', timeout: Number(step.metadata?.waitMs ?? 15_000) }).then(() => true, () => false);
      if (!shown) continue;
      // A click before the page has hydrated does nothing, so confirm the button went away (or the URL moved) and click again if not.
      const urlBefore = ctx.page.url();
      for (let attempt = 0; attempt < 3; attempt++) {
        await clickThrough(loc);
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
        const moved = await ctx.page
          .waitForFunction((u) => location.href !== u, urlBefore, { timeout: 6_000 })
          .then(() => true, () => false);
        if (moved || !(await loc.isVisible().catch(() => false))) break;
        // Workday's Apply opens a menu in place: the button stays and the next choice appears. Clicking again would close it.
        let opened = false;
        for (const f of following) if (await f.isVisible().catch(() => false)) opened = true;
        if (opened) break;
        logger.warn('apply:entry-click-ignored', { jobId: ctx.jobId, attempt: attempt + 1, selector: sel });
      }
      await ctx.page.waitForTimeout(1200);
    }
    if (!ctx.jobContext?.title || ctx.jobContext.title === 'Job application') {
      await applicationsService.nameFromPage(ctx.jobId, await ctx.page.title().catch(() => '')).catch(() => {});
    }
  },

  /**
   * Sites that need an account per company (Workday): create one with the
   * profile email and a generated password (stored encrypted, per site), or
   * sign in with the stored one. Unknown password / email verification → ask.
   */
  siteAccount: async (step, ctx) => {
    await loadProfile(ctx);
    const sel = { ...WORKDAY_ACCOUNT, ...((step.metadata?.selectors as Partial<typeof WORKDAY_ACCOUNT>) ?? {}) };
    const doneSel = (step.metadata?.doneSelector as string | undefined) ?? WORKDAY_NEXT;
    // Some sites land on the form at a URL more reliably than on any one element (SuccessFactors).
    const doneUrl = step.metadata?.doneUrl ? new RegExp(String(step.metadata.doneUrl), 'i') : null;
    const email = ctx.profile?.personal?.email;
    if (!email) throw new Error('Add your email to your profile — this site needs an account');
    const shown = (s: string | undefined) => (s ? ctx.page.locator(s).first().isVisible().catch(() => false) : Promise.resolve(false));
    // The wizard's stepper also counts: right after signing in the form body is still a skeleton and Next hasn't rendered.
    const WIZARD_STEPPER = '[data-automation-id="progressBar"], [data-automation-id="progressBarActiveStep"]';
    // …but Workday draws the same stepper on its Create Account / Sign In step, so only count it past that step.
    const stepperPastAccount = async () => {
      if (!(await shown(WIZARD_STEPPER))) return false;
      if (await ctx.page.locator('input[type="password"]').first().isVisible().catch(() => false)) return false;
      const active = await ctx.page.locator('[data-automation-id="progressBarActiveStep"]').first().innerText().catch(() => '');
      return !!active && !/create account|sign in/i.test(active);
    };
    const isDone = async () =>
      (doneUrl?.test(ctx.page.url()) ?? false) || (await shown(doneSel)) || (!step.metadata?.doneSelector && (await stepperPastAccount()));
    // Accounts belong to the company's site: SuccessFactors moves us from careers.<co>.com to career55.sapsf.eu.

    // Whichever shows first: the account screen, or the form (already signed in / no account).
    for (let waited = 0; waited < 20_000; waited += 1000) {
      if ((await isDone()) || (await shown(sel.email)) || (await shown(sel.createLink)) || (await shown(sel.signInLink))) break;
      await ctx.page.waitForTimeout(1000);
    }
    await declineCookieBanner(ctx.page);
    if ((await isDone()) && !(await shown(sel.email))) return;

    // Read once the account screen shows. One host can serve many companies (career55.sapsf.eu?company=…): the account is per company.
    const here = new URL(ctx.page.url());
    const tenant = here.searchParams.get('company');
    const host = tenant ? `${here.hostname}/${tenant}` : here.hostname;
    const keyName = `account:${host}:password`;
    const site = await siteName(ctx, host);

    let password = await readSecret(ctx, keyName);
    if (password && !(await readSecret(ctx, `${keyName}:user`)) && !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,}$/.test(password)) password = null;
    let mode: 'create' | 'signin' = password ? 'signin' : 'create';
    // A password we made up ourselves is never worth asking the user for: if signing in with it fails, the account probably
    // was never created (an earlier run died first), so try creating it once before concluding it's someone else's account.
    let generated = !(await readSecret(ctx, `${keyName}:user`));
    let triedCreate = mode === 'create';
    // The password the user chose for portals (Settings): new accounts use it, so they can always sign in by hand too.
    const userPortalPassword = await portalPassword.get(ctx.userId).catch(() => null);
    let triedPortal = false;
    if (!password) {
      password = userPortalPassword ?? generatePassword();
      // Saved before the site sees it: a run that dies after creating the account can still sign in.
      await writeSecret(ctx, keyName, password);
      if (userPortalPassword) {
        await writeSecret(ctx, `${keyName}:user`, '1');
        generated = false;
        triedPortal = true;
      }
    }

    // Some tenants open on Google / LinkedIn buttons; the email form hides behind "Sign in with email".
    const revealEmailForm = async () => {
      const viaEmail = ctx.page.locator('button:has-text("Sign in with email"), [role="button"]:has-text("Sign in with email")').first();
      // The screen renders after the step bar: wait for whichever of the two shows.
      for (let waited = 0; waited < 10_000; waited += 500) {
        if ((await shown(sel.email)) || (await viaEmail.isVisible().catch(() => false))) break;
        await ctx.page.waitForTimeout(500);
      }
      if (await shown(sel.email)) return;
      if (await viaEmail.isVisible().catch(() => false)) {
        await clickThrough(viaEmail);
        await ctx.page.locator(sel.email).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      }
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      await revealEmailForm();
      if (mode === 'create') {
        if (!(await shown(sel.verifyPassword)) && (await shown(sel.createLink))) {
          await clickThrough(ctx.page.locator(sel.createLink).first());
          await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
          await ctx.page.locator(sel.createSubmit).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
        }
        await ctx.page.locator(sel.email).first().fill(email);
        await ctx.page.locator(sel.password).first().fill(password);
        if (await shown(sel.verifyPassword)) await ctx.page.locator(sel.verifyPassword).first().fill(password);
        await fillSignupExtras(ctx, step, email, site);
        await acceptSignupTerms(ctx, sel.terms, step.metadata?.termsAccept as string | undefined);
        await clickThrough(ctx.page.locator(sel.createSubmit).first());
      } else {
        if (!(await shown(sel.signInSubmit)) && (await shown(sel.signInLink))) await clickThrough(ctx.page.locator(sel.signInLink).first());
        await ctx.page.locator(sel.email).first().fill(email);
        await ctx.page.locator(sel.password).first().fill(password);
        await clickThrough(ctx.page.locator(sel.signInSubmit).first());
      }

      // Outcome: the form, an error, or "verify your email".
      let problem = '';
      for (let waited = 0; waited < 20_000; waited += 1000) {
        await ctx.page.waitForTimeout(1000);
        if (await isDone()) {
          await stage(ctx, 'account', { site: host, action: mode === 'create' ? 'created' : 'signed in' });
          return;
        }
        const text = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (/verify (your )?(email|account)|verification (email|link)|check your (email|inbox)/i.test(text)) {
          problem = 'verify';
          break;
        }
        const errors = await readFormErrors(ctx.page).catch(() => [] as string[]);
        if (errors.length) {
          problem = errors.join('; ');
          break;
        }
      }

      logger.info('apply:account-attempt', { jobId: ctx.jobId, host, attempt, mode, generated, problem: problem.slice(0, 160) });
      // Right after creating an account, "wrong email or password" means it exists but isn't verified yet.
      if (mode === 'create' && /invalid username|wrong email address or password|account might be locked/i.test(problem)) problem = 'verify';
      if (problem === 'verify') {
        await awaitEmailVerification(ctx, `${step.id}_verify_${attempt}`);
        mode = 'signin';
        await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        // The verification link may already have signed us in; give the form (or the sign-in screen) time to show.
        for (let waited = 0; waited < 45_000; waited += 1000) {
          if ((await isDone()) || (await shown(sel.email))) break;
          await ctx.page.waitForTimeout(1000);
        }
        if (await isDone()) {
          await stage(ctx, 'account', { site: host, action: 'signed in' });
          return;
        }
        continue;
      }
      if (mode === 'create' && /password (must|should|needs)|must include|minimum of|at least \d+ char|too (weak|short)|complexity/i.test(problem)) {
        // No account exists yet, so any password works: make one every site's rules accept.
        password = generatePassword();
        await writeSecret(ctx, keyName, password);
        generated = true;
        if (attempt < 3) continue;
      }
      if (mode === 'create' && /already|exists|in use|registered/i.test(problem)) {
        // An account from before: sign in with the password we have; ask if that fails.
        mode = 'signin';
        continue;
      }
      // A sign-in that fails with a password we made up: the account may be one the user's own portal password opens.
      if (mode === 'signin' && userPortalPassword && !triedPortal && password !== userPortalPassword && /password|credentials|incorrect|invalid|wrong/i.test(problem)) {
        password = userPortalPassword;
        triedPortal = true;
        await writeSecret(ctx, keyName, password);
        await writeSecret(ctx, `${keyName}:user`, '1');
        generated = false;
        continue;
      }
      if (mode === 'signin' && generated && !triedCreate && /password|credentials|incorrect|invalid|wrong|not found|no account/i.test(problem)) {
        mode = 'create';
        triedCreate = true;
        continue;
      }
      if (mode === 'signin' && /password|credentials|incorrect|invalid|wrong/i.test(problem)) {
        // Asked masked and stored encrypted — never remembered as a form answer, never parked.
        password = await askUser(ctx, `${step.id}_password_${attempt}`, 'credentialFill',
          `You already have an account on ${host} with ${email}. What's its password? I'll keep it encrypted for next time. (Tip: set one portal password in Auto Apply settings and I'll use it for every new account.)`);
        if (!password) throw new Error('No password for the existing account');
        await writeSecret(ctx, keyName, password);
        await writeSecret(ctx, `${keyName}:user`, '1');
        generated = false;
        continue;
      }
      throw new Error(problem ? `The site didn't accept the account: ${problem}` : 'Signing in to the site timed out');
    }
    throw new Error('Could not sign in to the site');
  },

  /**
   * Passwordless sign-in (Oracle Recruiting Cloud): email + terms → a code
   * sent to that email (or a text to the phone) → verified → the form. With
   * the private inbox or a connected Gmail the code fills itself in.
   */
  emailCodeSignIn: async (step, ctx) => {
    await loadProfile(ctx);
    const m = (step.metadata ?? {}) as Record<string, string | undefined>;
    const sel = {
      email: m.email ?? '#primary-email-0, input[name="primary-email"], input[type="email"]',
      terms: m.terms ?? '.legal-disclaimer-container, [class*="legal-disclaimer"]',
      next: m.next ?? 'button[type="submit"][title="Next"], button[aria-label="Next"]',
      code: m.code ?? 'input[autocomplete="one-time-code"], input[id^="pin-code"], input[name*="pin" i], input[maxlength="1"], input[aria-label*="code" i], input[aria-label*="digit" i]',
      verify: m.verify ?? 'button[title="Verify"], button[aria-label="Verify"], button[title="Next"], button[type="submit"]',
      phone: m.phone ?? 'input[type="tel"], input[name*="phone" i]',
      done: m.doneSelector,
    };
    const email = ctx.profile?.personal?.email;
    if (!email) throw new Error('Add your email to your profile — this site signs you in with an email code');
    const shown = (s?: string) => (s ? ctx.page.locator(s).first().isVisible().catch(() => false) : Promise.resolve(false));
    const host = new URL(ctx.page.url()).hostname;
    const site = await siteName(ctx, host);
    const pageText = () => ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    // The form: no code boxes and real fields (the sign-in screen has only the email box
    // and its trap field; the form's own contact section has an email field too).
    const onForm = async () => {
      if (await shown(sel.done)) return true;
      if (await shown(sel.code)) return false;
      const fields = await scanForm(ctx.page).catch(() => [] as FormField[]);
      return fields.filter((f) => f.type !== 'file').length >= 3;
    };

    // The sign-in screen shows its email box next to the terms; a remembered session goes straight to the form.
    const onSignIn = async () => (await shown(sel.email)) && (await shown(sel.terms));
    for (let waited = 0; waited < 20_000; waited += 1000) {
      if ((await onSignIn()) || (await onForm())) break;
      await ctx.page.waitForTimeout(1000);
    }
    await declineCookieBanner(ctx.page);
    if (!(await onSignIn())) {
      if (await onForm()) return; // a session from before
      throw new Error("The site's sign-in screen didn't show");
    }

    await ctx.page.locator(sel.email).first().fill(email);
    await tickBox(ctx.page, sel.terms);
    await clickThrough(ctx.page.locator(sel.next).first());

    let codeTries = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      // What the site does next: a code screen, a phone number screen, the form, or an error.
      let state: 'code' | 'phone' | 'form' | 'error' | 'none' = 'none';
      for (let waited = 0; waited < 25_000 && state === 'none'; waited += 1000) {
        await ctx.page.waitForTimeout(1000);
        if (await shown(sel.code)) state = 'code';
        else if (await onForm()) state = 'form';
        else if ((await shown(sel.phone)) && !(await onSignIn())) state = 'phone';
        else if ((await readFormErrors(ctx.page).catch(() => [] as string[])).length) state = 'error';
      }
      if (state === 'form') {
        await stage(ctx, 'account', { site: host, action: 'signed in', via: 'email code' });
        return;
      }
      if (state === 'error') {
        const errors = await readFormErrors(ctx.page).catch(() => [] as string[]);
        if (attempt < 2 && errors.some((e) => /agree|terms|consent/i.test(e)) && (await onSignIn())) {
          await tickBox(ctx.page, sel.terms);
          await clickThrough(ctx.page.locator(sel.next).first());
          continue;
        }
        throw new Error(`The site didn't accept the sign-in: ${errors.slice(0, 2).join('; ')}`);
      }
      if (state === 'phone') {
        const phone = await ensurePhone(ctx, `${step.id}_phone`, site, 'wants to text you a sign-in code');
        await ctx.page.locator(sel.phone).first().fill(splitPhone(phone, countryCode(ctx)).national);
        await clickThrough(ctx.page.locator(sel.next).first());
        continue;
      }
      if (state === 'none') throw new Error('The sign-in code screen never showed');

      // A code: texted to the phone, or emailed (the inbox / Gmail reads that one for us).
      const text = await pageText();
      const bySms = /text message|\bsms\b|sent to (your )?(mobile|phone)|\+\d[\d\s-]{6,}/i.test(text) && !/sent to .*@/i.test(text);
      const phone = ctx.profile?.personal?.phone;
      const prompt = codeTries++
        ? 'That code didn’t work. Enter the newest one the site sent.'
        : bySms
          ? `${site} texted a sign-in code to ${phone ? maskPhone(phone) : 'your phone'}. What is it?`
          : mailReadForUser(ctx)
            ? `${site} emailed a sign-in code to ${mailboxPhrase(ctx)} — I'll fill it in as soon as it arrives.`
            : `${site} emailed a sign-in code to ${mailboxPhrase(ctx)}. What is it?`;
      // Emailed codes: read from the inbox first; ask only if none arrives.
      const mailed = !bySms && mailReadForUser(ctx) ? await waitForMailedCode(ctx, Date.now() - 5000, 45_000) : null;
      const code = mailed ?? (await askUser(ctx, `${step.id}_code_${codeTries}`, 'otp', !bySms && mailReadForUser(ctx) ? `${site} emailed a sign-in code but I couldn't read it from ${mailboxPhrase(ctx)}. What is it?` : prompt, { sensitive: true, channel: bySms ? 'sms' : 'email-manual' }));
      if (!code) throw new Error('No sign-in code');
      await enterCode(ctx.page, code, sel.code);
      await ctx.page.waitForTimeout(400);
      // Split boxes often submit on the last digit; otherwise press the site's button.
      if (await shown(sel.code)) {
        const button = ctx.page.locator(sel.verify).filter({ hasText: /verify|confirm|submit|next|continue/i }).first();
        if (await button.isVisible().catch(() => false)) await clickThrough(button);
      }
      await stage(ctx, 'account', { site: host, action: 'code entered', via: bySms ? 'sms' : 'email' });
    }
    throw new Error('Could not sign in with the code');
  },

  /**
   * Fill a form spread over several pages: each page from the profile and
   * remembered answers (asking for required unknowns), then the site's Next
   * button, until its review page (the button reads "Submit").
   */
  fillWizard: async (step, ctx) => {
    await loadProfile(ctx);
    const nextSel = (step.metadata?.next as string | undefined) ?? WORKDAY_NEXT;
    const maxPages = Number(step.metadata?.maxPages ?? 12);
    const answers: FieldAnswer[] = [];
    const allFields: FormField[] = [];
    const missing: FormField[] = [];
    const pages: string[] = [];
    const nextText = async () => (await ctx.page.locator(nextSel).first().innerText({ timeout: 2000 }).catch(() => '')).trim();
    const pageTitle = async () => {
      for (const s of ['[data-automation-id="progressBarActiveStep"]', '[data-automation-id="pageHeader"]', 'main h2', 'h2', 'h1']) {
        const t = (await ctx.page.locator(s).first().innerText({ timeout: 500 }).catch(() => '')).trim();
        if (t) return t.split('\n').pop()!.trim().slice(0, 80);
      }
      return `Page ${pages.length + 1}`;
    };

    const finalRe = step.metadata?.finalPattern ? new RegExp(String(step.metadata.finalPattern), 'i') : /submit/i;
    for (let i = 0; i < maxPages; i++) {
      // Each page renders client-side: wait for its Next button.
      await ctx.page.locator(nextSel).first().waitFor({ state: 'visible', timeout: 30_000 });
      await ctx.page.waitForTimeout(800);
      // Aadhaar / DigiLocker: the person's details are asked in chat and typed in, one step at a time.
      if (step.metadata?.identityHandoff) {
        const body = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (isIdentityGate(body)) {
          await verifyIdentity(ctx, step.id);
          i--; // the verification pages don't count as application pages
          continue;
        }
      }
      if (finalRe.test(await nextText())) {
        if (step.metadata?.fillLastPage) {
          const title = await pageTitle();
          const fields = await scanForm(ctx.page, step.target?.value).catch(() => [] as FormField[]);
          if (fields.length) {
            const { filled, stillMissing } = await fillPage(step, ctx, fields, `${step.id}_p${i}_ask`);
            for (const a of filled) a.page = i;
            answers.push(...filled);
            allFields.push(...fields);
            missing.push(...stillMissing);
            pages.push(title);
            await stage(ctx, 'answers', {
              page: title,
              filled: filled.length,
              missing: stillMissing.map((f) => f.label),
              answers: filled.map((a) => ({ label: a.field.label || a.field.name, source: a.source, required: a.field.required, kind: a.field.type })),
            });
          }
        }
        ctx.form = { fields: allFields, answers, missing, pages };
        await stage(ctx, 'parse', { pages: pages.length, fields: allFields.length, required: allFields.filter((f) => f.required).length, url: ctx.page.url() });
        return;
      }
      const title = await pageTitle();
      // Client-rendered pages show Next before their fields: give them a few seconds to appear.
      let fields = await scanForm(ctx.page, step.target?.value).catch(() => [] as FormField[]);
      for (let w = 0; w < 6 && !fields.length; w++) {
        await ctx.page.waitForTimeout(1000);
        fields = await scanForm(ctx.page, step.target?.value).catch(() => [] as FormField[]);
      }
      const { filled, stillMissing } = fields.length
        ? await fillPage(step, ctx, fields, `${step.id}_p${i}_ask`)
        : { filled: [] as FieldAnswer[], stillMissing: [] as FormField[] };
      for (const a of filled) a.page = i;
      answers.push(...filled);
      allFields.push(...fields);
      missing.push(...stillMissing);
      pages.push(title);
      await stage(ctx, 'answers', {
        page: title,
        filled: filled.length,
        missing: stillMissing.map((f) => f.label),
        answers: filled.map((a) => ({ label: a.field.label || a.field.name, source: a.source, required: a.field.required, kind: a.field.type })),
      });

      const before = `${title}|${ctx.page.url()}`;
      await clickThrough(ctx.page.locator(nextSel).first());
      let moved = false;
      for (let waited = 0; waited < 20_000 && !moved; waited += 1000) {
        await ctx.page.waitForTimeout(1000);
        moved = `${await pageTitle()}|${ctx.page.url()}` !== before || finalRe.test(await nextText());
      }
      if (!moved && !fields.length) {
        // Nothing was filled and the site said no: re-read the page once, fill what it now shows, and try again.
        const again = await scanForm(ctx.page, step.target?.value).catch(() => [] as FormField[]);
        if (again.length) {
          const retry = await fillPage(step, ctx, again, `${step.id}_p${i}_retry`);
          for (const a of retry.filled) a.page = i;
          answers.push(...retry.filled);
          allFields.push(...again);
          missing.push(...retry.stillMissing);
          await clickThrough(ctx.page.locator(nextSel).first());
          for (let waited = 0; waited < 15_000 && !moved; waited += 1000) {
            await ctx.page.waitForTimeout(1000);
            moved = `${await pageTitle()}|${ctx.page.url()}` !== before || finalRe.test(await nextText());
          }
        }
      }
      if (!moved) {
        // Whatever the scanner missed becomes a question for the person instead of a dead end.
        const asked = await askAboutRejectedPage(step, ctx, `${step.id}_p${i}_rej`).catch(() => 0);
        if (asked) {
          await clickThrough(ctx.page.locator(nextSel).first());
          for (let waited = 0; waited < 15_000 && !moved; waited += 1000) {
            await ctx.page.waitForTimeout(1000);
            moved = `${await pageTitle()}|${ctx.page.url()}` !== before || finalRe.test(await nextText());
          }
        }
      }
      if (!moved) {
        await stage(ctx, 'diagnostic', { why: 'page not accepted', ...(await pageDiagnostic(ctx.page)) });
        const errors = await readFormErrors(ctx.page).catch(() => [] as string[]);
        throw new Error(`The site didn't accept "${title}"${errors.length ? `: ${errors.slice(0, 3).join('; ')}` : ''}`);
      }
    }
    throw new Error(`The form has more than ${maxPages} pages`);
  },

  /** A login / registration page's image captcha: the user types what the picture says (retried if the site rejects it). */
  solveTextCaptcha: async (_step, ctx) => {
    const fields = await scanForm(ctx.page).catch(() => [] as FormField[]);
    const captcha = fields.find((f) => f.type === 'captcha');
    if (!captcha) return;
    await askTextCaptcha(ctx, captcha, 0);
  },

  /**
   * Recruitment portals: a multi-page application (Save & Next … Preview …
   * Final Submit). Same engine as fillWizard with the buttons government
   * portals use, and a stop for identity checks only the person can do.
   */
  govWizard: async (step, ctx) => {
    await ACTION_HANDLERS.fillWizard(
      {
        ...step,
        metadata: {
          next: GOV_NEXT,
          finalPattern: '(final\\s*)?submit|confirm.*submit|submit.*application',
          fillLastPage: true,
          identityHandoff: true,
          maxPages: 20,
          captchas: 'inline',
          ...step.metadata,
        },
      },
      ctx,
    );
  },

  reviewForm: async (step, ctx) => {
    await loadProfile(ctx);
    if (ctx.profile?.settings?.reviewBeforeSubmit === false && !ctx.stopBeforeSubmit) return;
    const form = ctx.form;
    if (!form) throw new Error('reviewForm needs autofillForm first');
    const kindOf = (f: FormField) =>
      f.type === 'file' ? 'file' : f.tag === 'textarea' ? 'textarea' : f.tag === 'select' || f.type === 'radio' || f.type === 'checkbox' ? 'select'
        : f.type === 'email' ? 'email' : f.type === 'tel' ? 'phone' : f.type === 'number' ? 'number' : 'text';
    // Multi-page forms: earlier pages are behind us, so their answers are shown
    // locked (fix them in the profile and apply again), one section per page.
    const wizard = !!form.pages?.length;
    const idOf = (a: FieldAnswer) => (a.page !== undefined ? `p${a.page}f${a.field.idx}` : `f${a.field.idx}`);
    const fields = form.answers.map((a) => ({
      id: idOf(a),
      section: a.page !== undefined ? form.pages?.[a.page] : undefined,
      locked: wizard || undefined,
      // Upload widgets often label their input with status text ("Unable to process…").
      label: a.key === 'resume' ? 'Résumé' : a.field.label || a.field.name,
      kind: kindOf(a.field),
      value: a.key === 'resume' ? (ctx.profile?.documents?.resumeFileName ?? 'Resume') : a.value,
      source: a.source === 'prefilled' ? 'workflow' : a.source,
      required: a.field.required,
      options: realOptions(a.field.options).length ? realOptions(a.field.options).map((o) => ({ label: o, value: o })) : undefined,
    }));
    const reviewId = `${step.id}_review`;
    // Continuation of a parked review: the user already approved these exact
    // answers. Only a form that grew new answers since then is shown again.
    const labelOf = (f: (typeof fields)[number]) => (f.section ? `${f.section} · ${f.label}` : f.label);
    const approvedBefore = ctx.approved;
    ctx.approved = undefined;
    if (approvedBefore && fields.every((f) => f.label === 'Résumé' || labelOf(f) in approvedBefore)) {
      const values: Record<string, string> = {};
      for (const f of fields) if (f.label !== 'Résumé') values[f.id] = approvedBefore[labelOf(f)];
      ctx.runtimeInputs[reviewId] = JSON.stringify({ action: 'approve', values });
      await stage(ctx, 'approved', { fields: fields.length, via: 'parked review' });
    } else await ACTION_HANDLERS.pauseForUserInput({
      id: reviewId,
      action: 'pauseForUserInput',
      expectedInput: 'review' as any,
      timeout: step.timeout && step.timeout > 60_000 ? step.timeout : 24 * 60 * 60_000,
      description: 'Review before submitting',
      contextMessage: `Ready to submit — check ${fields.length} answers`,
      metadata: {
        skipChallengeDetection: true,
        pauseData: {
          title: ctx.jobContext?.title ? `${ctx.jobContext.title}${ctx.jobContext.company ? ` · ${ctx.jobContext.company}` : ''}` : 'Review before submit',
          site: ctx.jobContext?.company,
          siteUrl: ctx.page.url(),
          actionLabel: 'Submit application',
          sections: wizard
            ? form.pages!.map((title, i) => ({ id: `p${i}`, title, fields: fields.filter((f) => f.id.startsWith(`p${i}f`)) }))
                .filter((sec) => sec.fields.length)
            : [{ id: 'answers', title: 'Answers', fields }],
          missing: form.missing.map((f) => f.label),
        },
        park: {
          kind: 'review',
          reviewFields: fields.map((f) => ({ id: f.id, label: labelOf(f), value: f.value })),
        } satisfies ParkSpec,
      },
    }, ctx);

    // The approved values are used verbatim — edits are written back to the form.
    let approved: { action?: string; values?: Record<string, string> } = {};
    try {
      approved = JSON.parse(ctx.runtimeInputs[reviewId] ?? '{}');
    } catch {
      approved = { action: 'approve' };
    }
    if (approved.action && approved.action !== 'approve') throw new JobCancelledError(ctx.jobId);
    if (wizard) return; // locked: nothing to write back
    for (let [id, value] of Object.entries(approved.values ?? {})) {
      const a = form.answers.find((x) => idOf(x) === id);
      if (!a || a.key === 'resume' || a.value === value) continue;
      // A choice field only takes one of its own options.
      if (a.field.tag === 'select' || a.field.type === 'radio') {
        const pick = pickOption(realOptions(a.field.options), value);
        if (!pick) {
          logger.warn('review:invalid-choice-ignored', { jobId: ctx.jobId, label: a.field.label });
          continue;
        }
        value = pick;
      }
      await fillField(ctx.page, { field: a.field, value });
      a.value = value;
      if (a.source !== 'profile') await answerMemory.remember(ctx.userId, a.field.label, value).catch(() => {});
    }
  },

  submitForm: async (step, ctx) => {
    // What was reviewed is what gets sent: re-check every answer right before submit.
    if (ctx.form) {
      const now = await scanForm(ctx.page).catch(() => [] as FormField[]);
      let fixed = 0;
      const fixedLabels: string[] = [];
      for (const a of ctx.form.answers) {
        // Files, radios and typeahead dropdowns don't keep their value in the input itself.
        if (a.key === 'resume' || a.field.type === 'radio' || a.field.type === 'combobox' || a.field.type === 'file') continue;
        const cur = now.find((f) =>
          a.field.selector ? f.selector === a.field.selector : f.label === a.field.label && f.type === a.field.type,
        );
        // Only a value that changed to something else is drift; an emptied box is a
        // picker widget (Lever location/school) that keeps its choice elsewhere.
        if (cur && cur.value.trim() && cur.value.trim() !== a.value.trim() && a.field.tag !== 'select') {
          await fillField(ctx.page, a).catch(() => {});
          fixed++;
          fixedLabels.push(`${a.field.label}: "${cur.value.slice(0, 40)}" → "${a.value.slice(0, 40)}"`);
        }
      }
      if (fixed) logger.warn('submit:drift-corrected', { jobId: ctx.jobId, fixed });
      await stage(ctx, 'verified', { answers: ctx.form.answers.length, corrected: fixed, ...(fixed ? { fields: fixedLabels } : {}) });
    }
    if (ctx.stopBeforeSubmit) {
      await stage(ctx, 'submit_skipped', { reason: 'test run' });
      ctx.extractedData.submitted = 'skipped (test run)';
      logger.info('submit:skipped-test-run', { jobId: ctx.jobId });
      return;
    }
    // Captchas are solved by the user right before the click, from a cropped image.
    const textCaptchas = async (attempt: number) => {
      for (const f of (await scanForm(ctx.page)).filter((x) => x.type === 'captcha')) await askTextCaptcha(ctx, f, attempt);
    };
    await textCaptchas(0);
    const checkbox = await untickedCheckbox(ctx.page);
    if (checkbox) await askClickCaptcha(ctx, checkbox, 'checkbox');

    const startUrl = ctx.page.url();
    // Re-resolved on every use: a server-rendered retry is a new page.
    const explicit = step.target?.value ? await resolveLocator(step, ctx) : null;
    // The real submit is the last matching control on the page: a job page's header "Apply" only scrolls to the form.
    const submitButton = async (): Promise<Locator> => {
      if (explicit) return explicit;
      const tiers = [
        // Lever: the visible button is type=button; the type=submit one is hCaptcha's hidden trigger.
        ctx.page.locator('#btn-submit, [data-qa="btn-submit"], button.template-btn-submit'),
        ctx.page.locator('button[type="submit"]:visible, input[type="submit"]:visible'),
        ctx.page.locator('button, [role="button"]').filter({ hasText: /submit|send application|finish|complete application/i }),
        ctx.page.locator('button, [role="button"]').filter({ hasText: /apply/i }),
      ];
      for (const tier of tiers) if (await tier.count().catch(() => 0)) return tier.last();
      return tiers[0];
    };
    await (await submitButton()).scrollIntoViewIfNeeded().catch(() => {});
    // What the site answered to the submit (a silent block shows as a missing or failing POST).
    const posts: string[] = [];
    const onResponse = (r: import('playwright').Response) => {
      if (r.request().method() === 'POST') posts.push(`${r.status()} ${r.url().split('?')[0].slice(0, 110)}`);
    };
    ctx.page.on('response', onResponse);
    let clickedAt = Date.now();
    await clickThrough(await submitButton());
    await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
    let securityCodes = 0;

    // Success = a confirmation message or a new page without form errors.
    const confirm = /thank you|application (has been |was |is )?(successfully )?(received|submitted)|we('ve| have) received|successfully submitted|submitted successfully|application complete|acknowledg\w+ (slip|receipt|number)/i;
    const submitWindow = step.timeout && step.timeout > 10_000 ? step.timeout : 30_000;
    let deadline = Date.now() + submitWindow;
    let captchaRetries = 0;
    while (Date.now() < deadline) {
      // Invisible reCAPTCHA may open a picture challenge after the click.
      const challenge = await visibleClickChallenge(ctx.page);
      if (challenge) {
        await askClickCaptcha(ctx, challenge);
        // The time the person took to answer doesn't count against the site's response window.
        deadline = Date.now() + submitWindow;
        continue;
      }
      // Greenhouse's emailed security code: read it, type it, press Submit again.
      if (securityCodes < 3 && (await enterEmailedSecurityCode(ctx, clickedAt - 3000, securityCodes))) {
        securityCodes++;
        clickedAt = Date.now();
        deadline = Date.now() + submitWindow; // the wait for the mail doesn't count against the submit
        await clickThrough(await submitButton());
        await ctx.page.waitForTimeout(1500);
        continue;
      }
      const text = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const match = text.match(confirm);
      if (match) {
        ctx.extractedData.confirmation = match[0];
        // A reference has a digit — "Application Submitted" is not one.
        const ref = text.match(/\b(?:reference|application|confirmation)\s*(?:id|no\.?|number|#)?\s*[:#]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{5,})\b/i);
        if (ref) ctx.extractedData.reference = ref[1];
        await stage(ctx, 'submitted', { confirmation: match[0], reference: ref?.[1] ?? null });
        return;
      }
      const errors = await readFormErrors(ctx.page).catch(() => []);
      // Sites that validate server-side re-render the form at another URL, so
      // "still on the form" is about the fields, not the address.
      const onForm = errors.length ? (await scanForm(ctx.page).catch(() => [] as FormField[])).some((f) => f.type !== 'file') : false;
      // Wrong captcha: the site shows a new image — ask again (twice at most).
      if (errors.some((e) => /captcha|security code|characters/i.test(e)) && captchaRetries < 2 && onForm) {
        captchaRetries++;
        // A server re-render is a fresh form: put back what it dropped (files always are).
        await restoreAnswers(ctx);
        await textCaptchas(captchaRetries);
        deadline = Date.now() + submitWindow;
        await clickThrough(await submitButton());
        await ctx.page.waitForTimeout(1500);
        continue;
      }
      if (errors.length && onForm) {
        throw new Error(`The site rejected the form: ${errors.slice(0, 3).join('; ')}`);
      }
      await ctx.page.waitForTimeout(1000);
    }
    const formGone = !(await scanForm(ctx.page).catch(() => [] as FormField[])).some((f) => f.type !== 'file');
    if (ctx.page.url() !== startUrl && formGone) {
      ctx.extractedData.confirmation = 'Moved past the form';
      await stage(ctx, 'submitted', { confirmation: 'Moved past the form', reference: null });
      return;
    }
    // Say what the page showed, so "never confirmed" can be told apart from a missed code step or a block.
    const shown = await ctx.page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 700)).catch(() => '');
    ctx.page.off('response', onResponse);
    const alerts = await ctx.page.evaluate(() => Array.from(document.querySelectorAll('[role="alert"], [class*="error" i], [class*="invalid" i], .recaptcha-error')).map((e) => (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6)).catch(() => []);
    const shotDir = join(process.cwd(), '..', '.dev-data', 'diagnostics');
    await mkdir(shotDir, { recursive: true }).catch(() => {});
    const shotPath = join(shotDir, `${ctx.jobId}.png`);
    await ctx.page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    await stage(ctx, 'diagnostic', { why: 'submit not confirmed', url: ctx.page.url(), posts: posts.slice(-8), alerts, screenshot: shotPath, securityBoxes: await ctx.page.locator('input[id^="security-input"]').count().catch(() => -1), shown: shown.slice(0, 200) });
    // Visible validation messages mean the form was refused, not "sent but unconfirmed".
    const refusals = [...new Set((alerts as string[]).filter((m) => m.length < 160 && /required|must|invalid|please|select|enter|choose|error/i.test(m)))];
    if (refusals.length && !posts.some((x) => /^2\d\d /.test(x))) throw new Error(`The site rejected the form: ${refusals.slice(0, 3).join('; ')}`);
    throw new Error('Submitted, but the site never confirmed the application');
  },
};

/**
 * Cookie banners: click "Decline non-essential" / "Reject all" / "Necessary
 * only" if one is showing — never "Accept". No banner → nothing happens.
 */
async function declineCookieBanner(page: Page): Promise<void> {
  const decline = page
    .locator('button, a, [role="button"], lyte-button')
    .filter({ hasText: /^\s*(decline|reject|refuse)( all)?( non-essential| optional)?( cookies)?\s*$|^\s*(only )?(strictly )?(necessary|essential)( cookies)?( only)?\s*$|^\s*use necessary cookies only\s*$/i })
    .first();
  if (await decline.isVisible().catch(() => false)) {
    await decline.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
}

/** The buttons recruitment portals use to move on (Save & Next, Save and Continue, Proceed, Preview, Submit). */
const GOV_NEXT = [
  'button:has-text("Save & Next")', 'button:has-text("Save and Next")', 'button:has-text("Save & Continue")',
  'button:has-text("Save and Continue")', 'button:has-text("Save & Proceed")', 'button:has-text("Next")',
  'button:has-text("Continue")', 'button:has-text("Proceed")', 'button:has-text("Preview")',
  'input[type="submit"][value*="Save"]', 'input[type="button"][value*="Next"]', 'input[type="submit"][value*="Next"]',
  'input[type="submit"][value*="Proceed"]', 'button:has-text("Final Submit")', 'button:has-text("Submit")',
  'button:has-text("Login")', 'button:has-text("Log in")', 'button:has-text("Sign in")',
  'button:has-text("Verify")', 'input[type="submit"][value*="Verify"]', 'input[type="submit"][value*="Login"]', 'input[type="submit"][value*="Sign in"]',
].join(', ');

/** Workday: the same automation ids on every company's site. */
const WORKDAY_NEXT = '[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]';
const WORKDAY_ACCOUNT = {
  email: '[data-automation-id="email"]',
  password: '[data-automation-id="password"]',
  verifyPassword: '[data-automation-id="verifyPassword"]',
  terms: '[data-automation-id="createAccountCheckbox"]',
  createLink: '[data-automation-id="createAccountLink"]',
  createSubmit: '[data-automation-id="createAccountSubmitButton"]',
  signInLink: '[data-automation-id="signInLink"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
};

/**
 * Sign-up forms that want more than email + password (SuccessFactors: retyped
 * email, name, phone with country code, country). `metadata.signup` maps a
 * selector to the profile value it takes; a phone the profile lacks is asked.
 */
async function fillSignupExtras(ctx: ExecutionContext, step: ActionStep, email: string, site: string): Promise<void> {
  const map = (step.metadata?.signup as Record<string, string> | undefined) ?? {};
  const p = ctx.profile?.personal ?? {};
  const [first, ...rest] = (p.fullName ?? '').trim().split(/\s+/);
  const cc = countryCode(ctx);
  for (const [selector, from] of Object.entries(map)) {
    const loc = ctx.page.locator(selector).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    let value = '';
    if (from === 'email') value = email;
    else if (from === 'firstName') value = p.firstName ?? first ?? '';
    else if (from === 'lastName') value = p.lastName ?? rest.join(' ');
    else if (from === 'phone' || from === 'phoneNational' || from === 'phoneDialCode') {
      const phone = await ensurePhone(ctx, `${step.id}_phone`, site, 'asks for a phone number to create your account');
      const parts = splitPhone(phone, cc);
      value = from === 'phone' ? phone : from === 'phoneNational' ? parts.national : parts.dial ? `+${parts.dial}` : '';
    } else if (from === 'country') value = DIAL_CODES[cc ?? '']?.name ?? p.country ?? '';
    if (!value) continue;
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input');
    if (tag === 'select') {
      const options = (await loc.locator('option').allInnerTexts().catch(() => [] as string[])).map((o) => o.trim()).filter(Boolean);
      // "India (+91)" for a dial code, "India" for a country.
      const dial = from === 'phoneDialCode' ? value.replace('+', '') : null;
      const pick = dial
        ? options.find((o) => o.startsWith(`${DIAL_CODES[cc ?? '']?.name ?? ''} (+${dial})`)) ?? options.find((o) => o.includes(`(+${dial})`))
        : pickOption(options, value);
      if (pick) await loc.selectOption({ label: pick }).catch(() => {});
    } else {
      await loc.fill(value);
    }
  }
}

/** The terms box at sign-up, or a "Read and accept" link that opens the statement with an Accept button. */
async function acceptSignupTerms(ctx: ExecutionContext, termsSel: string, acceptSel?: string): Promise<void> {
  const terms = ctx.page.locator(termsSel).first();
  if (!(await terms.count())) return;
  const kind = await terms.evaluate((el) => `${el.tagName}:${(el as HTMLInputElement).type ?? ''}`).catch(() => '');
  if (/INPUT:checkbox/i.test(kind)) {
    if (!(await terms.isChecked().catch(() => true))) await terms.check({ force: true }).catch(() => terms.click({ force: true }));
    return;
  }
  await clickThrough(terms);
  const accept = ctx.page.locator(acceptSel ?? 'button, [role="button"]').filter({ hasText: /^\s*(i )?accept\s*$|^\s*agree\s*$/i }).first();
  if (await accept.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) await clickThrough(accept);
}

/** Tick a consent box that may be a real checkbox, a role="checkbox" widget, or a clickable label. */
async function tickBox(page: Page, containerSel: string): Promise<void> {
  // The first attempt may fail on a hidden/overlaid box; the visible-text fallbacks below take over.
  await tickBoxOnce(page, containerSel).catch(() => {});
  const box = page.locator(containerSel).first();
  const ticked = async () =>
    box
      .evaluate((el) => {
        const i = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        const w = el.querySelector('[role="checkbox"], [aria-checked]');
        return i ? i.checked : w ? w.getAttribute('aria-checked') === 'true' : true; // unknown widget: assume it took
      })
      .catch(() => true);
  // Styled checkboxes (Oracle JET…) hide the input: click what a person would — the words, then the box icon.
  for (const target of [
    box.getByText(/\b(agree|accept|consent|terms|read)\b/i).first(),
    box.locator('[class*="checkbox-icon"], [class*="checkbox"], label').first(),
  ]) {
    if (await ticked()) return;
    await target.click({ timeout: 3_000 }).catch(() => target.click({ timeout: 3_000, force: true }).catch(() => {}));
    await page.waitForTimeout(300);
  }
}

async function tickBoxOnce(page: Page, containerSel: string): Promise<void> {
  const box = page.locator(containerSel).first();
  if (!(await box.count())) return;
  const input = box.locator('input[type="checkbox"]').first();
  if (await input.count()) {
    if (!(await input.isChecked().catch(() => true))) await input.check({ force: true, timeout: 5_000 }).catch(() => box.click({ timeout: 5_000, force: true }));
    return;
  }
  const widget = box.locator('[role="checkbox"]').first();
  if (await widget.count()) {
    if ((await widget.getAttribute('aria-checked')) === 'true') return;
    // The widget can be an empty styled span: the label around it takes the click, as for a person.
    if (await widget.isVisible().catch(() => false)) await clickThrough(widget);
    else await box.click({ timeout: 8_000 });
    if ((await widget.getAttribute('aria-checked')) !== 'true') await box.click({ timeout: 8_000 }).catch(() => {});
    return;
  }
  await box.click({ timeout: 8_000 });
}

/** Click, or force it when an overlay (Workday's click_filter) intercepts the pointer. */
async function clickThrough(loc: Locator): Promise<void> {
  try {
    await loc.click({ timeout: 8_000 });
  } catch {
    await loc.click({ timeout: 8_000, force: true });
  }
}

/**
 * Strong enough for every applicant system's password rules, and short enough
 * for the strictest (SuccessFactors: 8–18 characters, no spaces).
 */
function generatePassword(): string {
  return `${randomBytes(9).toString('base64url')}Aa1!`;
}

async function readSecret(ctx: ExecutionContext, keyName: string): Promise<string | null> {
  const { rows } = await getPgPool().query(
    'SELECT encrypted_value FROM user_secrets WHERE user_id = $1 AND site_id = $2 AND key_name = $3',
    [ctx.userId, ctx.siteId, keyName],
  );
  return rows[0] ? cryptoService.decrypt(rows[0].encrypted_value) : null;
}

async function writeSecret(ctx: ExecutionContext, keyName: string, value: string): Promise<void> {
  await getPgPool().query(
    `INSERT INTO user_secrets (user_id, site_id, key_name, encrypted_value) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, site_id, key_name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
    [ctx.userId, ctx.siteId, keyName, cryptoService.encrypt(value)],
  );
}

/** Ask the user one thing mid-run (not parked: secrets must never land in answer memory). */
/** A plain question to the person (not a code, password, upload, cover letter or something the profile owns). */
function genericAsk(f: FormField, written: Map<number, string>, fields: FormField[], ctx: ExecutionContext, step: ActionStep): boolean {
  if (written.get(f.idx) || f.type === 'file' || step.metadata?.askForMissing === false) return false;
  if (isOtpField(f.label) || isSecretField(f.label, f.type)) return false;
  if (isLoginIdField(f.label) && fields.some((x) => x.type === 'password')) return false;
  if (/cover(ing)? letter|motivation letter/i.test(f.label)) return false;
  if ((f.type === 'tel' || /\b(mobile|phone|cell)\b/i.test(f.label)) && !realOptions(f.options).length && !ctx.profile?.personal?.phone) return false;
  if (f.type === 'combobox' && ['school', 'degree', 'field'].includes(ruleFor(f) ?? '')) return false;
  return identityFieldKind(f.label, f.type) !== 'aadhaar';
}

async function askUser(ctx: ExecutionContext, id: string, expectedInput: string, message: string, extra: Record<string, unknown> = {}): Promise<string> {
  await ACTION_HANDLERS.pauseForUserInput({
    id,
    action: 'pauseForUserInput',
    expectedInput: expectedInput as ActionStep['expectedInput'],
    timeout: 10 * 60_000,
    description: message,
    contextMessage: message,
    metadata: { skipChallengeDetection: true, pauseData: { question: message, ...extra } },
  }, ctx);
  const value = (ctx.runtimeInputs[id] ?? '').trim();
  delete ctx.runtimeInputs[id];
  return value;
}

// ─── Account verification: email codes, links, phone codes ────────────────

/** Country calling codes for the countries we place jobs in (others: the number as typed). */
const DIAL_CODES: Record<string, { dial: string; name: string }> = {
  IN: { dial: '91', name: 'India' }, US: { dial: '1', name: 'United States' }, GB: { dial: '44', name: 'United Kingdom' },
  CA: { dial: '1', name: 'Canada' }, AU: { dial: '61', name: 'Australia' }, SG: { dial: '65', name: 'Singapore' },
  AE: { dial: '971', name: 'United Arab Emirates' }, DE: { dial: '49', name: 'Germany' }, IE: { dial: '353', name: 'Ireland' },
  NL: { dial: '31', name: 'Netherlands' }, FR: { dial: '33', name: 'France' },
};

/** "+91 98765 43210" → { dial: '91', national: '9876543210' }; a bare 10-digit number takes the country's code. */
export function splitPhone(phone: string, country?: string): { dial: string | null; national: string } {
  const digits = phone.replace(/[^\d+]/g, '');
  const code = DIAL_CODES[(country ?? '').toUpperCase()]?.dial ?? null;
  if (digits.startsWith('+')) {
    const known = Object.values(DIAL_CODES).map((d) => d.dial).sort((a, b) => b.length - a.length).find((d) => digits.startsWith(`+${d}`));
    if (known) return { dial: known, national: digits.slice(known.length + 1) };
    return { dial: null, national: digits.slice(1) };
  }
  if (code === '91' && /^0?\d{10}$/.test(digits)) return { dial: code, national: digits.replace(/^0/, '') };
  if (code && digits.startsWith(code) && digits.length > code.length + 8) return { dial: code, national: digits.slice(code.length) };
  return { dial: code, national: digits.replace(/^0/, '') };
}

/** The user's country as an ISO code ("India" / "IN" → "IN"). */
function countryCode(ctx: ExecutionContext): string | undefined {
  const c = (ctx.profile?.personal?.country ?? ctx.jobContext?.country ?? '').trim();
  if (c.length === 2) return c.toUpperCase();
  return Object.entries(DIAL_CODES).find(([, d]) => d.name.toLowerCase() === c.toLowerCase())?.[0];
}

/**
 * A mobile number for a site that texts a code or requires one at sign-up.
 * Asked once and saved to the profile, so the next site doesn't ask again.
 */
async function ensurePhone(ctx: ExecutionContext, id: string, site: string, why: string): Promise<string> {
  await loadProfile(ctx);
  const have = ctx.profile?.personal?.phone?.trim();
  if (have) return have;
  const phone = await askUser(ctx, id, 'mobile', `${site} ${why}. What's your mobile number? I'll save it to your profile.`);
  if (!/\d{6,}/.test(phone.replace(/\D/g, ''))) throw new Error(`${site} needs a mobile number`);
  ctx.profile = { ...ctx.profile, personal: { ...ctx.profile?.personal, phone } };
  await profileService.patch(ctx.userId, { personal: { phone } }, 'apply').catch(() => {});
  return phone;
}

/** Last four digits only — codes and numbers never appear in full in a message. */
const maskPhone = (phone: string) => `••••• ${phone.replace(/\D/g, '').slice(-4)}`;

/** Type a one-time code into one box, or one digit per box (Oracle-style split inputs). */
async function enterCode(page: Page, code: string, boxesSel: string): Promise<boolean> {
  const boxes = page.locator(boxesSel);
  const n = await boxes.count();
  const visible: Locator[] = [];
  for (let i = 0; i < n; i++) if (await boxes.nth(i).isVisible().catch(() => false)) visible.push(boxes.nth(i));
  if (!visible.length) return false;
  const chars = code.replace(/\s+/g, '');
  if (visible.length > 1 && visible.length >= chars.length) {
    for (let i = 0; i < chars.length; i++) {
      await visible[i].fill(chars[i]).catch(async () => { await visible[i].click(); await page.keyboard.type(chars[i]); });
    }
  } else {
    await visible[0].fill(chars);
  }
  return true;
}

/** Registrable part of a host ("ejgk.fa.em2.oraclecloud.com" → "oraclecloud.com"). */
const baseDomain = (host: string) => host.split('.').slice(-2).join('.');
const VERIFY_LINK_HOSTS = /(^|\.)(myworkdayjobs\.com|myworkday\.com|successfactors\.(com|eu)|sapsf\.(com|eu|cn)|oraclecloud\.com|taleo\.net|zohorecruit\.(com|in|eu)|freshteam\.com|keka\.com)$/i;

/**
 * Open a verification link from the site's email in this browser (same
 * cookies), then come back. Only links to the site itself or a known
 * applicant system are opened — never an arbitrary address from an email.
 */
async function openVerifyLink(ctx: ExecutionContext, link: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const siteHost = new URL(ctx.page.url()).hostname;
  // Plain http only between local test sites (tools/mock-ats).
  const local = (h: string) => h === '127.0.0.1' || h === 'localhost';
  const secure = url.protocol === 'https:' || (local(url.hostname) && local(siteHost));
  const ok = secure && (baseDomain(url.hostname) === baseDomain(siteHost) || VERIFY_LINK_HOSTS.test(url.hostname));
  if (!ok) {
    logger.warn('account:verify-link-refused', { jobId: ctx.jobId, host: url.hostname });
    return false;
  }
  const redis = await getRedisClient();
  await redis.sAdd(`verify-used:${ctx.userId}`, link);
  await redis.expire(`verify-used:${ctx.userId}`, 7 * 24 * 3600);
  const tab = await ctx.page.context().newPage();
  try {
    await tab.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await tab.waitForTimeout(2500);
  } finally {
    await tab.close().catch(() => {});
  }
  await stage(ctx, 'account', { site: siteHost, action: 'email verified' });
  return true;
}


/** Sender domains a site's own mail comes from: its host, its parent domain, and the government mail domains. */
function senderDomains(host: string): string[] {
  const parts = host.split('.');
  const parent = parts.slice(-2).join('.');
  const gov = /\.(gov|nic)\.in$/.test(host) ? ['gov.in', 'nic.in'] : [];
  // Some applicant systems mail from a different domain than their job pages.
  const mailer = /greenhouse\.io$/.test(host) ? ['greenhouse-mail.io'] : [];
  return [...new Set([host, parent, ...(parts.length > 3 ? [parts.slice(-3).join('.')] : []), ...gov, ...mailer])];
}

/**
 * Wait for mail the site is about to send (private inbox / connected Gmail): a code or a verification link.
 * Gmail is polled directly while waiting rather than on the scheduler's slower tick.
 */
export async function waitForMail(ctx: ExecutionContext, kind: 'code' | 'link', sinceMs: number, timeoutMs: number): Promise<string | null> {
  const pool = getPgPool();
  const host = (() => { try { return new URL(ctx.page.url()).hostname; } catch { return ''; } })();
  const allowFrom = host ? senderDomains(host) : [];
  const col = kind === 'code' ? 'extracted_code' : 'extracted_link';
  const deadline = Date.now() + timeoutMs;
  let lastSync = 0;
  // What the island's pill says while this quiet wait runs (no question is shown).
  await applicationsService.updateByExecJob(ctx.jobId, { status: 'running', detail: kind === 'code' ? 'Waiting for the code in your inbox…' : 'Waiting for the verification email…' }).catch(() => {});
  while (Date.now() < deadline) {
    if (ctx.emailVia === 'gmail' && Date.now() - lastSync > 7000) {
      lastSync = Date.now();
      await gmailService.sync(ctx.userId, { since: new Date(sinceMs - 60_000), allowFrom }).catch(() => 0);
    }
    const { rows } = await pool.query(
      `SELECT ${col} AS v FROM emails WHERE user_id = $1 AND ${col} IS NOT NULL AND received_at > $2 ORDER BY received_at DESC LIMIT 1`,
      [ctx.userId, new Date(sinceMs)],
    );
    if (rows[0]?.v) {
      await applicationsService.updateByExecJob(ctx.jobId, { status: 'running', detail: kind === 'code' ? 'Got the code — entering it' : 'Got the email — verifying' }).catch(() => {});
      return String(rows[0].v);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

/**
 * Greenhouse mails a security code once the form is submitted and shows it as
 * split boxes. Read it from the inbox; ask the person only if it never shows up.
 * Returns true when a code was entered (the caller presses Submit again).
 */
async function enterEmailedSecurityCode(ctx: ExecutionContext, sentAt: number, attempt: number): Promise<boolean> {
  const boxes = 'input[id^="security-input"]';
  if (!(await ctx.page.locator(boxes).first().isVisible().catch(() => false))) return false;
  const site = await siteName(ctx, new URL(ctx.page.url()).hostname);
  let code = mailReadForUser(ctx) ? await waitForMailedCode(ctx, sentAt, 90_000) : null;
  if (code) await stage(ctx, 'account', { site, action: 'security code read from inbox' });
  else {
    code = await askUser(
      ctx, `security_code_${attempt}`, 'otp',
      attempt ? 'That code didn’t work. Enter the newest one the site emailed.' : `${site} emailed a security code to ${mailboxPhrase(ctx)}. What is it?`,
      { sensitive: true, channel: 'email-manual' },
    );
  }
  if (!code) throw new Error('No security code');
  return enterCode(ctx.page, code, boxes);
}

/** A code that landed in the user's mailbox after `sinceMs`; null if none arrives in time. */
export async function waitForMailedCode(ctx: ExecutionContext, sinceMs: number, timeoutMs: number): Promise<string | null> {
  return waitForMail(ctx, 'code', sinceMs, timeoutMs);
}

/** Wait for the site's verification email: the inbox opens it for us, or the user does and says done. */
async function awaitEmailVerification(ctx: ExecutionContext, id: string): Promise<void> {
  // Already in the mailbox (a run that stopped after the account was made): the site won't send it again.
  if (mailReadForUser(ctx)) {
    const { rows } = await getPgPool().query(
      `SELECT extracted_link FROM emails WHERE user_id = $1 AND extracted_link IS NOT NULL AND received_at > NOW() - INTERVAL '1 day'
        ORDER BY received_at DESC LIMIT 5`,
      [ctx.userId],
    );
    const redis = await getRedisClient();
    for (const r of rows) {
      // Each link once: an old one that no longer verifies must not be retried forever.
      if (await redis.sIsMember(`verify-used:${ctx.userId}`, r.extracted_link)) continue;
      if (await openVerifyLink(ctx, r.extracted_link)) return;
    }
  }
  // The mail usually lands within a minute: wait for it quietly (no question on screen) before asking.
  if (mailReadForUser(ctx)) {
    await stage(ctx, 'account', { action: 'waiting for the verification email' });
    const link = await waitForMail(ctx, 'link', Date.now() - 20_000, 90_000);
    if (link && (await openVerifyLink(ctx, link))) return;
  }
  const where = mailboxPhrase(ctx);
  const reply = await askUser(ctx, id, 'emailLink', mailReadForUser(ctx)
    ? `The site sent a verification email to ${where} but it hasn't arrived where I can see it. Open it yourself, then reply "done" — or paste the link here.`
    : `The site sent a verification link to ${where}. Open it, then reply "done" — or paste the link here and I'll open it.`);
  if (/^https?:\/\//i.test(reply)) await openVerifyLink(ctx, reply);
}

/** Pages employers show when a posting is gone — no point waiting for a form that will never come. */
const POSTING_GONE =
  /page you are looking for doesn['’]?t exist|(job|position|role|posting|requisition)[^.\n]{0,40}(no longer (available|open|accepting)|has been (closed|filled|removed)|is (closed|unavailable|expired))|this (job|position) (has expired|is no longer)|no longer accepting applications|couldn['’]?t find (that|the) (job|page)/i;

async function assertPostingOpen(ctx: ExecutionContext): Promise<void> {
  const text = await ctx.page.evaluate(() => (document.body?.innerText ?? '').slice(0, 4000)).catch(() => '');
  // A real application form has fields; a dead page has a sentence and a logo.
  if (POSTING_GONE.test(text) && text.length < 1500) throw new Error(`${JOB_CLOSED} the posting is no longer available`);
}

/** Buttons that open the application form from a job description page. */
const APPLY_BUTTON = /^\s*(apply( now| for this (job|position|role)| to this job)?|i['’]?m interested|start (your )?application)\s*$/i;

/**
 * Fill the fields of the page that's open: profile → remembered answers →
 * ask the user for required unknowns (and remember them). `askPrefix` keeps
 * question ids unique when one run fills several pages.
 */
/** The site refused a page: re-read it and ask the person about every required box still empty. Returns how many were filled. */
async function askAboutRejectedPage(step: ActionStep, ctx: ExecutionContext, askPrefix: string): Promise<number> {
  const fields = (await scanForm(ctx.page, step.target?.value).catch(() => [] as FormField[])).filter(
    (f) => f.required && !f.value && f.type !== 'file',
  );
  if (!fields.length) return 0;
  await stage(ctx, 'answers', { page: 'Fixing what the site refused', filled: 0, missing: fields.map((f) => f.label), answers: [] });
  const { filled } = await fillPage(step, ctx, fields, askPrefix);
  return filled.length;
}

async function fillPage(
  step: ActionStep,
  ctx: ExecutionContext,
  fields: FormField[],
  askPrefix: string,
): Promise<{ filled: FieldAnswer[]; stillMissing: FormField[] }> {
  await loadProfile(ctx);
  const book = buildAnswerBook(ctx.profile!, { country: ctx.jobContext?.country });
  const intents = await classifyIntents(fields, book, ctx.userId).catch(() => new Map<number, string>());
  const { answers, missing } = await planAnswers(fields, book, (q) => answerMemory.recall(ctx.userId, q).catch(() => null), intents);

  const filled: FieldAnswer[] = [];
  for (const a of answers) {
    if (a.source === 'prefilled') {
      filled.push(a);
      continue;
    }
    try {
      // Typeahead dropdowns: the answer must be one of its real options.
      if (a.field.type === 'combobox') {
        if (!a.field.options.length) a.field.options = await readComboOptions(ctx.page, a.field);
        const opts = realOptions(a.field.options);
        if (opts.length) {
          const pick = pickOption(opts, a.value);
          if (!pick) {
            if (a.field.required) missing.push(a.field);
            continue;
          }
          a.value = pick;
        }
      }
      const isImage = a.key === 'photo' || a.key === 'signature';
      const file = a.key === 'resume' ? await resumePath(ctx) : isImage ? await govImage(ctx, a.field, a.key as 'photo' | 'signature') : undefined;
      if (a.key === 'resume' && !file) continue;
      if (isImage && !file) {
        if (a.field.required) missing.push(a.field);
        continue;
      }
      // A phone box beside its own country-code picker (Zoho, intl-tel-input) takes the national number.
      if (a.key === 'phone' && a.field.selector && /^\+/.test(a.value.trim())) {
        const split = await ctx.page.locator(a.field.selector).first()
          .evaluate((el) => !!el.closest('.cxDropdownInputGroup, .iti, .intl-tel-input, [class*="phone-code"], [class*="dial-code"]')).catch(() => false);
        if (split) a.value = splitPhone(a.value, countryCode(ctx)).national;
      }
      await fillField(ctx.page, a, file);
      filled.push(a);
      await humanDelay(30, 90);
    } catch (err) {
      logger.warn('autofill:field-failed', { jobId: ctx.jobId, label: a.field.label, error: (err as Error).message });
      if (a.field.required) missing.push(a.field);
    }
  }
  if (hasFileField(fields) && !filled.some((a) => a.key === 'resume')) {
    const resumeField = fields.find((f) => f.type === 'file' && /resume|cv/i.test(`${f.label} ${f.name}`));
    if (resumeField?.required && !missing.includes(resumeField)) missing.push(resumeField);
  }

  // Mid-flow image captchas (login / registration pages): the user types what the picture says.
  if (step.metadata?.captchas === 'inline') {
    for (const f of fields.filter((x) => x.type === 'captcha')) await askTextCaptcha(ctx, f, 0);
  }

  // Questions the profile's own facts answer are written by the model (shown in the review as AI-written);
  // only what's left is asked of the user.
  const written = step.metadata?.aiAnswers === false
    ? new Map<number, string>()
    : await aiAnswers(ctx.profile!, { title: ctx.jobContext?.title, company: ctx.jobContext?.company }, missing.filter((f) => identityFieldKind(f.label, f.type) !== 'aadhaar'), { userId: ctx.userId, jobId: ctx.jobId });

  // Ask for each required answer we don't have, then remember it.
  const stillMissing: FormField[] = [];
  const batchAnswers = new Map<number, string>();
  for (const field of missing) {
    const aiValue = written.get(field.idx);
    if (aiValue) {
      try {
        const answer: FieldAnswer = { field, key: 'ai', value: aiValue, source: 'ai' };
        await fillField(ctx.page, answer);
        filled.push(answer);
        continue;
      } catch (err) {
        logger.warn('autofill:ai-fill-failed', { jobId: ctx.jobId, label: field.label, error: (err as Error).message });
      }
    }
    // A required cover letter: written from the profile (upload → PDF, text box → the text).
    if (/cover(ing)? letter|motivation letter/i.test(field.label) && (field.type === 'file' || field.tag === 'textarea')) {
      try {
        const letter = await coverLetter(ctx);
        const file = field.type === 'file'
          ? await coverLetterFile(ctx.page.context(), userFileStore.getTempPath('uploads', ctx.jobId), letter, ctx.profile?.personal?.fullName ?? '')
          : undefined;
        const answer: FieldAnswer = { field, key: 'coverLetter', value: field.type === 'file' ? 'Cover letter (written from your profile)' : letter, source: 'default' };
        await fillField(ctx.page, answer, file);
        filled.push(answer);
        continue;
      } catch (err) {
        logger.warn('autofill:cover-letter-failed', { jobId: ctx.jobId, error: (err as Error).message });
      }
    }
    // A code the portal just sent: press its "Generate OTP" button, ask, type it — never remembered.
    if (isOtpField(field.label) && field.type !== 'file') {
      const sentAt = Date.now() - 3000;
      await pressOtpButton(ctx.page, field);
      const site = await siteName(ctx, new URL(ctx.page.url()).hostname);
      // An emailed code is read from the inbox first; only if it never shows up is the person asked.
      // A texted one can only come from the person.
      const emailField = /e-?mail/i.test(field.label);
      let code = emailField && mailReadForUser(ctx) ? await waitForMailedCode(ctx, sentAt, 60_000) : null;
      if (code) await stage(ctx, 'account', { site, action: 'code read from inbox' });
      else {
        code = await askUser(
          ctx, `${askPrefix}_${field.idx}_otp`, 'otp',
          emailField
            ? `${site} emailed a code for “${field.label.replace(/\s*\*$/, '')}”${mailReadForUser(ctx) ? ` but I couldn't read it from ${mailboxPhrase(ctx)}` : ` to ${mailboxPhrase(ctx)}`}. What is it?`
            : `${site} sent a code for “${field.label.replace(/\s*\*$/, '')}”. What is it?`,
          { channel: emailField ? 'email-manual' : 'sms', sensitive: true },
        );
      }
      if (!code) {
        stillMissing.push(field);
        continue;
      }
      const answer: FieldAnswer = { field, key: 'otp', value: code, source: 'user' };
      await fillField(ctx.page, answer);
      filled.push(answer);
      continue;
    }
    // A sign-in ID on a login page: asked once, kept encrypted for this site only.
    if (isLoginIdField(field.label) && fields.some((f) => f.type === 'password')) {
      const keyName = `login:${field.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
      const saved = await readSecret(ctx, keyName);
      const value = saved ?? (await askUser(ctx, `${askPrefix}_${field.idx}_id`, 'credentialFill', `The site asks for “${field.label.replace(/\s*\*$/, '')}” to sign in. Stored encrypted, only used on this site.`));
      if (!value) {
        stillMissing.push(field);
        continue;
      }
      if (!saved) await writeSecret(ctx, keyName, value);
      const answer: FieldAnswer = { field, key: 'secret', value, source: 'user' };
      await fillField(ctx.page, answer);
      filled.push(answer);
      continue;
    }
    // A password: asked as a secret, kept encrypted for this site only — never in answer memory.
    if (isSecretField(field.label, field.type)) {
      const keyName = `password:${field.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
      const saved = await readSecret(ctx, keyName);
      const value = saved ?? (await askUser(ctx, `${askPrefix}_${field.idx}_pw`, 'credentialFill', `The site asks for “${field.label.replace(/\s*\*$/, '')}”. Stored encrypted, only used on this site.`));
      if (!value) {
        stillMissing.push(field);
        continue;
      }
      if (!saved) await writeSecret(ctx, keyName, value);
      const answer: FieldAnswer = { field, key: 'secret', value, source: 'user' };
      await fillField(ctx.page, answer);
      filled.push(answer);
      continue;
    }
    if (field.type === 'file' || step.metadata?.askForMissing === false) {
      stillMissing.push(field);
      continue;
    }
    // A phone number belongs in the profile (every site wants it), not in one site's answers.
    if ((field.type === 'tel' || /\b(mobile|phone|cell)\b/i.test(field.label)) && !realOptions(field.options).length && !ctx.profile?.personal?.phone) {
      const site = await siteName(ctx, new URL(ctx.page.url()).hostname);
      const phone = await ensurePhone(ctx, `${askPrefix}_${field.idx}_phone`, site, 'asks for your phone number');
      const answer: FieldAnswer = { field, key: 'phone', value: phone, source: 'user' };
      await fillField(ctx.page, answer);
      filled.push(answer);
      continue;
    }
    // A school/degree list that doesn't know ours: its own "Other" beats asking about a 5000-entry list.
    if (field.type === 'combobox' && ['school', 'degree', 'field'].includes(ruleFor(field) ?? '')) {
      const other: FieldAnswer = { field, key: ruleFor(field)!, value: 'Other', source: 'default' };
      if (await fillField(ctx.page, other).then(() => true, () => false)) {
        filled.push(other);
        continue;
      }
    }
    if (field.type === 'combobox' && !field.options.length) field.options = await readComboOptions(ctx.page, field);
    const normalize = (f: FormField, raw: string) => {
      const r = raw.trim();
      return f.options.length ? (f.options.find((o) => o.toLowerCase() === r.toLowerCase()) ?? f.options.find((o) => o.toLowerCase().startsWith(r.toLowerCase())) ?? '') : r;
    };
    // Every other question this form will ask goes in ONE form, not one run (and one wait) per question.
    if (!batchAnswers.has(field.idx)) {
      const rest = missing.slice(missing.indexOf(field) + 1).filter((f) => genericAsk(f, written, fields, ctx, step));
      if (rest.length) {
        for (const f of rest) if (f.type === 'combobox' && !f.options.length) f.options = await readComboOptions(ctx.page, f).catch(() => []);
        const group = [field, ...rest];
        const batchId = `${askPrefix}_${field.idx}_batch`;
        const questions = group.map((f) => ({ id: String(f.idx), question: f.label.replace(/\s*\*$/, ''), options: realOptions(f.options) }));
        await ACTION_HANDLERS.pauseForUserInput({
          id: batchId,
          action: 'pauseForUserInput',
          expectedInput: 'text',
          timeout: 10 * 60_000,
          description: `The application asks ${group.length} more questions`,
          contextMessage: `The application asks ${group.length} more questions — answer them together`,
          metadata: {
            skipChallengeDetection: true,
            pauseData: { question: `${group.length} questions from the application`, questions },
            park: { kind: 'question', questions: questions.map((q) => ({ id: q.id, question: q.question })) } satisfies ParkSpec,
          },
        }, ctx);
        let given: Record<string, string> = {};
        try { given = JSON.parse(ctx.runtimeInputs[batchId] ?? '{}'); } catch { /* a plain answer: it belongs to the first question */ given = { [String(field.idx)]: ctx.runtimeInputs[batchId] ?? '' }; }
        delete ctx.runtimeInputs[batchId];
        for (const f of group) batchAnswers.set(f.idx, normalize(f, String(given[String(f.idx)] ?? '')));
      }
    }
    const askId = `${askPrefix}_${field.idx}`;
    if (batchAnswers.has(field.idx)) ctx.runtimeInputs[askId] = batchAnswers.get(field.idx) ?? '';
    else
    await ACTION_HANDLERS.pauseForUserInput({
      id: askId,
      action: 'pauseForUserInput',
      expectedInput: identityFieldKind(field.label, field.type) === 'aadhaar' ? 'aadhaar' : 'text',
      timeout: 10 * 60_000,
      description: `The application asks: "${field.label}"`,
      contextMessage: realOptions(field.options).length
        ? `The application asks: "${field.label}" — options: ${realOptions(field.options).slice(0, 12).join(' / ')}${realOptions(field.options).length > 12 ? ' …' : ''}`
        : `The application asks: "${field.label}"`,
      metadata: {
        skipChallengeDetection: true,
        pauseData: { question: field.label, options: realOptions(field.options), sensitive: identityFieldKind(field.label, field.type) === 'aadhaar' || undefined },
        park: { kind: 'question', question: field.label } satisfies ParkSpec,
      },
    }, ctx);
    const raw = (ctx.runtimeInputs[askId] ?? '').trim();
    const value = field.options.length ? (field.options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? field.options.find((o) => o.toLowerCase().startsWith(raw.toLowerCase())) ?? '') : raw;
    if (!value) {
      stillMissing.push(field);
      continue;
    }
    const answer: FieldAnswer = { field, key: 'memory', value, source: 'user' };
    await fillField(ctx.page, answer);
    filled.push(answer);
    // An Aadhaar / Virtual ID number is never remembered.
    if (identityFieldKind(field.label, field.type) !== 'aadhaar') await answerMemory.remember(ctx.userId, field.label, value).catch(() => {});
    // Asked once: parents' names, date of birth, category… belong to the profile for every later portal.
    const govKey = govRuleFor(field.label.toLowerCase().replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim());
    if (govKey) await saveGovAnswer(ctx, govKey, value);
  }
  return { filled, stillMissing };
}


/**
 * Aadhaar / DigiLocker verification pages: ask for each detail in chat and type it in.
 * The Aadhaar number, codes and PIN are used once — never saved, never put in answer memory
 * or the review. Face / biometric checks can't be done remotely: those hand off.
 */
async function verifyIdentity(ctx: ExecutionContext, stepId: string): Promise<void> {
  const host = new URL(ctx.page.url()).hostname;
  const bodyText = async () => ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (/face authentication|biometric|scan your (face|fingerprint)/i.test(await bodyText())) {
    throw new Error(`${host} wants a face or fingerprint check, which only your phone can do. Finish that on the site, then apply again — I'll sign in and continue.`);
  }
  for (let round = 0; round < 6; round++) {
    const fields = (await scanForm(ctx.page).catch(() => [] as FormField[])).filter((f) => !f.value || f.type === 'checkbox');
    const kinds = fields.map((f) => ({ f, kind: identityFieldKind(f.label, f.type) })).filter((x) => x.kind);
    if (!kinds.length) return;
    let sentCode = false;
    for (const { f, kind } of kinds) {
      const label = f.label.replace(/\s*\*$/, '');
      let value = '';
      if (kind === 'consent') {
        const ok = await askUser(ctx, `${stepId}_${round}_${f.idx}_consent`, 'confirmation', `${host} asks for your consent to verify you with Aadhaar / DigiLocker: “${label}”. Tick it?`, { options: ['Yes, tick it', 'No'] });
        if (!/^y/i.test(ok)) throw new Error('Verification needs your consent. Apply again when you want to continue.');
        value = 'yes';
      } else if (kind === 'aadhaar') {
        value = (await askUser(ctx, `${stepId}_${round}_${f.idx}_aadhaar`, 'aadhaar', `${host} asks for “${label}”. Your Aadhaar number or Virtual ID?`, { sensitive: true })).replace(/[\s-]/g, '');
      } else if (kind === 'mobile') {
        value = ctx.profile?.personal?.phone ? splitPhone(ctx.profile.personal.phone, ctx.profile.personal.country).national : await askUser(ctx, `${stepId}_${round}_${f.idx}_mobile`, 'mobile', `${host} asks for “${label}”. Your mobile number? (typed straight into the site, never shown to the AI)`, { sensitive: true });
      } else {
        // OTP / PIN: the code is sent after "Generate OTP" is pressed.
        if (kind === 'otp' && !sentCode) {
          sentCode = await pressIdentityButton(ctx.page, IDENTITY_SEND);
        }
        value = await askUser(
          ctx, `${stepId}_${round}_${f.idx}_${kind}`, kind === 'pin' ? 'credentialFill' : 'otp',
          kind === 'pin' ? `${host} asks for your DigiLocker security PIN (“${label}”). It is used once and not saved.` : `${host} sent a code to your Aadhaar-linked mobile for “${label}”. What is it?`,
          { sensitive: true, channel: 'sms', destination: 'your Aadhaar-linked mobile' },
        );
      }
      if (!value) throw new Error(`I need “${label}” to continue the verification.`);
      await fillField(ctx.page, { field: f, value: kind === 'consent' ? (f.options[0] ?? 'yes') : value });
    }
    // Send the code if the page had no code box yet, otherwise submit the verification.
    const pressed = kinds.some((k) => k.kind === 'otp' || k.kind === 'pin')
      ? await pressIdentityButton(ctx.page, IDENTITY_GO)
      : (await pressIdentityButton(ctx.page, IDENTITY_SEND)) || (await pressIdentityButton(ctx.page, IDENTITY_GO));
    await ctx.page.waitForTimeout(1500);
    if (!pressed) return;
    if (!isIdentityGate(await bodyText())) return;
  }
}

async function pressIdentityButton(page: Page, re: RegExp): Promise<boolean> {
  const buttons = page.locator('button, input[type="button"], input[type="submit"], a[role="button"], a.btn');
  const n = await buttons.count();
  for (let k = 0; k < n; k++) {
    const b = buttons.nth(k);
    if (!(await b.isVisible().catch(() => false))) continue;
    const text = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
    if (text && re.test(text)) {
      await b.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
      return true;
    }
  }
  return false;
}

/** The photo / signature on file, fitted to the size the portal states beside the upload box. */
async function govImage(ctx: ExecutionContext, field: FormField, kind: 'photo' | 'signature'): Promise<string | undefined> {
  let src: string;
  try {
    src = await userFileStore.resolveInputReference(ctx.userId, `file-category:${kind}`);
  } catch {
    return undefined;
  }
  const rule = imageRule(`${field.label} ${await nearbyText(ctx.page, field)}`);
  return fitImage(ctx.page.context(), src, rule, userFileStore.getTempPath('uploads', ctx.jobId)).catch((e) => { logger.warn("gov:fit-image-failed", { error: (e as Error).message, rule }); return src; });
}

const GOV_PATCH: Record<string, (v: string) => Record<string, unknown>> = {
  fatherName: (v) => ({ fatherName: v.trim() }),
  motherName: (v) => ({ motherName: v.trim() }),
  dob: (v) => {
    const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    return { dateOfBirth: m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v };
  },
  gender: (v) => ({ gender: v }),
  category: (v) => ({ category: v }),
  nationality: (v) => ({ nationality: v }),
  maritalStatus: (v) => ({ maritalStatus: v }),
  domicile: (v) => ({ domicileState: v }),
  pwd: (v) => ({ pwd: /^y/i.test(v) }),
  exServiceman: (v) => ({ exServiceman: /^y/i.test(v) }),
};
async function saveGovAnswer(ctx: ExecutionContext, key: string, value: string): Promise<void> {
  const patch = GOV_PATCH[key]?.(value);
  if (!patch) return;
  ctx.profile = { ...ctx.profile, government: { ...ctx.profile?.government, ...patch } };
  await profileService.patch(ctx.userId, { government: patch }, 'apply').catch(() => {});
}

/** One cover letter per run (a form can ask for it twice), kept on the timeline for the review. */
async function coverLetter(ctx: ExecutionContext): Promise<string> {
  if (typeof ctx.extractedData.coverLetter === 'string') return ctx.extractedData.coverLetter;
  await loadProfile(ctx);
  const letter = await coverLetterText(ctx.profile!, { title: ctx.jobContext?.title, company: ctx.jobContext?.company || undefined }, { userId: ctx.userId, jobId: ctx.jobId });
  ctx.extractedData.coverLetter = letter;
  await stage(ctx, 'cover_letter', { words: letter.split(/\s+/).length });
  return letter;
}

/** Pipeline stage on the application's timeline (never fails the run). */
async function stage(ctx: ExecutionContext, phase: string, detail: Record<string, unknown>): Promise<void> {
  await applicationsService.eventByExecJob(ctx.jobId, phase, detail).catch(() => {});
  const note = liveNote(phase, detail);
  if (note) await applicationsService.noteByExecJob(ctx.jobId, note).catch(() => {});
}

/** What the island says while the run works: the page being filled, the count so far. */
function liveNote(phase: string, d: Record<string, unknown>): string | null {
  const page = typeof d.page === 'string' && d.page ? d.page : '';
  switch (phase) {
    case 'account': return typeof d.action === 'string' ? `Account: ${d.action}` : 'Signing in to the site…';
    case 'answers': return page ? `Filled “${page}”${typeof d.filled === 'number' ? ` · ${d.filled} answers` : ''}` : 'Filling in your answers…';
    case 'parse': return 'Checked every page — getting ready for your review';
    case 'captcha': return 'Solving a security check…';
    case 'cover_letter': return 'Writing your cover letter…';
    case 'verified': return 'Final check before sending…';
    case 'submitted': return 'Sending your application…';
    default: return null;
  }
}

const ACTION_NOTE: Record<string, string> = {
  navigate: 'Opening the job page…',
  autofillForm: 'Reading and filling the form…',
  fillWizard: 'Filling the application, page by page…',
  govWizard: 'Filling the application, page by page…',
  reviewForm: 'Checking everything before review…',
  submitForm: 'Submitting…',
  uploadFile: 'Uploading your resume…',
  solveTextCaptcha: 'Solving a security check…',
};

async function loadProfile(ctx: ExecutionContext): Promise<void> {
  if (ctx.profile) return;
  const profile = (await profileService.get(ctx.userId)).data;
  // Applications go out with the address the user chose for them (onboarding's "Application email").
  if (ctx.jobContext) {
    const { email, via } = await applicationEmail(ctx.userId, profile.personal, profile.settings?.applicationEmailMode)
      .catch(() => ({ email: profile.personal?.email ?? null, via: 'personal' as const }));
    if (email) profile.personal = { ...profile.personal, email };
    ctx.emailVia = via;
  }
  ctx.profile = profile;
}

/** The company as the user knows it: the job's company, else the site's own name ("Mock Corp Careers" → "Mock Corp"). */
async function siteName(ctx: ExecutionContext, host: string): Promise<string> {
  const company = ctx.jobContext?.company?.trim();
  if (company) return company;
  const own = await ctx.page.locator('meta[property="og:site_name"]').first().getAttribute('content', { timeout: 1000 }).catch(() => null);
  return own?.replace(/\s*(careers?|jobs)\s*$/i, '').trim() || host;
}

/** Where the site's email goes, in words for the user. */
function mailboxPhrase(ctx: ExecutionContext): string {
  const email = ctx.profile?.personal?.email ?? 'your email';
  return ctx.emailVia === 'inbox' ? `your jobpilot inbox (${email})` : email;
}

/** Codes and links reach us on their own (private inbox, connected Gmail); otherwise the user forwards them. */
const mailReadForUser = (ctx: ExecutionContext) => ctx.emailVia === 'inbox' || ctx.emailVia === 'gmail';

async function resumePath(ctx: ExecutionContext): Promise<string | undefined> {
  const id = ctx.profile?.documents?.resumeFileId;
  try {
    const stored = id
      ? await userFileStore.resolveInputReference(ctx.userId, `file:${id}`)
      : await userFileStore.resolveInputReference(ctx.userId, 'file-category:resume');
    // Employers see the uploaded file's name: send "Jane_Doe_Resume.pdf", not our storage id.
    const original = ctx.profile?.documents?.resumeFileName?.replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!original) return stored;
    const dir = userFileStore.getTempPath('uploads', ctx.jobId);
    await mkdir(dir, { recursive: true });
    const named = join(dir, original);
    await copyFile(stored, named);
    return named;
  } catch {
    return undefined;
  }
}

const hasFileField = (fields: FormField[]) => fields.some((f) => f.type === 'file');

// ─── Captchas, shown to the user as a cropped screenshot (no live view) ──────

/** Re-fill approved answers a re-rendered form lost (empty now), résumé included. */
async function restoreAnswers(ctx: ExecutionContext): Promise<void> {
  if (!ctx.form) return;
  const now = await scanForm(ctx.page).catch(() => [] as FormField[]);
  let restored = 0;
  for (const a of ctx.form.answers) {
    const cur = now.find((f) => (a.field.selector ? f.selector === a.field.selector : f.label === a.field.label && f.type === a.field.type));
    if (!cur) continue;
    const empty = cur.type === 'file' || cur.type === 'radio' || !cur.value.trim();
    if (!empty) continue;
    try {
      const file = a.key === 'resume' ? await resumePath(ctx) : a.key === 'photo' || a.key === 'signature' ? await govImage(ctx, cur, a.key) : undefined;
      await fillField(ctx.page, { field: cur, value: a.value }, file);
      restored++;
    } catch (err) {
      logger.warn('submit:restore-failed', { jobId: ctx.jobId, label: a.field.label, error: (err as Error).message });
    }
  }
  if (restored) logger.info('submit:restored-after-rerender', { jobId: ctx.jobId, restored });
}

/** Text captcha: the user sees only the captcha image and types what it says. */
async function askTextCaptcha(ctx: ExecutionContext, field: FormField, attempt: number): Promise<void> {
  const img = await captchaImageFor(ctx.page, field);
  const shot = img ? await img.screenshot({ type: 'png' }).catch(() => null) : null;
  const id = `captcha_text_${field.idx}_${attempt}`;
  await ACTION_HANDLERS.pauseForUserInput({
    id,
    action: 'pauseForUserInput',
    expectedInput: 'captcha',
    timeout: 10 * 60_000,
    description: 'Type the characters in the image',
    contextMessage: attempt ? 'That code was not accepted — type the new one' : 'One last step: type the characters in the image',
    metadata: {
      skipChallengeDetection: true,
      pauseData: { captchaKind: 'text', captchaUrl: shot ? `data:image/png;base64,${shot.toString('base64')}` : '' },
    },
  }, ctx);
  await fillField(ctx.page, { field, value: (ctx.runtimeInputs[id] ?? '').trim() });
  await stage(ctx, 'captcha', { kind: 'text', attempt: attempt + 1 });
}

/**
 * Click captcha (reCAPTCHA / hCaptcha): the user sees only the challenge area
 * and clicks on it. Each click is replayed on the page and a fresh crop is
 * sent back, until the challenge closes or the user says done.
 */
async function askClickCaptcha(ctx: ExecutionContext, start: Locator, kind: 'checkbox' | 'challenge' = 'challenge'): Promise<void> {
  let target = start;
  let showing = kind;
  for (let i = 0; i < 40; i++) {
    const shot = await target.screenshot({ type: 'jpeg', quality: 85 }).catch(() => null);
    if (!shot) return;
    const id = `captcha_click_${i}`;
    await ACTION_HANDLERS.pauseForUserInput({
      id,
      action: 'pauseForUserInput',
      expectedInput: 'clickCaptcha',
      timeout: 10 * 60_000,
      description: 'Solve the security check',
      contextMessage:
        showing === 'checkbox'
          ? 'Security check: tap the "I\'m not a robot" box'
          : i
            ? 'Keep going — follow the instructions in the picture, then tap Verify'
            : 'Security check: follow the instructions in the picture',
      metadata: { skipChallengeDetection: true, pauseData: { captchaKind: 'click', captchaUrl: `data:image/jpeg;base64,${shot.toString('base64')}` } },
    }, ctx);
    let msg: { x?: number; y?: number; done?: boolean } = {};
    try {
      msg = JSON.parse(ctx.runtimeInputs[id] ?? '{}');
    } catch {
      /* not JSON — treat as done */
      msg = { done: true };
    }
    if (msg.done) break;
    const box = await target.boundingBox().catch(() => null);
    if (!box || typeof msg.x !== 'number' || typeof msg.y !== 'number') break;
    await ctx.page.mouse.click(box.x + msg.x * box.width, box.y + msg.y * box.height);
    await ctx.page.waitForTimeout(1500);
    // A ticked checkbox can open a picture challenge; follow it.
    const challenge = await visibleClickChallenge(ctx.page);
    if (challenge) {
      target = challenge;
      showing = 'challenge';
    }
    else if (!(await untickedCheckbox(ctx.page))) break; // solved
  }
  await stage(ctx, 'captcha', { kind: 'click' });
}

export class ExecutionEngine {
  private sessionManager: SessionManager;
  private selectorEngine: SelectorEngine;

  constructor(aiResolver?: AIResolver) {
    this.sessionManager = new SessionManager();
    this.selectorEngine = new SelectorEngine(aiResolver);
  }

  async execute(job: ExecuteJob): Promise<ExecutionResult> {
    const { sessionId, actionPlan, task } = job.payload;
    const pool = getBrowserPool();
    const stepResults: StepResult[] = [];
    const screenshots: string[] = [];
    const startTime = Date.now();
    let contextId: string | undefined;
    let liveStream: { stop: () => void } | undefined;

    try {
      const session = await this.sessionManager.getOrCreate(
        job.payload.sessionId,
        job.userId,
        job.payload.siteId
      );

      const entryUrl = actionPlan?.find((step) => step.action === 'navigate')?.target?.value;
      const localeHint = localeForUrl(entryUrl);
      let lease = await pool.acquireContext(sessionId, job.userId, session, session.proxy as any, job.payload.lightweight, localeHint);
      contextId = lease.contextId;
      pool.markActive(contextId);
      const page = await pool.getOrCreatePage(contextId);

      const ctx: ExecutionContext = {
        page,
        contextId,
        selectorEngine: this.selectorEngine,
        screenshots,
        jobId: job.id,
        userId: job.userId,
        sessionId,
        siteId: job.payload.siteId,
        workflowKey: job.payload.workflowKey,
        task,
        runtimeInputs: {},
        extractedData: {},
        workflowStack: [],
        workflowRecoveryPlan: (job.metadata?.fallbackPlan as ActionStep[] | undefined) ?? undefined,
        metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
        cancellation: { cancelled: false },
        jobContext: job.payload.context,
        stopBeforeSubmit: job.payload.stopBeforeSubmit,
        parkable: !!job.payload.context?.applyUrl,
        approved: job.payload.approved,
      };
      if (actionPlan?.some((s) => JSON.stringify(s).includes('{{profile:'))) await loadProfile(ctx);

      if (!actionPlan?.length) throw new Error('No action plan provided for execution');

      // Circuit Breaker Check
      const redis = await getRedisClient();
      // Not for job applications: all employers on one applicant system share a siteId, and a closed posting says nothing about the next one.
      const cbOpen = job.payload.context?.applyUrl ? null : await redis.get(`cb:open:${job.payload.siteId}`);
      if (cbOpen) {
        throw new Error(`Circuit breaker open for site ${job.payload.siteId}. Temporarily paused due to consecutive errors.`);
      }

      const stream = await streamLiveView(ctx, job.id, 1);
      liveStream = stream;
      (ctx as any).activeStream = stream;
      await updateJobRuntimeState(ctx, { status: 'running' });

      let attempts = 0;
      const MAX_JOB_ATTEMPTS = Math.max(1, job.payload.maxAttempts ?? 3);
      let allSucceeded = false;

      // Retry from the step that failed, not from the top: finished steps stay
      // done (a captcha or OTP the user already answered is never asked twice).
      // Only a lost browser restarts the plan, since its page state is gone.
      let resumeAt = 0;
      const HUMAN_STEPS = new Set(['pauseForUserInput', 'solveCaptcha', 'captcha']);
      const isBrowserGone = (err: unknown) => /Target (page, context or )?browser has been closed|browser has been closed|Target closed|has been closed/i.test(err instanceof Error ? err.message : String(err));

      while (attempts < MAX_JOB_ATTEMPTS && !allSucceeded) {
        attempts++;
        try {
          if (attempts > 1) {
            logger.info('job:retrying-from-step', { jobId: job.id, attempt: attempts, resumeAt });
            if (resumeAt === 0) stepResults.length = 0;
            await humanDelay(1500 * attempts, 3000 * attempts);
          }

          for (let i = resumeAt; i < actionPlan.length; i++) {
            await ensureNotCancelled(ctx);
            const rawStep = actionPlan[i];
            const step = normalizeStep(rawStep);
            const result = await this.executeStep(step, ctx);
            stepResults.push(result);

            if (!result.success && ctx.workflowRecoveryPlan?.length) {
              await executeNestedSteps(ctx.workflowRecoveryPlan, ctx);
              const retryResult = await this.executeStep(step, ctx);
              stepResults.push(retryResult);
              ctx.workflowRecoveryPlan = undefined;
              if (retryResult.success) continue;
            }

            if (!result.success) {
              // A person who timed out or declined a checkpoint is final; replaying
              // would only show them the same prompt again.
              resumeAt = HUMAN_STEPS.has(String((rawStep as any).action)) ? actionPlan.length : i;
              // Drop the failed result so the retried step reports its own outcome.
              if (resumeAt === i && attempts < MAX_JOB_ATTEMPTS) stepResults.pop();
              break;
            }
            resumeAt = i + 1;
          }

          allSucceeded = resumeAt >= actionPlan.length && stepResults.every((result) => result.success);
          if (!allSucceeded && resumeAt >= actionPlan.length) break; // human step failed: no retry
        } catch (err) {
          // Cancelled / parked are decisions, not faults: never retry them.
          if (err instanceof JobParkedError || err instanceof JobCancelledError) throw err;
          logger.error('job:execution-error', err, { jobId: job.id, attempt: attempts });
          if (attempts >= MAX_JOB_ATTEMPTS) throw err;

          if (isBrowserGone(err)) {
            // Recovery: rebuild the context on a fresh browser and start the plan over.
            await pool.releaseContext(contextId!, false).catch(() => {});
            const fresh = await pool.acquireContext(sessionId, job.userId, session, session.proxy as any, job.payload.lightweight, localeHint);
            contextId = fresh.contextId;
            pool.markActive(contextId);
            ctx.contextId = contextId;
            ctx.page = await pool.getOrCreatePage(contextId);
            lease = fresh;
            resumeAt = 0;
            logger.warn('job:browser-recovered', { jobId: job.id, attempt: attempts });
          }
          await humanDelay(2000 * attempts, 5000 * attempts);
        }
      }

      stream.stop();


      await this.sessionManager.save(sessionId, ctx.page, lease.context);

      allSucceeded = stepResults.every((result) => result.success);
      const verified = computeVerified(actionPlan, ctx, allSucceeded);
      await this.logResult(job.id, job.userId, job.payload.sessionId, job.payload.siteId, allSucceeded, stepResults, ctx.metrics, job.payload.task, undefined, job.payload.workflowKey, verified);
      const failedStepError = stepResults.find((result) => result.error)?.error;
      await updateJobRuntimeState(ctx, {
        status: allSucceeded ? 'completed' : 'failed',
        error: allSucceeded ? undefined : (failedStepError || 'Workflow finished with failed steps'),
        result: { steps: stepResults },
      });

      let failureMessage = `⚠️ Task encountered errors and could not complete all steps.`;
      
      if (!allSucceeded && failedStepError?.toLowerCase().includes('selector')) {
        const { enqueueJob } = await import('../shared/queue/index.js');
        const { randomUUID } = await import('crypto');
        await enqueueJob({
          id: randomUUID(),
          type: 'remap',
          priority: 'high',
          createdAt: new Date(),
          userId: job.userId,
          payload: {
            siteId: job.payload.siteId,
            reason: 'selector-failure'
          }
        });
        
        failureMessage = `⚠️ The website's layout seems to have changed, so I couldn't complete the task automatically. I've scheduled an update to learn the new layout.\n\nIn the meantime, you can complete the rest of the task manually on the website. Let me know if you need any other help!`;
      }

      await getRedisClient().then(r => r.publish('chat:message', JSON.stringify({
        sessionId,
        message: allSucceeded ? `✅ Task completed successfully.` : failureMessage,
      }))).catch(() => {});

      if (allSucceeded) {
        await getRedisClient().then(r => r.del(`cb:errors:${job.payload.siteId}`)).catch(() => {});
      } else {
        const r = await getRedisClient();
        const errs = await r.incr(`cb:errors:${job.payload.siteId}`);
        if (errs === 1) await r.expire(`cb:errors:${job.payload.siteId}`, 3600);
        if (errs >= 5 && !job.payload.context?.applyUrl) await r.setEx(`cb:open:${job.payload.siteId}`, 300, '1');
      }

      // Cleanup old temp files (best effort)
      userFileStore.cleanupTempFiles().catch(() => {});
      
      // Explicitly release the context to immediately destroy it and free up memory
      await pool.releaseContext(contextId, true);
      contextId = undefined; // prevent catch block from accessing it again

      return {
        jobId: job.id,
        success: allSucceeded,
        // Why it stopped, for the application row and the user's timeline.
        error: allSucceeded ? undefined : failedStepError || 'Workflow finished with failed steps',
        steps: stepResults,
        duration: Date.now() - startTime,
        screenshots,
        extractedData: ctx.extractedData,
        sessionId,
      };
    } catch (err) {
      // The frame loop polls Redis every second until stopped.
      liveStream?.stop();
      if (err instanceof JobParkedError) {
        const applicationId = await parkApplication(job.id, { ...err.state, job }).catch((parkErr) => {
          logger.error('job:park-failed', parkErr, { jobId: job.id });
          return null;
        });
        if (applicationId) {
          (contextId ? pool.releaseContext(contextId, false) : Promise.resolve()).catch(() => {});
          const late = err.lateAnswer();
          if (late !== undefined) await continueParked(applicationId, late).catch(() => {});
          return {
            jobId: job.id,
            success: false,
            parked: true,
            steps: stepResults,
            duration: Date.now() - startTime,
            screenshots,
            sessionId,
          };
        }
        // Not an application row to park on — behave like the old idle timeout.
        err = new JobCancelledError(job.id);
      }
      const error = getErrorMessage(err);
      const wasCancelled = err instanceof JobCancelledError;

      if (contextId) {
        try {
          const page = await pool.getOrCreatePage(contextId);
          const path = userFileStore.getTempPath('screenshots', `error-${job.id}.png`);
          await page.screenshot({ path });
          screenshots.push(path);
        } catch {}
      }

      // What was really on the page when it failed: the next fix starts from facts, not guesses.
      if (contextId && !wasCancelled) {
        try {
          const page = await pool.getOrCreatePage(contextId);
          await applicationsService.eventByExecJob(job.id, 'diagnostic', { why: error.slice(0, 200), ...(await pageDiagnostic(page)) });
        } catch {}
      }

      if (contextId) {
        try {
          const page = await pool.getOrCreatePage(contextId);
          await updateJobRuntimeState({
            page,
            contextId,
            selectorEngine: this.selectorEngine,
            screenshots,
            jobId: job.id,
            userId: job.userId,
            sessionId,
            siteId: job.payload.siteId,
            task,
            runtimeInputs: {},
            extractedData: {},
            workflowStack: [],
            metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
            cancellation: { cancelled: wasCancelled },
          }, { status: 'failed', error });
        } catch {}
      }

      if (wasCancelled) {
        logger.warn('job:cancelled', { jobId: job.id, userId: job.userId, sessionId });
      }

      if (contextId) {
        await pool.releaseContext(contextId, false).catch(() => {});
      }

      if (!wasCancelled) {
        await getRedisClient().then(r => r.publish('chat:message', JSON.stringify({
          sessionId,
          message: `❌ Task failed: ${error}`,
        }))).catch(() => {});
      }

      if (!wasCancelled) {
        try {
          const r = await getRedisClient();
          const errs = await r.incr(`cb:errors:${job.payload.siteId}`);
          if (errs === 1) await r.expire(`cb:errors:${job.payload.siteId}`, 3600);
          if (errs >= 5 && !job.payload.context?.applyUrl) await r.setEx(`cb:open:${job.payload.siteId}`, 300, '1');
        } catch {}
      }

      await this.logResult(
        job.id,
        job.userId,
        sessionId,
        job.payload.siteId,
        false,
        stepResults,
        { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
        job.payload.task,
        error,
        job.payload.workflowKey
      ).catch((logError) => {
        logger.error('job:log-result-failed', logError, { jobId: job.id, originalError: error });
      });

      return {
        jobId: job.id,
        success: false,
        steps: stepResults,
        duration: Date.now() - startTime,
        screenshots,
        error,
        sessionId,
      };
    }
  }

  private async executeStep(step: ActionStep, ctx: ExecutionContext): Promise<StepResult> {
    const start = Date.now();
    let lastError = '';

    for (let attempt = 0; attempt <= (step.retries ?? 1); attempt++) {
      await ensureNotCancelled(ctx);
      if (attempt > 0) {
        ctx.metrics.retryCount++;
        await humanDelay(500 * attempt, 1000 * attempt);
      }

      try {
        const handler = ACTION_HANDLERS[step.action];
        if (!handler) throw new Error(`Unknown action: ${step.action}`);
        if (ACTION_NOTE[step.action]) await applicationsService.noteByExecJob(ctx.jobId, ACTION_NOTE[step.action]).catch(() => {});
        await handler(step, ctx);
        return {
          stepId: step.id,
          success: true,
          duration: Date.now() - start,
          retryCount: attempt,
        };
      } catch (err) {
        // A user's cancel ends the run — it isn't a step failure to retry or recover.
        if (err instanceof JobCancelledError || err instanceof JobParkedError) throw err;
        lastError = getErrorMessage(err);
        try {
          const path = userFileStore.getTempPath('screenshots', `fail-step-${step.id}-${attempt}.png`);
          await ctx.page.screenshot({ path });
          ctx.screenshots.push(path);
        } catch {}

        const recoverySteps = step.metadata?.recoverySteps as ActionStep[] | undefined;
        if (attempt === (step.retries ?? 1) && recoverySteps?.length) {
          try {
            await executeNestedSteps(recoverySteps, ctx);
            return {
              stepId: step.id,
              success: true,
              duration: Date.now() - start,
              retryCount: attempt,
            };
          } catch {}
        }

        if (attempt === (step.retries ?? 1) && (lastError.includes('selector') || lastError.includes('captcha'))) {
          try {
            await ACTION_HANDLERS.pauseForUserInput({
              id: `${step.id}_recovery`,
              action: 'pauseForUserInput',
              timeout: 60_000,
              retries: 0,
              description: `I ran into an issue finding an element or solving a CAPTCHA (${lastError}). Can you help me proceed on the live view? Respond with "done" when ready.`,
              expectedInput: 'confirmation',
            }, ctx);
            return {
              stepId: step.id,
              success: true,
              duration: Date.now() - start,
              retryCount: attempt,
            };
          } catch {}
        }
      }
    }

    return {
      stepId: step.id,
      success: false,
      duration: Date.now() - start,
      error: lastError,
      retryCount: step.retries ?? 1,
    };
  }

  private async logResult(
    jobId: string,
    userId: string,
    sessionId: string,
    siteId: string,
    success: boolean,
    steps: StepResult[],
    metrics: ExecutionContext['metrics'],
    task?: string,
    errorMessage?: string,
    workflowKey?: string,
    verified?: boolean
  ): Promise<void> {
    const pool = getPgPool();
    const totalDuration = steps.reduce((sum, step) => sum + step.duration, 0);

    // Find first error from steps if errorMessage isn't provided
    const finalError = errorMessage || steps.find(s => s.error)?.error || null;

    await pool.query(
      `INSERT INTO job_logs (
         job_id, user_id, session_id, type, site_id, status, completed_at, duration_ms,
         success, ai_call_count, selector_fallback_cnt, retry_count, result, error, task, workflow_key, verified
       ) VALUES ($1, $2, $3, 'execute', $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        jobId,
        userId,
        sessionId,
        siteId,
        success ? 'completed' : 'failed',
        totalDuration,
        success,
        metrics.aiCallCount,
        metrics.selectorFallbackCount,
        metrics.retryCount,
        JSON.stringify({ steps }),
        finalError,
        task ?? null,
        workflowKey ?? null,
        verified ?? null,
      ]
    );
  }
}
