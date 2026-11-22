import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkableApiProvider } from './workable.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Robin Hood',
    firstName: 'Robin',
    lastName: 'Hood',
    email: 'robin@example.com',
    phone: '555-0500',
  },
  resume: {
    buffer: Buffer.from('Mock Workable Resume'),
    fileName: 'Robin_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('WorkableApiProvider', () => {
  let provider: WorkableApiProvider;

  beforeEach(() => {
    provider = new WorkableApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches Workable domains', () => {
    expect(provider.canHandle({ url: 'https://apply.workable.com/techco/j/99AABB', title: 'Role' })).toBe(true);
    expect(provider.canHandle({ url: 'https://techco.com/job', title: 'Role', atsType: 'workable' })).toBe(true);
  });

  it('submits application successfully to Workable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'workable-cand-55' }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );

    const target: JobTarget = {
      url: 'https://apply.workable.com/techco/j/99AABB',
      title: 'Role',
      boardToken: 'techco',
      externalId: '99AABB',
      atsType: 'workable',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.confirmationId).toBe('workable-cand-55');
    expect(result.receiptHash).toBeDefined();
  });
});

