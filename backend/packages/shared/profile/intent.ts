// ============================================================
// QUESTION INTENT — what a form question *means*, independent of its wording.
//
// "Are you legally authorised to work in the US?" and "Do you have the right
// to work in the United States?" are one intent. Intents are the stable key for
// remembered answers, the unit the provenance gate reasons about (which sources
// may answer which intent), and what the form-schema cache records.
// Pure functions: no I/O, safe to import anywhere.
// ============================================================

export type Intent =
  | 'work_authorization' | 'sponsorship' | 'relocation' | 'remote_preference' | 'onsite_ok'
  | 'salary_expected' | 'salary_current' | 'notice_period'
  | 'years_total' | 'years_technology'
  | 'eeo_gender' | 'eeo_race' | 'eeo_veteran' | 'eeo_disability' | 'eeo_other'
  | 'criminal_history' | 'security_clearance' | 'minimum_age' | 'date_of_birth'
  | 'previous_employee' | 'knows_employee' | 'referral_source'
  | 'consent' | 'signature_name' | 'todays_date'
  | 'first_name' | 'last_name' | 'full_name' | 'email' | 'phone' | 'linkedin' | 'github' | 'website'
  | 'address' | 'city' | 'state' | 'country' | 'postal_code' | 'location'
  | 'school' | 'degree' | 'field_of_study' | 'graduation_year' | 'gpa'
  | 'current_company' | 'current_title'
  | 'cover_letter' | 'resume' | 'free_text' | 'other';

/** Answers that must come from the person (their profile, notes or an explicit reply), never from a model or a default. */
export const SENSITIVE: ReadonlySet<Intent> = new Set<Intent>([
  'work_authorization', 'sponsorship', 'salary_expected', 'salary_current',
  'eeo_gender', 'eeo_race', 'eeo_veteran', 'eeo_disability', 'eeo_other',
  'criminal_history', 'security_clearance', 'minimum_age', 'date_of_birth', 'consent',
]);

/** Intents whose right answer depends on where the job is, so a remembered answer only travels within a country. */
const COUNTRY_SCOPED: ReadonlySet<Intent> = new Set<Intent>([
  'work_authorization', 'sponsorship', 'relocation', 'salary_expected', 'salary_current', 'security_clearance', 'criminal_history',
]);

