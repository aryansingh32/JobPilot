import { expect, it } from 'vitest';
import { validateAIPlan } from '../../packages/ai-service/plan-validation.js';
it('rejects missing selectors and unknown actions', () => {
  expect(() => validateAIPlan([{id:'a',action:'click'}])).toThrow();
  expect(() => validateAIPlan([{id:'a',action:'customJS',value:'alert(1)'}])).toThrow();
});
it('normalizes order and prevents blind retries of side effects', () => {
  expect(validateAIPlan([{id:'a',order:10,action:'click',target:{value:'button'},retries:20}])[0]).toMatchObject({order:1,retries:0});
});
it('rejects duplicate nested IDs and non-web navigations', () => {
  expect(() => validateAIPlan([{id:'a',action:'conditional',trueSteps:[{id:'a',action:'wait'}]}])).toThrow();
  expect(() => validateAIPlan([{id:'a',action:'navigate',value:'javascript:alert(1)'}])).toThrow();
});
it('rejects empty and unbounded plans', () => {
  expect(() => validateAIPlan([])).toThrow();
  expect(() => validateAIPlan([{id:'a',action:'wait',timeout:Infinity}])).toThrow();
});
