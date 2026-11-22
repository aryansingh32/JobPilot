import { expect, it } from 'vitest';
import { estimateTokenCost } from './pricing.js';
it('prices cached input separately without double counting reasoning output', () => {
  expect(estimateTokenCost({prompt:1000,completion:100,cached:500,cacheWrite:100},{input:2,output:10,cachedInput:0.2,cacheWrite:3})).toBeCloseTo(0.0022);
});
it('distinguishes unknown pricing from explicitly free pricing', () => {
  const u={prompt:1000,completion:100,cached:0,cacheWrite:0};
  expect(estimateTokenCost(u)).toBeNull();
  expect(estimateTokenCost(u,{input:0,output:0})).toBe(0);
  expect(estimateTokenCost(u,{input:-1,output:2})).toBeNull();
});
