import type { ProfileData } from './index.js';

// ============================================================
// PROFILE GAPS — the facts nearly every application asks for that this
// profile doesn't have yet. Asked once, up front ("This job needs the details
// below"), instead of one at a time while a browser sits waiting. Optional
// answers are never pushed: only what a typical form refuses to submit without.
// ============================================================

const COUNTRY_NAME: Record<string, string> = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', CA: 'Canada', DE: 'Germany', SG: 'Singapore',
  IE: 'Ireland', NL: 'Netherlands', FR: 'France', AU: 'Australia', AE: 'United Arab Emirates', JP: 'Japan',
  ES: 'Spain', PL: 'Poland', BR: 'Brazil', MX: 'Mexico', PT: 'Portugal', SE: 'Sweden', CH: 'Switzerland',
};

/** "India" / "INDIA" / "in" → "IN", so a profile written with names matches a job tagged with codes. */
export function countryKey(c: string | null | undefined): string {
  const u = (c ?? '').trim().toUpperCase();
  if (!u) return '';
  if (COUNTRY_NAME[u]) return u;
  const hit = Object.entries(COUNTRY_NAME).find(([, name]) => name.toUpperCase() === u);
  return hit?.[0] ?? u;
}

const DEMONYM: Record<string, string[]> = {
  IN: ['indian'], US: ['american', 'us citizen', 'usa'], GB: ['british', 'english', 'uk'], CA: ['canadian'], DE: ['german'],
  SG: ['singaporean'], IE: ['irish'], NL: ['dutch'], FR: ['french'], AU: ['australian'], AE: ['emirati'], JP: ['japanese'],
  ES: ['spanish'], PL: ['polish'], BR: ['brazilian'], MX: ['mexican'], PT: ['portuguese'], SE: ['swedish'], CH: ['swiss'],
};

/** Is this nationality ("Indian", "India", "IN") the job country's own? undefined when either is unknown. */
export function isCitizenOf(nationality: string | null | undefined, country: string | null | undefined): boolean | undefined {
  const nat = (nationality ?? '').trim().toLowerCase();
  const here = countryKey(country);
  if (!nat || !here) return undefined;
  if (countryKey(nat) === here) return true;
  if ((DEMONYM[here] ?? []).some((d) => nat === d || nat.includes(d))) return true;
  // A known nationality of another country is a "no"; an unrecognised word is not evidence.
  const other = Object.entries(DEMONYM).some(([code, ds]) => code !== here && ds.some((d) => nat === d));
  return other || Object.keys(COUNTRY_NAME).some((c) => c !== here && countryKey(nat) === c) ? false : undefined;
}

export const countryLabel = (c: string) => COUNTRY_NAME[countryKey(c)] ?? c;

export interface ProfileGap {
  /** Where the answer goes, e.g. "personal.postalCode" or "authorization.US". */
  key: string;
  label: string;
  hint?: string;
  input: 'text' | 'choice';
  options?: string[];
  /** The application can't be sent without it (vs. nice to have). */
  blocking: boolean;
}

/** Is the person known to be allowed to work in this country? undefined = never said. */
export function authorizedIn(data: ProfileData, country: string | null | undefined): boolean | undefined {
  const here = countryKey(country);
  const a = data.authorization;
  if (!here) return undefined;
  const listed = (a?.countries ?? []).map(countryKey);
  if (listed.includes(here)) return true;
  if ((a?.notAuthorized ?? []).map(countryKey).includes(here)) return false;
  // A list that names other countries means "authorized only there".
  return listed.length ? false : undefined;
}

