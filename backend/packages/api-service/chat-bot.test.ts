import { describe, expect, it } from 'vitest';
import { shouldCancelTask, looksLikeRequestedInput } from './chat-orchestrator.js';
import { resolveUi } from './chat-ui.js';

describe('shouldCancelTask', () => {
  it('stops on a short direct order', () => {
    for (const m of ['stop', 'Cancel', 'please cancel', 'stop the task', 'cancel my application', 'Stop now!', 'abort it']) {
      expect(shouldCancelTask(m), m).toBe(true);
    }
  });
  it("does not stop on sentences that only mention it", () => {
    for (const m of ["don't stop now", 'how do I cancel my subscription', 'can you stop by the careers page and apply', 'never cancel', 'why did it stop', 'I will not cancel this', 'apply to jobs and stop when you reach ten']) {
      expect(shouldCancelTask(m), m).toBe(false);
    }
  });
});

describe('looksLikeRequestedInput', () => {
  it('accepts only the shape asked for', () => {
    expect(looksLikeRequestedInput('otp', '482 913')).toBe(true);
    expect(looksLikeRequestedInput('otp', 'what is an otp?')).toBe(false);
    expect(looksLikeRequestedInput('confirmation', 'yes')).toBe(true);
    expect(looksLikeRequestedInput('confirmation', 'yes but wait')).toBe(false);
    expect(looksLikeRequestedInput('email', 'a@b.co')).toBe(true);
    expect(looksLikeRequestedInput('mobile', '+91 98765 43210')).toBe(true);
    expect(looksLikeRequestedInput('captcha', 'x'.repeat(200))).toBe(false);
    expect(looksLikeRequestedInput('unknown-kind', '1234')).toBe(false);
  });
});

describe('resolveUi (cards the model asks for)', () => {
  it('drops malformed directives and keeps well-formed ones, at most four', async () => {
    const cards = await resolveUi('u1', [
      { type: 'ask', kind: 'otp', prompt: 'Enter the code', length: 6 },
      { type: 'ask', kind: 'choice', prompt: 'Which?' },
      { type: 'ask', kind: 'nonsense', prompt: 'x' },
      { type: 'island', title: '', body: 'no title' },
      { type: 'island', tone: 'warn', title: 'Heads up', view: 'tasks' },
      { type: 'open', view: 'admin' },
      { type: 'open', view: 'inbox' },
      { type: 'island', title: 'fourth, still shown' },
      { type: 'island', title: 'fifth, beyond the cap' },
    ]);
    expect(cards.map((c) => c.type)).toEqual(['ask', 'island', 'open', 'island']);
    expect((cards[0] as { length?: number }).length).toBe(6);
    expect((cards[1] as { label?: string }).label).toBe('Open Applications');
  });
  it('ignores non-lists', async () => {
    expect(await resolveUi('u1', 'drop table')).toEqual([]);
    expect(await resolveUi('u1', undefined)).toEqual([]);
  });
});
