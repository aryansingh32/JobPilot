import { describe, expect, it } from 'vitest';
import { submissionState, UNCONFIRMED_ERROR, readableError } from './index.js';

describe('submissionState', () => {
  it('three honest states', () => {
    expect(submissionState({ status: 'submitted' })).toBe('confirmed');
    expect(submissionState({ status: 'failed', error: "The form was submitted but the site didn't confirm it. Check your email" })).toBe('unconfirmed');
    expect(submissionState({ status: 'failed', error: 'The run stopped while submitting. It may have gone through — check your inbox' })).toBe('unconfirmed');
    expect(submissionState({ status: 'failed', error: 'The site rejected the form: a field is required' })).toBe('not_sent');
    expect(submissionState({ status: 'running' })).toBe('in_progress');
    expect(UNCONFIRMED_ERROR.test('Submitted, but the site never confirmed the application')).toBe(true);
  });
});

describe('submissionState — evidence, not the absence of an exception', () => {
  it('a crash after the click is unconfirmed, a refusal is not', () => {
    const at = new Date();
    expect(submissionState({ status: 'failed', error: 'Target page, context or browser has been closed', submit_attempted_at: at })).toBe('unconfirmed');
    expect(submissionState({ status: 'cancelled', submit_attempted_at: at })).toBe('unconfirmed');
    expect(submissionState({ status: 'failed', error: 'The site rejected the form: Email is required', submit_attempted_at: at })).toBe('not_sent');
    expect(submissionState({ status: 'failed', error: 'Target closed' })).toBe('not_sent');
  });
  it('a test run that stopped before the click sent nothing', () => {
    expect(submissionState({ status: 'completed', status_detail: 'Test run — stopped before submit' })).toBe('not_sent');
    expect(submissionState({ status: 'completed', status_detail: 'Done' })).toBe('confirmed');
  });
});

describe('readableError', () => {
  it("doesn't blame the résumé for Lever's stock 100 MB message", () => {
    const text = readableError('The site rejected the form: File exceeds the maximum upload size of 100MB. Please try a smaller size.') ?? '';
    expect(text).toMatch(/bot check/);
    expect(text).not.toMatch(/Upload a smaller PDF/);
  });
  it('still tells a genuinely oversized file to be shrunk', () => {
    expect(readableError('File exceeds the maximum upload size of 2MB')).toMatch(/smaller PDF/);
  });
});
