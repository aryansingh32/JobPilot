import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LeverApiProvider } from './lever.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    email: 'jordan@example.com',
    phone: '555-0200',
    linkedin: 'https://linkedin.com/in/jordanlee',
    github: 'https://github.com/jordanlee',
    website: 'https://jordanlee.dev',
    summary: 'Full Stack Engineer with React and Node experience.',
  },
  work: {
    currentEmployer: 'Alpha Startup',
  },
  resume: {
    buffer: Buffer.from('Mock Resume'),
    fileName: 'Jordan_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('LeverApiProvider', () => {
  let provider: LeverApiProvider;

  beforeEach(() => {
    provider = new LeverApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches Lever domains and URLs', () => {
    expect(provider.canHandle({ url: 'https://jobs.lever.co/company/abc-123', title: 'Eng' })).toBe(true);
    expect(provider.canHandle({ url: 'https://company.com/jobs/1', title: 'Eng', atsType: 'lever' })).toBe(true);
    expect(provider.canHandle({ url: 'https://boards.greenhouse.io/sample/1', title: 'Eng' })).toBe(false);
  });

  it('submits application successfully to Lever API', async () => {
    // 1st fetch: fetchSchema (posting details)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'job-123',
            text: 'Software Engineer',
            cards: [
              {
                id: 'card-1',
                text: 'Work Authorization',
                fields: [{ id: 'f1', text: 'Are you authorized to work in US?', type: 'dropdown', options: [{ id: 'o1', text: 'Yes' }, { id: 'o2', text: 'No' }] }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // 2nd fetch: POST submit
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: { applicationId: 'lever-app-xyz-789' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const target: JobTarget = {
      url: 'https://jobs.lever.co/techco/job-123',
      title: 'Software Engineer',
      atsType: 'lever',
      boardToken: 'techco',
      externalId: 'job-123',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.confirmationId).toBe('lever-app-xyz-789');
    expect(result.receiptHash).toBeDefined();
    expect(result.submittedPayload?.name).toBe('Jordan Lee');
  });

  it('handles rate limits (429) cleanly', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json' } }),
      );

    const target: JobTarget = {
      url: 'https://jobs.lever.co/techco/job-123',
      title: 'Engineer',
      boardToken: 'techco',
      externalId: 'job-123',
      atsType: 'lever',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.error).toContain('Too many requests');
  });
});

