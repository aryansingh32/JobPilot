// ============================================================
// PAGE SAFETY — checks on what an application page asks for and where it lives.
// Page text is data, never instructions; a real application never asks for money or ID numbers up front.
// Pure functions (no I/O).
// ============================================================

/** What a scam "application" asks for that a real employer never does before an offer. */
const SCAM: Array<[RegExp, string]> = [
  [/\b(registration|processing|application|training|security|refundable|document|verification|interview|joining|kit|uniform|laptop) (fee|deposit|charge)s?\b|\bpay\b.{0,30}\b(fee|deposit)\b|\bprocessing fee\b|\bsecurity deposit\b/i, 'asks for a fee or deposit'],
  [/\b(send|transfer|wire|deposit)\b.{0,40}\b(money|funds|payment|cheque|check)\b|\bcheque (deposit|cashing)\b|\bpurchase (gift ?cards?|equipment)\b/i, 'asks you to send or deposit money'],
  [/\b(bank account|account number|iban|swift|routing number|ifsc)\b.{0,40}\b(to (receive|pay)|salary|direct deposit|verification)\b|\bcard (number|details)\b|\bcvv\b/i, 'asks for bank or card details'],
  [/\b(bitcoin|crypto(currency)?|usdt|binance|wallet address)\b/i, 'mentions cryptocurrency'],
  [/\b(whatsapp|telegram|signal)\b.{0,50}\b(interview|contact|message|join|apply|hr)\b|\b(interview|contact|message|apply)\b.{0,50}\b(whatsapp|telegram)\b/i, 'moves the hiring conversation to WhatsApp / Telegram'],
  [/\b(passport|aadhaar|aadhar|ssn|social security|national id|pan card)\b.{0,20}\b(number|copy|scan|photo)\b.{0,60}\b(before|to (process|verify|confirm))/i, 'asks for ID numbers before any offer'],
];

/** A reason the page looks like a scam, or null. Government portals legitimately ask for ID numbers: callers skip those. */
export function scamReason(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').slice(0, 20_000);
  for (const [re, why] of SCAM) if (re.test(t)) return why;
  return null;
}

/** Text in a form label or page that tries to give the assistant orders. */
const INJECTION = /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,30}\b(instruction|prompt|rule|message)s?\b|\bas an? (ai|assistant|language model)\b|\bsystem prompt\b|\b(you must|you should now|new instructions?)\b.{0,40}\b(answer|respond|reply|output|say)\b|\breveal\b.{0,30}\b(prompt|instruction|api key|password|profile)\b|\bpaste\b.{0,30}\b(your|the)\b.{0,20}\b(profile|resume data|notes|api key)\b/i;
export const looksLikeInjection = (text: string): boolean => INJECTION.test(text);

/** Known applicant systems: a host matches only on whole, dot-anchored labels. */
const ATS_SUFFIXES = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkday.com', 'workday.com', 'taleo.net', 'icims.com',
  'successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'oraclecloud.com', 'smartrecruiters.com', 'workable.com',
  'recruitee.com', 'personio.de', 'personio.com', 'teamtailor.com', 'bamboohr.com', 'breezy.hr', 'jobvite.com', 'comeet.com',
  'zohorecruit.com', 'zohorecruit.in', 'zohorecruit.eu', 'freshteam.com', 'keka.com', 'dayforcehcm.com', 'ultipro.com',
  'paylocity.com', 'rippling.com', 'avature.net', 'phenompeople.com', 'eightfold.ai', 'applytojob.com', 'gohire.io',
];
export const hostMatches = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);
export const isKnownAts = (host: string): boolean => ATS_SUFFIXES.some((s) => hostMatches(host.toLowerCase(), s));

/**
 * A lookalike origin: punycode / non-ASCII, plain http (outside local test sites), or an ATS name buried mid-hostname
 * (`acme.taleo.net.evil.io`, `acme-workday.com`). These are never worth typing personal details into.
 */
export function suspiciousOrigin(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'the address is not valid (look-alike characters?)'; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return null;
  if (u.protocol !== 'https:') return 'the page is not on https';
  if (/xn--/.test(host) || /[^\x00-\x7f]/.test(host)) return 'the address uses look-alike characters';
  if (!isKnownAts(host)) {
    const hit = ATS_SUFFIXES.find((s) => host.includes(`.${s}.`) || (host.includes(s.split('.')[0]) && host.split('.').length > 1 && /-(workday|taleo|icims|greenhouse|lever)\b/.test(host) && !hostMatches(host, s)));
    if (hit) return `the address imitates ${hit}`;
  }
  return null;
}
