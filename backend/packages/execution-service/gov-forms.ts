import type { ProfileData } from '../shared/profile/index.js';

// ============================================================
// GOVERNMENT FORMS — the deterministic (zero-token) layer.
// Recruitment portals ask the same things in the same words: parents' names,
// category, date of birth as DD/MM/YYYY, class X / XII marks, a passport photo
// and signature within a stated file size. All of it is answered from the
// profile by rule; the model is never needed for these.
// ============================================================

export type Government = NonNullable<ProfileData['government']>;

const dmy = (iso?: string) => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? '');
};

/** Education entry by level: class X (matric), class XII, graduation. */
function level(profile: ProfileData, re: RegExp) {
  return (profile.education ?? []).find((e) => re.test(`${e.degree ?? ''} ${e.field ?? ''}`));
}
const percent = (g?: string) => g?.match(/\d+(?:\.\d+)?/)?.[0] ?? '';
const year = (s?: string) => s?.match(/\d{4}/)?.[0] ?? '';

/** Keys the government rules point at. Empty string = not known (the user is asked once, then it's saved). */
export function governmentBook(profile: ProfileData): Record<string, string> {
  const g: Government = profile.government ?? {};
  const tenth = level(profile, /\b(10th|x|matric\w*|secondary|ssc|high school)\b/i);
  const twelfth = level(profile, /\b(12th|xii|intermediate|higher secondary|hsc|senior secondary)\b/i);
  const bool = (v?: boolean) => (v === undefined ? '' : v ? 'Yes' : 'No');
  return {
    fatherName: g.fatherName ?? '',
    motherName: g.motherName ?? '',
    dob: dmy(g.dateOfBirth),
    dobIso: g.dateOfBirth ?? '',
    gender: g.gender ?? '',
    category: g.category ?? '',
    nationality: g.nationality ?? profile.personal?.nationality ?? '',
    maritalStatus: g.maritalStatus ?? '',
    domicile: g.domicileState ?? '',
    pwd: bool(g.pwd),
    exServiceman: bool(g.exServiceman),
    tenthPercent: percent(tenth?.grade),
    tenthYear: year(tenth?.end),
    tenthBoard: tenth?.school ?? '',
    twelfthPercent: percent(twelfth?.grade),
    twelfthYear: year(twelfth?.end),
    twelfthBoard: twelfth?.school ?? '',
    declaration: 'Yes',
    gradPercent: percent(profile.education?.find((e) => e !== tenth && e !== twelfth)?.grade),
  };
}

