import { getBrowserPool } from './browser-pool.js';
import type { ActionStep } from '../shared/types/index.js';
import { randomUUID } from 'crypto';

export interface DryRunResult {
  success: boolean;
  stepsExecuted: number;
  error?: string;
  failedStepId?: string;
  durationMs: number;
}

export class DryRunService {
  async runDryRun(url: string, steps: ActionStep[]): Promise<DryRunResult> {
    const startTime = Date.now();
    const sessionId = `dryrun-${randomUUID()}`;
    const pool = getBrowserPool();
    const lease = await pool.acquireContext(sessionId, 'admin');
    
    let stepsExecuted = 0;
    try {
      const page = await pool.getOrCreatePage(lease.contextId);
      await page.goto(url, { waitUntil: 'networkidle' });

      for (const step of steps) {
        if (step.action === 'click' && step.target?.value) {
          await page.click(step.target.value, { timeout: 5000 });
        } else if ((step.action === 'fill' ) && step.target?.value) {
          await page.fill(step.target.value, step.value || '', { timeout: 5000 });
        } else if (step.action === 'navigate' && step.target?.value) {
          await page.goto(step.target.value, { waitUntil: 'networkidle' });
        }
        stepsExecuted++;
      }
      
      return {
        success: true,
        stepsExecuted,
        durationMs: Date.now() - startTime
      };
    } catch (error: any) {
      return {
        success: false,
        stepsExecuted,
        error: error.message,
        failedStepId: steps[stepsExecuted]?.id,
        durationMs: Date.now() - startTime
      };
    } finally {
      pool.releaseContext(lease.contextId);
    }
  }
}

export const dryRunService = new DryRunService();
