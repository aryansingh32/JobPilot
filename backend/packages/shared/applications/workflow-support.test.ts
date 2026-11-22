import { expect, it } from 'vitest';
import { supportsRecordedJob } from './workflow-support.js';
it('permits URL-specific recorded workflows on custom sites', () => {
  expect(supportsRecordedJob('https://portal.example/apply', 'custom', [{ats:'recorded',patterns:['^https://portal\\.example/']}])).toBe(true);
});
it('does not treat one recorded workflow as support for every recorded site', () => {
  expect(supportsRecordedJob('https://other.example/', 'recorded', [{ats:'recorded',patterns:['^https://portal\\.example/']}])).toBe(false);
});
it('keeps known ATS support and rejects generic or invalid patterns', () => {
  expect(supportsRecordedJob('https://example.com/', 'greenhouse', [{ats:'greenhouse'}])).toBe(true);
  expect(supportsRecordedJob('https://example.com/', 'custom', [{ats:'generic',patterns:['.*']},{ats:'recorded',patterns:['[']}])).toBe(false);
});
