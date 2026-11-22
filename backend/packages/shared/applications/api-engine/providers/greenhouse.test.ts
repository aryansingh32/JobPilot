import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GreenhouseApiProvider } from './greenhouse.js';
import type { CandidateProfile, JobTarget } from '../types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Alex River',
    firstName: 'Alex',
    lastName: 'River',
    email: 'alex@example.com',
    phone: '555-0100',
    country: 'United States',
  },
  work: {
    yearsOfExperience: 5,
  },
  authorization: {
    needsSponsorship: false,
    authorizedCountries: ['US'],
  },
  resume: {
    buffer: Buffer.from('Mock PDF Content'),
    fileName: 'Alex_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('GreenhouseApiProvider', () => {
  let provider: GreenhouseApiProvider;

  beforeEach(() => {
    provider = new GreenhouseApiProvider();
    vi.restoreAllMocks();
  });

  it('canHandle matches greenhouse domains and job urls', () => {
    expect(provider.canHandle({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/12345', title: 'Eng' })).toBe(true);
    expect(provider.canHandle({ url: 'https://boards.greenhouse.io/stripe/jobs/67890', title: 'Eng' })).toBe(true);
    expect(provider.canHandle({ url: 'https://careers.company.com/job/1', title: 'Eng', atsType: 'greenhouse' })).toBe(true);
    expect(provider.canHandle({ url: 'https://jobs.lever.co/palantir/1', title: 'Eng' })).toBe(false);
  });

  it('fetches schema from Greenhouse public API', async () => {
    const mockQuestions = {
      questions: [
        {
          label: 'First Name',
          required: true,
          fields: [{ name: 'first_name', type: 'input_text' }],
        },
        {
          label: 'Are you legally authorized to work in the US?',
          required: true,
          fields: [
            {
              name: 'question_1001',
              type: 'multi_value_single_select',
              values: [
                { label: 'Yes', value: 1 },
                { label: 'No', value: 0 },
              ],
            },
          ],
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockQuestions), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const target: JobTarget = {
      url: 'https://job-boards.greenhouse.io/sampleco/jobs/998877',
      title: 'Dev',
      atsType: 'greenhouse',
    };

    const schema = await provider.fetchSchema(target);
    expect(schema.length).toBe(2);
    expect(schema[0].label).toBe('First Name');
    expect(schema[1].fields[0].name).toBe('question_1001');
  });

  it('submits application successfully and returns confirmation receipt', async () => {
    // 1st fetch: fetchSchema
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ questions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      // 2nd fetch: submit POST
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://job-boards.greenhouse.io/sampleco/jobs/998877/confirmation/gh-conf-123' },
        }),
      );

    const target: JobTarget = {
      url: 'https://job-boards.greenhouse.io/sampleco/jobs/998877',
      title: 'Senior Engineer',
      boardToken: 'sampleco',
      externalId: '998877',
      atsType: 'greenhouse',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(302);
    expect(result.confirmationId).toBe('gh-conf-123');
    expect(result.receiptHash).toBeDefined();
    expect(result.submittedPayload?.firstName).toBe('Alex');
  });

  it('handles submission errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ questions: [] }), { status: 200 }))
      .mockResolvedValue(new Response('Missing required field', { status: 422 }));

    const target: JobTarget = {
      url: 'https://job-boards.greenhouse.io/sampleco/jobs/998877',
      title: 'Senior Engineer',
      boardToken: 'sampleco',
      externalId: '998877',
      atsType: 'greenhouse',
    };

    const result = await provider.submit(target, mockCandidate);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(422);
    expect(result.error).toContain('Missing required field');
  });
});

