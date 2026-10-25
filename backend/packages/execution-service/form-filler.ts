import type { Locator, Page } from 'playwright';
import { categoryOption, governmentBook, govRuleFor, isLoginIdField, isOtpField, isSecretField } from './gov-forms.js';
import type { ProfileData } from '../shared/profile/index.js';
import { authorizedIn } from '../shared/profile/gaps.js';

// ============================================================
// FORM FILLER — deterministic, no AI. Scans every field on the page, works
// out what it asks from its label, and answers from the user's profile (then
// their remembered answers). Anything required it can't answer is returned
// as `missing` so the run can ask the user instead of guessing.
// ============================================================

export interface FormField {
  idx: number;
  tag: 'input' | 'textarea' | 'select';
  /** input type, 'radio' for a whole radio group, 'combobox' for typeahead widgets */
  type: string;
  label: string;
  name: string;
  required: boolean;
  options: string[];
  value: string;
  /** Stable selector (id / unique name) — survives React re-renders that drop our tag. */
  selector?: string | null;
}

export type AnswerSource = 'profile' | 'memory' | 'user' | 'default' | 'prefilled' | 'ai';

export interface FieldAnswer {
  field: FormField;
  key: string;
  value: string;
  source: AnswerSource;
  /** Multi-page forms: which page it was on (field indexes repeat per page). */
  page?: number;
}

/** Profile + job flattened into the keys the label rules point at. */
export type AnswerBook = Record<string, string>;

const COUNTRY_NAME: Record<string, string> = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', CA: 'Canada', DE: 'Germany', SG: 'Singapore',
  IE: 'Ireland', NL: 'Netherlands', FR: 'France', AU: 'Australia', AE: 'United Arab Emirates', JP: 'Japan',
  ES: 'Spain', PL: 'Poland', BR: 'Brazil', MX: 'Mexico', PT: 'Portugal', SE: 'Sweden', CH: 'Switzerland',
};

const yesNo = (v: boolean | undefined) => (v === undefined ? '' : v ? 'Yes' : 'No');

export function buildAnswerBook(profile: ProfileData, job: { country?: string | null } = {}): AnswerBook {
  const p = profile.personal ?? {};
  const w = profile.work ?? {};
  const a = profile.authorization ?? {};
  const edu = profile.education?.[0];
  const exp = profile.experience?.find((e) => e.current) ?? profile.experience?.[0];
  const [first, ...rest] = (p.fullName ?? '').trim().split(/\s+/);
  const country = p.country ? COUNTRY_NAME[p.country.toUpperCase()] ?? p.country : '';
  // "India" in the profile vs "IN" on the job; a country they said no to counts as no. Sponsorship follows the job's country.
  const authorized = authorizedIn(profile, job.country);

  const book: AnswerBook = {
    firstName: p.firstName || first || '',
    lastName: p.lastName || rest.join(' '),
    fullName: p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' '),
    email: p.email ?? '',
    phone: p.phone ?? '',
    // National number without the country code (forms with a separate code picker).
    phoneLocal: (p.phone ?? '').replace(/\D/g, '').slice(-10),
    city: p.city ?? '',
    state: p.state ?? '',
    country,
    location: [p.city, p.state, country].filter(Boolean).join(', '),
    address: p.address ?? '',
    postalCode: p.postalCode ?? '',
    linkedin: p.linkedin ?? '',
    github: p.github ?? '',
    website: p.website || p.github || '',
    summary: p.summary ?? '',
    currentCompany: w.currentEmployer || exp?.company || '',
    currentTitle: w.currentTitle || exp?.title || '',
    yearsExperience: w.yearsOfExperience !== undefined ? String(w.yearsOfExperience) : '',
    noticePeriod: w.noticePeriod ?? '',
    expectedSalary: w.expectedSalary ?? '',
    currentSalary: w.currentSalary ?? '',
    needsSponsorship: yesNo(authorized !== undefined ? !authorized : a.needsSponsorship),
    authorized: yesNo(authorized ?? (a.needsSponsorship === undefined ? undefined : !a.needsSponsorship)),
    school: edu?.school ?? '',
    degree: edu?.degree ?? '',
    field: edu?.field ?? '',
    graduationYear: edu?.end?.match(/\d{4}/)?.[0] ?? '',
    skills: (profile.skills ?? []).join(', '),
    preferredLocation: profile.preferences?.locations?.find((l) => !/remote/i.test(l)) ?? '',
    ...governmentBook(profile),
  };
  return book;
}