const norm = (s: string) => s.toLowerCase().replace(/[*✱]/g, ' ').replace(/[^\p{L}\p{N}\s/'-]/gu, ' ').replace(/\s+/g, ' ').trim();

// Order matters: first match wins. More specific intents sit above the general ones.
const TABLE: Array<[RegExp, Intent]> = [
  [/\bsponsor(ship)?\b|\bvisa\b.*\b(require|need|now|future)\b|\b(require|need)\b.*\bvisa\b|\bimmigration (support|assistance)\b/, 'sponsorship'],
  [/\b(authori[sz]ed|authori[sz]ation|eligible|eligibility|right|legally (able|permitted|allowed)|permitted) to work\b|\bwork authori[sz]ation\b|\bwork permit\b|\bemployment eligibility\b/, 'work_authorization'],
  [/\bsecurity clearance\b|\bclearance\b.*\b(active|hold|level|current)\b|\bpublic trust\b/, 'security_clearance'],
  [/\b(criminal|convict\w*|felony|misdemeanou?r|arrest\w*)\b/, 'criminal_history'],
  [/\b(18|21|eighteen|twenty-one) years? (of age|old)\b|\bat least (18|21)\b|\bminimum (legal )?age\b/, 'minimum_age'],
  [/\bveteran\b|\bmilitary\b|\barmed forces\b/, 'eeo_veteran'],
  [/\bdisabilit\w*|\bhandicap\w*/, 'eeo_disability'],
  [/\bgender\b|\bsex\b(?! offender)|\bpronouns?\b|\btransgender\b|\bsexual orientation\b/, 'eeo_gender'],
  [/\brace\b|\bethnic\w*|\bhispanic\b|\blatino\b|\bcaste\b|\breligion\b|\bcommunity\b/, 'eeo_race'],
  [/\bdate of birth\b|\bdob\b|\bbirth ?date\b|\bbirthday\b/, 'date_of_birth'],
  [/\b(expected|desired|target|ideal|asking)\b.*\b(salary|ctc|compensation|pay|package|remuneration|rate)\b|\b(salary|compensation|ctc|pay) (expectation|requirement)s?\b|\bpay expectation\b/, 'salary_expected'],
  [/\b(current|present|existing|last drawn|drawn)\b.*\b(salary|ctc|compensation|pay|package|remuneration)\b/, 'salary_current'],
  [/\bnotice(\s+period)?\b|\bearliest (start|joining)\b|\bwhen can you (start|join)\b|\bhow soon can you (join|start)\b|\bstart date\b|\bavailab(le|ility) (to|for) (start|join)\b/, 'notice_period'],
  [/\b(previously|formerly|ever|before|currently)\b.{0,40}\b(work(ed)?|employ(ed|ee)|contractor|intern)\b.{0,30}\b(for|at|with|of)\b|\bformer (employee|intern)\b|\bcurrent(ly)? (an )?employee\b/, 'previous_employee'],
  [/\b(were you|are you|have you been|did someone) (referred|recommended)\b.{0,30}\b(employee|staff|team member|someone)\b/, 'knows_employee'],
  [/\b(know|knows|related to|friends?|relatives?|family members?)\b.{0,50}\b(work|employ|interview)/, 'knows_employee'],
  [/how did you (hear|find|come to know)|where did you (hear|find|learn)|source of (application|referral)|\bwho referred you\b/, 'referral_source'],
  [/\brelocat\w*/, 'relocation'],
  [/\b(remote|work from home|wfh)\b.{0,30}\b(prefer|open|ok|comfortable|willing)\b|\b(prefer|open|willing)\b.{0,30}\b(remote|work from home)\b/, 'remote_preference'],
  [/\b(hybrid|on-?site|in-?office|work (from|in|at) (the |our )?office)\b|\b(from|in|at) (the |our )?[\w ]{0,20}office\b.{0,30}\bdays? (a|per) week\b/, 'onsite_ok'],
  [/\byears?\b.{0,40}\b(experience|exp)\b.{0,30}\b(with|in|of|using|on)\s+(?!total\b|overall\b|all\b|relevant\b|professional\b|this\b|the (field|industry)\b)\S|\bexperience\b.{0,12}\b(with|in|using)\s+(?!total\b|overall\b)\S+.{0,40}\byears?\b/, 'years_technology'],
  // "Years of React experience": a tool or skill between "of" and "experience".
  [/\byears? of (?!relevant\b|professional\b|total\b|work\b|overall\b|industry\b|experience\b)[\w.#+/-]+(?: [\w.#+/-]+)?\s+experience\b/, 'years_technology'],
  [/\byears? of (relevant |professional |total |work )?experience\b|\bhow many years\b|\b(total|relevant|overall) (work )?experience\b|\bexperience \(?in years\)?/, 'years_total'],
  [/\bi (hereby )?(agree|accept|acknowledge|certify|confirm|declare|consent)\b|\bterms\b|\bprivacy\b|\bconsent\b|\bdeclaration\b/, 'consent'],
  [/\b(signature|sign (below|here)|electronic signature|type your (full )?name)\b/, 'signature_name'],
  [/^(today'?s )?date$|\bcurrent date\b|\bdate signed\b|\bdate of signature\b/, 'todays_date'],
  [/\b(first|given)\s*name\b|\bfname\b/, 'first_name'],
  [/\b(last|family|sur)\s*name\b|\blname\b|\bsurname\b/, 'last_name'],
  [/\b(full|legal)\s*name\b|^name$/, 'full_name'],
  [/e-?mail/, 'email'],
  [/\b(phone|mobile|contact number|cell|telephone)\b/, 'phone'],
  [/linkedin/, 'linkedin'],
  [/github/, 'github'],
  [/\b(website|portfolio|personal site|blog|other url)\b/, 'website'],
  [/\b(zip|postal|pin)\s*code\b/, 'postal_code'],
  [/\bstreet\b|\baddress\b/, 'address'],
  [/^city$|\bcity\b(?! you)|\btown\b/, 'city'],
  [/\b(state|province|region)\b/, 'state'],
  [/\bcountry\b/, 'country'],
  [/\blocation\b|\bwhere are you (based|located)\b/, 'location'],
  [/\b(school|university|college|institution)\b/, 'school'],
  [/\bdegree\b|\b(highest )?qualification\b/, 'degree'],
  [/\b(discipline|major|field of study)\b/, 'field_of_study'],
  [/\bgraduat\w*|\bpassing[- ]?out\b|\bpass[- ]?out year\b/, 'graduation_year'],
  [/\b(gpa|cgpa|grade point|percentage|marks)\b/, 'gpa'],
  [/\b(current|present|latest|most recent|last)\s+(company|employer|organi[sz]ation)\b|\bcompany name\b|\bemployer\b/, 'current_company'],
  [/\b(current|present|latest|most recent)\s+(job\s+)?(title|role|position|designation)\b|\bjob title\b|\bdesignation\b/, 'current_title'],
  [/\bcover letter\b|\bmotivation letter\b/, 'cover_letter'],
  [/\bresume\b|\bcv\b|\bcurriculum vitae\b/, 'resume'],
];

/** Meaning of a question. `type` lets a big free-text box fall into `free_text` rather than be mistaken for a short fact. */
export function classifyIntent(label: string, opts: { type?: string; tag?: string } = {}): Intent {
  const l = norm(label);
  if (!l) return 'other';
  // A long question that merely mentions "GitHub" or "location" is an open question, not that fact.
  const long = l.split(' ').length > 14;
  for (const [re, intent] of TABLE) {
    if (re.test(l)) {
      if (long && !SENSITIVE.has(intent) && !['years_total', 'years_technology', 'previous_employee', 'knows_employee', 'referral_source', 'relocation', 'onsite_ok', 'remote_preference'].includes(intent)) break;
      return intent;
    }
  }
  return opts.tag === 'textarea' || long ? 'free_text' : 'other';
}

/** The pay period a text implies (null = it doesn't say). "12 LPA" is a yearly figure. */
export function payPeriod(t: string): 'hour' | 'month' | 'year' | null {
  if (/\b(hour(ly)?|per hour|\/\s?hr|hr rate)\b/i.test(t)) return 'hour';
  if (/\b(month(ly)?|per month|\/\s?mo)\b/i.test(t)) return 'month';
  if (/\b(annual(ly)?|year(ly)?|per annum|p\.?a\.?|lpa|lakhs?|ctc)\b/i.test(t)) return 'year';
  return null;
}

export const isSensitive = (intent: Intent): boolean => SENSITIVE.has(intent);

/** Where a remembered answer applies: some answers only hold within one country. */
export function scopeFor(intent: Intent, country?: string | null): string {
  return COUNTRY_SCOPED.has(intent) && country ? `country:${country.toUpperCase()}` : 'global';
}

export type Provenance = 'profile' | 'memory' | 'user' | 'default' | 'prefilled' | 'ai';

export interface GateVerdict { ok: boolean; reason?: string }

/**
 * The provenance gate: may this answer, from this source, go into a question of this meaning?
 *  - sensitive intents are never written by a model, and never by a blanket default (except declining an EEO question);
 *  - everything else may come from anywhere the filler already allows.
 */
export function gate(intent: Intent, source: Provenance, key?: string): GateVerdict {
  if (!SENSITIVE.has(intent)) return { ok: true };
  if (source === 'ai') return { ok: false, reason: `${intent} must come from you, not a model` };
  if (source === 'default' && !(intent.startsWith('eeo_') && key === 'eeo')) return { ok: false, reason: `${intent} has no safe default` };
  return { ok: true };
}

/**
 * A statement the person signs for one application ("I certify that everything above is true"). Agreeing to a
 * privacy policy once is fine to remember; a declaration is made again, knowingly, for each application.
 */
export function isDeclaration(question: string): boolean {
  return /\b(certify|certifies|attest|hereby declare|i declare|declaration|under penalty|true,? (correct|accurate)|accurate and complete|true and (correct|complete|accurate))\b/i.test(question);
}
