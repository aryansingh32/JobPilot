import type { Frame, Locator, Page } from 'playwright';
import { categoryOption, governmentBook, govRuleFor, isLoginIdField, isOtpField, isSecretField } from './gov-forms.js';
import type { ProfileData } from '../shared/profile/index.js';
import { namesAnyOf, workedCompanies } from '../shared/profile/employers.js';
import { yearsOfExperience } from '../shared/profile/years.js';
import { authorizedIn, isCitizenOf } from '../shared/profile/gaps.js';
import { buildAnswerBank } from '../shared/profile/resume-analysis.js';
import { classifyIntent, gate, isDeclaration, payPeriod } from '../shared/profile/intent.js';
import { EMPTY_DEFAULTS, isOn, matchCustom, type AnswerDefaults } from '../shared/answers/defaults.js';

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
  /** For a default: which rule gave it (a built-in id or a custom rule's id). */
  rule?: string;
  /** Multi-page forms: which page it was on (field indexes repeat per page). */
  page?: number;
  /** What the page did with the value ("the site changed this to …"), shown in the review. */
  note?: string;
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
  // Where they live: what they said, else where they connect from (a first guess they can edit).
  const homeCode = /^[A-Za-z]{2}$/.test(p.country ?? '') ? p.country!.toUpperCase() : /^[A-Za-z]{2}$/.test(p.detectedCountry ?? '') && !p.country ? p.detectedCountry!.toUpperCase() : '';
  const country = p.country ? COUNTRY_NAME[p.country.toUpperCase()] ?? p.country : homeCode ? COUNTRY_NAME[homeCode] ?? '' : '';
  // "India" in the profile vs "IN" on the job; a country they said no to counts as no. Sponsorship follows the job's country.
  const authorized = authorizedIn(profile, job.country);

  const book: AnswerBook = {
    firstName: p.firstName || first || '',
    lastName: p.lastName || rest.join(' '),
    fullName: p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' '),
    email: p.email ?? '',
    phone: p.phone ?? '',
    // National number without the country code (forms with a separate code picker).
    todaysDate: new Date().toISOString().slice(0, 10),
    phoneDeviceType: 'Mobile',
    phoneCountryName: country,
    phoneExtension: '',
    phoneLocal: (p.phone ?? '').replace(/\D/g, '').slice(-10),
    city: p.city ?? '',
    state: p.state ?? '',
    country,
    homeCountryCode: homeCode,
    location: [p.city, p.state, country].filter(Boolean).join(', '),
    address: p.address ?? '',
    postalCode: p.postalCode ?? '',
    linkedin: p.linkedin ?? '',
    github: p.github ?? '',
    website: p.website || p.github || '',
    summary: p.summary ?? '',
    // Ready-made answers (prepared when the résumé changed) — so these open questions never wait on a model.
    ...(() => { const bank = { ...buildAnswerBank(profile), ...(profile.answerBank ?? {}) }; return { aboutYou: bank.aboutYou ?? '', strengths: bank.strengths ?? '', achievement: bank.achievement ?? '', careerGoal: bank.careerGoal ?? '' }; })(),
    currentCompany: w.currentEmployer || exp?.company || '',
    // Everywhere they say they have worked (joined with |): "worked for X before?" is Yes only for these.
    workedAt: workedCompanies(profile).join('|'),
    currentTitle: w.currentTitle || exp?.title || '',
    yearsExperience: (() => { const y = yearsOfExperience(profile); return y === null ? '' : String(y); })(),
    noticePeriod: w.noticePeriod ?? '',
    expectedSalary: w.expectedSalary ?? '',
    currentSalary: w.currentSalary ?? '',
    citizenHere: yesNo(isCitizenOf(p.nationality ?? profile.government?.nationality, job.country)),
    needsSponsorship: yesNo(authorized !== undefined ? !authorized : a.needsSponsorship),
    authorized: yesNo(authorized ?? (a.needsSponsorship === undefined ? undefined : !a.needsSponsorship)),
    school: edu?.school ?? '',
    degree: edu?.degree ?? '',
    field: edu?.field ?? '',
    graduationYear: edu?.end?.match(/\d{4}/)?.[0] ?? '',
    skills: (profile.skills ?? []).join(', '),
    workplace: (profile.preferences?.workplace ?? []).join(', '),
    nationality: profile.personal?.nationality ?? profile.government?.nationality ?? '',
    certifications: (profile.certifications ?? []).join(', '),
    preferredLocation: profile.preferences?.locations?.find((l) => !/remote/i.test(l)) ?? '',
    ...governmentBook(profile),
  };
  // Repeated sections ("School 2", experience[1]): the Nth entry of the profile, never entry 0 again.
  (profile.education ?? []).slice(0, 6).forEach((e, i) => {
    book[`school#${i}`] = e.school ?? '';
    book[`degree#${i}`] = e.degree ?? '';
    book[`field#${i}`] = e.field ?? '';
    book[`graduationYear#${i}`] = e.end?.match(/\d{4}/)?.[0] ?? '';
  });
  (profile.experience ?? []).slice(0, 6).forEach((e, i) => {
    book[`currentCompany#${i}`] = e.company ?? '';
    book[`currentTitle#${i}`] = e.title ?? '';
  });
  return book;
}

