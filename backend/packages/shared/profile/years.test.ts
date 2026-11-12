import { describe, expect, it } from 'vitest';
import { yearsOfExperience } from './years.js';

const now = new Date('2026-10-26');

describe('yearsOfExperience', () => {
  it('uses the stated number first', () => {
    expect(yearsOfExperience({ work: { yearsOfExperience: 4 } }, now)).toBe(4);
  });
  it('adds up the experience entries, counting overlaps once', () => {
    expect(yearsOfExperience({ experience: [
      { company: 'A', title: 'x', start: 'Jan 2020', end: 'Dec 2021' },
      { company: 'B', title: 'y', start: '2021', current: true },
    ] }, now)).toBe(7);
    expect(yearsOfExperience({ experience: [
      { company: 'A', title: 'x', start: '2018', end: '2019' },
      { company: 'B', title: 'y', start: '2022', end: '2024' },
    ] }, now)).toBe(3);
  });
  it('a fresher has none, and nothing known is null', () => {
    expect(yearsOfExperience({ work: { experienceLevel: 'Student / fresher' } }, now)).toBe(0);
    expect(yearsOfExperience({}, now)).toBeNull();
  });
});
