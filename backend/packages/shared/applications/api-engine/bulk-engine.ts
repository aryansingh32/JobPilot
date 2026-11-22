import { atsApiClient } from './client.js';
import type { JobTarget, ApiSubmissionResult, BulkApplyReport } from './types.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('bulk-api-engine');

export class BulkApiEngine {
  /**
   * Applies to multiple jobs concurrently using direct ATS APIs with zero browser overhead.
   */
  async applyBatch(
    userId: string,
    targets: JobTarget[],
    concurrency = 5,
    options: {
      dryRun?: boolean;
      onProgress?: (completed: number, total: number, item: { target: JobTarget; result: ApiSubmissionResult }) => void;
    } = {},
  ): Promise<BulkApplyReport> {
    const startTime = Date.now();
    const items: Array<{ target: JobTarget; result: ApiSubmissionResult }> = [];
    let succeeded = 0;
    let failed = 0;
    let completed = 0;

    const queue = [...targets];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) break;

        try {
          const result = await atsApiClient.apply(userId, target, { dryRun: options.dryRun });
          if (result.success) {
            succeeded++;
          } else {
            failed++;
          }
          items.push({ target, result });
          completed++;

          options.onProgress?.(completed, targets.length, { target, result });
        } catch (err) {
          failed++;
          completed++;
          const failedResult: ApiSubmissionResult = {
            success: false,
            provider: 'bulk-engine',
            submissionState: 'failed',
            durationMs: 0,
            error: (err as Error).message,
          };
          items.push({ target, result: failedResult });
          options.onProgress?.(completed, targets.length, { target, result: failedResult });
        }
      }
    });

    await Promise.all(workers);

    const report: BulkApplyReport = {
      total: targets.length,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      items,
    };

    logger.info('bulk-engine:batch-complete', {
      total: report.total,
      succeeded: report.succeeded,
      failed: report.failed,
      durationMs: report.durationMs,
    });

    return report;
  }
}

export const bulkApiEngine = new BulkApiEngine();

