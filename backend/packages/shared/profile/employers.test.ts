import { describe, expect, it } from 'vitest';
import { namesAnyOf, workedCompanies } from './employers.js';

describe('companies the person has worked for', () => {
  it('collects experience, current employer and the ones listed in their notes', () => {
    const list = workedCompanies({
      work: { currentEmployer: 'Acme Inc.' },
      experience: [{ company: 'Globex Ltd', title: 'x' }],
      about: 'I like hiking.\nPrevious employers: Initech, Hooli and Umbrella Corp\nOpen to relocation.',
    });
    expect(list).toEqual(expect.arrayContaining(['Acme Inc.', 'Globex Ltd', 'Initech', 'Hooli', 'Umbrella Corp']));
  });

  it('names a company in a question whole-word, ignoring suffixes', () => {
    const q = 'Have you ever worked for Clear Street as a full-time employee, an intern or contractor?';
    expect(namesAnyOf(q, ['Clear Street LLC'])).toBe(true);
    expect(namesAnyOf(q, ['Acme', 'Globex'])).toBe(false);
    expect(namesAnyOf('Have you worked for Streetwise before?', ['Street'])).toBe(false);
  });
});