// Order matters: the first rule whose pattern matches the label wins.
const RULES: Array<[RegExp, string]> = [
  [/\b(first|given)\s*name|\bfname\b/, 'firstName'],
  [/\b(last|family|sur)\s*name|\blname\b|\bsurname\b/, 'lastName'],
  [/\bpreferred\s*name\b/, 'firstName'],
  [/\b(full|legal|your)\s*name\b|^name$|^(candidate|applicant|student)'?s?\s*name$|^name of (the )?(candidate|applicant)$/, 'fullName'],
  [/e-?mail/, 'email'],
  [/\b(phone|mobile|contact number|cell)\b/, 'phone'],
  [/linkedin/, 'linkedin'],
  [/github/, 'github'],
  [/\b(website|portfolio|personal site|blog|other url)\b/, 'website'],
  [/\b(sponsor|sponsorship|visa)\b/, 'needsSponsorship'],
  [/\b(authori[sz]ed|authori[sz]ation|eligible|right) to work\b|\bwork authori[sz]ation\b/, 'authorized'],
  [/\b(current|present|latest|most recent|last|existing)\s+(company|employer|organi[sz]ation|workplace|firm|business)\b|\bemployer\b|^(company|organi[sz]ation|employer)$|\bcompany name\b|\bname of (the |your )?(company|employer|organi[sz]ation)\b|\bwhere do you (currently )?work\b|\bcurrently work(?:ing)? (at|for)\b|\borgani[sz]ation name\b|\bnom de l'?(entreprise|employeur)\b|\bempresa actual\b|\baktueller arbeitgeber\b|\bवर्तमान (कंपनी|नियोक्ता)/, 'currentCompany'],
  [/\b(current|present|latest|most recent)\s+(job\s+)?(title|role|position|designation|occupation)\b|\bjob title\b|\bdesignation\b|\bposition held\b|\bposte actuel\b|\bcargo actual\b/, 'currentTitle'],
  [/\brelevant experience\b.*\b(skills|qualifications|role)\b|\byears? of (relevant |professional |total )?experience\b|\bhow many years\b|\b(total|relevant|overall) (work )?experience\b|\bexperience \(?in years\)?/, 'yearsExperience'],
  [/\bnotice(\s+period)?\b|\bearliest (start|joining)\b|\bwhen can you (start|join)\b|\b(joining|start) (date|time)\b|\bhow soon can you (join|start)\b|\bavailab(le|ility) (to|for) (start|join)\b|\bpréavis\b|\bkündigungsfrist\b|\bpreaviso\b|\bnotice period in days\b/, 'noticePeriod'],
  // Current pay is never filled from the expected figure (or guessed).
  [/\b(expected|desired|target|ideal|asking)\b.*\b(salary|ctc|compensation|pay|package|remuneration)\b|\b(salary|compensation|ctc|package|remuneration) (expectation|requirement)s?\b|\bpay expectation\b|\bprétentions salariales\b|\bpretensión salarial\b|\bgehaltsvorstellung\b/, 'expectedSalary'],
  [/\b(current|present|existing|last drawn|drawn|fixed|existing)\b.*\b(salary|ctc|compensation|pay|package|remuneration)\b|\bcurrent (annual )?(salary|ctc)\b|\bsalaire actuel\b|\bsalario actual\b|\baktuelles gehalt\b/, 'currentSalary'],
  [/\b(expected|desired|target|ideal|asking)\b.*\b(salary|ctc|compensation|pay|package|remuneration)\b|\b(salary|compensation|ctc|package|remuneration) (expectation|requirement)s?\b|\bpay expectation\b|\b(salary|compensation|ctc|package)\b|\bprétentions salariales\b|\bpretensión salarial\b|\bgehaltsvorstellung\b/, 'expectedSalary'],
  [/\b(zip|postal|pin)\s*code\b/, 'postalCode'],
  [/\b(street )?address\b/, 'address'],
  [/^city$|\bcity\b(?! you)/, 'city'],
  [/\b(state|province|region)\b/, 'state'],
  [/\bcountry\b/, 'country'],
  // Indian forms ask both: where you are now, and where you'd work.
  [/\bpreferred (job |work )?locations?\b|\blocation preference\b/, 'preferredLocation'],
  [/\blocation\b|\bwhere are you (based|located)\b|\bcurrently (based|located)\b/, 'location'],
  [/\b(school|university|college|institution)\b/, 'school'],
  [/\bdegree\b|\b(highest )?qualification\b/, 'degree'],
  [/\b(discipline|major|field of study)\b/, 'field'],
  [/\bgraduat/, 'graduationYear'],
  [/\b(summary|about (yourself|you))\b/, 'summary'],
];

/** Voluntary self-identification questions → pick the "decline" option, never guess. */
const EEO = /\b(gender|race|ethnic|hispanic|latino|veteran|disability|sexual orientation|pronoun|transgender)\b/;
// "I do not wish to answer" (Workday), "I don't wish to self-identify", "Decline to state"…
const DECLINE = /decline|prefer not|rather not|do(?:n'?t| not) (?:wish|want) to|not to (?:say|answer|disclose)|choose not/i;

const norm = (s: string) => s.toLowerCase().replace(/[*✱]/g, ' ').replace(/[^\p{L}\p{N}\s/'-]/gu, ' ').replace(/\s+/g, ' ').trim();

export function ruleFor(field: FormField): string | null {
  if (field.type === 'file') {
    const l = norm(`${field.label} ${field.name}`);
    if (/cover/.test(l)) return null;
    if (/\b(signature|sign)\b/.test(l)) return 'signature';
    if (/\b(photo|photograph|passport size|passport-size)\b/.test(l)) return 'photo';
    return /resume|cv|curriculum/.test(l) ? 'resume' : null;
  }
  const l = norm(field.label) || norm(field.name.replace(/[_\[\]]+/g, ' '));
  if (!l) return null;
  // "Mobile OTP" and "Email OTP" are codes sent to you, not your number or address.
  if (isOtpField(l) || isSecretField(l, field.type)) return null;
  if (/cover letter|pronounc|high school|secondary school|referr(al|ed|er)\b/.test(l)) return null;
  // A long question that merely mentions "GitHub" or "location" is an open question,
  // not that profile field — only yes/no eligibility rules apply to long text.
  const long = l.split(' ').length > 14;
  const gov = long ? null : govRuleFor(l);
  if (gov) return gov;
  for (const [re, key] of RULES) {
    // "Type of right-to-work document" asks which document, not whether they may work.
    if (key === 'authorized' && /\b(document|documents|proof|evidence|type of|which)\b/.test(l) && !/^(are|do|will|can)\b/.test(l)) continue;
    if (long && key !== 'needsSponsorship' && key !== 'authorized' && !(key === 'yearsExperience' && /^(what|how much|how many)\b.{0,30}experience/.test(l))) continue;
    if (re.test(l)) return key;
  }
  return null;
}

/** "12 LPA" / "12 lakh" / "1.2 cr" / "15,00,000" / "$120k" → plain number string. */
export function toAmount(v: string): string | null {
  const m = v.toLowerCase().replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b|cr|crores?|k\b)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = !m[2] ? 1 : /^l/.test(m[2]) ? 100_000 : /^c/.test(m[2]) ? 10_000_000 : 1_000;
  return String(Math.round(n * mult));
}

/** "<1 Yrs" / "1-3 Yrs" / "3-6" / "6+" / "10 or more": the range a number of years falls in. */
export function rangeOption(options: string[], n: number): string | null {
  for (const o of options) {
    const t = o.toLowerCase().replace(/,/g, '');
    const nums = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (!nums.length) continue;
    if (/^\s*(<|less than|under|below|fresher|0\s*[-–]\s*1\b)/.test(t) && n < nums[0] + (/0\s*[-–]\s*1\b/.test(t) ? 1 : 0)) return o;
    if (/\+|or more|and above|above|more than|over/.test(t) && nums.length === 1 && n >= nums[0]) return o;
    if (nums.length >= 2 && n >= nums[0] && n <= nums[1]) return o;
  }
  return null;
}

/** "15 days" / "2 weeks" / "1 month" / "immediate" → days. */
export function noticeDays(v: string): number | null {
  const t = v.toLowerCase();
  if (/immediate|none|no notice|serving/.test(t)) return 0;
  const n = parseFloat(t.match(/\d+(?:\.\d+)?/)?.[0] ?? '');
  if (!Number.isFinite(n)) return null;
  return Math.round(/month/.test(t) ? n * 30 : /week/.test(t) ? n * 7 : n);
}

/** The list entry for a notice of N days: an exact number first, else the range it falls in. */
export function noticeOption(options: string[], days: number): string | null {
  const asDays = (o: string): number[] => {
    const t = o.toLowerCase();
    const mult = /month/.test(t) ? 30 : /week/.test(t) ? 7 : 1;
    return (t.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => Math.round(Number(x) * mult));
  };
  if (days === 0) { const o = options.find((x) => /immediate|no notice|zero|^0\b/i.test(x)); if (o) return o; }
  const exact = options.find((o) => !/[<>+\-–]|less|more|up to|within/i.test(o) && asDays(o)[0] === days);
  if (exact) return exact;
  for (const o of options) {
    const nums = asDays(o);
    const t = o.toLowerCase();
    if (!nums.length) continue;
    if (/^\s*(<|less than|within|up to)/.test(t) && days < nums[0]) return o;
    if (/\+|more than|above|over|or more|and above/.test(t) && nums.length === 1 && days >= nums[0]) return o;
    if (nums.length >= 2 && days >= nums[0] && days <= nums[1]) return o;
  }
  return null;
}

/** "How did you hear about us?": the honest generic answer a list offers. */
export function sourceOption(options: string[]): string | null {
  const want = [/career/i, /company (web)?site|corporate site|official/i, /job (board|portal|site)/i, /online|internet|web/i, /^other/i];
  for (const re of want) {
    const hit = options.find((o) => re.test(o));
    if (hit) return hit;
  }
  return null;
}

/** Best option text for a wanted value (exact → yes/no → prefix → contains). */
export function pickOption(options: string[], wanted: string): string | null {
  if (!options.length || !wanted) return null;
  const w = norm(wanted);
  const opts = options.map((o) => ({ o, n: norm(o) })).filter((x) => x.n && !/^(select|choose|please select)/.test(x.n));
  const exact = opts.find((x) => x.n === w);
  if (exact) return exact.o;
  if (w === 'yes' || w === 'no') return opts.find((x) => x.n.startsWith(w))?.o ?? null;
  // Prefix/contains only when the option isn't a much longer, different thing
  // ("State University" must not pick "State University of New York - Albany").
  const close = (x: { n: string }) => x.n.length <= w.length + 15;
  return (
    opts.find((x) => x.n.startsWith(w) && close(x))?.o ??
    opts.find((x) => (x.n.includes(w) && close(x)) || (w.includes(x.n) && x.n.length >= 4))?.o ??
    null
  );
}

/**
 * Decide an answer for every field. `recall` looks up remembered answers to
 * open questions. Returns what to fill, and the required fields left over.
 */
export async function planAnswers(
  fields: FormField[],
  book: AnswerBook,
  recall: (question: string) => Promise<string | null>,
  /** Keys chosen by meaning for fields no rule recognised (see intent.ts). */
  intents: Map<number, string> = new Map(),
): Promise<{ answers: FieldAnswer[]; missing: FormField[] }> {
  const answers: FieldAnswer[] = [];
  const missing: FormField[] = [];
  const signIn = fields.some((f) => f.type === 'password');
  for (const field of fields) {
    // Solved by the user right before submit — never from memory.
    if (field.type === 'captcha') continue;
    // Already filled (by the site or an earlier recorded step): keep it, but
    // list it so the review shows everything that will be sent.
    if (field.value && field.type !== 'radio') {
      answers.push({ field, key: 'prefilled', value: field.value, source: 'prefilled' });
      continue;
    }
    const choice = field.tag === 'select' || field.type === 'radio' || field.type === 'checkbox';
    const key = ruleFor(field) ?? intents.get(field.idx) ?? null;

    if (key === 'resume' || key === 'photo' || key === 'signature') {
      answers.push({ field, key, value: key, source: 'profile' });
      continue;
    }
    if (choice && EEO.test(norm(field.label)) && !(key && book[key])) {
      const decline = field.options.find((o) => DECLINE.test(o));
      if (decline) {
        answers.push({ field, key: 'eeo', value: decline, source: 'default' });
        continue;
      }
    }

    let value = key ? book[key] ?? '' : '';
    // A typeahead "Location (City)" suggests places worldwide: give it the state and country too.
    if (key === 'city' && field.type === 'combobox' && book.state) value = [book.city, book.state, book.country].filter(Boolean).join(', ');
    let source: AnswerSource = 'profile';
    if (!value && field.label) {
      value = (await recall(field.label)) ?? '';
      source = 'memory';
    }
    // Experience asked as ranges ("<1 Yrs", "1-3 Yrs"…): the range the profile's years fall in.
    if (value && choice && key === 'yearsExperience' && Number.isFinite(Number(value))) {
      value = rangeOption(field.options, Number(value)) ?? value;
    }
    // "How did you hear about us?" — never in a profile; a generic true source, not a made-up referrer.
    if (!value && choice && /how did you (hear|find|come to know)|where did you (hear|find|learn)|source of (application|referral)/.test(norm(field.label))) {
      value = sourceOption(field.options) ?? '';
      if (value) source = 'default';
    }
    // A box that wants a number of days ("Available to join (in days)").
    if (value && key === 'noticePeriod' && !choice && (field.type === 'number' || /\bin days\b/i.test(field.label))) {
      const d = noticeDays(value);
      if (d !== null) value = String(d);
    }
    // Notice period as a list ("Immediate", "<15 Days", "15-30 Days", "1 Month"): by days, never a loose text match.
    if (value && choice && key === 'noticePeriod') {
      const days = noticeDays(value);
      if (days !== null) value = noticeOption(field.options, days) ?? value;
    }
    if (value && choice) value = (key === 'category' ? categoryOption(field.options, value) : null) ?? pickOption(field.options, value) ?? '';
    // A date box that is really type=date takes ISO; text boxes take DD/MM/YYYY.
    if (value && key === 'dob' && field.type === 'date') value = book.dobIso || value;
    // The profile's answer fits none of the options ("Bachelor's" vs "B.E / B.Tech"): what the user chose before.
    if (!value && choice && source === 'profile' && field.label) {
      const remembered = await recall(field.label);
      value = remembered ? pickOption(field.options, remembered) ?? '' : '';
      source = 'memory';
    }
    // Hundreds of known schools/degrees and ours isn't one of them: the list's own "Other" is the honest answer.
    if (!value && choice && (key === 'school' || key === 'degree' || key === 'field')) {
      value = field.options.find((o) => /^other$/i.test(o.trim())) ?? '';
      if (value) source = 'default';
    }
    // Amount boxes want a number: "12 LPA" → 1200000, "15,00,000" → 1500000.
    if (value && /salary/i.test(key ?? '') && (field.type === 'number' || /amount/i.test(field.name))) value = toAmount(value) ?? '';
    if (value) answers.push({ field, key: key ?? 'memory', value, source });
    // Sign-in boxes are rarely marked required: on a page with a password box the ID is needed too.
    else if (field.required || (signIn && (field.type === 'password' || isLoginIdField(field.label)))) missing.push(field);
  }
  return { answers, missing };
}

// ─── Browser side ────────────────────────────────────────────

/** Tag and describe every fillable field (radio groups collapse into one). */
export async function scanForm(page: Page, scope?: string): Promise<FormField[]> {
  // Dev builds (tsx/esbuild keepNames) wrap named functions in __name(), which
  // doesn't exist in the page — define a no-op so the scanner runs anywhere.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  return page.evaluate((scopeSel) => {
    const root: ParentNode = (scopeSel && document.querySelector(scopeSel)) || document;
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*/g, ' ').trim();
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const textOf = (el: Element | null) => clean((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '');
    /** The closest label-like element before the input: a preceding sibling, or the previous table cell. */
    const nearLabel = (el: HTMLElement): Element | null => {
      const LABELISH = /^(LABEL|SPAN|DIV|P|B|STRONG|TD|TH|DT|LEGEND)$/;
      let node: Element | null = el;
      for (let up = 0; node && up < 3; up++, node = node.parentElement) {
        if (node.tagName === 'TD' || node.tagName === 'TH') {
          const prev = node.previousElementSibling;
          if (prev && !prev.querySelector('input, select, textarea') && textOf(prev)) return prev;
        }
        let sib = node.previousElementSibling;
        for (let k = 0; sib && k < 3; k++, sib = sib.previousElementSibling) {
          if (/^(INPUT|SELECT|TEXTAREA)$/.test(sib.tagName)) break;
          if (/^(BUTTON|BR|IMG|SVG|SCRIPT|STYLE)$/i.test(sib.tagName)) continue;
          const t = textOf(sib);
          if (LABELISH.test(sib.tagName) && t && t.length <= 140 && !sib.querySelector('input, select, textarea')) return sib;
        }
      }
      return null;
    };
    const labelFor = (el: HTMLElement): string => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && textOf(l)) return textOf(l);
      }
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' '));
        if (t) return t;
      }
      const wrap = el.closest('label');
      if (wrap && textOf(wrap)) return textOf(wrap);
      // Zoho Recruit: input "rec-form_<id>" ↔ <label id="crc-label-rec-form_<id>">.
      const zoho = `${el.getAttribute('name') ?? ''} ${el.id}`.match(/rec-form_\d+/);
      if (zoho) {
        const l = document.getElementById(`crc-label-${zoho[0]}`);
        const t = l?.querySelector('.crc-label-text > span')?.textContent?.trim() || textOf(l);
        if (t) return clean(t);
      }
      // Zoho lookups (City, State): the input sits in <lyte-autocomplete id="<field id>">.
      const lookup = el.closest('lyte-autocomplete[id]');
      if (lookup && /^\d+$/.test(lookup.id)) {
        const l = document.getElementById(`crc-label-rec-form_${lookup.id}`);
        const t = l?.querySelector('.crc-label-text > span')?.textContent?.trim() || textOf(l);
        if (t) return clean(t);
      }
      const aria = el.getAttribute('aria-label');
      if (aria) return clean(aria);
      // Flat markup (<label>Name *</label><input> repeated in one form, or label and input in neighbouring table cells):
      // the label right before this input, not the first one in the form.
      const near = nearLabel(el);
      if (near) return textOf(near);
      let box: Element | null = el.parentElement;
      // Six levels: custom-element forms (Zoho's lyte, Workday) nest inputs deep under their row.
      for (let i = 0; box && i < 6; i++, box = box.parentElement) {
        const lab = box.querySelector('label, legend, [class*="label"], [class*="question"]');
        if (lab && !lab.contains(el) && textOf(lab)) return textOf(lab);
      }
      return clean((el as HTMLInputElement).placeholder || el.getAttribute('name') || el.id);
    };
    const rawText = (el: HTMLElement) => {
      const l = (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) ?? el.closest('label');
      if (l) return l.textContent ?? '';
      const zoho = `${el.getAttribute('name') ?? ''} ${el.id}`.match(/rec-form_\d+/);
      const zl = zoho && document.getElementById(`crc-label-${zoho[0]}`)?.textContent;
      if (zl) return zl;
      // A label beside the input in its row (Freshteam: <div class="form-group"><label>Email<span class="required">*</span></label><input>).
      const row = el.parentElement;
      const sib = row && Array.from(row.children).find((c) => c.tagName === 'LABEL' && !c.contains(el));
      return nearLabel(el)?.textContent ?? sib?.textContent ?? '';
    };
    const isRequired = (el: HTMLElement, label: string) =>
      (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(label) || /[*✱]/.test(rawText(el))
      // Zoho marks the field's row, not the input.
      || !!el.closest('.mandatoryField, .cxGroupMandatoryField');

    const out: Array<{
      idx: number; tag: 'input' | 'textarea' | 'select'; type: string; label: string; name: string;
      required: boolean; options: string[]; value: string; selector: string | null;
    }> = [];
    const stable = (el: Element): string | null => {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      const n = el.getAttribute('name');
      if (n) {
        const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(n)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      return null;
    };
    const radioGroups = new Map<string, number>();
    const checkGroups = new Map<Element, number>();
    let idx = 0;
    root.querySelectorAll('input, textarea, select, [aria-haspopup="listbox"]:not(input), [role="combobox"]:not(input):not(select)').forEach((node) => {
      const el = node as HTMLInputElement;
      // Site chrome (language / settings pickers, nav, banner search) is never part of the application. Without this
      // a Workday page whose real fields haven't rendered yet "has one field" and is submitted empty.
      if (el.closest('nav, [data-automation-id*="settingsSelector"], [data-automation-id*="languageSelector"], [data-automation-id*="utilityButton"], [data-automation-id="navigationItem"]')
        || (el.closest('[role="banner"]') && !el.closest('form'))) return;
      // Workday-style dropdowns are buttons that open a listbox; "Select One" means nothing chosen yet.
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        if (el.getAttribute('aria-disabled') === 'true' || !visible(el) || el.closest('[data-jp-field]')) return;
        const shown = clean(el.textContent ?? '');
        const label = labelFor(el);
        el.setAttribute('data-jp-field', String(idx));
        out.push({
          idx: idx++, tag: 'input', type: 'combobox', label, name: el.getAttribute('name') || el.id || '',
          required: isRequired(el, label), options: [],
          value: /^(select one|select|choose|please select)\b/i.test(shown) ? '' : shown, selector: stable(el),
        });
        return;
      }
      const tag = el.tagName.toLowerCase() as 'input' | 'textarea' | 'select';
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) return;
      if (el.disabled || el.readOnly) return;
      // Upload widgets mirror the chosen file's name in a read-only text box.
      if (/file.?name/i.test(el.getAttribute('name') ?? '') || /\breadonly\b/.test(el.className)) return;
      // Widget internals: react-select's hidden "required" proxy, tabindex=-1 dummies.
      if (type !== 'file' && (el.getAttribute('aria-hidden') === 'true' || (el.tabIndex === -1 && getComputedStyle(el).opacity === '0'))) return;
      if (type !== 'file' && type !== 'radio' && !visible(el)) return;

      if (type === 'radio') {
        const group = el.name || el.id;
        const optionLabel = labelFor(el);
        if (radioGroups.has(group)) {
          const f = out[radioGroups.get(group)!];
          el.setAttribute('data-jp-field', String(f.idx));
          el.setAttribute('data-jp-opt', String(f.options.length));
          f.options.push(optionLabel || el.value);
          return;
        }
        // The question text often sits a few levels up (Lever: .application-question > .application-label).
        let legend: Element | null = null;
        let set: Element | null = el.parentElement;
        for (let i = 0; set && i < 6 && !legend; i++, set = set.parentElement) {
          legend = Array.from(set.querySelectorAll('legend, [class*="label"], [class*="question-text"], label:not(:has(input))'))
            .find((c) => !c.querySelector('input[type="radio"]') && clean(textOf(c))) ?? null;
          if (!legend && set.getAttribute('aria-label')) break;
        }
        const question = clean(legend ? textOf(legend) : set?.getAttribute('aria-label') || group);
        el.setAttribute('data-jp-field', String(idx));
        el.setAttribute('data-jp-opt', '0');
        radioGroups.set(group, out.length);
        out.push({
          idx: idx++, tag, type: 'radio', label: question, name: group,
          required: el.required || /[*✱]/.test(legend ? legend.textContent ?? '' : ''),
          options: [optionLabel || el.value], value: '', selector: null,
        });
        return;
      }
      if (type === 'checkbox') {
        // Optional / multi-choice boxes are left alone. A required one (usually
        // "I have read and consent to…") becomes a Yes/No question — the user
        // decides once, it's remembered; never ticked on our own.
        const label = labelFor(el);
        if (!isRequired(el, label) || !visible(el)) return;
        // Several boxes under one question (Greenhouse "Which location…", "None of the above"):
        // one pick-one question with the boxes as options, not a Yes/No per box.
        let wrap: Element | null = el.parentElement;
        for (let i = 0; wrap && i < 5 && wrap.querySelectorAll('input[type="checkbox"]').length < 2; i++) wrap = wrap.parentElement;
        const boxes = wrap ? Array.from(wrap.querySelectorAll('input[type="checkbox"]')) : [];
        const question = wrap && boxes.length >= 2 && boxes.length <= 30
          ? Array.from(wrap.querySelectorAll('legend, [class*="label"], label:not(:has(input))'))
            .find((c) => !c.querySelector('input[type="checkbox"]') && !boxes.some((b) => labelFor(b as HTMLElement) === clean(textOf(c))) && clean(textOf(c)))
          : null;
        if (wrap && question) {
          const seen = checkGroups.get(wrap);
          if (seen !== undefined) {
            const f = out[seen];
            el.setAttribute('data-jp-field', String(f.idx));
            el.setAttribute('data-jp-opt', String(f.options.length));
            f.options.push(label || el.value);
            return;
          }
          el.setAttribute('data-jp-field', String(idx));
          el.setAttribute('data-jp-opt', '0');
          checkGroups.set(wrap, out.length);
          out.push({
            idx: idx++, tag, type: 'radio', label: clean(textOf(question)), name: el.getAttribute('name') || el.id || '',
            required: true, options: [label || el.value], value: '', selector: null,
          });
          return;
        }
        el.setAttribute('data-jp-field', String(idx));
        out.push({
          idx: idx++, tag, type: 'checkbox', label, name: el.getAttribute('name') || el.id || '',
          required: true, options: ['Yes', 'No'], value: el.checked ? 'Yes' : '', selector: stable(el),
        });
        return;
      }

      let rawLabel = labelFor(el);
      // Upload widgets are labelled "Attach"; the question ("Please provide a transcript *") sits above the widget.
      let questionStar = false;
      if (type === 'file' && /^(attach|upload|browse|choose|select|drag)\b/i.test(clean(rawLabel))) {
        let up: Element | null = el.parentElement;
        for (let i = 0; up && i < 6; i++, up = up.parentElement) {
          const prev = up.previousElementSibling;
          const text = prev ? clean(textOf(prev)) : '';
          if (prev && text && !/^(attach|dropbox|upload)/i.test(text) && text.length < 200) {
            rawLabel = text;
            questionStar = /[*✱]/.test(prev.textContent ?? '');
            break;
          }
        }
      }
      el.setAttribute('data-jp-field', String(idx));
      const combobox = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
      const hint = `${el.id} ${el.getAttribute('name') ?? ''} ${(el as HTMLInputElement).placeholder ?? ''} ${rawLabel}`;
      // "Security code" is an image captcha only with a picture beside it; Greenhouse's is an emailed code.
      let captcha = /captcha|characters? (shown|you see)/i.test(hint);
      if (!captcha && /security ?code/i.test(hint)) {
        let box: Element | null = el.parentElement;
        for (let i = 0; box && i < 5 && !captcha; i++, box = box.parentElement) captcha = !!box.querySelector('img[src*="captcha" i], canvas, img[alt*="captcha" i]');
      }
      out.push({
        idx: idx++,
        tag,
        type: captcha ? 'captcha' : combobox ? 'combobox' : type,
        label: rawLabel,
        name: el.getAttribute('name') || el.id || '',
        required: questionStar || isRequired(el, rawLabel),
        options: tag === 'select' ? Array.from((el as unknown as HTMLSelectElement).options).map((o) => clean(o.text)) : [],
        value: tag === 'select' ? ((el as unknown as HTMLSelectElement).selectedIndex > 0 ? clean((el as unknown as HTMLSelectElement).value) : '') : type === 'file' ? '' : el.value,
        selector: stable(el),
      });
    });
    return out;
  }, scope ?? null);
}

