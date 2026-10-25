import { describe, expect, it } from 'vitest';
import { ruleFor, type FormField } from './form-filler.js';

const f = (label: string): FormField => ({ idx: 0, label, name: '', type: 'text', tag: 'input', options: [], required: true, value: '' } as unknown as FormField);

describe('question wording → profile fact', () => {
  const cases: [string, string | null][] = [
    ['Current company', 'currentCompany'],
    ['Company name', 'currentCompany'],
    ['Where do you currently work?', 'currentCompany'],
    ['Current employer / organisation', 'currentCompany'],
    ['Nom de l\'entreprise', 'currentCompany'],
    ['Present designation', 'currentTitle'],
    ['What is your current CTC?', 'currentSalary'],
    ['Current annual salary (INR)', 'currentSalary'],
    ['Last drawn salary', 'currentSalary'],
    ['Expected CTC', 'expectedSalary'],
    ['Expected annual salary', 'expectedSalary'],
    ['Salary expectations', 'expectedSalary'],
    ['Notice period (in days)', 'noticePeriod'],
    ['How soon can you join?', 'noticePeriod'],
    ['Why do you want to work at our company?', null],
    ['Why this company?', null],
  ];
  for (const [label, key] of cases) it(`${label} → ${key}`, () => expect(ruleFor(f(label))).toBe(key));
});

import { rangeOption, sourceOption } from './form-filler.js';
describe('option pickers', () => {
  it('picks the experience range', () => {
    const o = ['<1 Yrs', '1-3 Yrs', '3-6 Yrs', '6+ Yrs'];
    expect(rangeOption(o, 0)).toBe('<1 Yrs');
    expect(rangeOption(o, 2)).toBe('1-3 Yrs');
    expect(rangeOption(o, 8)).toBe('6+ Yrs');
  });
  it('picks a generic source', () => {
    expect(sourceOption(['LinkedIn', 'Referred by a friend', 'Motive Careers Page'])).toBe('Motive Careers Page');
  });
  it('relevant experience in skills is the years fact', () => {
    expect(ruleFor(f('What relevant experience do you have in the key skills mentioned in the job qualifications?'))).toBe('yearsExperience');
  });
});

describe('right to work', () => {
  it('a document-type question is not the yes/no authorisation', () => {
    expect(ruleFor(f('Please confirm type of right to work document'))).toBeNull();
    expect(ruleFor(f('Are you legally authorised to work in India?'))).toBe('authorized');
  });
});

import { noticeDays, noticeOption } from './form-filler.js';
describe('notice period lists', () => {
  const o = ['Immediate', '<15 Days', '15-30 Days', '30-60 Days', '60+ Days'];
  it('15 days is the 15-30 entry, not <15', () => expect(noticeOption(o, noticeDays('15 days')!)).toBe('15-30 Days'));
  it('immediate', () => expect(noticeOption(o, 0)).toBe('Immediate'));
  it('exact number wins', () => expect(noticeOption(['7 Days', '15 Days', '30 Days'], 15)).toBe('15 Days'));
  it('a month', () => expect(noticeOption(o, noticeDays('1 month')!)).toBe('15-30 Days'));
});

describe('referrer and numeric notice', () => {
  it('a referrer is never the applicant', () => {
    expect(ruleFor(f('Referrer work email'))).toBeNull();
    expect(ruleFor(f('Referrer name'))).toBeNull();
  });
});
