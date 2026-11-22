import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AshbyApiProvider } from './ashby.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Morgan Blake',
    firstName: 'Morgan',
    lastName: 'Blake',
    email: 'morgan@example.com',
    phone: '555-0300',
    linkedin: 'https://linkedin.com/in/morganblake',
    country: 'US',
  },
  resume: {
    buffer: Buffer.from('Mock Ashby Resume'),
    fileName: 'Morgan_Resume.pdf',
    mimeType: 'application/pdf',
  },
  authorization: { authorizedCountries: ['US'], needsSponsorship: false },
};

describe('AshbyApiProvider', () => {
  let provider: AshbyApiProvider;

  beforeEach(() => {
    provider = new AshbyApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches Ashby domains', () => {
    expect(provider.canHandle({ url: 'https://jobs.ashbyhq.com/company/abc-123', title: 'Role' })).toBe(true);
    expect(provider.canHandle({ url: 'https://custom.com/job', title: 'Role', atsType: 'ashby' })).toBe(true);
    expect(provider.canHandle({ url: 'https://jobs.lever.co/company/1', title: 'Role' })).toBe(false);
  });

  it('submits application successfully to Ashby', async () => {
    vi.spyOn(globalThis, 'fetch')
      // 1. fetchSchema
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobs: [{ id: 'job-ashby-1', title: 'Eng' }] }), { status: 200 }),
      )
      // 2. submit
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const target: JobTarget = {
      url: 'https://jobs.ashbyhq.com/sampleorg/job-ashby-1',
      title: 'Dev',
      boardToken: 'sampleorg',
      externalId: 'job-ashby-1',
      atsType: 'ashby',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.confirmationId).toBeUndefined();
    expect(result.submissionState).toBe('submission_accepted');
    expect(result.receiptHash).toBeDefined();
  });
});

