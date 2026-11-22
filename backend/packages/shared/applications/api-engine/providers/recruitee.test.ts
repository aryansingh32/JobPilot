import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RecruiteeApiProvider } from './recruitee.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Casey Stone',
    firstName: 'Casey',
    lastName: 'Stone',
    email: 'casey@example.com',
  },
  resume: {
    buffer: Buffer.from('Mock Recruitee Resume'),
    fileName: 'Casey_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('RecruiteeApiProvider', () => {
  let provider: RecruiteeApiProvider;

  beforeEach(() => {
    provider = new RecruiteeApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches Recruitee domains', () => {
    expect(provider.canHandle({ url: 'https://startup.recruitee.com/o/lead-dev', title: 'Lead' })).toBe(true);
    expect(provider.canHandle({ url: 'https://startup.com/o/1', title: 'Lead', atsType: 'recruitee' })).toBe(true);
  });

  it('submits application successfully to Recruitee', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ candidate: { id: 123456 } }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );

    const target: JobTarget = {
      url: 'https://startup.recruitee.com/o/lead-dev',
      title: 'Lead',
      boardToken: 'startup',
      externalId: 'lead-dev',
      atsType: 'recruitee',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.confirmationId).toBe('123456');
    expect(result.receiptHash).toBeDefined();
  });
});