const locate = async (page: Page, field: FormField) => {
  if (field.selector) {
    const byStable = page.locator(field.selector).first();
    if (await byStable.count()) return byStable;
  }
  return page.locator(`[data-jp-field="${field.idx}"]`).first();
};

/** The options belonging to this dropdown (its listbox), never other widgets' hidden lists. */
async function optionsOf(page: Page, input: Locator) {
  const owns = (await input.getAttribute('aria-controls').catch(() => null)) ?? (await input.getAttribute('aria-owns').catch(() => null));
  if (owns) {
    const scoped = page.locator(`[id="${owns}"] [role="option"]`);
    if (await scoped.count()) return scoped;
  }
  return page.locator('[role="option"]:visible');
}

const texts = async (opts: Locator) =>
  (await opts.allInnerTexts().catch(() => [] as string[])).map((o) => o.replace(/\s+/g, ' ').trim());

/** Typeahead dropdowns (react-select etc.) only render their options once opened. Empty = async search. */
export async function readComboOptions(page: Page, field: FormField): Promise<string[]> {
  const loc = await locate(page, field);
  await loc.click({ timeout: 5_000 }).catch(() => {});
  // Options render a beat after the click: poll for them instead of always paying a fixed pause.
  let options: string[] = [];
  for (let waited = 0; waited < 1_500; waited += 150) {
    await page.waitForTimeout(150);
    options = await texts(await optionsOf(page, loc));
    if (options.length) break;
  }
  await page.keyboard.press('Escape').catch(() => {});
  // Long lists (country codes, nationalities) run past 200: a low cap hides the answer (India sorts after 50).
  return [...new Set(options.filter(Boolean))].slice(0, 500);
}

