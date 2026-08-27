import type { Page } from 'playwright';
import type { ActionStep, InterventionResolvedBy } from '../../shared/types/index.js';
import type { ExecutionContext } from '../executor.js';
import { createLogger } from '../../shared/logger/index.js';
import { detectChallenge } from './detector.js';
import { selectProvider } from './provider-registry.js';
import { canUsePaidProvider, recordPaidProviderUsage } from './plan-gate.js';
import { createEvent, resolveEvent, updateWorkflowCheckpoint } from './events.js';
import { SOLVABLE_CHALLENGE_TYPES, SECURITY_BLOCK_TYPES } from './types.js';
import type { ChallengeDetection } from './types.js';
import { CaptchaHandler } from '../captcha-handler.js';

const logger = createLogger('captcha-orchestrator');
const captchaHandler = new CaptchaHandler();

// ============================================================
// ORCHESTRATOR
// The single entry point executor.ts calls for any pause/checkpoint
// step. Owns: detection -> free auto-solve -> plan-gated paid solve.
// Deliberately does NOT own the human-in-the-loop Redis pause/resume
// mechanics — that already exists in executor.ts (idle timeout, live
// stream FPS boost, cancellation) and is left untouched; this module
// only decides whether human intervention is needed and records what
// happened once it's over. No LLM calls anywhere in this module.
// ============================================================

const MAX_AUTO_ATTEMPTS = parseInt(process.env.CAPTCHA_MAX_AUTO_ATTEMPTS ?? '2', 10);

export interface BeginChallengeResult {
  detection: ChallengeDetection;
  /** null only if the DB write itself failed — resolution still proceeds, just unlogged. */
  eventId: string | null;
}

/** Classify the current step/page and open a metrics event for it. Always returns a result — callers decide what to do with a non-detected/generic classification. */
export async function beginChallenge(page: Page, ctx: ExecutionContext, step: ActionStep): Promise<BeginChallengeResult> {
  let detection: ChallengeDetection;
  try {
    detection = await detectChallenge(page, { expectedInput: step.expectedInput });
  } catch (err) {
    logger.warn('begin-challenge:detect-failed', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message });
    detection = { detected: false, type: 'unknown', eventType: 'generic' };
  }

  let eventId: string | null = null;
  try {
    eventId = await createEvent({
      jobId: ctx.jobId,
      workflowKey: ctx.workflowKey,
      siteId: ctx.siteId,
      userId: ctx.userId,
      stepId: step.id,
      eventType: detection.eventType,
      challengeType: detection.detected ? detection.type : undefined,
      metadata: { signal: detection.signal, sitekey: detection.sitekey },
    });
  } catch (err) {
    logger.warn('begin-challenge:event-create-failed', { jobId: ctx.jobId, stepId: step.id, error: (err as Error).message });
  }

  return { detection, eventId };
}

export interface AutoAttemptResult {
  resolved: boolean;
  resolvedBy: InterventionResolvedBy;
  token?: string;
  provider?: string;
  attempts: number;
  costUsd: number;
  error?: string;
}

/**
 * Tiers 1+2: free in-browser solve, then a plan-gated paid provider.
 * Bounded to MAX_AUTO_ATTEMPTS total — never loops, never calls an LLM.
 * Security blocks (WAF/rate-limit/JS interstitial) are refused here even
 * if a caller mistakenly invokes this on one — those are never auto-attempted.
 */
