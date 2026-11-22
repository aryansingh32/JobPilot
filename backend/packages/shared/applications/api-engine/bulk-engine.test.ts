import { describe, expect, it, vi, beforeEach } from 'vitest';
import { bulkApiEngine } from './bulk-engine.js';
import { atsApiClient } from './client.js';
import type { JobTarget } from './types.js';

describe('BulkApiEngine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('processes batch jobs in parallel and returns aggregated report', async () => {
    const targets: JobTarget[] = [
      { url: 'https://job-boards.greenhouse.io/co1/jobs/1', title: 'Job 1', atsType: 'greenhouse', boardToken: 'co1', externalId: '1' },
      { url: 'https://jobs.lever.co/co2/2', title: 'Job 2', atsType: 'lever', boardToken: 'co2', externalId: '2' },
      { url: 'https://jobs.ashbyhq.com/co3/3', title: 'Job 3', atsType: 'ashby', boardToken: 'co3', externalId: '3' },
    ];

    vi.spyOn(atsApiClient, 'apply').mockResolvedValue({
      success: true,
      provider: 'Mock Provider',
      submissionState: 'submission_accepted',
      durationMs: 45,
      confirmationId: 'conf-mock-123',
    });

    const report = await bulkApiEngine.applyBatch('user-test-123', targets, 2);

    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.items.length).toBe(3);
    expect(report.items[0].result.confirmationId).toBe('conf-mock-123');
  });

  it('isolates failures so one bad job does not abort the batch', async () => {
    const targets: JobTarget[] = [
      { url: 'https://job-boards.greenhouse.io/co1/jobs/1', title: 'Good Job', atsType: 'greenhouse' },
      { url: 'https://job-boards.greenhouse.io/co2/jobs/2', title: 'Bad Job', atsType: 'greenhouse' },
    ];

    vi.spyOn(atsApiClient, 'apply')
      .mockResolvedValueOnce({
        success: true,
        provider: 'Mock Provider',
        submissionState: 'submission_accepted',
        durationMs: 30,
        confirmationId: 'conf-1',
      })
      .mockResolvedValueOnce({
        success: false,
        provider: 'Mock Provider',
        submissionState: 'failed',
        durationMs: 30,
        error: 'Job posting expired',
      });

    const report = await bulkApiEngine.applyBatch('user-test-123', targets, 1);

    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.items[1].result.error).toBe('Job posting expired');
  });
});

