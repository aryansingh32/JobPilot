import { describe, expect, it } from 'vitest';
import { ruleFor, defaultYesNo, type FormField } from './form-filler.js';

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

describe('defaultYesNo', () => {
  const yn = ['Yes', 'No'];
  it('never worked there before → No, unless it is the current employer', () => {
    expect(defaultYesNo('Have you previously worked for Databricks?', yn, { currentCompany: 'Nexora' })).toBe('No');
    expect(defaultYesNo('Are you currently an employee of a WPP agency?', yn, {})).toBe('No');
    expect(defaultYesNo('Are you currently an employee of Nexora?', yn, { currentCompany: 'Nexora' })).toBe('Yes');
  });
  it('knows nobody there → No; open to office/hybrid → Yes unless remote-only', () => {
    expect(defaultYesNo('Do you know anyone currently working at ConveGenius?', yn, {})).toBe('No');
    expect(defaultYesNo('Are you open to a hybrid role based in Bangalore?', yn, {})).toBe('Yes');
    expect(defaultYesNo('Are you open to a hybrid role based in Bangalore?', yn, { workplace: 'Remote' })).toBeNull();
    expect(defaultYesNo('What is your favourite colour?', yn, {})).toBeNull();
  });
  it('passing-out year is the graduation year', () => {
    expect(ruleFor(f('Please mention the Passing Out Year'))).toBe('graduationYear');
  });
});

describe('defaultYesNo in text boxes', () => {
  it('answers yes/no questions with the word, ignores open questions', () => {
    expect(defaultYesNo('Are you a previous Weave employee?', [], {})).toBe('No');
    expect(defaultYesNo('Are you related to anyone who currently works at Weave? If so, please list their name!', [], {})).toBe('No');
    expect(defaultYesNo('Are you currently an Imagine Worldwide employee?', ['Yes', 'No'], {})).toBe('No');
    expect(defaultYesNo('Describe your previous employee experience', [], {})).toBeNull();
  });
});

import { answerFromNotes } from './ai-answers.js';
describe('answerFromNotes', () => {
  const about = 'Passing out year: 2027\n↳ Are you willing to work from the Bangalore office: Yes\nCGPA / backlogs: 8.0, none';
  const field = (label: string, options: string[] = []) => ({ ...f(label), options }) as FormField;
  it('matches a differently worded question to a note line without any model call', () => {
    expect(answerFromNotes(about, field('Please mention the Passing Out Year'))).toBe('2027');
    expect(answerFromNotes(about, field('Are you willing to work from the Bangalore office?', ['Yes', 'No']))).toBe('Yes');
    expect(answerFromNotes(about, field('Please share your CGPA / backlogs details'))).toBe('8.0, none');
  });
  it('leaves unrelated questions alone', () => {
    expect(answerFromNotes(about, field('Why do you want to work here?'))).toBeNull();
  });
});
