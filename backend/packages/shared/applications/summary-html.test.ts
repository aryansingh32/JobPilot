import { describe, expect, it } from 'vitest';
import { summaryHtml } from './summary-html.js';

describe('summaryHtml', () => {
  const base = { title: 'Engineer <b>', company: 'Acme & Co', url: 'https://x.test/?a=1&b=2', submittedAt: new Date('2026-10-26T10:00:00Z'), confirmation: 'Thank you for applying', reference: 'AB-12345' };
  it('escapes everything that came from a site or a person', () => {
    const html = summaryHtml({ ...base, answers: [{ label: '<script>alert(1)</script>', value: '"quoted" & more', source: 'profile' }] });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('&quot;quoted&quot; &amp; more');
  });
  it('says where each answer came from and counts only filled ones', () => {
    const html = summaryHtml({ ...base, answers: [{ label: 'Q1', value: 'A', source: 'ai' }, { label: 'Q2', value: '', source: 'profile' }] });
    expect(html).toContain('Written by AI from your notes');
    expect(html).toContain('(1 answer)');
    expect(html).toContain('AB-12345');
  });
  it('embeds the receipt when there is one', () => {
    expect(summaryHtml({ ...base, answers: [], receiptPng: 'AAAA' })).toContain('data:image/png;base64,AAAA');
    expect(summaryHtml({ ...base, answers: [] })).not.toContain('<img');
  });
});
