import { describe, it, expect } from 'vitest';
import { buildAnswerBook, planAnswers, residenceAnswer, countryNamed, ruleFor, type FormField } from './form-filler.js';

const f = (label: string, options: string[] = [], type = options.length ? 'select' : 'text'): FormField =>
  ({ idx: 0, tag: options.length ? 'select' : 'input', type, label, name: '', required: true, options, value: '', selector: null }) as FormField;
const india = buildAnswerBook({ personal: { country: 'IN', nationality: 'Indian' } }, { country: 'US' });
const YN = ['Yes', 'No'];

describe('residence and citizenship follow the person, not the job', () => {
  it('names the country in the question', () => {
    expect(countryNamed('Do you currently reside in the United States?')).toBe('US');
    expect(countryNamed('Are you a citizen of the UK or Ireland?')).toBeNull();
  });
  it('a person in India does not reside in the US, and lives in India', () => {
    expect(residenceAnswer(f('Do you currently reside in the United States?', YN), india, 'Indian')).toBe('No');
    expect(residenceAnswer(f('Are you currently located in India?', YN), india, 'Indian')).toBe('Yes');
  });
  it('citizenship is judged by nationality', () => {
    expect(residenceAnswer(f('Are you a citizen of the United States?', YN), india, 'Indian')).toBe('No');
    expect(residenceAnswer(f('Are you a citizen of India?', YN), india, 'Indian')).toBe('Yes');
  });
  it('country of residence / citizenship pick-lists', () => {
    expect(residenceAnswer(f('Country of residence', ['Germany', 'India', 'United States']), india, 'Indian')).toBe('India');
    expect(residenceAnswer(f('Country of citizenship', ['Germany', 'India']), india, 'Indian')).toBe('India');
  });
  it('relocation questions are not residence questions, and unknown places are asked', () => {
    expect(residenceAnswer(f('Are you willing to relocate to the United States?', YN), india, 'Indian')).toBeNull();
    expect(residenceAnswer(f('Do you live in California?', YN), india, 'Indian')).toBeNull();
  });
  it('falls back to the network country when none was given', () => {
    const b = buildAnswerBook({ personal: { detectedCountry: 'in' } }, {});
    expect(b.country).toBe('India');
    expect(b.homeCountryCode).toBe('IN');
  });
  it('plans the answer without asking', async () => {
    const { answers, missing } = await planAnswers([f('Do you reside in the United States?', YN)], india, async () => null);
    expect(missing).toEqual([]);
    expect(answers[0]).toMatchObject({ value: 'No', key: 'residence' });
  });
});

describe('prepared personal answers', () => {
  const p = { personal: { fullName: 'A B' }, work: { yearsOfExperience: 4, currentTitle: 'Data Analyst' }, skills: ['SQL', 'Python'], preferences: { roles: ['Data Analyst'] } };
  it.each([
    ['Tell us about yourself', 'aboutYou'], ['What are your key strengths?', 'strengths'], ['Describe your greatest professional achievement', 'achievement'],
    ['What are your career goals?', 'careerGoal'],
  ])('%s → %s', (label, key) => expect(ruleFor(f(label))).toBe(key));
  it('fills them from the profile with no model', async () => {
    const book = buildAnswerBook(p, {});
    const { answers, missing } = await planAnswers([{ ...f('Tell us about yourself'), tag: 'textarea', type: 'textarea' } as FormField], book, async () => null);
    expect(missing).toEqual([]);
    expect(answers[0].value).toContain('Data Analyst');
  });
});

import { dialCodeOption } from './form-filler.js';
describe('live-run findings (2026-10-26 provider tests)', () => {
  const codes = ['+93', '+355', '+1-684', '+1', '+44', '+91', '+971'];
  it('picks the dial code of the number', () => {
    expect(dialCodeOption(codes, '+1 415 555 0100')).toBe('+1');
    expect(dialCodeOption(codes, '+91 98765 43210')).toBe('+91');
    expect(dialCodeOption(codes, '9876543210')).toBeNull();
  });
  const sel = (label: string, options = YN, type = 'select'): FormField => ({ idx: 0, tag: type === 'select' ? 'select' : 'input', type, label, name: '', required: true, options, value: '', selector: null }) as FormField;
  const book = buildAnswerBook({ personal: { country: 'US' }, work: { currentEmployer: 'Example Corp' } }, {});
  it.each([
    ['Are you over the age of 18 ?', 'Yes'],
    ['Are you currently (or previously) engaged with Pebl or its affiliate partners/clients as an employee, supported employee or any engagement type?', 'No'],
    ['Are you now, or have you ever been employed by Fanatics, Inc. or any of its affiliates or subsidiaries?', 'No'],
  ])('%s → %s', async (label, value) => {
    const { answers } = await planAnswers([sel(label)], book, async () => null);
    expect(answers[0]?.value).toBe(value);
  });
  it('a typeahead (options not readable yet) still gets the default in words', async () => {
    const { answers } = await planAnswers([sel('Are you over the age of 18 ?', [], 'combobox')], book, async () => null);
    expect(answers[0]?.value).toBe('Yes');
  });
  it('a long "current employer" label still reads as the employer', () => {
    expect(ruleFor(sel('Please provide the name of your current employer (or most recent employer if not currently employed). This information is used for conflict-of-interest and client relationship reviews.', [], 'text'))).toBe('currentCompany');
  });
});
