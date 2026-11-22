import { describe, expect, it } from 'vitest';
import { postingKey } from './form-schema.js';

describe('postingKey', () => {
  it('drops tracking noise but keeps the parameter that picks the job', () => {
    expect(postingKey('https://acme.com/careers?gh_jid=123&utm_source=x')).toBe('acme.com/careers?gh_jid=123');
    expect(postingKey('https://acme.com/careers?gh_jid=123')).not.toBe(postingKey('https://acme.com/careers?gh_jid=456'));
    expect(postingKey('https://jobs.lever.co/acme/abc/apply?lever-source=x')).toBe('jobs.lever.co/acme/abc');
  });
});
