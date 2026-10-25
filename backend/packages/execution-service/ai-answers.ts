import { createHash } from 'crypto';
import { answerMemory, type ProfileData } from '../shared/profile/index.js';
import { completeJSON } from '../shared/llm/gateway.js';
import { isDummyLLMKey } from '../shared/llm/index.js';
import { createLogger } from '../shared/logger/index.js';
import { coverLetterFacts } from './cover-letter.js';
import type { FormField } from './form-filler.js';

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
    'religion|caste|category|community|disabilit|handicap|veteran|ethnic|race\\b|gender|sex\\b|marital|orientation',
    'criminal|convict|arrest|court|background check|visa|sponsor|work authori[sz]|right to work|citizen',
    'date of birth|\\bdob\\b|signature|photo|declaration|i (hereby )?(declare|agree|certify|confirm)|terms|consent|privacy|acknowledg',
    'expected (salary|ctc|compensation)|current (salary|ctc)|salary expectation',
  ].join('|'),
  'i',
);

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
  const eligible = fields.filter(eligibleForAi).slice(0, 12);
  const facts = coverLetterFacts(profile);
  const todo: FormField[] = [];
  for (const f of eligible) {
    const rule = answerByRule(profile, f);
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
      maxTokens: 900,
      temperature: 0.2,
      timeoutMs: 30_000,
      messages: [
        {
          role: 'system',
          content:
            'You fill in a job application for the candidate. Answer each question using ONLY the facts provided. If the facts do not clearly answer it, answer null — never guess or invent employers, numbers, dates, skills or achievements. For a question with options, answer with exactly one option, copied verbatim. For free text, write 1–3 plain first-person sentences. Return JSON: {"answers":[{"id":<id>,"answer":<string|null>}]}.',
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
