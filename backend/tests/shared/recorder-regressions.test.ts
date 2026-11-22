import { describe, expect, it } from 'vitest';
import { compileRecordingDetailed } from '../../packages/shared/workflows/compile-recording.js';
const target = { selectors: ['#field'], tag: 'input' };
describe('general workflow recording regressions', () => {
  it('does not merge identical selectors from distinct frames', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'fill', target, value: 'one', frameUrl: 'https://one.example/form' },
      { action: 'fill', target, value: 'two', frameUrl: 'https://two.example/form' },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps.map(s => s.trueSteps?.[0].value)).toEqual(['one', 'two']);
  });
  it('does not mutate the source recording', () => {
    const event = Object.freeze({ action: 'input', target, value: 'hello' });
    expect(() => compileRecordingDetailed([event])).not.toThrow();
    expect(event.action).toBe('input');
  });
  it('preserves repeated clicks that may increment a quantity', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'click', target, timestamp: 1 },
      { action: 'click', target, timestamp: 1000 },
    ]);
    expect(steps).toHaveLength(2);
  });
  it('keeps unrelated section clicks before filling another field', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'click', target: { selectors: ['#expand'], tag: 'div', text: 'Details' } },
      { action: 'fill', target, value: 'hello' },
    ]);
    expect(steps.map(s => s.action)).toEqual(['click', 'fill']);
  });
});

it('removes the final submit inside an iframe and keeps step IDs unique', () => {
  const { steps } = compileRecordingDetailed([
    { action: 'fill', target, value: 'Asha', frameUrl: 'https://forms.example/apply' },
    { action: 'click', target: { selectors: ['#submit'], tag: 'button', text: 'Submit' }, frameUrl: 'https://forms.example/apply' },
  ], { jobApply: true, profileValues: { firstName: 'Asha' } });
  const all = steps.flatMap(s => [s, ...(s.trueSteps ?? [])]);
  expect(all.some(s => s.action === 'click' && s.target?.value === '#submit')).toBe(false);
  expect(new Set(all.map(s => s.id)).size).toBe(all.length);
  expect(steps.slice(-3).every(s => !s.metadata?.frameUrl)).toBe(true);
});
it('uses a document binding for general workflows and a resume for job workflows', () => {
  const raw = [{ action: 'upload', target }];
  expect(compileRecordingDetailed(raw).steps[0].value).toBe('{{userFile:document}}');
  expect(compileRecordingDetailed(raw, { jobApply: true }).steps[0].value).toBe('{{userFile:resume}}');
});
