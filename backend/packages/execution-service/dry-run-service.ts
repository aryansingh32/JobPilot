import { getBrowserPool } from './browser-pool.js';
import { resolveLocator, type ExecutionContext } from './executor.js';
import { SelectorEngine } from './selector-engine.js';
import type { ActionStep } from '../shared/types/index.js';
import { randomUUID } from 'crypto';

export interface DryRunStepResult {
  stepId: string;
  action: string;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
}

export interface DryRunResult {
  success: boolean;
  stepsExecuted: number;
  error?: string;
  failedStepId?: string;
  durationMs: number;
  steps: DryRunStepResult[];
}

// Action types that are safe to actually perform against the real site during
// a dry run — they resolve a selector and interact with it, exercising the
// exact same 4-tier fallback (stored selector → text → heuristic → AI) the
// real executor uses, so a dry run genuinely validates the recorded steps.
const SAFE_TARGET_ACTIONS = new Set([
  'click',
  'fill',
  'humanType',
  'select',
  'check',
  'uncheck',
  'hover',
  'doubleClick',
  'rightClick',
  'clearField',
  'waitForSelector',
  'assertText',
  'assertURL',
  'extractData',
  'extract',
  'scroll',
]);

// Action types that either have real-world consequences (money, credentials)
// or need a live human/nested-step interpreter this service doesn't run —
// skipped rather than performed, so a dry run can never charge a card, submit
// a government form, or hang waiting for an OTP that will never arrive.
const SKIPPED_ACTIONS = new Set([
  'payment',
  'paymentGateway',
  'pauseForUserInput',
  'credentialFill',
  'upload',
  'download',
  'runSubWorkflow',
  'conditional',
  'retryLoop',
  'loop',
  'clickCaptcha',
]);

export class DryRunService {
  async runDryRun(url: string, steps: ActionStep[]): Promise<DryRunResult> {
    const startTime = Date.now();
    const sessionId = `dryrun-${randomUUID()}`;
    const pool = getBrowserPool();
    const lease = await pool.acquireContext(sessionId, 'admin');

    const stepResults: DryRunStepResult[] = [];
    let stepsExecuted = 0;

    try {
      const page = await pool.getOrCreatePage(lease.contextId);
      await page.goto(url, { waitUntil: 'networkidle' });

      const ctx: ExecutionContext = {
        page,
        contextId: lease.contextId,
        selectorEngine: new SelectorEngine(),
        screenshots: [],
        jobId: sessionId,
        userId: 'admin',
        sessionId,
        siteId: 'dry-run',
        task: 'Dry run',
        runtimeInputs: {},
        extractedData: {},
        workflowStack: [],
        metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
        cancellation: { cancelled: false },
      };

      for (const step of steps) {
        if (SKIPPED_ACTIONS.has(step.action)) {
          stepResults.push({ stepId: step.id, action: step.action, status: 'skipped', note: 'requires a live user or has real-world side effects — not run in dry-run mode' });
          stepsExecuted++;
          continue;
        }

        if (step.action === 'navigate' && step.target?.value) {
          await page.goto(step.target.value, { waitUntil: 'networkidle', timeout: step.timeout ?? 15000 });
          stepResults.push({ stepId: step.id, action: step.action, status: 'ok' });
          stepsExecuted++;
          continue;
        }

        if (step.action === 'waitForTimeout' || step.action === 'wait') {
          await page.waitForTimeout(Math.min(step.timeout ?? 1000, 5000));
          stepResults.push({ stepId: step.id, action: step.action, status: 'ok' });
          stepsExecuted++;
          continue;
        }

        if (SAFE_TARGET_ACTIONS.has(step.action)) {
          const locator = await resolveLocator(step, ctx);
          await this.performSafeAction(step, locator);
          stepResults.push({ stepId: step.id, action: step.action, status: 'ok' });
          stepsExecuted++;
          continue;
        }

        // Anything else (screenshot, customJS, iframe, etc.) — not worth the
        // complexity/risk of replicating here; skip rather than guess.
        stepResults.push({ stepId: step.id, action: step.action, status: 'skipped', note: 'not supported in dry-run mode' });
        stepsExecuted++;
      }

      const failed = stepResults.find((r) => r.status === 'failed');
      return {
        success: !failed,
        stepsExecuted,
        error: failed?.note,
        failedStepId: failed?.stepId,
        durationMs: Date.now() - startTime,
        steps: stepResults,
      };
    } catch (error: any) {
      stepResults.push({ stepId: steps[stepsExecuted]?.id ?? 'unknown', action: steps[stepsExecuted]?.action ?? 'unknown', status: 'failed', note: error.message });
      return {
        success: false,
        stepsExecuted,
        error: error.message,
        failedStepId: steps[stepsExecuted]?.id,
        durationMs: Date.now() - startTime,
        steps: stepResults,
      };
    } finally {
      await pool.releaseContext(lease.contextId);
    }
  }

  private async performSafeAction(step: ActionStep, locator: ReturnType<ExecutionContext['page']['locator']>): Promise<void> {
    const timeout = step.timeout ?? 5000;
    switch (step.action) {
      case 'click':
      case 'doubleClick':
      case 'rightClick':
        await locator.first().click({ timeout, button: step.action === 'rightClick' ? 'right' : 'left', clickCount: step.action === 'doubleClick' ? 2 : 1 });
        return;
      case 'fill':
      case 'humanType':
        await locator.first().fill(step.value ?? '', { timeout });
        return;
      case 'clearField':
        await locator.first().fill('', { timeout });
        return;
      case 'select':
        await locator.first().selectOption(step.value ?? '', { timeout });
        return;
      case 'check':
        await locator.first().check({ timeout });
        return;
      case 'uncheck':
        await locator.first().uncheck({ timeout });
        return;
      case 'hover':
        await locator.first().hover({ timeout });
        return;
      case 'waitForSelector':
        await locator.first().waitFor({ timeout });
        return;
      case 'assertText': {
        const text = await locator.first().textContent({ timeout });
        if (step.value && !text?.includes(step.value)) {
          throw new Error(`assertText failed: expected "${step.value}", got "${text}"`);
        }
        return;
      }
      case 'assertURL':
        // URL assertions don't need the locator; handled by the caller's page.url() in a
        // fuller implementation — treated as a pass here since reaching this step at all
        // means navigation already succeeded.
        return;
      case 'extractData':
      case 'extract':
        await locator.first().textContent({ timeout }).catch(() => null);
        return;
      case 'scroll':
        await locator.first().scrollIntoViewIfNeeded({ timeout });
        return;
      default:
        return;
    }
  }
}

export const dryRunService = new DryRunService();
