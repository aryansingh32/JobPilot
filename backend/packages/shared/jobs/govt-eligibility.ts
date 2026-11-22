import type { ProfileData } from '../profile/index.js';

// ============================================================
// Government notices state who may apply: an age band (with relaxations by
// category) and a minimum qualification. This reads those out of the notice
// text and compares them with the person's profile, so the app can say
// "you are eligible", "check this", or "not eligible — here is why" before
// anyone spends an application on it. Rules differ by state and post, so a
// doubtful reading is "check", never a silent yes.
// ============================================================

export type Level = 'class10' | 'class12' | 'iti' | 'diploma' | 'graduate' | 'postgraduate' | 'doctorate';
const RANK: Record<Level, number> = { class10: 1, class12: 2, iti: 3, diploma: 3, graduate: 4, postgraduate: 5, doctorate: 6 };
const LABEL: Record<Level, string> = {
  class10: '10th pass', class12: '12th pass', iti: 'ITI', diploma: 'Diploma', graduate: "a Bachelor's degree", postgraduate: "a Master's degree", doctorate: 'a PhD',
};

export interface NoticeRequirements {
  ageMin?: number;
  ageMax?: number;
  /** The date the age limit counts on (ISO), when the notice names one. */
  ageAsOn?: string;
  /** Lowest level that qualifies. */
  level?: Level;
  womenOnly?: boolean;
  menOnly?: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dateIn(s: string): string | null {
  let m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/i);
  const mi = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return m && mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** Highest-sounding level the notice asks for as a minimum; "graduate" beats "12th" when both appear as the requirement. */
export function parseRequirements(text: string): NoticeRequirements {
  const t = text.replace(/\s+/g, ' ');
  const out: NoticeRequirements = {};

  // "Age Limit: 18 to 32 years", "Minimum Age: 18 Years  Maximum Age: 35 Years", "18-27 years"
  const range = t.match(/\bage\b[^.]{0,60}?\b(\d{2})\s*(?:-|–|to)\s*(\d{2})\s*(?:years|yrs)/i) ?? t.match(/\b(\d{2})\s*(?:-|–|to)\s*(\d{2})\s*(?:years|yrs)\b/i);
  if (range && Number(range[1]) >= 14 && Number(range[2]) <= 70 && Number(range[1]) < Number(range[2])) {
    out.ageMin = Number(range[1]);
    out.ageMax = Number(range[2]);
  } else {
    const min = t.match(/\bminimum\s+age\b[^0-9]{0,30}(\d{2})/i);
    const max = t.match(/\b(?:maximum|max\.?|upper)\s+age(?:\s+limit)?\b[^0-9]{0,30}(\d{2})/i) ?? t.match(/\bnot\s+(?:more|exceed(?:ing)?)\s+than\s+(\d{2})\s*(?:years|yrs)/i) ?? t.match(/\bage\s+limit\b[^0-9]{0,20}(?:up\s?to\s+)?(\d{2})\s*(?:years|yrs)/i);
    if (min) out.ageMin = Number(min[1]);
    if (max && Number(max[1]) >= 18 && Number(max[1]) <= 70) out.ageMax = Number(max[1]);
  }
  const asOn = t.match(/\b(?:age\b[^.]{0,80}?)?(?:as\s+on|as\s+of|calculated\s+(?:as\s+on|from)|on)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/i);
  if (asOn && /age/i.test(t.slice(Math.max(0, (asOn.index ?? 0) - 120), (asOn.index ?? 0) + asOn[0].length))) {
    const d = dateIn(asOn[1]);
    if (d) out.ageAsOn = d;
  }

  // Qualification: the lowest level named near "qualification / eligibility / pass".
  // Wording varies ("Educational Qualification", "Eligibility Criteria", a table column): read the text after each mention.
  const windows = [...t.matchAll(/(?:qualifications?|eligibility\s+criteria|educational)\b(.{0,300})/gi)].slice(0, 6).map((m) => m[1]);
  const q = windows.length ? windows.join(' | ') : t.slice(0, 1500);
  const found: Level[] = [];
  if (/\b(ph\.?\s?d|doctorate)\b/i.test(q)) found.push('doctorate');
  if (/\b(post[\s-]?graduat\w*|master'?s?|m\.?\s?(?:sc|a|com|tech|e|ba|ca|ed)\b|mba|pgdm)/i.test(q)) found.push('postgraduate');
  if (/\b(graduat\w*|graduation|bachelor'?s?|b\.?\s?(?:sc|a|com|tech|e|ed|ca|ba)\b|b\.?\s?e\b|degree)/i.test(q)) found.push('graduate');
  if (/\bdiploma\b/i.test(q)) found.push('diploma');
  if (/\bITI\b/.test(q)) found.push('iti');
  if (/\b(12th|intermediate|10\s?\+\s?2|higher secondary|hsc|\+2)\b/i.test(q)) found.push('class12');
  if (/\b(10th|matric\w*|ssc\b|secondary school|class x\b|high school)/i.test(q)) found.push('class10');
  if (found.length) {
    // "Graduate/Postgraduate" lists mean the lowest of them qualifies; "10th, 12th" lists are separate posts.
    out.level = found.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
  }

  if (/\b(only|exclusively)\s+(?:for\s+)?(?:female|women)\b|\bwomen\s+candidates\s+only\b/i.test(t)) out.womenOnly = true;
  if (/\b(only|exclusively)\s+(?:for\s+)?male\b|\bmale\s+candidates\s+only\b/i.test(t)) out.menOnly = true;
  return out;
}

/** Highest level the education history shows. */
export function levelOf(education: ProfileData['education']): Level | null {
  let best: Level | null = null;
  const consider = (l: Level) => { if (!best || RANK[l] > RANK[best]) best = l; };
  for (const e of education ?? []) {
    const d = `${e.degree ?? ''} ${e.field ?? ''}`.toLowerCase();
    if (/ph\.?\s?d|doctor/.test(d)) consider('doctorate');
    else if (/\b(m\.?\s?(sc|a|com|tech|e|ba|ca|ed)|master|mba|pgdm|post[\s-]?grad|mca)\b/.test(d)) consider('postgraduate');
    else if (/\b(b\.?\s?(sc|a|com|tech|e|ed|ca|ba|pharm)|bachelor|graduat|bca|llb|b\.?e\b|degree)\b/.test(d)) consider('graduate');
    else if (/diploma|polytechnic/.test(d)) consider('diploma');
    else if (/\biti\b/.test(d)) consider('iti');
    else if (/12|intermediate|higher secondary|hsc|senior secondary/.test(d)) consider('class12');
    else if (/10|matric|secondary|ssc/.test(d)) consider('class10');
  }
  return best;
}

export function ageOn(dob: string, on: Date): number | null {
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  let age = on.getUTCFullYear() - Number(m[1]);
  const before = on.getUTCMonth() + 1 < Number(m[2]) || (on.getUTCMonth() + 1 === Number(m[2]) && on.getUTCDate() < Number(m[3]));
  if (before) age--;
  return age;
}

/** Usual central-government upper-age relaxation in years (states differ: that case says "check"). */
export function relaxation(g: NonNullable<ProfileData['government']>): { years: number; why: string } {
  let years = 0;
  let why = '';
  const take = (y: number, w: string) => { if (y > years) { years = y; why = w; } };
  if (g.category === 'OBC') take(3, 'OBC relaxation (+3)');
  if (g.category === 'SC' || g.category === 'ST') take(5, `${g.category} relaxation (+5)`);
  if (g.pwd) take(10, 'PwD relaxation (+10)');
  if (g.exServiceman) take(3, 'ex-serviceman relaxation (about +3)');
  return { years, why };
}

export interface Eligibility {
  status: 'eligible' | 'check' | 'not_eligible';
  reasons: string[];
  /** What the profile lacks to be sure (drives the "add your date of birth" nudge). */
  needs: string[];
}

export function checkEligibility(p: ProfileData, req: NoticeRequirements, opts: { closesAt?: Date | null; now?: Date; state?: string | null } = {}): Eligibility {
  const reasons: string[] = [];
  const needs: string[] = [];
  let status: Eligibility['status'] = 'eligible';
  const g = p.government ?? {};
  const worse = (s: Eligibility['status']) => { if (s === 'not_eligible' || status === 'eligible') status = s; };

  // Age
  if (req.ageMax !== undefined || req.ageMin !== undefined) {
    if (!g.dateOfBirth) {
      needs.push('date of birth');
      worse('check');
      reasons.push(`Age limit ${req.ageMin ?? ''}${req.ageMin !== undefined && req.ageMax !== undefined ? '–' : ''}${req.ageMax ?? ''} years: add your date of birth to check`);
    } else {
      const on = req.ageAsOn ? new Date(`${req.ageAsOn}T00:00:00Z`) : (opts.closesAt ?? opts.now ?? new Date());
      const age = ageOn(g.dateOfBirth, on);
      if (age !== null) {
        const rel = relaxation(g);
        const max = req.ageMax !== undefined ? req.ageMax : undefined;
        if (req.ageMin !== undefined && age < req.ageMin) {
          worse('not_eligible');
          reasons.push(`Too young: minimum age is ${req.ageMin}, you are ${age}${req.ageAsOn ? ` on ${req.ageAsOn}` : ''}`);
        } else if (max !== undefined && age <= max) {
          reasons.push(`Age ${age} is within the limit (${max})`);
        } else if (max !== undefined && age <= max + rel.years) {
          reasons.push(`Age ${age} is over ${max}, but fits with your ${rel.why}`);
          // Reservation rules also vary by state: still say so.
          if (g.category && g.category !== 'General' && g.category !== 'EWS' && !g.domicileState) { needs.push('domicile state'); worse('check'); }
        } else if (max !== undefined) {
          reasons.push(`Age ${age} is over the limit of ${max}${rel.years ? ` even with ${rel.why}` : ''}`);
          // Without a stated category a relaxation might still apply; with one the answer is final.
          if (g.category) worse('not_eligible');
          else { needs.push('category'); worse('check'); }
        }
      }
    }
  }

  // Qualification
  if (req.level) {
    const have = levelOf(p.education);
    if (!have) {
      needs.push('education');
      worse('check');
      reasons.push(`Needs ${LABEL[req.level]}: add your education to check`);
    } else if (RANK[have] >= RANK[req.level]) {
      reasons.push(`Qualification fits (needs ${LABEL[req.level]})`);
    } else {
      worse('not_eligible');
      reasons.push(`Needs ${LABEL[req.level]}; your highest is ${LABEL[have]}`);
    }
  }

  // Gender-restricted posts
  const gender = g.gender ?? (p.personal as { gender?: string } | undefined)?.gender;
  if (req.womenOnly) {
    if (!gender) { needs.push('gender'); worse('check'); } else if (!/^(f|female|woman|women)/i.test(gender)) { worse('not_eligible'); reasons.push('Open to women candidates only'); }
  }
  if (req.menOnly) {
    if (!gender) { needs.push('gender'); worse('check'); } else if (!/^(m|male|man|men)/i.test(gender)) { worse('not_eligible'); reasons.push('Open to male candidates only'); }
  }

  if (!reasons.length) {
    worse('check');
    reasons.push('The notice does not state age or qualification in a form I can read — check the official notice');
  }
  return { status, reasons: [...new Set(reasons)], needs: [...new Set(needs)] };
}
