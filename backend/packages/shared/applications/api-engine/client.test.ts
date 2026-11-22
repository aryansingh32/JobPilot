import { describe, expect, it, vi, beforeEach } from 'vitest';
import { atsApiClient } from './client.js';
import { profileService } from '../../profile/index.js';
import type { JobTarget } from './types.js';

describe('AtsApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes providers without advertising uncertified adapters as live-capable', () => {
    expect(atsApiClient.findProvider({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/1', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.findProvider({ url: 'https://jobs.lever.co/company/2', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.findProvider({ url: 'https://jobs.ashbyhq.com/company/3', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.findProvider({ url: 'https://jobs.smartrecruiters.com/company/4', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.findProvider({ url: 'https://apply.workable.com/company/5', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.findProvider({ url: 'https://company.recruitee.com/o/6', title: 'Eng' })).not.toBeNull();
    expect(atsApiClient.canApplyViaApi({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/1', title: 'Eng' })).toBe(false);
    expect(atsApiClient.canApplyViaApi({ url: 'https://company.myworkdayjobs.com/en-US/careers/job/7', title: 'Eng' })).toBe(false);
  });

  it('refuses live direct submissions before profile access or network I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const profile = vi.spyOn(profileService, 'get');
    const result = await atsApiClient.apply('00000000-0000-0000-0000-000000000001', {
      url: 'https://jobs.lever.co/company/2', title: 'Eng', atsType: 'lever',
    });
    expect(result.success).toBe(false);
    expect(result.submissionState).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });

  it('runs dry run without making outbound network requests', async () => {
    const target: JobTarget = {
      url: 'https://job-boards.greenhouse.io/sampleco/jobs/12345',
      title: 'Backend Engineer',
      atsType: 'greenhouse',
      boardToken: 'sampleco',
      externalId: '12345',
    };

    // Mock profileService.get to avoid connecting to Postgres in unit test
    vi.spyOn(profileService, 'get').mockResolvedValue({
      version: 1,
      data: {
        personal: { fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
      },
    } as any);

    // Mock Greenhouse fetchSchema
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ questions: [] }), { status: 200 }),
    );

    const result = await atsApiClient.apply('00000000-0000-0000-0000-000000000001', target, {
      dryRun: true,
      resumeBuffer: Buffer.from('%PDF-test'),
    });
    expect(result.success).toBe(true);
    expect(result.submissionState).toBe('simulated');
    expect(result.confirmationId).toBeUndefined(); // Zero synthetic IDs in dryRun mode
    expect(result.provider).toBe('Greenhouse API Engine');
    expect(result.timings?.tSchemaFetchMs).toBeGreaterThanOrEqual(0);
  });
});