export async function attemptAutomatedResolution(
  page: Page,
  ctx: ExecutionContext,
  detection: ChallengeDetection
): Promise<AutoAttemptResult> {
  if (SECURITY_BLOCK_TYPES.has(detection.type)) {
    return { resolved: false, resolvedBy: 'skipped', attempts: 0, costUsd: 0, error: 'security block — never auto-attempted, routed to human/report' };
  }
  if (detection.eventType !== 'captcha' || !SOLVABLE_CHALLENGE_TYPES.has(detection.type)) {
    return { resolved: false, resolvedBy: 'skipped', attempts: 0, costUsd: 0, error: 'not an auto-solvable captcha challenge' };
  }

  let attempts = 0;

  // Tier 1 — free, in-browser (checkbox / audio / slider). No cost, no plan gate.
  if (attempts < MAX_AUTO_ATTEMPTS) {
    attempts++;
    try {
      const result = await captchaHandler.handle(page, ctx.jobId);
      if (result.solved) {
        return { resolved: true, resolvedBy: 'auto', token: result.token, attempts, costUsd: 0 };
      }
      logger.info('auto-resolve:tier1-failed', { jobId: ctx.jobId, type: detection.type, error: result.error });
    } catch (err) {
      logger.warn('auto-resolve:tier1-threw', { jobId: ctx.jobId, error: (err as Error).message });
    }
  }

  // Tier 2 — paid provider API, gated by the user's plan/usage limits.
  if (attempts < MAX_AUTO_ATTEMPTS) {
    const gate = await canUsePaidProvider(ctx.userId).catch((err) => {
      logger.warn('auto-resolve:plan-gate-failed', { jobId: ctx.jobId, error: (err as Error).message });
      return null;
    });

    if (gate && !gate.allowed) {
      logger.info('auto-resolve:plan-gate-denied', { jobId: ctx.jobId, userId: ctx.userId, reason: gate.reason });
    }

    if (gate?.allowed) {
      const provider = selectProvider(detection.type);
      if (provider) {
        attempts++;
        try {
          const result = await provider.solve({
            challengeType: detection.type,
            sitekey: detection.sitekey,
            pageUrl: page.url(),
            imageUrl: await captureChallengeImage(page, detection).catch(() => undefined),
          });
          if (result.solved && result.token) {
            await recordPaidProviderUsage(ctx.userId, result.costUsd).catch(() => {});
            return { resolved: true, resolvedBy: 'premium_api', token: result.token, provider: provider.id, attempts, costUsd: result.costUsd };
          }
          logger.warn('auto-resolve:tier2-failed', { jobId: ctx.jobId, provider: provider.id, error: result.error });
          return { resolved: false, resolvedBy: 'failed', provider: provider.id, attempts, costUsd: result.costUsd, error: result.error };
        } catch (err) {
          return { resolved: false, resolvedBy: 'failed', provider: provider.id, attempts, costUsd: 0, error: (err as Error).message };
        }
      }
    }
  }

  return { resolved: false, resolvedBy: 'failed', attempts, costUsd: 0, error: 'no automated resolution available — falling back to human-in-the-loop' };
}

async function captureChallengeImage(page: Page, detection: ChallengeDetection): Promise<string | undefined> {
  if (detection.type !== 'image-text' || !detection.selector) return undefined;
  const locator = page.locator(detection.selector).first();
  const buffer = await locator.screenshot({ type: 'jpeg', quality: 80 });
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

/** Record how a challenge was ultimately resolved (auto, paid, human, or failed/timeout) and retain the checkpoint on its workflow. */
export async function finalizeResolution(
  eventId: string | null,
  ctx: ExecutionContext,
  step: ActionStep,
  detection: ChallengeDetection,
  outcome: { status: 'resolved' | 'failed' | 'timeout'; resolvedBy: InterventionResolvedBy; provider?: string; attempts: number; costUsd?: number; durationMs?: number; error?: string }
): Promise<void> {
  if (eventId) {
    await resolveEvent(eventId, {
      status: outcome.status,
      resolvedBy: outcome.resolvedBy,
      provider: outcome.provider,
      attempts: outcome.attempts,
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      error: outcome.error,
    });
  }

  const workflowKey = ctx.workflowKey;
  if (workflowKey && detection.detected) {
    await updateWorkflowCheckpoint(workflowKey, {
      stepId: step.id,
      eventType: detection.eventType,
      challengeType: detection.type,
      resolvedBy: outcome.resolvedBy,
      provider: outcome.provider,
    });
  }
}
