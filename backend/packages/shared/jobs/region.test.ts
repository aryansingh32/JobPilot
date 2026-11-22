import { describe, it, expect } from 'vitest';
import { scoreJob, homeCountry, type JobRow } from './matcher.js';
import { matchedSkills, openEnded } from '../../execution-service/ai-answers.js';
import type { FormField } from '../../execution-service/form-filler.js';

const job = (over: Partial<JobRow>): JobRow => ({
  id: '1', title: 'Backend Engineer', company: 'Acme', url: 'u', location: null, country: null, workplace: null, employment_type: null,
  salary_min: null, salary_max: null, salary_currency: null, salary_period: null, posted_at: null, skills: ['Node.js', 'SQL'],
  seniority: null, ats_type: 'greenhouse', ...over,
});
// No city or workplace named: the only location signal is where the person connects from.
const me = { preferences: { roles: ['Backend Engineer'] }, skills: ['node.js', 'sql'], personal: { detectedCountry: 'in' } };

describe('region-first ranking', () => {
  it('takes the home country from the person first, else from the network', () => {
    expect(homeCountry({ personal: { country: 'US', detectedCountry: 'IN' } })).toBe('US');
    expect(homeCountry(me)).toBe('IN');
    expect(homeCountry({ personal: { country: 'India' } })).toBeNull();
  });
  it('a job in the region is eligible and ranks above a remote one tied to another country', () => {
    const local = scoreJob(me, job({ country: 'IN', workplace: 'On-site', location: 'Pune' }));
    const abroad = scoreJob(me, job({ country: 'US', workplace: 'On-site', location: 'Austin' }));
    expect(local.eligible).toBe(true);
    expect(local.reasons).toContain('In your region');
    expect(abroad.eligible).toBe(false);
  });
  it('global remote is eligible; remote tied to another country is not', () => {
    expect(scoreJob(me, job({ workplace: 'Remote', location: 'Remote' })).eligible).toBe(true);
    expect(scoreJob(me, job({ workplace: 'Remote', country: 'DE', location: 'Remote - Germany' })).eligible).toBe(false);
  });
  it('can be switched off', () => {
    expect(scoreJob(me, job({ country: 'US', workplace: 'On-site' }), { regionOnly: false }).eligible).toBe(true);
  });
});

const field = (label: string, over: Partial<FormField> = {}): FormField =>
  ({ idx: 0, tag: 'textarea', type: 'textarea', label, name: '', required: false, options: [], value: '', selector: null, ...over }) as FormField;

describe('answer helpers', () => {
  it('recognises open-ended questions, not factual ones', () => {
    expect(openEnded(field('Why do you want to work at Acme?'))).toBe(true);
    expect(openEnded(field('Tell us about yourself'))).toBe(true);
    expect(openEnded(field('Years of experience with SQL', { type: 'number' }))).toBe(false);
    expect(openEnded(field('Why are you leaving?', { options: ['Yes', 'No'] }))).toBe(false);
  });
  it('matched skills are only ones the person really has', () => {
    expect(matchedSkills({ skills: ['Node.js', 'SQL'] }, 'node.js, Rust, SQL')).toEqual(['node.js', 'SQL']);
    expect(matchedSkills({ skills: [] }, 'Rust')).toEqual([]);
  });
});

describe('résumé-based match', () => {
  it('a job like a past role scores even when it is not a named target', () => {
    const p = { preferences: { roles: ['Product Manager'] }, experience: [{ company: 'Initech', title: 'Backend Engineer' }], personal: { detectedCountry: 'IN' } };
    const r = scoreJob(p, job({ country: 'IN', workplace: 'On-site' }));
    expect(r.reasons).toContain('Like your work at Initech');
    expect(r.eligible).toBe(true);
  });
  it('tools named in achievements count as skills', () => {
    const p = { preferences: { roles: ['Backend Engineer'] }, experience: [{ company: 'X', title: 'Dev', highlights: ['Cut query time 60% by tuning SQL and Redis caching'] }], personal: { detectedCountry: 'IN' } };
    expect(scoreJob(p, job({ country: 'IN', skills: ['SQL', 'Redis'] })).matchedSkills.length).toBe(2);
  });
});
