import { createHash } from 'crypto';
import { answerMemory, type ProfileData } from '../shared/profile/index.js';
import { completeJSON } from '../shared/llm/gateway.js';
import { isDummyLLMKey } from '../shared/llm/index.js';
import { createLogger } from '../shared/logger/index.js';
import { pickOption, type FormField } from './form-filler.js';

// ============================================================
// AI ANSWERS — the step between "remembered answers" and "ask the user".
// Open questions an employer adds ("Why do you want this role?", "Do you
// have experience with X?") are answered from the profile's own facts, in a
// single batched call, and shown in the review marked as AI-written. Nothing
// is invented: the model may only use the facts it is given, and says null
// when they don't cover the question. Identity numbers, legal declarations
// and demographic questions are never guessed.
// ============================================================

const logger = createLogger('ai-answers');

/** Questions a person must answer themselves — no model guesses these. */
const NEVER_GUESS = new RegExp(
  [
    'aadhaar|aadhar|\\bpan\\b|passport|\\bssn\\b|social security|password|\\botp\\b|\\bcvv\\b|card number|bank|account number|ifsc',
    'date of birth|\\bdob\\b|signature|photo|declaration|i (hereby )?(declare|agree|certify|confirm)|terms|consent|privacy|acknowledg',
    'expected (salary|ctc|compensation)|current (salary|ctc)|salary expectation',
  ].join('|'),
  'i',
);
/** Personal or legal matters: answered only when the person's own notes ("about") say so, never inferred. */
const NOTES_ONLY = new RegExp(
  [
    'religion|caste|category|community|disabilit|handicap|veteran|ethnic|race\\b|gender|sex\\b|marital|orientation|pronoun',
    'criminal|convict|arrest|court|background check|visa|sponsor|work authori[sz]|right to work|citizen',
  ].join('|'),
  'i',
);
const notesOnly = (f: FormField) => NOTES_ONLY.test(`${f.label} ${f.name}`);

export function eligibleForAi(f: FormField): boolean {
  if (f.type === 'file' || f.type === 'password' || f.type === 'checkbox') return false;
  return !NEVER_GUESS.test(`${f.label} ${f.name}`);
}

/**
 * Zero-token tier: questions the facts answer by rule. "Experience with X?"
 * is Yes when X is a listed skill (never No — absence isn't proof).
 */
