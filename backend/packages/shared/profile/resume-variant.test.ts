import { describe, expect, it } from 'vitest';
import { pickResumeVariant } from './resume-variant.js';

const v = [
  { label: 'Backend', fileId: 'b', keywords: ['golang', 'java', 'api'] },
  { label: 'Data science', fileId: 'd', keywords: ['ml', 'analytics'] },
  { label: 'Design', fileId: 'x', keywords: ['ux', 'figma'] },
];
describe('pickResumeVariant', () => {
  it('matches on the title', () => {
    expect(pickResumeVariant(v, 'Senior Backend Engineer')?.fileId).toBe('b');
    expect(pickResumeVariant(v, 'ML Engineer')?.fileId).toBe('d');
    expect(pickResumeVariant(v, 'Product UX Designer')?.fileId).toBe('x');
  });
  it('falls back to the main résumé when nothing fits', () => {
    expect(pickResumeVariant(v, 'Accountant')).toBeNull();
    expect(pickResumeVariant(undefined, 'Backend Engineer')).toBeNull();
  });
  it('a skills-only coincidence is not enough', () => {
    expect(pickResumeVariant(v, 'Platform Engineer', ['golang'])).toBeNull();
  });
});
