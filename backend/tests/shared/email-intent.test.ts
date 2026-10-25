import { describe, it, expect } from 'vitest';
import { classifyIntent, extractCode, extractVerifyLink } from '../../packages/shared/inbox/index.js';

describe('classifyIntent', () => {
  const cases: [string, string, string | null][] = [
    ['Interview with Acme', "We'd like to schedule a 30 minute phone screen. Share your availability.", 'interview'],
    ['Your application to Acme', 'Unfortunately, we have decided to move forward with other candidates.', 'rejection'],
    ['Next steps', 'Please complete the HackerRank coding challenge within 5 days.', 'assessment'],
    ['Congratulations!', 'We are pleased to extend an offer for the Backend Engineer role. After your interviews…', 'offer'],
    ['Next steps: rejection', 'Unfortunately we will not be moving forward. Next steps: none.', 'rejection'],
    ['Thanks for applying', 'We received your application and will review it.', null],
  ];
  it.each(cases)('%s → %s', (subject, body, expected) => {
    expect(classifyIntent(subject, body)).toBe(expected);
  });
});

describe('extractCode', () => {
  it('finds codes near OTP words', () => {
    expect(extractCode('Your security code is 482913. It expires in 10 minutes.')).toBe('482913');
    expect(extractCode('Thanks for applying to Acme in 2026.')).toBeNull();
  });
});

describe('extractCode — employer phrasings', () => {
  it('finds a code a few words after the keyword', () => {
    expect(extractCode('Use this verification code to continue your job application: 346369\n\nThe code expires in 10 minutes.')).toBe('346369');
    expect(extractCode('Enter the following one-time passcode on the sign-in page — 77120894')).toBe('77120894');
    expect(extractCode('Your OTP is 4821')).toBe('4821');
  });
  it('ignores dates, phone numbers and amounts', () => {
    expect(extractCode('Your application code reference was sent on 23/10/2026 to +91 98765 43210.')).toBeNull();
    expect(extractCode('Security notice: we posted 1,250,000 roles this year.')).toBeNull();
  });
});

describe('extractVerifyLink', () => {
  it('picks the link after "verify"', () => {
    const text = 'Visit https://careers.example.com for jobs.\nPlease verify your email address by clicking the link below:\nhttps://career55.sapsf.eu/verify?token=abc123.\nThanks';
    expect(extractVerifyLink(text)).toBe('https://career55.sapsf.eu/verify?token=abc123');
  });
  it('none when the mail has no verification link', () => {
    expect(extractVerifyLink('Thanks for applying! See https://example.com/jobs')).toBeNull();
  });
});
