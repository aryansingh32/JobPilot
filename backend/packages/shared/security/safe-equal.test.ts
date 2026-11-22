import { describe, expect, it } from 'vitest';
import { safeEqual } from './safe-equal.js';

describe('safeEqual', () => {
  it('matches only identical non-empty strings', () => {
    expect(safeEqual('k-123', 'k-123')).toBe(true);
    expect(safeEqual('k-123', 'k-124')).toBe(false);
    expect(safeEqual('k', 'longer-key')).toBe(false);
    expect(safeEqual(undefined, 'k')).toBe(false);
    expect(safeEqual(['k'], 'k')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual('x', undefined)).toBe(false);
  });
});
