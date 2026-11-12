import { describe, expect, it } from 'vitest';
import { buildAnswerBook, planAnswers, type FormField } from './form-filler.js';
import type { ProfileData } from '../shared/profile/index.js';

// Real questions asked of real applicants (from the application history), against a typical complete profile.
// What lands in `missing` here is what a person would be interrupted with.

const profile: ProfileData = {
  personal: { fullName: 'Asha Verma', firstName: 'Asha', lastName: 'Verma', email: 'asha@example.com', phone: '+919876543210', city: 'Pune', state: 'Maharashtra', country: 'India', address: '12 MG Road', postalCode: '411001', linkedin: 'https://linkedin.com/in/asha', nationality: 'Indian' },
  work: { experienceLevel: '3-5 years', yearsOfExperience: 4, currentEmployer: 'Acme', currentTitle: 'Engineer', noticePeriod: '30 days', expectedSalary: '18 LPA', currentSalary: '14 LPA' },
  authorization: { statement: 'Authorized to work in India', needsSponsorship: false, countries: ['IN'] },
  preferences: { roles: ['Software Engineer'], locations: ['Pune', 'Bengaluru'], workplace: ['Hybrid'], jobTypes: ['Full-time'] },
  education: [{ school: 'Pune University', degree: 'B.Tech', field: 'Computer Science', end: '2020' }],
  skills: ['TypeScript', 'React', 'Node.js'],
};

let n = 0;
const q = (label: string, options: string[] = [], type = options.length ? 'radio' : 'text'): FormField => ({
  idx: n++, tag: type === 'select' ? 'select' : 'input', type, label, name: '', required: true, options, value: '', selector: null,
});

const asked = async (fields: FormField[], p: ProfileData = profile) => {
  const { missing } = await planAnswers(fields, buildAnswerBook(p, { country: 'IN' }), async () => null);
  return missing.map((m) => m.label);
};

describe('questions that used to interrupt people', () => {
  it('are answered from the profile, a safe default, or declined — not asked', async () => {
    const missing = await asked([
      q('How Did You Hear About Us?', ['LinkedIn', 'Company Website', 'Referral', 'Other'], 'select'),
      q('How did you hear about this job?', ['LinkedIn Job Posting', 'Recruiter Reach Out', 'BrickFest', 'School Career Fair and/or Event', 'Referral from Employee', 'I am a previous Databricks intern'], 'select'),
      q('How did you hear about this opportunity?', ['LinkedIn', 'Glassdoor', 'BuiltIn', 'Comparably', 'Medium', 'Motive Careers Page', 'Referred by a friend', 'Instagram', 'RepVue'], 'select'),
      q('Please select your gender', ['Male', 'Female', 'I do not wish to answer']),
      q('Expected Salary'),
      q('Current Salary'),
      q('Phone Number'),
      q('Address Line 1'),
      q('LinkedIn or Website'),
      q('Highest Qualification', ['No Selection', 'B.E', 'B.Tech', 'M.E', 'M.Tech', 'MCA', 'Other'], 'select'),
      q('What relevant experience do you have in the key skills mentioned in the job qualifications?', ['<1 Yrs', '1-3 Yrs', '3-6 Yrs', '6+ Yrs'], 'select'),
      q('Are you willing to relocate to Pune?', ['Yes', 'No']),
      q('Are you related to anyone who currently works at Weave? If so, please list their name!'),
      q('Do you know anyone currently working at ConveGenius? If yes, please mention the full name.'),
      q('State', ['N/A', 'Alabama', 'Alaska', 'Maharashtra', 'Karnataka'], 'select'),
      q('Do you now, or will you in the future, require sponsorship for employment visa status to work legally for our company?', ['Citizen', 'Permanent Resident', 'Visa Holder', 'Require Sponsorship']),
    ]);
    expect(missing).toEqual([]);
  });

  it('are only ones the person must answer: facts no profile can hold', async () => {
    const missing = await asked([
      q('What is your experience with AI-assisted development tools (e.g., GitHub Copilot, Cursor, Claude Code)?'),
      q('Please choose the single location that you\'re the most interested in', ['Mountain View, CA', 'San Francisco, CA', 'Bellevue, WA', 'Vancouver, Canada']),
    ]);
    // These are judgement calls — left to the notes ("Tell us more about you") or the person.
    expect(missing.length).toBe(2);
  });

  it("needs a person for a document type and for a visa status it can't settle", async () => {
    const abroad = { ...profile, personal: { ...profile.personal, nationality: 'Indian' } };
    const { missing } = await planAnswers(
      [q('Please confirm type of right to work document'), q('Work status', ['Permanent Resident', 'Visa Holder', 'Require Sponsorship'])],
      buildAnswerBook(abroad, { country: 'US' }),
      async () => null,
    );
    expect(missing.map((m) => m.label)).toContain('Please confirm type of right to work document');
  });
});