export function profileGaps(data: ProfileData, job?: { country?: string | null }): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  const p = data.personal ?? {};
  const w = data.work ?? {};
  const add = (g: ProfileGap) => gaps.push(g);

  if (!p.phone) add({ key: 'personal.phone', label: 'Phone number', hint: 'With country code, e.g. +91 98765 43210', input: 'text', blocking: true });
  if (!p.address) add({ key: 'personal.address', label: 'Street address', hint: 'Forms ask for it; "Lucknow" is fine if you prefer not to give the street', input: 'text', blocking: true });
  if (!p.city) add({ key: 'personal.city', label: 'City', input: 'text', blocking: true });
  if (!p.state) add({ key: 'personal.state', label: 'State / region', input: 'text', blocking: true });
  if (!p.postalCode) add({ key: 'personal.postalCode', label: 'ZIP / PIN code', input: 'text', blocking: true });
  if (!p.country) add({ key: 'personal.country', label: 'Country', hint: 'Two-letter code or name, e.g. IN or India', input: 'text', blocking: true });
  if (!w.noticePeriod) {
    add({ key: 'work.noticePeriod', label: 'Notice period / earliest start', input: 'choice', options: ['Immediately', '15 days', '30 days', '60 days', '90 days'], blocking: true });
  }
  if (!w.expectedSalary) {
    add({ key: 'work.expectedSalary', label: 'Expected salary', hint: 'Per month or per year, in the currency you want — e.g. "12k negotiable"', input: 'text', blocking: true });
  }
  // Only ever asked when the job's country is known and nothing in the profile settles it.
  if (job?.country && authorizedIn(data, job.country) === undefined) {
    const key = countryKey(job.country);
    add({
      key: `authorization.${key}`,
      label: `Are you legally allowed to work in ${countryLabel(key)} without sponsorship?`,
      input: 'choice',
      options: ['Yes', 'No'],
      blocking: true,
    });
  }
  return gaps;
}

/** The profile patch for the answers given (values are trimmed; unknown keys are ignored). */
export function gapPatch(current: ProfileData, answers: Record<string, string>): ProfileData {
  const patch: ProfileData = {};
  const set = (section: 'personal' | 'work', field: string, value: string) => {
    (patch as Record<string, Record<string, unknown>>)[section] = { ...((patch as Record<string, Record<string, unknown>>)[section] ?? {}), [field]: value };
  };
  const PERSONAL = ['phone', 'address', 'city', 'state', 'postalCode', 'country'];
  const WORK = ['noticePeriod', 'expectedSalary'];
  for (const [key, raw] of Object.entries(answers)) {
    const value = String(raw ?? '').trim().slice(0, 200);
    if (!value) continue;
    const [section, field] = key.split('.');
    if (section === 'personal' && PERSONAL.includes(field)) set('personal', field, value);
    else if (section === 'work' && WORK.includes(field)) set('work', field, value);
    else if (section === 'authorization' && /^[A-Z]{2}$/.test(field)) {
      const a = patch.authorization ?? { ...(current.authorization ?? {}) };
      const yes = /^y/i.test(value);
      const countries = new Set((a.countries ?? []).map(countryKey));
      const no = new Set((a.notAuthorized ?? []).map(countryKey));
      if (yes) { countries.add(field); no.delete(field); } else { no.add(field); countries.delete(field); }
      patch.authorization = { ...a, countries: [...countries], notAuthorized: [...no] };
    }
  }
  return patch;
}

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const IN_CITIES = /\b(bengaluru|bangalore|mumbai|delhi|new delhi|gurugram|gurgaon|noida|hyderabad|pune|chennai|kolkata|lucknow|ahmedabad|jaipur|kochi|indore|chandigarh)\b/i;

/** Best-effort country code from a posting's location text ("Mountain View, CA", "Remote - India", "Bengaluru"). */
export function inferCountry(location: string | null | undefined): string | null {
  const l = (location ?? '').trim();
  if (!l) return null;
  for (const [code, name] of Object.entries(COUNTRY_NAME)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(l)) return code;
  }
  if (/\b(ind|india)\b/i.test(l) || IN_CITIES.test(l)) return 'IN';
  if (/\b(usa|u\.s\.|us)\b/i.test(l) || new RegExp(`,\\s*(${US_STATES})\\b`).test(l)) return 'US';
  if (/\buk\b|\bengland\b|\blondon\b/i.test(l)) return 'GB';
  if (new RegExp(',\\s*(ON|BC|QC|AB|MB|NS)\\b').test(l) || /\b(toronto|vancouver|montreal)\b/i.test(l)) return 'CA';
  return null;
}
