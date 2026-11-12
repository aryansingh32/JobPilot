import { beforeEach, describe, expect, it } from 'vitest';
import { cosine, setSkillIdf, stretchSimilarity, weightedCoverage, yearsFit } from './fit-math.js';

beforeEach(() => setSkillIdf(new Map([['git', 1.2], ['sql', 1.5], ['rust', 5], ['kubernetes', 4]])));

describe('weightedCoverage', () => {
  it('weights rare skills above common ones', () => {
    const rare = weightedCoverage(['rust', 'git'], (s) => s === 'rust');
    const common = weightedCoverage(['rust', 'git'], (s) => s === 'git');
    expect(rare).toBeGreaterThan(common);
  });
  it('does not give a one-skill job a perfect score', () => {
    expect(weightedCoverage(['sql'], () => true)).toBeLessThan(0.85);
    expect(weightedCoverage(['sql', 'git', 'rust', 'kubernetes', 'x', 'y'], () => true)).toBeGreaterThan(0.8);
  });
  it('uses the prior when no skills are named', () => {
    expect(weightedCoverage([], () => false)).toBe(0.4);
  });
});

describe('yearsFit', () => {
  it('is 1 inside the band and falls smoothly outside', () => {
    expect(yearsFit(4, 3, 6)).toBe(1);
    const one = yearsFit(2, 3, 6);
    const three = yearsFit(0, 3, 6);
    expect(one).toBeGreaterThan(0.7);
    expect(three).toBeLessThan(0.2);
  });
  it('is gentler on over-qualification than under-qualification', () => {
    expect(yearsFit(9, 3, 6)).toBeGreaterThan(yearsFit(0, 3, 6));
  });
});

describe('cosine', () => {
  it('is higher for related text', () => {
    const resume = 'built react dashboards typescript node apis postgres';
    expect(cosine(resume, 'we need react typescript engineer for dashboards apis')).toBeGreaterThan(cosine(resume, 'nurse needed for night shifts in hospital ward'));
    expect(cosine('abc', '')).toBe(0);
  });
  it('stretches onto 0–1 monotonically', () => {
    expect(stretchSimilarity(0.3)).toBeGreaterThan(stretchSimilarity(0.1));
    expect(stretchSimilarity(0)).toBeLessThan(0.2);
  });
});
