import type { ProfileData } from './index.js';

// Companies the person has worked for, as far as their own profile says: the experience entries, the current
// employer, and anything they list in "Tell us more about you" ("Previous employers: Acme, Globex").
// "Have you ever worked for X?" is answered Yes only for these, No for everyone else.

const SUFFIX = /\b(inc|incorporated|llc|ltd|limited|pvt|private|plc|corp|corporation|co|company|gmbh|ag|sa|group|holdings|technologies|technology|solutions)\b\.?/g;
const clean = (s: string) => s.toLowerCase().replace(SUFFIX, ' ').replace(/[^\p{L}\p{N}\s&]/gu, ' ').replace(/\s+/g, ' ').trim();

const LISTED = /(?:worked (?:at|for|with)|previous(?:ly)? (?:employers?|companies|worked (?:at|for|with))|former employers?|past employers?|companies i(?:'ve| have) worked (?:at|for|with)|employers?)\s*[:\-–]\s*([^\n.]+)/gi;

export function workedCompanies(p: ProfileData): string[] {
  const out = new Set<string>();
  const add = (c: string | undefined) => {
    const t = (c ?? '').trim();
    if (t.length >= 2) out.add(t);
  };
  add(p.work?.currentEmployer);
  for (const e of p.experience ?? []) add(e.company);
  for (const m of (p.about ?? '').matchAll(LISTED)) {
    for (const part of m[1].split(/[,;]|\band\b|&/i)) add(part.replace(/^\s*(and|at|for)\s+/i, ''));
  }
  return [...out];
}

/** Is any of these companies the one the question names? Whole-word, ignoring "Inc", "Ltd" and the like. */
export function namesAnyOf(question: string, companies: string[]): boolean {
  const q = ` ${clean(question)} `;
  return companies.some((c) => {
    const n = clean(c);
    return n.length >= 3 && q.includes(` ${n} `);
  });
}