// Order matters; tested against the normalised label.
export const GOV_RULES: Array<[RegExp, string]> = [
  // "I declare that the information given is true" — shown in the review before anything is submitted.
  [/\b(declare|certify|undertake)\b.*\b(true|correct|genuine)\b|\bdeclaration\b/, 'declaration'],
  [/\bfather'?s?\b.*\bname\b|\bname of (the )?father\b|\bfather\b$/, 'fatherName'],
  [/\bmother'?s?\b.*\bname\b|\bname of (the )?mother\b|\bmother\b$/, 'motherName'],
  [/\bdate of birth\b|\bdob\b|\bbirth date\b/, 'dob'],
  [/\b(gender|sex)\b/, 'gender'],
  [/\b(category|caste|community|reservation)\b/, 'category'],
  [/\bnationality\b|\bcountry of nationality\b/, 'nationality'],
  [/\bmarital status\b/, 'maritalStatus'],
  [/\bdomicile\b|\bstate of domicile\b|\bhome state\b/, 'domicile'],
  [/\b(pwd|pwbd|person with (a )?disabilit\w*|differently abled|physically handicapped)\b/, 'pwd'],
  [/\bex-?serviceman?\b|\bex-?servicemen\b/, 'exServiceman'],
  [/\b(10th|x|matric\w*|secondary)\b.*\b(percent\w*|marks|%)|\b(percent\w*|marks)\b.*\b(10th|matric\w*)/, 'tenthPercent'],
  [/\b(10th|matric\w*|secondary)\b.*\b(year|passing)|\byear of passing\b.*\b(10th|matric)/, 'tenthYear'],
  [/\b(10th|matric\w*|secondary)\b.*\bboard\b/, 'tenthBoard'],
  [/\b(12th|xii|intermediate|higher secondary)\b.*\b(percent\w*|marks|%)/, 'twelfthPercent'],
  [/\b(12th|xii|intermediate|higher secondary)\b.*\b(year|passing)/, 'twelfthYear'],
  [/\b(12th|xii|intermediate|higher secondary)\b.*\bboard\b/, 'twelfthBoard'],
];

export function govRuleFor(label: string): string | null {
  for (const [re, key] of GOV_RULES) if (re.test(label)) return key;
  return null;
}

/** Common spellings of reservation categories, so "OBC-NCL" finds the site's "Other Backward Classes (NCL)". */
const CATEGORY_ALIASES: Record<string, string[]> = {
  general: ['general', 'gen', 'ur', 'unreserved', 'open'],
  obc: ['obc', 'obc-ncl', 'obc ncl', 'other backward', 'bc'],
  ews: ['ews', 'economically weaker'],
  sc: ['sc', 'scheduled caste'],
  st: ['st', 'scheduled tribe'],
};
export function categoryOption(options: string[], wanted: string): string | null {
  const w = wanted.toLowerCase().replace(/[^a-z ]/g, ' ').trim();
  const group = Object.values(CATEGORY_ALIASES).find((g) => g.some((a) => a === w || w.startsWith(`${a} `)));
  if (!group) return null;
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return (
    options.find((o) => group.some((a) => clean(o) === a)) ??
    options.find((o) => group.some((a) => (a.length > 3 ? clean(o).includes(a) : clean(o).startsWith(`${a} `)))) ??
    null
  );
}

// ─── What a field is, beyond its profile key ───────────────────

/** A code the portal just sent the user: asked for, used once, never remembered. */
export const isOtpField = (label: string) => /\b(otp|one[- ]time (password|pin|code)|verification code|email code|mobile code)\b/i.test(label);

/** Verification only the person can do (Aadhaar / DigiLocker / face / biometric): the run hands off. */
export const isIdentityGate = (text: string) => /\b(aadhaar|aadhar)\b.*\b(otp|verif\w*|authenticat\w*)|digilocker|face authentication|biometric/i.test(text);

export const isCaptchaLabel = (label: string) => /\bcaptcha\b|security code|enter the (text|characters|code) (shown|in the image)/i.test(label);

/** Never typed from a profile and never remembered. */
export const isSecretField = (label: string, type: string) => type === 'password' || /\bpassword\b|\bpin\b(?! code)/i.test(label);

// ─── Image requirements ("JPG, 20 KB to 50 KB, 200 x 230 pixels") ──

export interface ImageRule {
  minKB?: number;
  maxKB?: number;
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png';
}

export function imageRule(text: string): ImageRule {
  const t = text.toLowerCase().replace(/,/g, '');
  const rule: ImageRule = {};
  const unit = (n: number, u: string) => (u.startsWith('m') ? n * 1024 : n);
  const range = t.match(/(\d+(?:\.\d+)?)\s*(kb|mb)?\s*(?:to|-|–|and)\s*(\d+(?:\.\d+)?)\s*(kb|mb)/);
  if (range) {
    rule.minKB = unit(Number(range[1]), range[2] ?? range[4]);
    rule.maxKB = unit(Number(range[3]), range[4]);
  } else {
    const max = t.match(/(?:max(?:imum)?|upto|up to|not exceed(?:ing)?|below|less than|within|<=?)\s*(?:size\s*)?(?:of\s*)?(\d+(?:\.\d+)?)\s*(kb|mb)/);
    if (max) rule.maxKB = unit(Number(max[1]), max[2]);
    const min = t.match(/(?:min(?:imum)?|at least|above|more than)\s*(?:size\s*)?(?:of\s*)?(\d+(?:\.\d+)?)\s*(kb|mb)/);
    if (min) rule.minKB = unit(Number(min[1]), min[2]);
  }
  const px = t.match(/(\d{2,4})\s*(?:x|×|\*|by)\s*(\d{2,4})\s*(?:px|pixels?)/);
  if (px) {
    rule.width = Number(px[1]);
    rule.height = Number(px[2]);
  }
  if (/\bpng\b/.test(t) && !/jpe?g/.test(t)) rule.format = 'png';
  else if (/jpe?g/.test(t)) rule.format = 'jpeg';
  return rule;
}

/** The sign-in name on a portal login page ("Registration Number", "User ID", "Roll No."). */
export const isLoginIdField = (label: string) =>
  /\b(registration|reg|roll|login|user|application|enrol(l)?ment)\s*(no\.?|number|id)\b|\buser\s*name\b|\blogin\s*id\b/i.test(label);

/** What a box on an Aadhaar / DigiLocker verification page wants. */
export function identityFieldKind(label: string, type: string): 'aadhaar' | 'otp' | 'pin' | 'consent' | 'mobile' | null {
  const l = label.toLowerCase();
  if (type === 'checkbox') return /consent|authori[sz]e|agree|permit|allow/.test(l) ? 'consent' : null;
  if (/\b(otp|one[- ]time|verification code)\b/.test(l)) return 'otp';
  if (/\b(security pin|6[- ]digit pin|\bpin\b)/.test(l) && !/pin ?code/.test(l)) return 'pin';
  if (/\b(aadhaar|aadhar|uid|virtual id|vid)\b/.test(l)) return 'aadhaar';
  if (/\b(mobile|phone)\b/.test(l)) return 'mobile';
  return null;
}

/** Buttons on those pages, in the order they are needed. */
export const IDENTITY_SEND = /(generate|send|get|request|resend).{0,15}(otp|code)/i;
export const IDENTITY_GO = /^(verify|submit|continue|proceed|allow|authenticate|confirm|next)\b|verify (&|and) (continue|proceed)|\bverify\b/i;

/** Answers that are never sent to the AI, the chat history or answer memory. */
export const SENSITIVE_INPUT = new Set(['aadhaar', 'otp', 'mfa', 'loginVerification', 'mobile', 'credentialFill', 'password']);

/** Does a reply look like the value asked for? (Checked in code, never by a model.) */
export function fitsSensitiveInput(type: string, reply: string): boolean {
  const v = reply.trim();
  switch (type) {
    case 'aadhaar':
      return /^\d{12}$/.test(v.replace(/[\s-]/g, '')) || /^\d{16}$/.test(v.replace(/[\s-]/g, ''));
    case 'otp':
    case 'mfa':
    case 'loginVerification':
      return /^[A-Za-z0-9]{4,10}$/.test(v.replace(/\s/g, ''));
    case 'mobile':
      return /^\+?[\d\s-]{10,16}$/.test(v);
    default:
      return v.length > 0 && v.length <= 200;
  }
}