const COUNTRY_ALIAS: Record<string, string> = { usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US', uk: 'GB', 'u.k.': 'GB', britain: 'GB', 'great britain': 'GB', uae: 'AE', emirates: 'AE' };

/** The country a question names ("…reside in the United States?"), if it names exactly one. */
export function countryNamed(label: string): string | null {
  const l = ` ${label.toLowerCase().replace(/[(),?]/g, ' ')} `;
  const hits = new Set<string>();
  for (const [code, name] of Object.entries(COUNTRY_NAME)) if (l.includes(` ${name.toLowerCase()} `)) hits.add(code);
  for (const [alias, code] of Object.entries(COUNTRY_ALIAS)) if (l.includes(` ${alias} `)) hits.add(code);
  return hits.size === 1 ? [...hits][0] : null;
}

const YES_NO = (o: string[]) => o.length > 0 && o.length <= 4 && o.some((x) => /^yes\b/i.test(x.trim())) && o.some((x) => /^no\b/i.test(x.trim()));

/**
 * Where the person lives and what they are a citizen of, answered from the profile and the country the question names.
 * "Do you reside in the United States?" is No for someone in India — never left blank or guessed Yes.
 */
export function residenceAnswer(field: FormField, book: AnswerBook, nationality: string | undefined): string | null {
  const l = field.label.toLowerCase();
  const asksResidence = /\b(resid\w*|liv(e|ing)|located|based)\b/.test(l) && !/\b(relocat|willing|open to)\w*/.test(l);
  const asksCitizen = /\b(citizen(ship)?|national of|passport holder)\b/.test(l) && !/\bdual\b/.test(l);
  if (!asksResidence && !asksCitizen) return null;
  const named = countryNamed(field.label);
  if (YES_NO(field.options)) {
    if (!named) return null;
    if (asksCitizen && !asksResidence) {
      const c = isCitizenOf(nationality, named);
      return c === undefined ? null : c ? 'Yes' : 'No';
    }
    return book.homeCountryCode ? (book.homeCountryCode === named ? 'Yes' : 'No') : null;
  }
  // "Country of residence" as a pick-list or box.
  if (/\bcountr(y|ies)\b/.test(l) && !named && field.type !== 'checkbox') {
    if (asksResidence && book.country) return field.options.length ? pickOption(field.options, book.country) : book.country;
    if (asksCitizen && nationality) {
      const code = Object.keys(COUNTRY_NAME).find((c) => isCitizenOf(nationality, c) === true);
      const name = code ? COUNTRY_NAME[code] : null;
      return name ? (field.options.length ? pickOption(field.options, name) : name) : null;
    }
  }
  return null;
}

/** A phone box's country-code list ("+93", "+1-684"…): the code the person's own number starts with. */
export function dialCodeOption(options: string[], phone: string | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!phone?.trim().startsWith('+') || digits.length < 8) return null;
  const codes = options.map((o) => ({ o, code: (o.trim().match(/^\+(\d+)(?:-(\d+))?/) ?? []).slice(1).filter(Boolean).join('') })).filter((c) => c.code);
  const hit = codes.filter((c) => digits.startsWith(c.code)).sort((a, b) => b.code.length - a.code.length)[0];
  return hit?.o ?? null;
}

const SECTION_KEYS = new Set(['school', 'degree', 'field', 'graduationYear', 'currentCompany', 'currentTitle']);

