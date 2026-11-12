import { getSetting } from '../config/settings.js';

// ============================================================
// DEFAULT ANSWERS — what is answered without asking, for everyone: never worked there, knows nobody there,
// fine with an office, "how did you hear", declining diversity questions, agreeing to a privacy notice.
// The built-in rules live in code; the admin can switch any off, change the wording of its answer, and add rules
// of their own. Stored in the `answers.defaults` setting, so a change applies to every worker within seconds and
// is recorded in the settings history. A custom rule is still subject to the provenance gate: it can never answer a
// sensitive question (work authorisation, salary, EEO, …).
// ============================================================

export interface CustomRule {
  id: string;
  enabled: boolean;
  /** Regex tested against the question, lower-cased with punctuation removed. */
  match: string;
  /** Regex that vetoes the match. */
  exclude?: string;
  /** The text to type, or the option wording to pick (the nearest option is chosen). */
  answer: string;
  note?: string;
}

export interface AnswerDefaults {
  /** Built-in rule ids switched off. */
  disabled: string[];
  /** Built-in rule id → the answer to give instead of its own. */
  overrides: Record<string, string>;
  custom: CustomRule[];
}

export interface BuiltinRule {
  id: string;
  title: string;
  description: string;
  /** What it answers when not overridden. */
  answer: string;
  /** Whether the answer text can be changed (the others are decisions, not wording). */
  overridable: boolean;
}

export const BUILTIN_RULES: BuiltinRule[] = [
  { id: 'policy-ack', title: 'Agree to a privacy notice or terms', description: 'Required "I agree to the Candidate Privacy Notice / Terms" boxes. Never marketing, SMS, arbitration, waivers, NDAs or certifications.', answer: 'Yes (ticks the box)', overridable: false },
  { id: 'never-worked-here', title: 'Worked here before?', description: '"Have you ever worked for X?" — No, unless X is a company the person listed (experience, current employer, or "Previous employers: …" in Tell us more about you).', answer: 'No', overridable: true },
  { id: 'adult-18', title: 'Are you over 18?', description: '"Are you at least / over 18 years old?" — Yes. Turn off if you want to be asked.', answer: 'Yes', overridable: true },
  { id: 'knows-nobody', title: 'Related to or know an employee?', description: '"Do you know anyone who works at X?" — No. A referrer\'s name is never made up.', answer: 'No', overridable: true },
  { id: 'relocate-office', title: 'Relocate / office / hybrid', description: '"Willing to relocate / work from our office?" — Yes, unless the person said they only want remote.', answer: 'Yes', overridable: true },
  { id: 'how-did-you-hear', title: 'How did you hear about us?', description: 'A generic true source from the list (careers page, company site, job board, online, other).', answer: 'Careers page / company site', overridable: true },
  { id: 'no-licenses', title: 'Licences you hold', description: '"List any licences you hold — if none, say None" — None, unless reworded here.', answer: 'None', overridable: true },
  { id: 'eeo-decline', title: 'Diversity questions (gender, race, veteran, disability…)', description: 'Picks "I prefer not to answer" when the profile has no answer.', answer: 'Decline to answer', overridable: false },
];

export const EMPTY_DEFAULTS: AnswerDefaults = { disabled: [], overrides: {}, custom: [] };

const BUILTIN_IDS = new Set(BUILTIN_RULES.map((r) => r.id));

const validRegex = (src: string): boolean => {
  try { new RegExp(src, 'i'); return true; } catch { return false; }
};

/** Whatever was stored → a safe config (bad regexes, unknown ids and oversized entries dropped). */
export function normalizeDefaults(raw: unknown): AnswerDefaults {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AnswerDefaults>;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const overrides: Record<string, string> = {};
  for (const [id, v] of Object.entries(r.overrides ?? {})) {
    const t = str(v, 200);
    if (BUILTIN_IDS.has(id) && t) overrides[id] = t;
  }
  const custom: CustomRule[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(r.custom) ? r.custom.slice(0, 100) : []) {
    const match = str(c?.match, 300);
    const answer = str(c?.answer, 300);
    const exclude = str(c?.exclude, 300);
    if (!match || !answer || !validRegex(match) || (exclude && !validRegex(exclude))) continue;
    const id = str(c?.id, 60) || `custom-${custom.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    custom.push({ id, enabled: c?.enabled !== false, match, ...(exclude ? { exclude } : {}), answer, ...(str(c?.note, 200) ? { note: str(c?.note, 200) } : {}) });
  }
  return { disabled: (Array.isArray(r.disabled) ? r.disabled : []).filter((id): id is string => typeof id === 'string' && BUILTIN_IDS.has(id)), overrides, custom };
}

/** Admin input: the same shape, but a rule that can't be used is an error to show, not something dropped silently. */
export function validateDefaults(raw: unknown): { ok: true; value: AnswerDefaults } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : null) as Partial<AnswerDefaults> | null;
  if (!r) return { ok: false, error: 'Expected an object' };
  for (const c of Array.isArray(r.custom) ? r.custom : []) {
    if (!c?.match || !String(c.match).trim()) return { ok: false, error: 'Every custom rule needs a question pattern' };
    if (!c?.answer || !String(c.answer).trim()) return { ok: false, error: `Rule "${c.match}" needs an answer` };
    if (!validRegex(String(c.match))) return { ok: false, error: `"${c.match}" is not a valid pattern` };
    if (c.exclude && !validRegex(String(c.exclude))) return { ok: false, error: `"${c.exclude}" is not a valid pattern` };
  }
  return { ok: true, value: normalizeDefaults(r) };
}

export const isOn = (cfg: AnswerDefaults, id: string) => !cfg.disabled.includes(id);

/** The first enabled custom rule whose pattern matches this (already normalised) question. */
export function matchCustom(cfg: AnswerDefaults, normalizedQuestion: string): CustomRule | null {
  for (const c of cfg.custom) {
    if (!c.enabled) continue;
    if (!new RegExp(c.match, 'i').test(normalizedQuestion)) continue;
    if (c.exclude && new RegExp(c.exclude, 'i').test(normalizedQuestion)) continue;
    return c;
  }
  return null;
}

export async function loadAnswerDefaults(): Promise<AnswerDefaults> {
  try {
    return normalizeDefaults(await getSetting('answers.defaults'));
  } catch {
    return EMPTY_DEFAULTS;
  }
}