/** Put one answer into its field. `filePath` is used for file inputs. */
export async function fillField(page: Page, answer: { field: FormField; value: string }, filePath?: string): Promise<void> {
  const { field, value } = answer;
  if (field.type === 'radio') {
    const i = field.options.indexOf(value);
    if (i < 0) throw new Error(`No option "${value}" for "${field.label}"`);
    await page.locator(`[data-jp-field="${field.idx}"][data-jp-opt="${i}"]`).first().check({ force: true, timeout: 5_000 });
    return;
  }
  const loc = await locate(page, field);
  if (field.type === 'checkbox') {
    if (/^yes$/i.test(value)) await loc.check({ force: true, timeout: 5_000 });
    else await loc.uncheck({ force: true, timeout: 5_000 }).catch(() => {});
    return;
  }
  if (field.type === 'file') {
    if (!filePath) throw new Error('No file to upload');
    await loc.setInputFiles(filePath, { timeout: 10_000 });
    return;
  }
  if (field.tag === 'select') {
    await loc.selectOption({ label: value }, { timeout: 5_000 });
    return;
  }
  if (field.type === 'combobox' && !['INPUT', 'TEXTAREA'].includes(await loc.evaluate((e) => e.tagName).catch(() => 'INPUT'))) {
    await loc.click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    let opts = page.locator('[role="option"]:visible');
    let list = await texts(opts);
    let want = pickOption(list, value);
    // Long or virtualised lists only render some options: type to narrow them down.
    if (!want) {
      await page.keyboard.type(value, { delay: 30 }).catch(() => {});
      await page.waitForTimeout(500);
      opts = page.locator('[role="option"]:visible');
      list = await texts(opts);
      want = pickOption(list, value);
    }
    if (!want) {
      await page.keyboard.press('Escape').catch(() => {});
      throw new Error(`No option "${value}" for "${field.label}"`);
    }
    await opts.nth(list.indexOf(want)).click({ timeout: 5_000 });
    return;
  }
  if (field.type === 'combobox') {
    await loc.click({ timeout: 5_000 });
    await loc.fill(value, { timeout: 5_000 });
    // Async searches (cities…) need a moment after typing.
    let opts = await optionsOf(page, loc);
    let list: string[] = [];
    for (let i = 0; i < 6 && !list.length; i++) {
      await page.waitForTimeout(600);
      opts = await optionsOf(page, loc);
      list = await texts(opts);
    }
    // Pick the suggestion that matches; Enter only as a last resort.
    let want = pickOption(list, value);
    // "Lucknow, Uttar Pradesh, India" found nothing: search the city alone and pick the entry in the right state/country
    // (a bare "Lucknow" would otherwise take the first hit, Lucknow, Ontario).
    if (!want && value.includes(',')) {
      const [city, ...rest] = value.split(',').map((x) => x.trim());
      await loc.fill(city, { timeout: 5_000 });
      list = [];
      for (let i = 0; i < 6 && !list.length; i++) {
        await page.waitForTimeout(600);
        opts = await optionsOf(page, loc);
        list = await texts(opts);
      }
      want = list.find((o) => rest.length && rest.every((r) => o.toLowerCase().includes(r.toLowerCase())))
        ?? list.find((o) => rest.length && o.toLowerCase().includes(rest[rest.length - 1].toLowerCase()));
    }
    if (want) await opts.nth(list.indexOf(want)).click({ timeout: 5_000 });
    else await loc.press('Enter').catch(() => {});
    return;
  }
  await loc.fill(value, { timeout: 5_000 });
}

