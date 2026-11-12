import { describe, expect, it } from 'vitest';
import { tally, remainingSlots, describe as summarize } from './campaigns.js';

const app = (status: string, extra: Record<string, unknown> = {}) => ({ status, ...extra });

describe('campaign progress', () => {
  const apps = [
    app('submitted'),
    app('submitted'),
    app('failed', { error: "site didn't confirm" }),
    app('failed', { submit_attempted_at: new Date(), error: 'browser closed' }),
    app('failed', { error: 'No application form found' }),
    app('running'),
    app('completed', { status_detail: 'Stopped before submit (test run)' }),
  ];

  it('counts only confirmed submissions as done', () => {
    expect(tally(apps)).toEqual({ confirmed: 2, unconfirmed: 2, inProgress: 1, failed: 2 });
  });

  it('reserves places for unconfirmed and running ones so a run never over-applies', () => {
    expect(remainingSlots(10, tally(apps))).toBe(5);
    expect(remainingSlots(3, tally(apps))).toBe(0);
  });

  it('reports a short campaign honestly', () => {
    const p = tally(apps);
    const text = summarize({ target: 100, status: 'exhausted', stopReason: 'No new matches at 75% or above' }, p);
    expect(text).toMatch(/^2 of 100 confirmed — target not reached: No new matches/);
    expect(text).toMatch(/2 may have been sent but weren't confirmed/);
  });

  it('says done only for a reached target', () => {
    expect(summarize({ target: 2, status: 'completed', stopReason: null }, { confirmed: 2, unconfirmed: 0, inProgress: 0, failed: 0 })).toBe('Done: 2 of 2 applications confirmed.');
  });
});
