import { describe, expect, it } from 'vitest';
import { categoryOption, govRuleFor, imageRule, isIdentityGate, isLoginIdField, isOtpField, isSecretField } from './gov-forms.js';

describe('govRuleFor', () => {
  it.each([
    ["Father's Name", 'fatherName'],
    ['Name of the Mother', 'motherName'],
    ['Date of Birth (DD/MM/YYYY)', 'dob'],
    ['Category', 'category'],
    ['10th Percentage', 'tenthPercent'],
    ['12th Year of Passing', 'twelfthYear'],
    ['I declare that the information given is true', 'declaration'],
  ])('%s → %s', (label, key) => expect(govRuleFor(label.toLowerCase())).toBe(key));

  it('leaves unrelated questions alone', () => expect(govRuleFor('why do you want this job')).toBeNull());
});

describe('categoryOption', () => {
  const opts = ['--Select--', 'UR (General)', 'OBC (Non-Creamy Layer)', 'EWS', 'SC', 'ST'];
  it('maps short names onto the long option', () => {
    expect(categoryOption(opts, 'OBC')).toBe('OBC (Non-Creamy Layer)');
    expect(categoryOption(opts, 'General')).toBe('UR (General)');
    expect(categoryOption(opts, 'sc')).toBe('SC');
  });
  it('returns null for an unknown category', () => expect(categoryOption(opts, 'martian')).toBeNull());
});

describe('imageRule', () => {
  it('reads a KB range and pixel size', () => {
    expect(imageRule('JPG only, size 20 KB to 50 KB, 200 x 230 pixels')).toMatchObject({ minKB: 20, maxKB: 50, width: 200, height: 230, format: 'jpeg' });
  });
  it('reads a maximum in MB', () => expect(imageRule('Maximum 1 MB').maxKB).toBe(1024));
  it('reads nothing from unrelated text', () => expect(imageRule('Upload your photo')).toEqual({}));
});

describe('field kinds', () => {
  it('spots OTP boxes', () => expect(isOtpField('Email OTP *')).toBe(true));
  it('spots secrets', () => {
    expect(isSecretField('Password', 'password')).toBe(true);
    expect(isSecretField('Pin code', 'text')).toBe(false);
  });
  it('spots sign-in IDs but not names', () => {
    expect(isLoginIdField('Registration Number')).toBe(true);
    expect(isLoginIdField('User ID')).toBe(true);
    expect(isLoginIdField("Candidate's Name")).toBe(false);
  });
  it('hands off Aadhaar / DigiLocker', () => {
    expect(isIdentityGate('Verify with Aadhaar OTP')).toBe(true);
    expect(isIdentityGate('Enter your email')).toBe(false);
  });
});

import { identityFieldKind } from './gov-forms.js';
describe('identityFieldKind', () => {
  it('classifies verification boxes', () => {
    expect(identityFieldKind('Aadhaar Number / Virtual ID', 'text')).toBe('aadhaar');
    expect(identityFieldKind('Aadhaar OTP', 'text')).toBe('otp');
    expect(identityFieldKind('Security PIN', 'password')).toBe('pin');
    expect(identityFieldKind('I consent to authenticate with Aadhaar', 'checkbox')).toBe('consent');
    expect(identityFieldKind('Pin code', 'text')).toBeNull();
  });
});

import { fitsSensitiveInput, SENSITIVE_INPUT } from './gov-forms.js';
describe('sensitive replies', () => {
  it('are routed by format in code', () => {
    expect(SENSITIVE_INPUT.has('aadhaar') && SENSITIVE_INPUT.has('otp') && SENSITIVE_INPUT.has('mobile')).toBe(true);
    expect(fitsSensitiveInput('aadhaar', '1234 5678 9012')).toBe(true);
    expect(fitsSensitiveInput('aadhaar', 'what is this for?')).toBe(false);
    expect(fitsSensitiveInput('otp', '482913')).toBe(true);
    expect(fitsSensitiveInput('otp', 'why do you need it')).toBe(false);
    expect(fitsSensitiveInput('mobile', '+91 98765 43210')).toBe(true);
  });
});
