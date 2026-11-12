import { describe, expect, it } from 'vitest';
import { ungroundedClaims } from './ai-answers.js';

const facts = 'I have 4 years of experience building React and Node.js apps at Acme Corp. Led a team of 3.\nRole: Frontend Engineer Globex';

describe('ungroundedClaims', () => {
  it('accepts an answer built only from the facts', () => {
    expect(ungroundedClaims('I bring 4 years of React and Node.js experience from Acme Corp, and my skills fit the Frontend Engineer role at Globex.', facts)).toEqual([]);
  });
  it('flags an invented number', () => {
    expect(ungroundedClaims('I have 7 years of React experience.', facts)).toEqual(['7']);
  });
  it('flags an invented employer or tool', () => {
    expect(ungroundedClaims('At Google I shipped Kubernetes pipelines.', facts).sort()).toEqual(['Google', 'Kubernetes']);
    expect(ungroundedClaims('I worked with Stripe and React.', facts)).toEqual(['Stripe']);
  });
  it('does not flag the first word of a sentence or digits embedded in a larger number', () => {
    expect(ungroundedClaims('Building apps is what I do.', facts)).toEqual([]);
    expect(ungroundedClaims('I led 33 people.', facts)).toEqual(['33']);
  });
});
