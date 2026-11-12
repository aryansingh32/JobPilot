import { describe, expect, it } from 'vitest';
import { compileRecording, compileRecordingDetailed } from './compile-recording.js';

const t = Date.now();
const sel = (s: string) => ({ selectors: [s] });
const nav = { action: 'navigate', url: 'https://jobs.example.com/apply/1', timestamp: t };

const form = [
  nav,
  { action: 'fill', target: { ...sel('#first_name'), tag: 'input', label: 'First name', metadata: { name: 'first_name' } }, value: 'Asha', timestamp: t },
  { action: 'fill', target: { ...sel('#why'), tag: 'textarea', label: 'Why us?', metadata: { name: 'why' } }, value: 'I love your mission', timestamp: t },
  { action: 'click', target: { ...sel('#sponsor_yes'), tag: 'input', text: '', label: 'Yes', metadata: { type: 'radio' } }, timestamp: t },
  { action: 'click', target: { ...sel('li.opt-3'), tag: 'li', text: '5 years', metadata: { role: 'option' } }, timestamp: t },
  { action: 'click', target: { ...sel('#cont'), tag: 'button', text: 'Continue' }, timestamp: t },
  { action: 'click', target: { ...sel('#submit'), tag: 'button', text: 'Submit application' }, timestamp: t },
  { action: 'page', url: 'https://jobs.example.com/apply/1/thanks', snapshot: { title: 'Thanks', headings: ['Application received'] }, timestamp: t },
];

describe('compileRecording for job forms', () => {
  const opts = { jobApply: true, profileValues: { firstName: 'Asha' } };
  const r = compileRecordingDetailed(form as never[], opts);

  it("never bakes one person's answers into a shared workflow", () => {
    const values = r.steps.map((s) => s.value ?? '');
    expect(values.join('|')).not.toMatch(/love your mission/);
    expect(r.steps.some((s) => s.action === 'click' && /sponsor|5 years|opt-3/.test(JSON.stringify(s.target)))).toBe(false);
    expect(r.warnings.length).toBe(3);
  });

  it('keeps profile tokens and navigation clicks, and ends with the standard tail', () => {
    expect(r.steps.find((s) => s.action === 'fill')?.value).toBe('{{profile:firstName}}');
    expect(r.steps.some((s) => s.action === 'click' && /Continue/.test(s.description ?? ''))).toBe(true);
    expect(r.steps.slice(-3).map((s) => s.action)).toEqual(['autofillForm', 'reviewForm', 'submitForm']);
  });

  it("teaches the site's own confirmation signal from the page after Submit", () => {
    expect(r.confirmation).toEqual({ urlPath: '/apply/1/thanks', text: 'Application received' });
    expect(r.steps.at(-1)?.metadata?.confirmation).toEqual(r.confirmation);
  });

  it('still keeps literals for non-job (government) recordings', () => {
    const steps = compileRecording(form as never[]);
    expect(steps.some((s) => s.value === 'I love your mission')).toBe(true);
  });

  it('no confirmation hint when the recording never reached a page after Submit', () => {
    expect(compileRecordingDetailed(form.slice(0, 7) as never[], opts).confirmation).toBeUndefined();
  });
});