export function answerByRule(profile: ProfileData, f: FormField): string | null {
  const q = f.label.toLowerCase();
  const yes = f.options.find((o) => /^(yes|y|true)$/i.test(o.trim()));
  const skill = q.match(/(?:experience|proficien\w*|familiar\w*|worked|knowledge)\s+(?:with|in|of|using|on)\s+([a-z0-9.+#/ -]{2,30})/i)?.[1]?.trim();
  if (yes && skill && (profile.skills ?? []).some((s) => s.toLowerCase() === skill.toLowerCase())) return yes;
  if (/notice period/.test(q) && profile.work?.noticePeriod) return profile.work.noticePeriod;
  return null;
}

const STOP = new Set('the a an of to in on at for and or is are do you your have has any if so please what which when how with be this that will would can could it as by from my i we us our'.split(' '));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));

/** The person's notes as {topic, value} lines: "Passing out year: 2027" and learned "↳ question: answer". */
export function noteLines(about: string): { topic: string; value: string }[] {
  const out: { topic: string; value: string }[] = [];
  for (const raw of about.split('\n')) {
    const line = raw.replace(/^[\s•*\-↳]+/, '').trim();
    const i = line.lastIndexOf(': ');
    if (i < 2 || i > line.length - 2) continue;
    out.push({ topic: line.slice(0, i), value: line.slice(i + 2).trim() });
  }
  return out;
}

/** Zero-token tier: a question that says the same thing as one of the person's note lines gets that line's value. */
export function answerFromNotes(about: string, f: FormField): string | null {
  const q = words(f.label);
  if (q.size < 1) return null;
  let best: { value: string; score: number } | null = null;
  for (const n of noteLines(about)) {
    const t = words(n.topic);
    if (!t.size) continue;
    let hit = 0;
    for (const w of t) if (q.has(w)) hit++;
    // Every word of the (short) topic appears in the question, or the two mostly overlap.
    const score = Math.max(hit / t.size, hit / Math.max(q.size, t.size));
    if (hit >= Math.min(2, t.size) && score >= 0.75 && (!best || score > best.score)) best = { value: n.value, score };
  }
  if (!best) return null;
  if (!f.options.length) return best.value;
  return pickOption(f.options, best.value);
}

/** Cached AI answers are keyed to the facts they were written from, so an edited profile re-asks. */
const factsKey = (facts: string[], label: string) =>
  `ai:${createHash('sha256').update(facts.join('\n')).digest('hex').slice(0, 12)}:${label}`;

/** field.idx → the answer, only for the fields the profile's facts really cover. Rules, then cache, then ONE batched model call for what's left. */
export async function aiAnswers(
  profile: ProfileData,
  job: { title?: string; company?: string | null },
  fields: FormField[],
  ids: { userId: string; jobId: string },
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const about = profile.about?.trim() ?? '';
  const eligible = fields.filter((f) => eligibleForAi(f) && (!notesOnly(f) || about)).slice(0, 30);
  // The model reads only what the person wrote about themselves (their notes) — never the rest of the profile.
  const facts = about ? [about.slice(0, 4000)] : [];
  const todo: FormField[] = [];
  for (const f of eligible) {
    const rule = answerByRule(profile, f) ?? (about ? answerFromNotes(about, f) : null);
    if (rule) {
      out.set(f.idx, rule);
      continue;
    }
    const cached = facts.length ? await answerMemory.recall(ids.userId, factsKey(facts, f.label)).catch(() => null) : null;
    const pick = cached && (f.options.length ? f.options.find((o) => o.toLowerCase() === cached.toLowerCase()) : cached);
    if (pick) out.set(f.idx, pick);
    else todo.push(f);
  }
  if (!todo.length || !facts.length || isDummyLLMKey()) return out;
  try {
    const { data } = await completeJSON<{ answers?: { id: number; answer: string | null }[] }>({
      purpose: 'field_answers',
      userId: ids.userId,
      jobId: ids.jobId,
      maxTokens: 1800,
      temperature: 0.2,
      timeoutMs: 30_000,
      messages: [
        {
          role: 'system',
          content:
            'You fill in a job application for the candidate. Answer each question using ONLY the facts provided. If the facts do not clearly answer it, answer null — never guess or invent employers, numbers, dates, skills or achievements. Questions about identity, legal status, disability, gender or similar may be answered ONLY if the notes state it; otherwise null. For a question with options, answer with exactly one option, copied verbatim. For free text, write 1–3 plain first-person sentences. Return JSON: {"answers":[{"id":<id>,"answer":<string|null>}]}.',
        },
        {
          role: 'user',
          content: `Role: ${job.title || 'the role'}${job.company ? ` at ${job.company}` : ''}\nFacts:\n- ${facts.join('\n- ')}\n\nQuestions:\n${JSON.stringify(
            todo.map((f) => ({ id: f.idx, question: f.label, options: f.options.length ? f.options.slice(0, 30) : undefined })),
          )}`,
        },
      ],
    });
    for (const a of data.answers ?? []) {
      const field = todo.find((f) => f.idx === a.id);
      const text = typeof a.answer === 'string' ? a.answer.trim() : '';
      // The facts being silent is not proof of a "no": a written denial the profile doesn't state is never sent.
      const denial = /^(i (have not|haven'?t|do not|don'?t|am not|never)|no\b|none\b|not (yet|applicable))/i.test(text) && !field.options.length;
      if (!field || !text || denial || /^(null|n\/a|unknown|not specified)$/i.test(text) || /\[[^\]]+\]|\{\{/.test(text)) continue;
      if (field.options.length) {
        const pick = field.options.find((o) => o.toLowerCase() === text.toLowerCase());
        if (pick) out.set(field.idx, pick);
      } else if (text.length <= 800) out.set(field.idx, text);
      const got = out.get(field.idx);
      if (got) await answerMemory.remember(ids.userId, factsKey(facts, field.label), got, 'ai-cache').catch(() => {});
    }
    logger.info('ai-answers:done', { jobId: ids.jobId, asked: todo.length, answered: out.size });
  } catch (err) {
    logger.warn('ai-answers:failed', { jobId: ids.jobId, error: (err as Error).message });
  }
  return out;
}
