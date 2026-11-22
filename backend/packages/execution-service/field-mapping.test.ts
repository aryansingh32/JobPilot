import { describe, expect, it } from 'vitest';
import { ruleFor, type FormField } from './form-filler.js';
import { classifyIntent } from '../shared/profile/intent.js';

const field = (label: string): FormField => ({ idx: 0, label, name: '', type: 'text', tag: 'input', required: true, options: [], value: '' } as unknown as FormField);

describe('field labels → profile keys', () => {
  it.each([
    ['Name as per Aadhaar', 'fullName'],
    ['Full Name (as per 10th certificate)', 'fullName'],
    ["Father's name", 'fatherName'],
    ['Zip', 'postalCode'],
    ['Pincode', 'postalCode'],
    ['Telephone', 'phone'],
    ['WhatsApp number', 'phone'],
    ['Branch / Specialization', 'field'],
    ['Highest education level', 'degree'],
    ['Total years of experience', 'yearsExperience'],
  ])('%s → %s', (label, key) => expect(ruleFor(field(label))).toBe(key));

  it('never answers a tool-specific experience question with total years', () => {
    expect(ruleFor(field('Years of experience with Python'))).toBeNull();
    expect(ruleFor(field('How many years of experience do you have in React?'))).toBeNull();
  });
});

describe('question → intent', () => {
  it.each([
    ['Are you open to working from our Bangalore office 5 days a week?', 'onsite_ok'],
    ['Were you referred by an employee?', 'knows_employee'],
    ['Years of React experience', 'years_technology'],
    ['Years of professional experience', 'years_total'],
    ['How many years of experience do you have in total?', 'years_total'],
    ['Do you now or will you in the future require visa sponsorship?', 'sponsorship'],
  ])('%s → %s', (q, intent) => expect(classifyIntent(q)).toBe(intent));
});
