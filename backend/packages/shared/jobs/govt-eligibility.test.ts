import { describe, expect, it } from 'vitest';
import { checkEligibility, levelOf, parseRequirements } from './govt-eligibility.js';

describe('parseRequirements', () => {
  it('reads an age range, as-on date and qualification', () => {
    const r = parseRequirements('Age Limit: 18 to 32 years as on 01.01.2026. Educational Qualification: Graduate in any discipline from a recognised university.');
    expect(r).toMatchObject({ ageMin: 18, ageMax: 32, ageAsOn: '2026-01-01', level: 'graduate' });
  });
  it('reads min/max age and a 12th-pass post', () => {
    const r = parseRequirements('Minimum Age: 18 Years. Maximum Age: 27 Years. Qualification: 12th pass (Intermediate).');
    expect(r).toMatchObject({ ageMin: 18, ageMax: 27, level: 'class12' });
  });
  it('spots women-only posts', () => {
    expect(parseRequirements('Anganwadi worker, women candidates only.').womenOnly).toBe(true);
  });
});

describe('checkEligibility', () => {
  const edu = [{ school: 'X', degree: 'B.Tech', field: 'CSE' }];
  it('is eligible inside the age band with the right degree', () => {
    const e = checkEligibility({ education: edu, government: { dateOfBirth: '2000-05-05', category: 'General' } }, { ageMin: 18, ageMax: 32, level: 'graduate' }, { now: new Date('2026-10-01') });
    expect(e.status).toBe('eligible');
  });
  it('uses category relaxation', () => {
    const base = { ageMax: 30 };
    const dob = '1994-01-01'; // 32 in 2026
    expect(checkEligibility({ government: { dateOfBirth: dob, category: 'General' } }, base, { now: new Date('2026-10-01') }).status).toBe('not_eligible');
    expect(checkEligibility({ government: { dateOfBirth: dob, category: 'OBC', domicileState: 'Bihar' } }, base, { now: new Date('2026-10-01') }).status).toBe('eligible');
  });
  it('asks for the date of birth instead of guessing', () => {
    const e = checkEligibility({ education: edu }, { ageMax: 30 });
    expect(e.status).toBe('check');
    expect(e.needs).toContain('date of birth');
  });
  it('rejects a lower qualification', () => {
    const e = checkEligibility({ education: [{ school: 'S', degree: '12th' }] }, { level: 'graduate' });
    expect(e.status).toBe('not_eligible');
  });
  it('levelOf picks the highest degree', () => {
    expect(levelOf([{ school: 'a', degree: '12th' }, { school: 'b', degree: 'M.Sc' }])).toBe('postgraduate');
  });
});