/** Visible validation errors after a submit attempt. */
export async function readFormErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll('[aria-invalid="true"], .error, .field-error, [class*="error-message"], [role="alert"], [data-automation-id="errorMessage"]'))
      .map((el) => (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim())
      .filter((t): t is string => !!t && t.length < 200);
    // Fields the browser itself refuses to submit (HTML required/pattern).
    const invalid = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid')).filter((el) => {
      // Each box of a pick-one-or-more group carries `required`; one ticked box satisfies the group.
      if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return true;
      let wrap: Element | null = el.parentElement;
      for (let i = 0; wrap && i < 3 && wrap.querySelectorAll('input[type="checkbox"]').length < 2; i++) wrap = wrap.parentElement;
      return !wrap || wrap.querySelectorAll('input[type="checkbox"]').length < 2 || !wrap.querySelector('input[type="checkbox"]:checked');
    }).map((el) => {
      const id = el.getAttribute('id');
      const label = (id && document.querySelector(`label[for="${id}"]`)?.textContent) || el.getAttribute('name') || 'a field';
      return `${label.replace(/\s+/g, ' ').replace(/\*/g, '').trim()} is required`;
    });
    return [...messages, ...invalid].slice(0, 10);
  });
}

/** Placeholder entries like "Select..." aren't real choices. */
export const realOptions = (options: string[]) => options.filter((o) => o.trim() && !/^(select|choose|please select|--)/i.test(o.trim()));

