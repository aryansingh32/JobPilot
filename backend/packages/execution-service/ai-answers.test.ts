import { describe, expect, it } from 'vitest';
import { answerByRule, answerFromNotes, modelMayAnswer } from './ai-answers.js';
import { payPeriod } from '../shared/profile/intent.js';

const f = (label: string, options: string[] = []) => ({ idx: 0, label, name: '', options, type: 'text', tag: 'input', required: true, value: '', selector: null }) as never;

describe('similar questions are not the same question', () => {
  const notes = 'Years of experience: 2\nSalary expectation: 12 LPA\nSponsorship required: No';
  it('total experience never answers experience with a technology', () => {
    expect(answerFromNotes(notes, f('Total years of experience'))).toBe('2');
    expect(answerFromNotes(notes, f('Years of experience with React?'))).toBeNull();
  });
  it('a listed skill is not professional experience or years', () => {
    const p = { skills: ['React'] } as never;
    expect(answerByRule(p, f('Do you have experience with React?', ['Yes', 'No']))).toBe('Yes');
    expect(answerByRule(p, f('Do you have professional experience with React?', ['Yes', 'No']))).toBeNull();
    expect(answerByRule(p, f('Years of experience with React?', ['Yes', 'No']))).toBeNull();
  });
  it('a yearly figure never answers an hourly or monthly box', () => {
    expect(answerFromNotes(notes, f('Salary expectation'))).toBe('12 LPA');
    expect(answerFromNotes(notes, f('Expected hourly rate'))).toBeNull();
    expect(answerFromNotes(notes, f('Expected monthly salary'))).toBeNull();
    expect(payPeriod('12 LPA')).toBe('year');
    expect(payPeriod('Expected hourly rate')).toBe('hour');
  });
  it('sponsorship and work authorisation are never model-written', () => {
    expect(modelMayAnswer('Will you require sponsorship?')).toBe(false);
    expect(modelMayAnswer('Are you legally authorized to work in the US?')).toBe(false);
    expect(modelMayAnswer('What is your expected hourly rate?')).toBe(false);
    expect(modelMayAnswer('Why do you want to work here?')).toBe(true);
    // but the person's own note still answers it
    expect(answerFromNotes(notes, f('Sponsorship required'))).toBe('No');
  });
});
