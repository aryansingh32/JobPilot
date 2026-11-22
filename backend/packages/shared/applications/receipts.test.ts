import { describe, expect, it } from 'vitest';
import { receiptPath } from './receipts.js';

describe('receiptPath', () => {
  it('only builds paths from run ids', () => {
    const id = '3f2b8c1e-0a4d-4c55-9a1b-7e6f5d4c3b2a';
    expect(receiptPath(id)).toMatch(/receipts\/3f2b8c1e-0a4d-4c55-9a1b-7e6f5d4c3b2a\.png$/);
    expect(receiptPath(id, 'diagnostics')).toMatch(/diagnostics\//);
    expect(receiptPath('../../etc/passwd')).toBeNull();
    expect(receiptPath('')).toBeNull();
    expect(receiptPath(null)).toBeNull();
  });
});
