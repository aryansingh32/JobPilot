import { describe, expect, it } from 'vitest';
import { normalizeDefaults, validateDefaults, matchCustom } from './defaults.js';
import { buildAnswerBook, planAnswers, type FormField } from '../../execution-service/form-filler.js';

const field = (label: string, options: string[] = [], type = options.length ? 'radio' : 'text'): FormField =>
  ({ idx: 0, tag: 'input', type, label, name: '', required: true, options, value: '', selector: null }) as FormField;
const plan = (f: FormField, cfg?: Parameters<typeof normalizeDefaults>[0]) => planAnswers([f], buildAnswerBook({}), async () => null, undefined, normalizeDefaults(cfg));

describe('answer defaults (admin-editable)', () => {
  it('built-ins answer by default and say which rule did', async () => {
    const r = await plan(field('Do you know anyone currently working at Acme?', ['Yes', 'No']));
    expect(r.answers[0]).toMatchObject({ value: 'No', source: 'default', rule: 'knows-nobody' });
  });

  it('a built-in can be switched off — then it is asked', async () => {
    const r = await plan(field('Do you know anyone currently working at Acme?', ['Yes', 'No']), { disabled: ['knows-nobody'] });
    expect(r.answers).toHaveLength(0);
    expect(r.missing).toHaveLength(1);
  });

  it('a built-in answer can be reworded', async () => {
    const r = await plan(field('How did you hear about us?', ['LinkedIn', 'Company Website', 'Other']), { overrides: { 'how-did-you-hear': 'LinkedIn' } });
    expect(r.answers[0]).toMatchObject({ value: 'LinkedIn', rule: 'how-did-you-hear' });
    const base = await plan(field('How did you hear about us?', ['LinkedIn', 'Company Website', 'Other']));
    expect(base.answers[0].value).toBe('Company Website');
  });

  it('the privacy-notice rule and the diversity rule can be switched off too', async () => {
    const policy = field('You must agree to the Candidate Privacy Notice', [], 'checkbox');
    expect((await plan(policy)).answers[0]?.rule).toBe('policy-ack');
    expect((await plan(policy, { disabled: ['policy-ack'] })).answers).toHaveLength(0);
    const eeo = field('Please select your gender', ['Male', 'Female', 'I prefer not to say']);
    expect((await plan(eeo)).answers[0]?.rule).toBe('eeo-decline');
    expect((await plan(eeo, { disabled: ['eeo-decline'] })).answers).toHaveLength(0);
  });

  it('a custom rule answers a question nothing else knows', async () => {
    const cfg = { custom: [{ id: 'c1', enabled: true, match: 'driving licen[cs]e', answer: 'Yes' }] };
    const r = await plan(field('Do you hold a valid driving license?', ['Yes', 'No']), cfg);
    expect(r.answers[0]).toMatchObject({ value: 'Yes', source: 'default', rule: 'c1' });
  });

  it('a custom rule can never answer a sensitive question', async () => {
    const cfg = { custom: [{ id: 'c2', enabled: true, match: 'sponsorship', answer: 'No' }] };
    const r = await plan(field('Will you now or in the future require visa sponsorship?', ['Yes', 'No']), cfg);
    expect(r.answers).toHaveLength(0);
  });

  it('exclude vetoes, disabled rules are skipped', () => {
    expect(matchCustom(normalizeDefaults({ custom: [{ id: 'a', match: 'hobby', exclude: 'work', answer: 'x' }] }), 'work hobby')).toBeNull();
    expect(matchCustom(normalizeDefaults({ custom: [{ id: 'a', enabled: false, match: 'hobby', answer: 'x' }] }), 'hobby')).toBeNull();
  });

  it('bad input is refused with a reason, and dropped when merely read', () => {
    expect(validateDefaults({ custom: [{ match: '([', answer: 'x' }] })).toMatchObject({ ok: false });
    expect(validateDefaults({ custom: [{ match: 'a', answer: '' }] })).toMatchObject({ ok: false });
    const n = normalizeDefaults({ disabled: ['nope', 'knows-nobody'], overrides: { nope: 'x' }, custom: [{ match: '([', answer: 'x' }] });
    expect(n).toEqual({ disabled: ['knows-nobody'], overrides: {}, custom: [] });
  });
});
