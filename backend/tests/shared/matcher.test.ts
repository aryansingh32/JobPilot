import { describe, it, expect } from 'vitest';
import { scoreJob, type JobRow } from '../../packages/shared/jobs/matcher.js';

const profile = {
  personal: { city: 'San Francisco', country: 'US' },
  work: { experienceLevel: '2–5 years' },
  authorization: { countries: ['US'], needsSponsorship: false },
  preferences: { roles: ['Software Engineer'], locations: ['San Francisco', 'Remote'], workplace: ['Remote', 'Hybrid'] },
  skills: ['TypeScript', 'Python', 'AWS'],
};
const job = (location: string, country: string | null, workplace: JobRow['workplace']): JobRow => ({
  id: '1', title: 'Software Engineer', company: 'X', url: '', location, country, workplace, employment_type: null,
  salary_min: null, salary_max: null, salary_currency: null, salary_period: null, posted_at: null,
  skills: ['TypeScript', 'Python', 'AWS'], seniority: 'mid', ats_type: 'greenhouse',
});

describe('scoreJob location', () => {
  it('treats the metro area as the chosen city', () => {
    expect(scoreJob(profile, job('Menlo Park, CA', 'US', 'Hybrid'))).toMatchObject({ score: 100, eligible: true });
  });
  it('keeps another US city below local roles', () => {
    const r = scoreJob(profile, job('Seattle, WA', 'US', null));
    expect(r.score).toBeLessThanOrEqual(60);
    expect(r.reasons).toContain('Another city — may need to relocate');
  });
  it('penalises a workplace the user did not pick', () => {
    expect(scoreJob(profile, job('San Francisco, CA', 'US', 'On-site')).score).toBe(90);
  });
  it('hides remote roles tied to a country the user cannot work in', () => {
    expect(scoreJob(profile, job('Remote - Canada', 'CA', 'Remote')).eligible).toBe(false);
  });
  it('hides on-site roles abroad', () => {
    expect(scoreJob(profile, job('Bengaluru', 'IN', 'On-site')).eligible).toBe(false);
  });
});

describe('India', () => {
  const india = {
    personal: { city: 'Gurugram', country: 'IN' },
    work: { experienceLevel: 'Student / fresher' },
    authorization: { countries: ['IN'] },
    preferences: { roles: ['Software Engineer'], locations: ['Delhi NCR'], workplace: ['On-site', 'Hybrid'] },
    skills: ['Java', 'SQL'],
  };
  const job = (location: string, min: number | null, max: number | null): JobRow => ({
    id: '1', title: 'Software Engineer', company: 'X', url: '', location, country: 'IN', workplace: null, employment_type: null,
    salary_min: null, salary_max: null, salary_currency: null, salary_period: null, posted_at: null,
    skills: ['Java', 'SQL'], seniority: 'mid', ats_type: 'keka', experience_min: min, experience_max: max,
  });
  it('treats Noida as part of Delhi NCR', () => {
    expect(scoreJob(india, job('Noida, Uttar Pradesh, India', 0, 1)).reasons).toContain('In your city');
  });
  it('fits a fresher to 0–1 year roles and hides 5+ year ones', () => {
    expect(scoreJob(india, job('Gurugram', 0, 1))).toMatchObject({ eligible: true });
    expect(scoreJob(india, job('Gurugram', 0, 1)).reasons).toContain('Fits your experience (0–1 yrs)');
    expect(scoreJob(india, job('Gurugram', 5, 8)).eligible).toBe(false);
  });
});
