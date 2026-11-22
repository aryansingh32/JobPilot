import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SmartRecruitersApiProvider } from './smartrecruiters.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Taylor Swift',
    firstName: 'Taylor',
    lastName: 'Swift',
    email: 'taylor@example.com',
    phone: '555-0400',
    city: 'Nashville',
  },
  resume: {
    buffer: Buffer.from('Mock SR Resume'),
    fileName: 'Taylor_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('SmartRecruitersApiProvider', () => {
  let provider: SmartRecruitersApiProvider;

  beforeEach(() => {
    provider = new SmartRecruitersApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches SmartRecruiters domains', () => {
    expect(provider.canHandle({ url: 'https://jobs.smartrecruiters.com/Acme/123-dev', title: 'Dev' })).toBe(true);
    expect(provider.canHandle({ url: 'https://acme.com/apply', title: 'Dev', atsType: 'smartrecruiters' })).toBe(true);
  });

  it('submits application successfully to SmartRecruiters', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'candidate-sr-7788' }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );

    const target: JobTarget = {
      url: 'https://jobs.smartrecruiters.com/Acme/123-dev',
      title: 'Dev',
      boardToken: 'Acme',
      externalId: '123-dev',
      atsType: 'smartrecruiters',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.confirmationId).toBe('candidate-sr-7788');
    expect(result.receiptHash).toBeDefined();
  });
});

