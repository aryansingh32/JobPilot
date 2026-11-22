import { describe, expect, it } from 'vitest';
import { canAutoSubmit } from './review-policy.js';

describe('canAutoSubmit', () => {
  it('sends when every answer is the person’s own or a safe default', () => {
    expect(canAutoSubmit([{ source: 'profile' }, { source: 'memory' }, { source: 'user' }, { source: 'default' }, { source: 'prefilled' }]).ok).toBe(true);
  });
  it('waits when a model wrote an answer', () => {
    const v = canAutoSubmit([{ source: 'profile' }, { source: 'ai' }, { source: 'ai' }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/2 answers were written by AI/);
  });
  it('does not let an AI answer be hidden by an optional hold setting', () => {
    const answers = [{ source: 'profile' }, { source: 'ai' }];
    expect(canAutoSubmit(answers).ok).toBe(false);
  });
  it('waits when a required question has no answer', () => {
    expect(canAutoSubmit([{ source: 'profile' }], [{}]).ok).toBe(false);
  });
  it.each([
    'Are you authorized to work in this country?',
    'Do you require visa sponsorship?',
    'I certify this information is accurate',
  ])('requires explicit confirmation for sensitive declaration: %s', (label) => {
    expect(canAutoSubmit([{ source: 'profile', label }]).ok).toBe(false);
  });
  it.each([
    'Do you have a disability?',
    'Have you ever been convicted of a felony?',
    'I authorize a background check',
    'Please select your race or ethnicity',
  ])('requires explicit confirmation for additional sensitive declaration: %s', (label) => {
    expect(canAutoSubmit([{ source: 'profile', label }]).ok).toBe(false);
  });
});