/** The image a text-captcha input belongs to (nearest captcha-looking <img>/<canvas>). */
export async function captchaImageFor(page: Page, field: FormField): Promise<Locator | null> {
  const handle = await (await locate(page, field)).elementHandle().catch(() => null);
  if (!handle) return null;
  const marker = await handle.evaluate((input) => {
    const looks = (el: Element) => /captcha/i.test(`${el.id} ${el.className} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('src') ?? ''}`);
    let box: Element | null = input.parentElement;
    for (let i = 0; box && i < 5; i++, box = box.parentElement) {
      const imgs = Array.from(box.querySelectorAll('img, canvas'));
      const img = imgs.find(looks) ?? (imgs.length === 1 ? imgs[0] : undefined);
      if (img) {
        img.setAttribute('data-jp-captcha', '1');
        return true;
      }
    }
    const any = Array.from(document.querySelectorAll('img, canvas')).find(looks);
    any?.setAttribute('data-jp-captcha', '1');
    return !!any;
  });
  return marker ? page.locator('[data-jp-captcha="1"]').first() : null;
}

/** A visible click-challenge (reCAPTCHA / hCaptcha) frame, if one is showing. */
export async function visibleClickChallenge(page: Page): Promise<Locator | null> {
  for (const sel of [
    'iframe[src*="recaptcha/api2/bframe"]',
    'iframe[src*="recaptcha/enterprise/bframe"]',
    'iframe[src*="hcaptcha"][title*="challenge" i]',
  ]) {
    const frames = page.locator(sel);
    for (let i = 0; i < (await frames.count()); i++) {
      const f = frames.nth(i);
      const box = await f.boundingBox().catch(() => null);
      if (box && box.width > 100 && box.height > 100 && (await f.isVisible().catch(() => false))) return f;
    }
  }
  return null;
}