import { statusOption } from './form-filler.js';
import { isCitizenOf } from '../shared/profile/gaps.js';
describe('work-status lists', () => {
  const o = ['Citizen', 'Permanent Resident', 'Visa Holder', 'Require Sponsorship'];
  it('picks only what the profile settles', () => {
    expect(statusOption(o, { needsSponsorship: true })).toBe('Require Sponsorship');
    expect(statusOption(o, { needsSponsorship: false, citizen: 'Yes' })).toBe('Citizen');
    expect(statusOption(o, { needsSponsorship: false, citizen: 'No' })).toBeNull();
    expect(statusOption(o, { needsSponsorship: false })).toBeNull();
    expect(statusOption(['I do not require sponsorship', 'I will require sponsorship'], { needsSponsorship: false })).toBe('I do not require sponsorship');
    expect(statusOption(['I do not require sponsorship', 'I will require sponsorship'], { needsSponsorship: true })).toBe('I will require sponsorship');
    expect(statusOption(['Non-citizen national', 'Visa Holder'], { needsSponsorship: false, citizen: 'Yes' })).toBeNull();
  });
  it('knows whose country it is', () => {
    expect(isCitizenOf('Indian', 'IN')).toBe(true);
    expect(isCitizenOf('India', 'India')).toBe(true);
    expect(isCitizenOf('Indian', 'US')).toBe(false);
    expect(isCitizenOf('Martian', 'US')).toBeUndefined();
    expect(isCitizenOf('', 'US')).toBeUndefined();
  });
});

import { policyAcknowledgement } from './form-filler.js';
describe('policy acknowledgements are ticked, not asked', () => {
  it('recognises policy agreements and nothing that commits the person', () => {
    for (const l of [
      "Before submitting your application, you must agree to Spaulding Ridge's Candidate Privacy Notice.",
      'I have read and agree to the Terms and Conditions',
      'I acknowledge the Applicant Privacy Policy',
      'I accept the cookie policy',
    ]) expect(policyAcknowledgement(l), l).toBe(true);
    for (const l of [
      'I agree to receive marketing emails and the privacy policy',
      'I consent to text messages about my application per the terms',
      'I agree to binding arbitration under the terms',
      'I certify that the information is true and accept the terms',
      'Do you agree to a background check?',
      'Join our talent community — I agree to the privacy notice',
      'Are you authorized to work in India?',
    ]) expect(policyAcknowledgement(l), l).toBe(false);
  });

  it('ticks a required checkbox and a Yes/No radio, as a default that needs no confirmation', async () => {
    const label = "Before submitting your application, you must agree to Spaulding Ridge's Candidate Privacy Notice.";
    const box = { ...q(label, [], 'checkbox'), tag: 'input' as const };
    const radio = q(label, ['Yes', 'No']);
    const { answers, missing } = await planAnswers([box, radio], buildAnswerBook(profile, { country: 'IN' }), async () => null);
    expect(missing).toEqual([]);
    expect(answers.map((a) => [a.value, a.source, a.key])).toEqual([['Yes', 'default', 'policyAck'], ['Yes', 'default', 'policyAck']]);
  });
});

describe('questions the user listed as "never ask"', () => {
  it('are answered by default — and "worked for X" turns Yes only for listed companies', async () => {
    const lic = q('Please provide a list of licenses that you currently hold or have previously held. If you do not have any, please say “None.”');
    const hear = q('How/where did you first learn about this role?');
    const worked = q('Have you ever worked for Clear Street as a full-time or part-time employee, as an intern or as a temporary/contract employee or through a third-party?', ['Yes', 'No']);
    const run = (p: ProfileData) => planAnswers([lic, hear, worked], buildAnswerBook(p, { country: 'IN' }), async () => null);
    const base = await run(profile);
    expect(base.missing).toEqual([]);
    expect(base.answers.map((a) => a.value)).toEqual(['None', 'Online job board', 'No']);
    const listed = await run({ ...profile, about: 'Previous employers: Clear Street, Globex' });
    expect(listed.answers[2].value).toBe('Yes');
  });
  it('picks a plain source from any list, never a person or an event', async () => {
    const r = await planAnswers([q('How did you first hear about us?', ['Employee referral', 'Campus event', 'Glassdoor', 'Recruiter'], 'select')], buildAnswerBook(profile), async () => null);
    expect(r.answers[0].value).toBe('Glassdoor');
  });
});
