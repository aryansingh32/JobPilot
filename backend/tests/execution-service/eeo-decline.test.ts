import { describe, it, expect } from 'vitest';
import { planAnswers, type FormField } from '../../packages/execution-service/form-filler.js';

const select = (label: string, options: string[]): FormField =>
  ({ idx: 0, tag: 'select', type: 'select', label, name: 'q', required: true, options, value: '', selector: null }) as FormField;

describe('voluntary questions pick the decline option', () => {
  it.each([
    ['Please select your gender', ['Male', 'Female', 'I do not wish to answer'], 'I do not wish to answer'],
    ['Veteran status', ['I am a veteran', "I don't wish to self-identify"], "I don't wish to self-identify"],
    ['Race / ethnicity', ['Asian', 'White', 'Decline to state'], 'Decline to state'],
  ])('%s', async (label, options, expected) => {
    const { answers, missing } = await planAnswers([select(label, options)], {}, async () => null);
    expect(missing).toHaveLength(0);
    expect(answers[0]).toMatchObject({ value: expected, source: 'default' });
  });
});

describe('required consent checkboxes', () => {
  const box: FormField = {
    idx: 1, tag: 'input', type: 'checkbox', label: 'I have read and consent to the terms', name: 'agree',
    required: true, options: ['Yes', 'No'], value: '', selector: null,
  } as FormField;
  it('are asked, never ticked on their own', async () => {
    const { answers, missing } = await planAnswers([box], {}, async () => null);
    expect(answers).toHaveLength(0);
    expect(missing).toEqual([box]);
  });
  it('reuse the answer the user gave before', async () => {
    const { answers } = await planAnswers([box], {}, async () => 'Yes');
    expect(answers[0]).toMatchObject({ value: 'Yes', source: 'memory' });
  });
});

import { ruleFor } from '../../packages/execution-service/form-filler.js';
describe('Indian application questions', () => {
  const text = (label: string): FormField => ({ idx: 0, tag: 'input', type: 'text', label, name: '', required: true, options: [], value: '', selector: null }) as FormField;
  it.each([
    ['Total Experience', 'yearsExperience'], ['Relevant Experience (in years)', 'yearsExperience'], ['Current CTC', 'currentSalary'],
    ['Expected CTC', 'expectedSalary'], ['Notice Period', 'noticePeriod'], ['Preferred Location', 'preferredLocation'],
    ['Current Location', 'location'], ['Highest Qualification', 'degree'], ['Mobile', 'phone'],
  ])('%s → %s', (label, key) => expect(ruleFor(text(label))).toBe(key));
});
