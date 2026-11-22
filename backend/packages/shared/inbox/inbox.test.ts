import { describe, expect, it } from 'vitest';
import { categorize, extractVerifyLink } from './index.js';
import { searchQuery } from '../gmail/index.js';

describe('inbox classification', () => {
  it('treats a verification-link mail as a code mail', () => {
    const body = 'Click this link to confirm your email address and complete setup for your candidate account\nhttps://acme.wd5.myworkdayjobs.com/x/activate/abc123';
    const link = extractVerifyLink(body);
    expect(link).toContain('/activate/');
    expect(categorize('Verify your candidate account', body, null, link)).toBe('code');
    expect(categorize('Verify your candidate account', body, null)).not.toBe('code');
  });
});

describe('gmail search', () => {
  it('covers Workday OTP mail and employer confirmations by subject', () => {
    const q = searchQuery(['Acme'], new Date('2026-10-25T00:00:00Z'));
    expect(q).toContain('from:workday.com');
    expect(q).toContain('subject:"thank you for applying"');
    expect(q).toContain('"Acme"');
  });
});
