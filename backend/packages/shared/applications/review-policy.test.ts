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
});
