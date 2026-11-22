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

import { pickOption, isThirdParty } from './form-filler.js';
describe('third-party fields', () => {
  it('never take the applicant\'s own contact details', () => {
    for (const l of ['Emergency contact phone', 'Reference email', 'Manager email', "Supervisor's phone number", 'Spouse name', 'Recruiter name', 'Email of your previous manager', 'Parent/guardian mobile'])
      expect(ruleFor(f(l)), l).toBeNull();
    expect(isThirdParty('email address')).toBe(false);
    expect(ruleFor(f('Email address'))).toBe('email');
    expect(ruleFor(f('Phone'))).not.toBeNull();
  });
});

describe('pickOption safety', () => {
  it('whole words only: US is not Australia', () => {
    expect(pickOption(['Australia', 'United States'], 'US')).toBe('United States');
    expect(pickOption(['Australia', 'Austria'], 'US')).toBeNull();
  });
  it('No is not "Not a protected veteran"', () => {
    expect(pickOption(['I am not a protected veteran', 'No'], 'No')).toBe('No');
    expect(pickOption(['Not a veteran'], 'No')).toBeNull();
  });
  it('a negated option is not a loose match for the positive', () => {
    expect(pickOption(['Non-US citizen', 'US citizen'], 'US citizen')).toBe('US citizen');
    expect(pickOption(['Do not require sponsorship'], 'Require sponsorship')).toBeNull();
  });
  it('aliases', () => {
    expect(pickOption(['USA', 'Canada'], 'United States')).toBe('USA');
    expect(pickOption(['United Kingdom'], 'UK')).toBe('United Kingdom');
  });
  it('still prefix-matches', () => {
    expect(pickOption(['Bachelor of Technology', 'Master of Technology'], 'Bachelor')).toBe('Bachelor of Technology');
    expect(pickOption(['State University of New York - Albany'], 'State University')).toBeNull();
  });
});

describe('workday phone block', () => {
  it('device type and country code are not the phone number', () => {
    expect(ruleFor(f('Phone Device Type'))).toBe('phoneDeviceType');
    expect(ruleFor(f('Country Phone Code'))).toBe('phoneCountryName');
    expect(ruleFor(f('Phone Number'))).toBe('phone');
  });
});

import { parseDateParts, sectionIndex, buildAnswerBook, planAnswers } from './form-filler.js';
describe('dates, sections, pay bands', () => {
  it('parses dates day-first', () => {
    expect(parseDateParts('2026-10-25')).toEqual({ year: '2026', month: '10', day: '25' });
    expect(parseDateParts('05/03/1999')).toEqual({ day: '05', month: '03', year: '1999' });
    expect(parseDateParts('03/2021')).toEqual({ month: '03', day: '', year: '2021' });
    expect(parseDateParts('nonsense')).toBeNull();
  });
  it('finds the entry of a repeated section', () => {
    expect(sectionIndex({ label: 'School', name: 'education[0].school' })).toBe(0);
    expect(sectionIndex({ label: 'School', name: 'education[1].school' })).toBe(1);
    expect(sectionIndex({ label: 'Employer #3', name: '' })).toBe(2);
    expect(sectionIndex({ label: 'Second school attended', name: '' })).toBe(1);
    expect(sectionIndex({ label: 'School', name: 'school' })).toBe(0);
  });
  it('fills the second school from the second entry, not the first', async () => {
    const profile = { education: [{ school: 'IIT Delhi' }, { school: 'Delhi Public School' }], work: { expectedSalary: '12 LPA' } };
    const book = buildAnswerBook(profile as never);
    const mk = (label: string, name: string, extra: Partial<FormField> = {}) => ({ idx: 1, label, name, type: 'text', tag: 'input', options: [], required: true, value: '', ...extra }) as unknown as FormField;
    const r = await planAnswers([mk('School', 'education[1].school')], book, async () => null);
    expect(r.answers[0].value).toBe('Delhi Public School');
    const none = await planAnswers([mk('School', 'education[3].school')], book, async () => null);
    expect(none.answers).toHaveLength(0);
    const pay = await planAnswers([mk('Expected salary', 'sal', { type: 'select', tag: 'select', options: ['< 5,00,000', '10,00,000 - 15,00,000', '15,00,000+'] })], book, async () => null);
    expect(pay.answers[0].value).toBe('10,00,000 - 15,00,000');
  });
  it('a signature date is today, not asked', async () => {
    const book = buildAnswerBook({} as never);
    const r = await planAnswers([{ idx: 0, label: 'Date', name: 'd', type: 'datesplit', tag: 'input', options: ['M', 'D', 'Y'], required: true, value: '' } as FormField], book, async () => null);
    expect(r.answers[0].value).toBe(book.todaysDate);
  });
});
