import { describe, expect, it } from 'vitest';
import { classifyIntent, gate, isSensitive, scopeFor } from './intent.js';

describe('classifyIntent', () => {
  const cases: [string, string][] = [
    ['Are you legally authorized to work in the United States?', 'work_authorization'],
    ['Do you have the right to work in the UK?', 'work_authorization'],
    ['Will you now or in the future require visa sponsorship?', 'sponsorship'],
    ['Do you require sponsorship?', 'sponsorship'],
    ['What are your salary expectations?', 'salary_expected'],
    ['Expected CTC (LPA)', 'salary_expected'],
    ['Current CTC', 'salary_current'],
    ['Are you a protected veteran?', 'eeo_veteran'],
    ['Gender', 'eeo_gender'],
    ['Race/Ethnicity', 'eeo_race'],
    ['Do you have a disability?', 'eeo_disability'],
    ['Have you ever been convicted of a felony?', 'criminal_history'],
    ['Do you hold an active security clearance?', 'security_clearance'],
    ['Are you at least 18 years of age?', 'minimum_age'],
    ['Have you previously worked for Databricks?', 'previous_employee'],
    ['How many years of experience do you have with Python?', 'years_technology'],
    ['Total years of experience', 'years_total'],
    ['Are you willing to relocate?', 'relocation'],
    ['How did you hear about this job?', 'referral_source'],
    ['First Name', 'first_name'],
    ['Phone', 'phone'],
    ['I agree to the privacy policy', 'consent'],
    ['Why do you want to work here?', 'other'],
  ];
  for (const [q, intent] of cases) it(`${q} → ${intent}`, () => expect(classifyIntent(q)).toBe(intent));
  it('a long open question is free text', () => {
    expect(classifyIntent('Tell us about a project where you used GitHub actions to improve release velocity for a large team of engineers across time zones', { tag: 'textarea' })).toBe('free_text');
  });
});

describe('gate and scope', () => {
  it('sensitive intents never take a model or default answer', () => {
    expect(isSensitive('work_authorization')).toBe(true);
    expect(gate('work_authorization', 'ai').ok).toBe(false);
    expect(gate('sponsorship', 'default').ok).toBe(false);
    expect(gate('eeo_gender', 'default', 'eeo').ok).toBe(true);
    expect(gate('work_authorization', 'profile').ok).toBe(true);
    expect(gate('years_total', 'ai').ok).toBe(true);
  });
  it('country-dependent answers do not travel', () => {
    expect(scopeFor('work_authorization', 'us')).toBe('country:US');
    expect(scopeFor('work_authorization', null)).toBe('global');
    expect(scopeFor('first_name', 'US')).toBe('global');
  });
});

import { isDeclaration } from './intent.js';
describe('isDeclaration', () => {
  it('flags statements signed per application, not policy checkboxes', () => {
    expect(isDeclaration('I certify that the information provided is true and complete')).toBe(true);
    expect(isDeclaration('I hereby declare that all statements are correct')).toBe(true);
    expect(isDeclaration('I have read and agree to the Privacy Policy')).toBe(false);
    expect(isDeclaration('I agree to the terms and conditions')).toBe(false);
  });
});