// Order matters: the first rule whose pattern matches the label wins.
const RULES: Array<[RegExp, string]> = [
  [/\b(first|given)\s*name|\bfname\b/, 'firstName'],
  [/\b(last|family|sur)\s*name|\blname\b|\bsurname\b/, 'lastName'],
  [/\bpreferred\s*name\b/, 'firstName'],
  // "Name as per Aadhaar / 10th certificate / passport": the applicant's own full name (the father's and mother's are gov rules, matched earlier).
  [/\bname\b.{0,24}\b(as per|as in|as on|as given in|as mentioned in|according to)\b/, 'fullName'],
  [/\b(full|legal|your)\s*name\b|^name$|^(candidate|applicant|student)'?s?\s*name$|^name of (the )?(candidate|applicant)$/, 'fullName'],
  [/e-?mail/, 'email'],
  [/^(today'?s )?date$|\b(current|todays?|today's) date\b|\bdate (signed|of signature)\b|\bsignature date\b/, 'todaysDate'],
  // Workday's phone block: a device-type list ("Mobile") and a country-code list ("India (+91)") beside the number.
  [/\bphone\s*device\s*type\b|\bdevice\s*type\b|\b(phone|contact)\s*type\b/, 'phoneDeviceType'],
  [/\b(country|international)\s*(phone\s*)?(calling\s*)?code\b|\bphone\s*(country\s*)?code\b|\bdial(ing)?\s*code\b/, 'phoneCountryName'],
  [/\bphone\s*extension\b/, 'phoneExtension'],
  [/\b(phone|mobile|contact number|cell|telephone|whats ?app)\b/, 'phone'],
  [/linkedin/, 'linkedin'],
  [/github/, 'github'],
  [/\b(website|portfolio|personal site|blog|other url)\b/, 'website'],
  [/\b(tell (us|me)|talk) (a bit |something |more )?about (yourself|you)\b|\babout yourself\b|\bintroduce yourself\b|^about you$|\b(brief|short) (introduction|bio|profile)\b|\bprofessional (summary|profile)\b/, 'aboutYou'],
  [/\b(your |key |top )?(strengths?|strong points)\b|\bwhat makes you (a )?(good|great|strong|right) (fit|candidate)\b|\bwhy should we (hire|select|choose) you\b/, 'strengths'],
  [/\b(greatest|biggest|proudest|key|major|notable|top|most significant) (professional |career )?(achievement|accomplishment)s?\b/, 'achievement'],
  [/\bcareer (goals?|objectives?|aspirations?|plans?)\b|\bwhere do you see yourself\b|\bwhat are you looking for (in|from)\b/, 'careerGoal'],
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
  [/\b(zip|postal|pin)\s*code\b|^zip$|\bpostcode\b|\bzip\b(?! file)/, 'postalCode'],
  [/\b(street )?address\b/, 'address'],
  [/^city$|\bcity\b(?! you)/, 'city'],
  [/\b(state|province|region)\b/, 'state'],
  [/\bcountry\b/, 'country'],
  // Indian forms ask both: where you are now, and where you'd work.
  [/\bpreferred (job |work )?locations?\b|\blocation preference\b/, 'preferredLocation'],
  [/\blocation\b|\bwhere are you (based|located)\b|\bcurrently (based|located)\b/, 'location'],
  [/\b(school|university|college|institution)\b/, 'school'],
  [/\bdegree\b|\b(highest )?qualification\b|\b(highest )?(level of education|education level)\b/, 'degree'],
  [/\b(discipline|major|field of study|branch|specialis?ation)\b/, 'field'],
  [/\bnationality\b|\bcitizenship\b(?! status)/, 'nationality'],
  [/\bcertifications?\b/, 'certifications'],
  [/\bgraduat|\bpassing[- ]?out\b|\byear of passing\b|\bpass[- ]?out year\b/, 'graduationYear'],
  [/\b(summary|about (yourself|you))\b/, 'summary'],
];

/** Voluntary self-identification questions → pick the "decline" option, never guess. */
const EEO = /\b(gender|race|ethnic|hispanic|latino|veteran|disability|sexual orientation|pronoun|transgender)\b/;
// "I do not wish to answer" (Workday), "I don't wish to self-identify", "Decline to state"…
const DECLINE = /decline|prefer not|rather not|do(?:n'?t| not) (?:wish|want) to|not to (?:say|answer|disclose)|choose not/i;

const norm = (s: string) => s.toLowerCase().replace(/[*✱]/g, ' ').replace(/[^\p{L}\p{N}\s/'-]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The label names another person (referee, emergency contact, manager, spouse…): the applicant's own email/phone/links don't belong there. */
const THIRD_PARTY = /\b(references?|referees?|emergency|next of kin|spouse|husband|wife|parents?|guardian|recruiter|hiring manager|colleague|co-?worker|professional contact)\b|\b(manager|supervisor|mentor|hr|employer|principal|teacher|professor)(?:'?s)?\b.{0,24}\b(name|e-?mail|phone|mobile|number|contact|linkedin|website)\b|\b(name|e-?mail|phone|mobile|number|contact)\b.{0,24}\b(of|for)\b.{0,12}\b(your |the |a )?(previous |former |current |reporting |direct )?(manager|supervisor|mentor|employer|hr)\b/;
export const isThirdParty = (l: string): boolean => THIRD_PARTY.test(l);

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
  if (/cover letter|pronounc|high school|secondary school|\breferr(al|ed|er)\b/.test(l)) return null;
  // A long question that merely mentions "GitHub" or "location" is an open question,
  // not that profile field — only yes/no eligibility rules apply to long text.
  const long = l.split(' ').length > 14;
  const gov = long ? null : govRuleFor(l);
  if (gov) return gov;
  // "Emergency contact phone", "Manager's email", "Reference name": someone else's details, never the applicant's own.
  if (isThirdParty(l) && !/\bname of your (current|most recent|last) employer\b|\byour (current|most recent) employer\b/.test(l)) return null;
  for (const [re, key] of RULES) {
    // "Type of right-to-work document" asks which document, not whether they may work.
    if (key === 'authorized' && /\b(document|documents|proof|evidence|type of|which)\b/.test(l) && !/^(are|do|will|can)\b/.test(l)) continue;
    if (long && key !== 'needsSponsorship' && key !== 'authorized' && !(key === 'currentCompany' && /\b(current|most recent|last) employer\b/.test(l)) && !(key === 'yearsExperience' && /^(what|how much|how many)\b.{0,30}experience/.test(l))) continue;
    if (re.test(l)) {
      // "Years of experience with Python" asks about one tool, not the person's total years: never answer it with the total.
      if (key === 'yearsExperience' && classifyIntent(l) === 'years_technology') return null;
      return key;
    }
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

/**
 * "You must agree to the Candidate Privacy Notice", "I accept the Terms": agreeing to read a policy is the same
 * for everyone and nobody applies without it, so it is ticked, never asked. Anything that gives something up or
 * commits the person (arbitration, a waiver, an NDA, marketing or text messages, a certification they sign) is not.
 */
export function policyAcknowledgement(label: string): boolean {
  const l = norm(label);
  if (!/\b(privacy|terms|conditions|cookie|data protection|candidate notice|applicant notice|data processing|personal data|policy|policies)\b/.test(l)) return false;
  if (!/\b(agree|accept|acknowledg\w*|read|understand|consent|confirm|must|required)\b/.test(l)) return false;
  if (/\b(marketing|promotional|newsletter|sms|text messages?|whatsapp|phone calls?|contact me|keep me|talent (community|network|pool)|future (opportunities|roles|positions)|arbitration|waive\w*|non-?disclosure|nda|binding|background check|electronic signature|certify|certifies|attest|declare|declaration|under penalty)\b/.test(l)) return false;
  return !isDeclaration(label);
}

/**
 * Sponsorship asked as a status list ("Citizen / Permanent Resident / Visa Holder / Require Sponsorship"): only an
 * option the profile settles outright — needing sponsorship, a citizen of the job's country, or a "do not require" line.
 */
export function statusOption(options: string[], who: { needsSponsorship: boolean; citizen?: string }): string | null {
  const find = (re: RegExp) => options.find((o) => re.test(o.trim()));
  if (who.needsSponsorship) return find(/^(?!.*\b(do not|don't|not)\b).*\b(require|need)\b.*sponsor|^(?!.*\b(do not|don't|not)\b).*\bsponsorship (required|needed)\b/i) ?? null;
  const none = find(/\b(do not|don't|no)\b.{0,20}\b(require|need)\b|without (the need for )?(visa )?sponsorship|not require/i);
  if (none) return none;
  return who.citizen === 'Yes' ? find(/^(a |an )?(u\.?s\.? |national |native )?citizen\b(?!.*non)/i) ?? null : null;
}

/**
 * Yes/No questions that are the same for nearly everyone, answered without asking: never worked there before,
 * knows nobody there, fine with an office or hybrid week. Returns the matching option, or null (then it is asked).
 */
/**
 * "Please list any licenses you hold. If you have none, say 'None'": a list the profile doesn't have is "None".
 * Only licences (driving, trade, professional): certifications are in the profile and answered from it.
 */
export function defaultNoneRule(label: string, cfg: AnswerDefaults = EMPTY_DEFAULTS): { value: string; rule: string } | null {
  if (!isOn(cfg, 'no-licenses')) return null;
  const l = norm(label);
  if (!/\b(licen[sc]es?|licen[sc]ures?)\b/.test(l) || !/\b(list|provide|hold|held|have|any|currently)\b/.test(l)) return null;
  if (/\b(driv\w*|do you (have|hold) a)\b/.test(l) && !/\blist\b/.test(l)) return null;
  return { value: cfg.overrides['no-licenses'] || 'None', rule: 'no-licenses' };
}

export function defaultYesNoRule(
  label: string,
  options: string[],
  book: { currentCompany?: string; workplace?: string; workedAt?: string },
  cfg: AnswerDefaults = EMPTY_DEFAULTS,
): { value: string; rule: string } | null {
  const l = norm(label);
  const opt = (re: RegExp) => options.find((o) => re.test(o.trim()));
  // A text box takes the word itself; a list needs its own wording of it.
  const yes = options.length ? opt(/^(yes|y|true)\b/i) : 'Yes';
  const no = options.length ? opt(/^(no|n|false)\b/i) : 'No';
  if (!options.length && !/^(are|is|do|does|did|have|has|will|would|can|could)\b/.test(l)) return null;
  const cur = norm(book.currentCompany ?? '');
  // The admin's own wording for a rule's answer, matched to the nearest option.
  const say = (rule: string, fallback: string | null | undefined): { value: string; rule: string } | null => {
    const over = cfg.overrides[rule];
    const value = over ? (options.length ? pickOption(options, over) : over) : fallback;
    return value ? { value, rule } : null;
  };
  // "Are you at least 18?" — Yes (only the legal-age question; other ages are never answered).
  if (isOn(cfg, 'adult-18') && /\b(at least|over|older than|above|minimum)\b.{0,25}\b(18|eighteen)\b|\b(18|eighteen) (years? )?(of age|or older|years? old|and (over|older))\b/.test(l) && !/\b(under|younger|less than)\b/.test(l)) return say('adult-18', yes);
  // "Have you previously worked for X?" / "Are you currently an employee of X?" — No, unless X is where they work now.
  if (isOn(cfg, 'never-worked-here') && !/\b(know|related|anyone|someone|friends?|relatives?)\b/.test(l) && /\b(previously|formerly|ever|before|currently|now)\b.{0,40}\b(work(ed|ing)?|employ(ed|ee)|an employee|contractor|intern(ed)?)\b.{0,30}\b(for|at|with|of|by)\b|\bformer (employee|intern)\b|\bcurrent(ly)? (an )?employee\b|\b(previous|former|current|currently|ex)\b.{0,40}\b(employee|employed)\b|\bemployee of\b|\b(engaged|affiliated|associated|connected)\b.{0,90}\b(employee|contractor|any engagement)\b/.test(l)) {
    const employers = (book.workedAt ?? '').split('|').filter(Boolean);
    if (cur) employers.push(book.currentCompany ?? '');
    return namesAnyOf(label, employers) ? (yes ? { value: yes, rule: 'never-worked-here' } : null) : say('never-worked-here', no);
  }
  // "Do you know anyone who works at X?" — No (a referrer's name is never made up).
  if (isOn(cfg, 'knows-nobody') && (/\brelated to (anyone|any one|someone)\b/.test(l) || /\b(know|knows|acquaint\w*|friends?|relatives?|family members?)\b.{0,50}\b(work|employ|interview)/.test(l) || /\b(referred|referral)\b.{0,30}\b(by|from) (an? )?(current )?(employee|team member)/.test(l))) return say('knows-nobody', no);
  // Relocating / office / hybrid — Yes, unless they said they only want remote.
  if (isOn(cfg, 'relocate-office') && /\b(relocat\w*|hybrid|on-?site|in-?office|work from (our|the) \w+ office|(work|working) (from|in|at) (the |our )?(office|[a-z]+ office))\b/.test(l)) {
    const w = (book.workplace ?? '').toLowerCase();
    const onlyRemote = w && !/hybrid|on-?site|office|any/.test(w);
    return onlyRemote ? null : say('relocate-office', yes);
  }
  return null;
}

export function defaultYesNo(label: string, options: string[], book: { currentCompany?: string; workplace?: string; workedAt?: string }): string | null {
  return defaultYesNoRule(label, options, book)?.value ?? null;
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
  // Nothing generic on offer: any plain public source is true enough; never a person, event or school.
  const personal = /refer|recruit|employee|friend|event|fair|intern|universit|college|campus|agency|none|select|choose|--|alumni|social/i;
  return options.find((o) => o.trim() && !personal.test(o)) ?? null;
}

/** "2026-10-25" / "25/10/2026" / "10/2026" / "today" → zero-padded parts. Slash dates are day-first (this product's forms). */
export function parseDateParts(v: string, now = new Date()): { month: string; day: string; year: string } | null {
  const t = v.trim().toLowerCase();
  const pad = (n: string | number) => String(n).padStart(2, '0');
  if (t === 'today') return { month: pad(now.getMonth() + 1), day: pad(now.getDate()), year: String(now.getFullYear()) };
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: m[1], month: pad(m[2]), day: pad(m[3]) };
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return { day: pad(m[1]), month: pad(m[2]), year: m[3] };
  m = t.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (m) return { month: pad(m[1]), day: '', year: m[2] };
  m = t.match(/^(\d{4})$/);
  return m ? { year: m[1], month: '', day: '' } : null;
}

/** Which entry of a repeated section a field belongs to: `education[1]` / "School 2" / "Employer #3" → 1 / 1 / 2 (zero-based). */
export function sectionIndex(field: { label: string; name: string }): number {
  const byName = field.name.match(/(?:education|school|college|degree|experience|employment|employer|work|job|history|qualification)\w*\[(\d+)\]/i);
  if (byName) return Number(byName[1]);
  const l = field.label.replace(/[*✱]/g, '').trim();
  const ord: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
  const word = l.toLowerCase().match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\b/)?.[1];
  if (word && /school|college|university|degree|company|employer|job|position|education|experience/i.test(l)) return ord[word] - 1;
  const num = l.match(/\b(?:school|college|university|degree|company|employer|job|position|institution|organi[sz]ation|title)\b.*?(?:#|no\.?\s*|\()?\s*(\d)\)?\s*$/i)?.[1];
  return num ? Math.max(0, Number(num) - 1) : 0;
}

const NEGATION = /\b(no|not|non|never|none|without|neither|nor|don'?t|do not|cannot|can'?t|isn'?t|aren'?t|n'?t)\b/;
/** Spellings that mean the same list entry. */
const ALIASES: string[][] = [
  ['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america'],
  ['uk', 'u k', 'united kingdom', 'great britain', 'england'],
  ['uae', 'u a e', 'united arab emirates'],
  ['phd', 'ph d', 'doctorate', 'doctor of philosophy'],
  ['bachelors', "bachelor's", 'bachelor', 'undergraduate'],
  ['masters', "master's", 'master', 'postgraduate'],
];
const aliasesOf = (w: string): string[] => {
  const group = ALIASES.find((g) => g.some((a) => norm(a) === w));
  return group ? group.map(norm) : [w];
};
/** `needle` appears in `hay` as whole words ("us" is in "us", not in "australia"). */
const hasWords = (hay: string, needle: string) => needle.length > 0 && new RegExp(`(^|[\\s/(-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s/),-])`).test(hay);

/**
 * Best option text for a wanted value (exact → alias → yes/no → whole-word prefix → whole-word contains).
 * An option that negates what the wanted value does not ("Not a protected veteran" for "No", "Non-US" for "US")
 * is never picked by a loose match.
 */
export function pickOption(options: string[], wanted: string): string | null {
  if (!options.length || !wanted) return null;
  const w = norm(wanted);
  const opts = options.map((o) => ({ o, n: norm(o) })).filter((x) => x.n && !/^(select|choose|please select)/.test(x.n));
  const exact = opts.find((x) => x.n === w);
  if (exact) return exact.o;
  const forms = aliasesOf(w);
  const alias = forms.length > 1 ? opts.find((x) => forms.includes(x.n)) : null;
  if (alias) return alias.o;
  if (w === 'yes' || w === 'no') return opts.find((x) => x.n === w || x.n.startsWith(`${w} `))?.o ?? null;
  const wantsNeg = NEGATION.test(w);
  const ok = (x: { n: string }) => NEGATION.test(x.n) === wantsNeg;
  // Prefix/contains only when the option isn't a much longer, different thing
  // ("State University" must not pick "State University of New York - Albany").
  const close = (x: { n: string }) => x.n.length <= w.length + 15;
  for (const form of forms) {
    const hit = opts.find((x) => ok(x) && hasWords(x.n, form) && x.n.startsWith(form) && close(x))
      ?? opts.find((x) => ok(x) && ((hasWords(x.n, form) && close(x)) || (hasWords(form, x.n) && x.n.length >= 4)));
    if (hit) return hit.o;
  }
  return null;
}

/**
 * Decide an answer for every field. `recall` looks up remembered answers to
 * open questions. Returns what to fill, and the required fields left over.
 */
export async function planAnswers(
  fields: FormField[],
  book: AnswerBook,
  recall: (question: string) => Promise<string | null>,
  /** Keys chosen by meaning for fields no rule recognised (see shared/profile/intent.ts). */
  intents: Map<number, string> = new Map(),
  /** The admin's switches, wording and extra rules for answers given without asking. */
  defaults: AnswerDefaults = EMPTY_DEFAULTS,
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
    if (isOn(defaults, 'policy-ack') && (choice || field.type === 'checkbox') && policyAcknowledgement(field.label)) {
      const agree = field.options.length
        ? field.options.find((o) => /^(yes|y|i agree|agree|i accept|accept|acknowledge|i acknowledge|i have read|i understand)\b/i.test(o.trim())) ?? field.options.find((o) => /agree|accept|acknowledg/i.test(o))
        : 'Yes';
      if (agree) {
        answers.push({ field, key: 'policyAck', value: agree, source: 'default', rule: 'policy-ack' });
        continue;
      }
    }
    if (isOn(defaults, 'eeo-decline') && choice && EEO.test(norm(field.label)) && !(key && book[key])) {
      const decline = field.options.find((o) => DECLINE.test(o));
      if (decline) {
        answers.push({ field, key: 'eeo', value: decline, source: 'default', rule: 'eeo-decline' });
        continue;
      }
    }

    // A country-code list beside a phone box: the code of their own number.
    if (field.tag === 'select' && field.options.length > 8 && field.options.filter((o) => /^\+\d/.test(o.trim())).length >= field.options.length * 0.8) {
      const code = dialCodeOption(field.options, book.phone);
      if (code) {
        answers.push({ field, key: 'phoneCode', value: code, source: 'profile' });
        continue;
      }
    }
    // Where they live / what they are a citizen of, against the country the question names.
    if (!field.options.length || YES_NO(field.options) || field.tag === 'select') {
      const res = residenceAnswer(field, book, book.nationality);
      if (res) {
        answers.push({ field, key: 'residence', value: res, source: 'profile' });
        continue;
      }
    }
    // A later entry of a repeated section takes that entry of the profile, or nothing — never the first one again.
    const nth = key && SECTION_KEYS.has(key) ? sectionIndex(field) : 0;
    let value = key ? (nth > 0 ? book[`${key}#${nth}`] ?? '' : book[key] ?? '') : '';
    // A typeahead "Location (City)" suggests places worldwide: give it the state and country too.
    if (key === 'city' && field.type === 'combobox' && book.state) value = [book.city, book.state, book.country].filter(Boolean).join(', ');
    // The profile's pay figures are yearly: an hourly or monthly box is asked, never given a yearly number.
    if (value && (key === 'expectedSalary' || key === 'currentSalary') && ['hour', 'month'].includes(payPeriod(field.label) ?? '')) value = '';
    let source: AnswerSource = 'profile';
    let rule: string | undefined;
    if (!value && field.label) {
      value = (await recall(field.label)) ?? '';
      source = 'memory';
    }
    // Experience asked as ranges ("<1 Yrs", "1-3 Yrs"…): the range the profile's years fall in.
    if (value && choice && key === 'yearsExperience' && Number.isFinite(Number(value))) {
      value = rangeOption(field.options, Number(value)) ?? value;
    }
    // Same answer for nearly everyone (never worked there, knows nobody there, fine with an office) — see defaultYesNo.
    // (A typeahead's options are only readable once it is open: it is answered in words and matched to its list on fill.)
    if (!value && field.label && (choice ? field.options.length > 0 : field.type === 'text' || field.tag === 'textarea' || field.type === 'combobox')) {
      const hit = defaultYesNoRule(field.label, field.options, book, defaults) ?? (!choice ? defaultNoneRule(field.label, defaults) : null);
      value = hit?.value ?? '';
      if (value) { source = 'default'; rule = hit!.rule; }
    }
    // A rule the admin wrote: same standing as a built-in default, and the provenance gate below still applies.
    if (!value && field.label && (choice ? field.options.length > 0 : field.type === 'text' || field.tag === 'textarea' || field.type === 'combobox')) {
      const custom = matchCustom(defaults, norm(field.label));
      if (custom) {
        value = choice ? pickOption(field.options, custom.answer) ?? '' : custom.answer;
        if (value) { source = 'default'; rule = custom.id; }
      }
    }
    // "How did you hear about us?" — never in a profile; a generic true source, not a made-up referrer.
    if (!value && isOn(defaults, 'how-did-you-hear') && (choice || field.type === 'text' || field.type === 'combobox') && /\b(how|where)( or (how|where))?\s+(did|do|would) you (first |initially |originally )?(hear|find|learn|come (to know|across)|discover|get to know)\b|source of (application|referral)|how were you referred/.test(norm(field.label))) {
      const wanted = defaults.overrides['how-did-you-hear'];
      value = (choice ? (wanted ? pickOption(field.options, wanted) : null) ?? sourceOption(field.options) : wanted ?? 'Online job board') ?? '';
      if (value) { source = 'default'; rule = 'how-did-you-hear'; }
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
    // Pay asked as bands ("100,000 - 120,000"): the band the figure falls in.
    if (value && choice && (key === 'expectedSalary' || key === 'currentSalary')) {
      const n = Number(toAmount(value));
      if (Number.isFinite(n) && n > 0) value = rangeOption(field.options, n) ?? value;
    }
    if (value && choice) value = (key === 'category' ? categoryOption(field.options, value) : null) ?? pickOption(field.options, value) ?? '';
    // Work status asked as a list rather than Yes/No: the entry the profile settles (never a guess between visa types).
    if (!value && choice && source === 'profile' && (key === 'needsSponsorship' || key === 'authorized') && book[key]) {
      const needs = key === 'needsSponsorship' ? book[key] === 'Yes' : book[key] === 'No';
      value = statusOption(field.options, { needsSponsorship: needs, citizen: book.citizenHere }) ?? '';
    }
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
    if (value) {
      // The provenance gate: a sensitive question (work authorisation, EEO, salary…) is never answered by a blanket default.
      const verdict = gate(classifyIntent(field.label, { tag: field.tag }), source, key ?? undefined);
      if (verdict.ok) answers.push({ field, key: key ?? 'memory', value, source, ...(rule && source === 'default' ? { rule } : {}) });
      else if (field.required) missing.push(field);
    }
    // Sign-in boxes are rarely marked required: on a page with a password box the ID is needed too.
    else if (field.required || (signIn && (field.type === 'password' || isLoginIdField(field.label)))) missing.push(field);
  }
  return { answers, missing };
}

// ─── Browser side ────────────────────────────────────────────

/** The frame whose form was last scanned on a page, when the application lives in an iframe (Greenhouse embed, Jobvite, iCIMS…). */
const formFrames = new WeakMap<Page, Frame>();
export const formSurface = (page: Page): Page | Frame => surface(page);
const surface = (page: Page): Page | Frame => {
  const f = formFrames.get(page);
  return f && !f.isDetached() ? f : page;
};
/** Frames that never hold an application: captcha / ads / analytics widgets. */
const WIDGET_FRAME = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|doubleclick|googletagmanager|youtube|facebook\.com\/tr|stripe\.com\/(v3|elements)|linkedin\.com\/(px|li)|about:blank$/i;
const meaningful = (fields: FormField[]) => fields.filter((f) => f.type !== 'captcha').length;

/** Tag and describe every fillable field (radio groups collapse into one). Looks inside an iframe when that holds the form. */
export async function scanForm(page: Page, scope?: string): Promise<FormField[]> {
  const main = await scanSurface(page, scope);
  // A page with next to no fields of its own whose iframe holds the form: work inside that frame.
  if (meaningful(main) < 3 && !scope) {
    let best: { frame: Frame; fields: FormField[] } | null = null;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached() || WIDGET_FRAME.test(frame.url())) continue;
      const fields = await scanSurface(frame).catch(() => [] as FormField[]);
      if (meaningful(fields) > meaningful(main) && (!best || meaningful(fields) > meaningful(best.fields))) best = { frame, fields };
    }
    if (best) { formFrames.set(page, best.frame); return best.fields; }
  }
  formFrames.delete(page);
  return main;
}

async function scanSurface(page: Page | Frame, scope?: string): Promise<FormField[]> {
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
      || !!el.closest('.mandatoryField, .cxGroupMandatoryField')
      // Sites that enforce it in script and say so in words ("you must agree to our Privacy Notice").
      || /\b(must|required to|need to|have to)\b.{0,40}\b(agree|accept|acknowledge)|before (submitting|applying|continuing).{0,60}\b(agree|accept)/i.test(label);

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
    // Yes/No (or any few-choice) toggles built from buttons — Ashby and others — are a pick-one question like radios.
    const toggled = new Set<Element>();
    root.querySelectorAll('[class*="yesno" i], [role="group"], [role="radiogroup"]').forEach((group) => {
      if (toggled.has(group) || group.closest('nav')) return;
      const btns = Array.from(group.querySelectorAll('button[aria-pressed], [role="button"][aria-pressed], [role="radio"]:not(input)')).filter((b) => visible(b) && clean(textOf(b)));
      if (btns.length < 2 || btns.length > 6 || btns.some((b) => b.closest('[data-jp-field]'))) return;
      toggled.add(group);
      const label = labelFor(btns[0] as HTMLElement);
      const entry = group.closest('[class*="fieldEntry"], [data-field-path]');
      const pressed = btns.find((b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true');
      btns.forEach((b, i) => { b.setAttribute('data-jp-field', String(idx)); b.setAttribute('data-jp-opt', String(i)); });
      out.push({
        idx: idx++, tag: 'input', type: 'radio', label, name: group.getAttribute('data-field-path') || entry?.getAttribute('data-field-path') || '',
        required: /[*✱]/.test(label) || !!entry?.querySelector('[class*="required" i]'),
        options: btns.map((b) => clean(textOf(b))), value: pressed ? clean(textOf(pressed)) : '', selector: null,
      });
    });
    // Split date widgets (Workday: month / day / year boxes) are one question, not three text boxes.
    const dateGroups = new Map<Element, { month?: HTMLInputElement; day?: HTMLInputElement; year?: HTMLInputElement }>();
    root.querySelectorAll('input[data-automation-id^="dateSection"]').forEach((node) => {
      const el = node as HTMLInputElement;
      if (el.disabled || !visible(el)) return;
      const part = /Month/i.test(el.getAttribute('data-automation-id') ?? '') ? 'month' : /Day/i.test(el.getAttribute('data-automation-id') ?? '') ? 'day' : 'year';
      const wrap = el.closest('[data-automation-id^="formField"], [data-automation-id="dateInputWrapper"]') ?? el.parentElement?.parentElement ?? el.parentElement;
      if (!wrap) return;
      const g = dateGroups.get(wrap) ?? {};
      g[part] = el;
      dateGroups.set(wrap, g);
    });
    dateGroups.forEach((g, wrap) => {
      const first = (g.month ?? g.day ?? g.year)!;
      const label = clean(wrap.querySelector('label, legend')?.textContent) || labelFor(first);
      // History panels name their own date boxes (…--startDate-dateSection…): the label says which one.
      const named = first.id.match(/(start|end|first|last)\w*date|(first|last)year/i)?.[0];
      const idx0 = idx++;
      out.push({
        idx: idx0, tag: 'input', type: 'datesplit', label: label && !/^(mm|dd|yyyy|month|day|year)$/i.test(label) ? label : named ?? 'Date',
        name: first.id, required: isRequired(first, label) || !!wrap.querySelector('[aria-required="true"]'),
        options: [g.month ? 'M' : '', g.day ? 'D' : '', g.year ? 'Y' : ''].filter(Boolean),
        value: [g.month?.value, g.day?.value, g.year?.value].filter(Boolean).join('/'), selector: null,
      });
      for (const [part, el] of Object.entries(g)) { el.setAttribute('data-jp-field', String(idx0)); el.setAttribute('data-jp-part', part); }
    });
    root.querySelectorAll('input, textarea, select, [aria-haspopup="listbox"]:not(input), [role="combobox"]:not(input):not(select)').forEach((node) => {
      if ((node as HTMLElement).hasAttribute('data-jp-part')) return;
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
      // Workday's searchable prompts are filled by the Workday pass (their chips are the answer, not this box).
      if (el.getAttribute('data-automation-id') === 'searchBox' || el.closest('[data-automation-id="multiselectInputContainer"]')) return;
      // Upload widgets mirror the chosen file's name in a read-only text box.
      if (/file.?name/i.test(el.getAttribute('name') ?? '') || /\breadonly\b/.test(el.className)) return;
      // Widget internals: react-select's hidden "required" proxy, tabindex=-1 dummies.
      if (type !== 'file' && (el.getAttribute('aria-hidden') === 'true' || (el.tabIndex === -1 && getComputedStyle(el).opacity === '0'))) return;
      if (type !== 'file' && type !== 'radio' && !visible(el)) return;
      // Honeypots: bots fill them, people never see them (Workday "beecatcher", off-screen "website"/"url" traps).
      if (type !== 'file') {
        const trap = `${el.getAttribute('data-automation-id') ?? ''} ${el.name} ${el.id} ${el.className}`;
        const r = el.getBoundingClientRect();
        if (/beecatcher|honey-?pot|\bhp[-_]|bot-?field|nobots?\b/i.test(trap) || r.left + window.scrollX < -500 || r.top + window.scrollY < -500) return;
      }

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
  const root = surface(page);
  if (field.selector) {
    const byStable = root.locator(field.selector).first();
    if (await byStable.count()) return byStable;
  }
  return root.locator(`[data-jp-field="${field.idx}"]`).first();
};

/** The options belonging to this dropdown (its listbox), never other widgets' hidden lists. */
async function optionsOf(page: Page, input: Locator) {
  const owns = (await input.getAttribute('aria-controls').catch(() => null)) ?? (await input.getAttribute('aria-owns').catch(() => null));
  if (owns) {
    const scoped = surface(page).locator(`[id="${owns}"] [role="option"]`);
    if (await scoped.count()) return scoped;
  }
  return surface(page).locator('[role="option"]:visible');
}

const texts = async (opts: Locator) =>
  (await opts.allInnerTexts().catch(() => [] as string[])).map((o) => o.replace(/\s+/g, ' ').trim());

/** Scroll a virtualised listbox top to bottom, collecting every option it renders along the way. */
async function collectScrolling(page: Page, input: Locator): Promise<string[]> {
  const seen = new Set<string>();
  const handle = await (await optionsOf(page, input)).first().elementHandle({ timeout: 500 }).catch(() => null);
  if (!handle) return [];
  // The scrollable ancestor of the first option.
  const box = await handle.evaluateHandle((el) => {
    let n: HTMLElement | null = el.parentElement;
    while (n && n.scrollHeight <= n.clientHeight + 4) n = n.parentElement;
    return n;
  }).catch(() => null);
  const scroller = box?.asElement();
  if (!scroller) return [];
  for (let i = 0; i < 60; i++) {
    for (const t of await texts(await optionsOf(page, input))) seen.add(t);
    const more = await scroller.evaluate((n) => {
      const before = n.scrollTop;
      n.scrollTop = before + Math.max(80, n.clientHeight - 20);
      return n.scrollTop > before;
    }).catch(() => false);
    if (!more) break;
    await page.waitForTimeout(60);
  }
  return [...seen];
}

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
  // Virtualised lists (Workday countries / schools) render a window of options: scroll through to read them all.
  if (options.length) options = [...new Set([...options, ...(await collectScrolling(page, loc).catch(() => [] as string[]))])];
  await page.keyboard.press('Escape').catch(() => {});
  // Long lists (country codes, nationalities) run past 200: a low cap hides the answer (India sorts after 50).
  return [...new Set(options.filter(Boolean))].slice(0, 500);
}

/** Text a dropdown / typeahead currently shows as chosen (its single-value node, button label, or input value). */
async function shownValue(loc: Locator): Promise<{ text: string; open: boolean; typed: string }> {
  return loc.evaluate((el) => {
    const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
    const input = el as HTMLInputElement;
    const typed = 'value' in input ? clean(input.value) : '';
    const open = el.getAttribute('aria-expanded') === 'true';
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName)) return { text: clean(el.textContent), open, typed: '' };
    let n: Element | null = el;
    for (let i = 0; n && i < 5; i++, n = n.parentElement) {
      const chosen = Array.from(n.querySelectorAll('[class*="singleValue" i], [class*="single-value" i], [class*="selected-value" i], [class*="multiValue" i], [class*="selection" i]'))
        .map((c) => clean(c.textContent)).filter(Boolean);
      if (chosen.length) return { text: chosen.join(' | '), open, typed };
    }
    return { text: typed, open, typed };
  }).catch(() => ({ text: '', open: false, typed: '' }));
}

/** Did the dropdown keep `want`? Closed, and showing it (or an emptied search box with something chosen). */
async function committed(loc: Locator, want: string): Promise<boolean> {
  const n = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const { text, open } = await shownValue(loc);
  if (open) return false;
  const shown = n(text);
  const w = n(want);
  return !!shown && !/^(select|choose|please select)/.test(shown) && (shown.includes(w) || w.includes(shown));
}

/** Clear text typed into a search box that never became a selection. */
async function clearTyped(page: Page, loc: Locator): Promise<void> {
  if (!['INPUT', 'TEXTAREA'].includes(await loc.evaluate((e) => e.tagName).catch(() => 'BUTTON'))) return;
  await loc.fill('', { timeout: 2_000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Choose an option and make sure it stuck. react-select and friends commit on `mousedown`, so a plain click is
 * not always enough: click → synthesised mousedown/up/click → keyboard, checking the shown value after each.
 */
async function commitOption(page: Page, trigger: Locator, option: Locator, want: string): Promise<boolean> {
  await option.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(150);
  if (await committed(trigger, want)) return true;
  await option.evaluate((el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }).catch(() => {});
  await page.waitForTimeout(150);
  if (await committed(trigger, want)) return true;
  // Keyboard: the option is highlighted by hovering it, then Enter.
  await option.hover({ timeout: 2_000 }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(150);
  return committed(trigger, want);
}

/** Walk a long listbox with ArrowDown, reading the highlighted option, until one matches. */
async function walkToOption(page: Page, trigger: Locator, value: string): Promise<string | null> {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press('ArrowDown').catch(() => {});
    const current = await trigger.evaluate((el) => {
      const doc = el.ownerDocument;
      const active = doc.activeElement;
      const id = active?.getAttribute('aria-activedescendant') || el.getAttribute('aria-activedescendant');
      const node = (id && doc.getElementById(id)) || doc.querySelector('[role="option"][aria-selected="true"], [role="option"][data-highlighted], [role="option"].selected, [role="option"][class*="focused" i]');
      return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
    if (!current || seen.has(current)) return null;
    seen.add(current);
    if (pickOption([current], value)) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(150);
      return current;
    }
  }
  return null;
}

/** Put one answer into its field. `filePath` is used for file inputs. */
export async function fillField(page: Page, answer: { field: FormField; value: string }, filePath?: string): Promise<void> {
  const { field, value } = answer;
  if (field.type === 'radio') {
    const i = field.options.indexOf(value);
    if (i < 0) throw new Error(`No option "${value}" for "${field.label}"`);
    const target = surface(page).locator(`[data-jp-field="${field.idx}"][data-jp-opt="${i}"]`).first();
    // A toggle built from buttons is clicked, a real radio is checked.
    if ((await target.evaluate((e) => e.tagName).catch(() => 'INPUT')) !== 'INPUT') await target.click({ timeout: 5_000 });
    else await target.check({ force: true, timeout: 5_000 });
    return;
  }
  if (field.type === 'datesplit') {
    const d = parseDateParts(value);
    if (!d) throw new Error(`"${value}" is not a date`);
    for (const [part, text] of [['month', d.month], ['day', d.day], ['year', d.year]] as const) {
      const box = surface(page).locator(`[data-jp-field="${field.idx}"][data-jp-part="${part}"]`).first();
      if (!(await box.count()) || !text) continue;
      await box.fill(text, { timeout: 5_000 });
      await box.press('Tab').catch(() => {});
    }
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
    let opts = surface(page).locator('[role="option"]:visible');
    let list = await texts(opts);
    let want = pickOption(list, value);
    // Long or virtualised lists only render some options: type to narrow them down.
    if (!want) {
      await page.keyboard.type(value, { delay: 30 }).catch(() => {});
      await page.waitForTimeout(500);
      opts = surface(page).locator('[role="option"]:visible');
      list = await texts(opts);
      want = pickOption(list, value);
    }
    if (want) {
      if (await commitOption(page, loc, opts.nth(list.indexOf(want)), want)) return;
    } else {
      // Still nothing rendered that matches: walk the list with the arrow keys (virtualised lists render a window).
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (await walkToOption(page, loc, value)) { if (await committed(loc, value)) return; }
    }
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(want ? `"${value}" would not stay selected for "${field.label}"` : `No option "${value}" for "${field.label}"`);
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
        ?? list.find((o) => rest.length && o.toLowerCase().includes(rest[rest.length - 1].toLowerCase()))
        ?? null;
    }
    if (want) {
      if (await commitOption(page, loc, opts.nth(list.indexOf(want)), want)) return;
      await clearTyped(page, loc);
      throw new Error(`"${want}" would not stay selected for "${field.label}"`);
    }
    await loc.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
    if (!(await committed(loc, value))) {
      await clearTyped(page, loc);
      throw new Error(`No option matching "${value}" for "${field.label}"`);
    }
    return;
  }
  // Lever's "Current location": a text box that only counts once a suggestion from its dropdown is chosen.
  if (await loc.evaluate((e) => (e as HTMLInputElement).name === 'location' || /location-input/.test(e.className)).catch(() => false)) {
    await loc.click({ timeout: 5_000 });
    await loc.fill('', { timeout: 5_000 }).catch(() => {});
    await loc.pressSequentially(value.split(',')[0].trim(), { delay: 60 });
    const hits = surface(page).locator('.dropdown-results .dropdown-location, .dropdown-results [role="option"], .dropdown-container .dropdown-location');
    await hits.first().waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
    const texts = await hits.allInnerTexts().catch(() => [] as string[]);
    const region = value.split(',').slice(1).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const at = Math.max(0, texts.findIndex((t) => region.some((r) => t.toLowerCase().includes(r))));
    if (texts.length) await hits.nth(at).click({ timeout: 5_000 });
    else await loc.fill(value, { timeout: 5_000 });
    return;
  }
  await loc.fill(value, { timeout: 5_000 });
}

/** Labels of required fields the browser still counts as empty (react-select pickers that never took their choice…). */
export async function unsetRequiredLabels(page: Page): Promise<string[]> {
  return surface(page).evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('input:invalid, select:invalid, textarea:invalid').forEach((el) => {
      if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(el.type)) return;
      const id = el.getAttribute('id');
      let label = (id && document.querySelector(`label[for="${id}"]`)?.textContent) || el.getAttribute('aria-label') || '';
      for (let w: Element | null = el.parentElement, i = 0; !label && w && i < 6; i++, w = w.parentElement) label = w.querySelector('label')?.textContent ?? '';
      const t = label.replace(/\s+/g, ' ').replace(/\*/g, '').trim();
      if (t) out.push(t);
    });
    return out;
  }).catch(() => [] as string[]);
}

/** Visible validation errors after a submit attempt. */
export async function readFormErrors(page: Page): Promise<string[]> {
  return surface(page).evaluate(() => {
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
      let label = (id && document.querySelector(`label[for="${id}"]`)?.textContent) || el.getAttribute('aria-label') || el.getAttribute('name') || '';
      // react-select keeps its value in a nameless hidden input: the nearest label above it names the field.
      for (let w: Element | null = el.parentElement, i = 0; !label && w && i < 6; i++, w = w.parentElement) label = w.querySelector('label')?.textContent ?? '';
      return `${(label || 'a field').replace(/\s+/g, ' ').replace(/\*/g, '').trim()} is required`;
    });
    // Lever's "Couldn't auto-read resume" (its parser failing) is a notice, not a rejection of the form.
    const parserNotice = messages.some((m) => /couldn'?t auto-?read/i.test(m));
    // A 100 MB cap is never what stops a one-page résumé: that text is the parser notice's second line.
    const real = messages.filter((m) => !(parserNotice && /auto-?read/i.test(m)) && !/exceeds the maximum upload size of 100\s*MB/i.test(m));
    return [...real, ...invalid].slice(0, 10);
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
  return surface(page).evaluate(() => {
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

// ─── After a fill: did the page keep it? ─────────────────────

export type Landed = { state: 'ok' | 'reformatted' | 'truncated' | 'rejected'; actual: string };

/** What a text box / select actually holds now, compared with what was typed (masks reformat; limits truncate; scripts reject). */
export async function verifyFilled(page: Page, field: FormField, wanted: string): Promise<Landed | null> {
  if (['file', 'radio', 'checkbox', 'captcha'].includes(field.type) || field.type === 'combobox') return null;
  const loc = await locate(page, field);
  const actual = await loc.evaluate((el) => {
    const e = el as HTMLInputElement | HTMLSelectElement;
    return e.tagName === 'SELECT' ? (e as HTMLSelectElement).selectedOptions[0]?.text ?? '' : (e.value ?? '');
  }).catch(() => null);
  if (actual === null) return null;
  const flat = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const a = actual.trim();
  if (a === wanted.trim() || flat(a) === flat(wanted)) return { state: a === wanted.trim() ? 'ok' : 'reformatted', actual: a };
  if (!flat(a)) return { state: 'rejected', actual: a };
  if (flat(wanted).startsWith(flat(a))) return { state: 'truncated', actual: a };
  // A phone / date mask that re-spaced or re-ordered the same digits is the same value.
  if (/^\d+$/.test(flat(wanted)) && flat(a) === flat(wanted)) return { state: 'reformatted', actual: a };
  return { state: 'reformatted', actual: a };
}

/** Indexes of fields the page itself currently marks invalid (aria-invalid / browser validation / error row nearby). */
export async function invalidFieldIdx(page: Page): Promise<number[]> {
  return surface(page).evaluate(() => {
    const out = new Set<number>();
    document.querySelectorAll('[data-jp-field]').forEach((el) => {
      const idx = Number(el.getAttribute('data-jp-field'));
      const bad = el.getAttribute('aria-invalid') === 'true' || (el as HTMLInputElement).matches?.(':invalid')
        || !!el.closest('[class*="error" i], [class*="invalid" i], [data-automation-id*="error" i]')
        || !!el.closest('[data-automation-id^="formField"]')?.querySelector('[data-automation-id*="error" i], [role="alert"]');
      if (bad && Number.isFinite(idx)) out.add(idx);
    });
    return [...out];
  }).catch(() => [] as number[]);
}