/** An unticked "I'm not a robot" checkbox on the form. */
export async function untickedCheckbox(page: Page): Promise<Locator | null> {
  // Invisible reCAPTCHA keeps a small badge iframe on the page (size=invisible) — there is no box to tick,
  // and the site runs the check itself on Submit. Only a normal/compact widget needs the person.
  const anchor = page
    .locator('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha"][title*="checkbox" i]')
    .and(page.locator(':not([src*="size=invisible"])'))
    .first();
  if (!(await anchor.count()) || !(await anchor.isVisible().catch(() => false))) return null;
  const token = await page.locator('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]').first().inputValue().catch(() => '');
  return token ? null : anchor;
}


/** Everything a person could interact with on the page, and which of it the scanner didn't claim. For failure reports. */
export async function pageDiagnostic(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const txt = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const controls = Array.from(document.querySelectorAll('input, textarea, select, button, [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [role="switch"], [aria-haspopup], [contenteditable="true"]'))
      .filter(vis)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        popup: el.getAttribute('aria-haspopup'),
        auto: el.getAttribute('data-automation-id'),
        label: txt(el),
        invalid: el.getAttribute('aria-invalid') === 'true',
        claimed: el.hasAttribute('data-jp-field'),
      }));
    return {
      url: location.href,
      title: document.title,
      heading: txt(document.querySelector('h1, h2, [data-automation-id="pageHeader"]') ?? document.body),
      unclaimed: controls.filter((c) => !c.claimed && c.tag !== 'button').slice(0, 40),
      invalid: controls.filter((c) => c.invalid).slice(0, 20),
      buttons: controls.filter((c) => c.tag === 'button').map((c) => c.label).filter(Boolean).slice(0, 15),
      errors: Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], .error, [class*="error"]')).filter(vis).map(txt).filter(Boolean).slice(0, 10),
    };
  }).catch(() => ({}));
}
