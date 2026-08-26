import type { Page, Locator } from 'playwright';
import { readFile } from 'fs/promises';
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
import { captchaService } from './captcha-service.js';
import { cryptoService } from './crypto-service.js';
import { CaptchaHandler } from './captcha-handler.js';

const logger = createLogger('execution-engine');
const captchaHandler = new CaptchaHandler();

class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled by the user`);
    this.name = 'JobCancelledError';
  }
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
        if (!ctx.page.isClosed()) {
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
    .replace(/\{\{extracted:([^}]+)\}\}/g, (_match, key) => String(ctx.extractedData[key] ?? ''));
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

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  navigate: async (step, ctx) => {
    if (!step.value) throw new Error('navigate action requires a URL value');
    await ctx.page.goto(resolveRuntimeValue(step.value, ctx), {
      waitUntil: 'domcontentloaded',
      timeout: step.timeout,
    });
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
    if (step.expectedInput === 'captcha') {
      // Tier 1: attempt fully-automated, in-browser solve (checkbox+audio for
      // reCAPTCHA v2, hCaptcha checkbox, slider drag simulation). Cheapest and
      // fastest path — no external API cost, no human wait.
      try {
        const auto = await captchaHandler.handle(ctx.page, ctx.jobId);
        if (auto.solved) {
          logger.info('captcha:auto-solved', { jobId: ctx.jobId, stepId: step.id, method: auto.method });
          if (auto.token) ctx.runtimeInputs[step.id] = auto.token;
          return;
        }
        logger.warn('captcha:auto-solve-failed', { jobId: ctx.jobId, stepId: step.id, error: auto.error });
      } catch (err) {
        logger.warn('captcha:auto-solve-threw', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message });
      }

      // Tier 2: premium solver API (if configured, budget permitting) or
      // human-in-the-loop via the admin captcha queue.
      try {
        const locator = await resolveLocator(step, ctx);
        let captchaUrl = '';
        if (locator) {
          const src = await locator.first().getAttribute('src');
          captchaUrl = src && src.startsWith('data:') ? src : `data:image/jpeg;base64,${(await locator.first().screenshot({ type: 'jpeg' })).toString('base64')}`;
        }

        const solution = await captchaService.solve({
          id: `${ctx.jobId}_${step.id}`,
          type: 'text',
          imageUrl: captchaUrl,
          siteId: ctx.siteId,
          userId: ctx.userId,
          premium: Boolean(process.env.CAPTCHA_SOLVER_API_KEY),
        });

        ctx.runtimeInputs[step.id] = solution;
        return;
      } catch (err) {
        logger.warn('captcha:automated-solve-failed-falling-back', { jobId: ctx.jobId, error: (err as Error).message });
      }
    }

    const redis = await getRedisClient();
    await ensureNotCancelled(ctx);
    
    // Boost stream if this is a CAPTCHA or sensitive input
    const stream = (ctx as any).activeStream;
    if (stream && step.expectedInput === 'captcha') {
      stream.setFps(3);
    }

    let captchaUrl = '';
    let rect: { x: number, y: number, w: number, h: number } | undefined = undefined;

    if (step.expectedInput === 'captcha' && step.target) {
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

    await redis.publish('chat:pause', JSON.stringify({
      jobId: ctx.jobId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      stepId: step.id,
      type: step.expectedInput || 'text',
      contextMessage: step.contextMessage ?? step.description,
      data: { captchaUrl, rect }
    }));

    return new Promise<void>((resolve, reject) => {
      const subRedis = redis.duplicate();
      const idleTimeoutMs = step.timeout || 3 * 60 * 1000; // 3 minutes default
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

        // Idle timeout — auto-cancel if user doesn't respond
        const idleTimer = setTimeout(() => {
          if (settled) return;
          console.warn(`[Executor] Idle timeout (${idleTimeoutMs / 1000}s) for job ${ctx.jobId} step ${step.id}`);
          ctx.cancellation.cancelled = true;
          updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
          if (stream && step.expectedInput === 'captcha') {
            stream.setFps(1);
          }
          cleanup().catch(() => {});
          reject(new JobCancelledError(ctx.jobId));
        }, idleTimeoutMs);

        subRedis.subscribe(`job:resume:${ctx.jobId}`, (message) => {
          if (settled) return;
          ctx.runtimeInputs[step.id] = message;
          updateJobRuntimeState(ctx, { status: 'running', activeStepId: step.id }).catch(() => {});
          
          // Reset FPS if it was boosted
          if (stream && step.expectedInput === 'captcha') {
            stream.setFps(1);
          }
          cleanup().catch(() => {});
          resolve();
        });
        subRedis.subscribe(`job:cancel:${ctx.jobId}`, () => {
          if (settled) return;
          ctx.cancellation.cancelled = true;
          updateJobRuntimeState(ctx, { status: 'failed' }).catch(() => {});
          if (stream && step.expectedInput === 'captcha') {
            stream.setFps(1);
          }
          cleanup().catch(() => {});
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
    // then replays those clicks on the browser page.
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

    return new Promise<void>((resolve, reject) => {
      const subRedis = redis.duplicate();
      subRedis.connect().then(() => {
        subRedis.subscribe(`job:resume:${ctx.jobId}`, async (message) => {
          try {
            const { points } = JSON.parse(message) as { points: Array<{ x: number, y: number }> };
            const locator = await resolveLocator(step, ctx);
            const box = await locator.first().boundingBox();
            if (box && points) {
              for (const pt of points) {
                await ctx.page.mouse.click(box.x + pt.x, box.y + pt.y);
                await humanDelay(100, 300);
              }
            }
            await subRedis.quit();
            resolve();
          } catch (err) {
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
};

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

    try {
      const session = await this.sessionManager.getOrCreate(
        job.payload.sessionId,
        job.userId,
        job.payload.siteId
      );

      const entryUrl = actionPlan?.find((step) => step.action === 'navigate')?.target?.value;
      const localeHint = localeForUrl(entryUrl);
      const lease = await pool.acquireContext(sessionId, job.userId, session, session.proxy as any, job.payload.lightweight, localeHint);
      contextId = lease.contextId;
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
        task,
        runtimeInputs: {},
        extractedData: {},
        workflowStack: [],
        workflowRecoveryPlan: (job.metadata?.fallbackPlan as ActionStep[] | undefined) ?? undefined,
        metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
        cancellation: { cancelled: false },
      };

      if (!actionPlan?.length) throw new Error('No action plan provided for execution');

      // Circuit Breaker Check
      const redis = await getRedisClient();
      const cbOpen = await redis.get(`cb:open:${job.payload.siteId}`);
      if (cbOpen) {
        throw new Error(`Circuit breaker open for site ${job.payload.siteId}. Temporarily paused due to consecutive errors.`);
      }

      const stream = await streamLiveView(ctx, job.id, 1);
      (ctx as any).activeStream = stream;
      await updateJobRuntimeState(ctx, { status: 'running' });

      let attempts = 0;
      const MAX_JOB_ATTEMPTS = 3;
      let allSucceeded = false;

      while (attempts < MAX_JOB_ATTEMPTS && !allSucceeded) {
        attempts++;
        try {
          // Clear step results for retry if not first attempt
          if (attempts > 1) {
            stepResults.length = 0;
            logger.info('job:retrying-full-execution', { jobId: job.id, attempt: attempts });
            await ctx.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
          }

          for (const rawStep of actionPlan) {
            await ensureNotCancelled(ctx);
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

            if (!result.success) break;
          }

          allSucceeded = stepResults.every((result) => result.success);
        } catch (err) {
          logger.error('job:execution-error', err, { jobId: job.id, attempt: attempts });
          if (attempts >= MAX_JOB_ATTEMPTS) throw err;
          await humanDelay(2000 * attempts, 5000 * attempts);
        }
      }

      stream.stop();


      await this.sessionManager.save(sessionId, page, lease.context);

      allSucceeded = stepResults.every((result) => result.success);
      await this.logResult(job.id, job.userId, job.payload.sessionId, job.payload.siteId, allSucceeded, stepResults, ctx.metrics, job.payload.task);
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
        if (errs >= 5) await r.setEx(`cb:open:${job.payload.siteId}`, 300, '1');
      }

      // Cleanup old temp files (best effort)
      userFileStore.cleanupTempFiles().catch(() => {});
      
      // Explicitly release the context to immediately destroy it and free up memory
      await pool.releaseContext(contextId, true);
      contextId = undefined; // prevent catch block from accessing it again

      return {
        jobId: job.id,
        success: allSucceeded,
        steps: stepResults,
        duration: Date.now() - startTime,
        screenshots,
        extractedData: ctx.extractedData,
        sessionId,
      };
    } catch (err) {
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

      await getRedisClient().then(r => r.publish('chat:message', JSON.stringify({
        sessionId,
        message: `❌ Task failed: ${error}`,
      }))).catch(() => {});

      if (!wasCancelled) {
        try {
          const r = await getRedisClient();
          const errs = await r.incr(`cb:errors:${job.payload.siteId}`);
          if (errs === 1) await r.expire(`cb:errors:${job.payload.siteId}`, 3600);
          if (errs >= 5) await r.setEx(`cb:open:${job.payload.siteId}`, 300, '1');
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
        error
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
        await handler(step, ctx);
        return {
          stepId: step.id,
          success: true,
          duration: Date.now() - start,
          retryCount: attempt,
        };
      } catch (err) {
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
    errorMessage?: string
  ): Promise<void> {
    const pool = getPgPool();
    const totalDuration = steps.reduce((sum, step) => sum + step.duration, 0);

    // Find first error from steps if errorMessage isn't provided
    const finalError = errorMessage || steps.find(s => s.error)?.error || null;

    await pool.query(
      `INSERT INTO job_logs (
         job_id, user_id, session_id, type, site_id, status, completed_at, duration_ms,
         success, ai_call_count, selector_fallback_cnt, retry_count, result, error, task
       ) VALUES ($1, $2, $3, 'execute', $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      ]
    );
  }
}
