import type { ProfileData } from './index.js';

const parse = (s: string | undefined, fallback: Date): Date | null => {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (/present|current|now|ongoing/i.test(t)) return fallback;
  const y = t.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!y) return null;
  const m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)?.[1]?.toLowerCase();
  const month = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m) : (/-(\d{2})\b/.test(t) ? Number(t.match(/-(\d{2})\b/)![1]) - 1 : 0);
  return new Date(Number(y), Math.min(Math.max(month, 0), 11), 1);
};

/**
 * Whole years of work the profile itself shows: the stated number first, else the span of the experience entries
 * (overlaps counted once), else 0 for a fresher. null when nothing says — then the question is asked.
 */
export function yearsOfExperience(p: ProfileData, now = new Date()): number | null {
  if (p.work?.yearsOfExperience !== undefined) return p.work.yearsOfExperience;
  const spans = (p.experience ?? [])
    .map((e) => [parse(e.start, now), e.current ? now : parse(e.end, now)] as const)
    .filter((s): s is readonly [Date, Date] => !!s[0] && !!s[1] && s[1] >= s[0])
    .sort((a, b) => +a[0] - +b[0]);
  if (spans.length) {
    let months = 0;
    let [curStart, curEnd] = spans[0];
    for (const [s, e] of spans.slice(1)) {
      if (s <= curEnd) { if (e > curEnd) curEnd = e; }
      else { months += (+curEnd - +curStart) / 2_629_800_000; curStart = s; curEnd = e; }
    }
    months += (+curEnd - +curStart) / 2_629_800_000;
    return Math.round(months / 12);
  }
  if (/student|fresher/i.test(p.work?.experienceLevel ?? '')) return 0;
  return null;
}
