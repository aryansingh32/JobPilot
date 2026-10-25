import { answerMemory } from '../shared/profile/index.js';
import { completeJSON } from '../shared/llm/gateway.js';
import { isDummyLLMKey } from '../shared/llm/index.js';
import { createLogger } from '../shared/logger/index.js';
import { ruleFor, type AnswerBook, type FormField } from './form-filler.js';

// ============================================================
// FIELD INTENT — what a question is really asking, in any wording or language.
// The rules in form-filler.ts cover the common phrasings for free; what they
// miss ("Where are you employed right now?", "¿Cuál es su sueldo actual?",
// "वर्तमान कंपनी") goes to the model in ONE batched call that may only choose
// from the profile keys we hold — it never produces an answer, so nothing is
// invented. The choice is remembered per question text, so a wording is
// classified once, ever.
// ============================================================

const logger = createLogger('field-intent');

/** Profile facts that are safe to fill by meaning (nothing identity-, legal- or demographic-related). */
const INTENT_KEYS: Record<string, string> = {
  firstName: 'first / given name',
  lastName: 'last / family name',
  fullName: 'full name',
  email: 'email address',
  phone: 'phone / mobile number',
  city: 'city of residence',
  state: 'state / province of residence',
  country: 'country of residence',
  location: 'current location (city, state, country)',
  address: 'street address',
  postalCode: 'ZIP / PIN / postal code',
  linkedin: 'LinkedIn URL',
  github: 'GitHub URL',
  website: 'portfolio / website URL',
  currentCompany: 'name of the company the person works at now (or last worked at)',
  currentTitle: 'their current job title / designation',
  yearsExperience: 'total years of work experience',
  noticePeriod: 'notice period / how soon they can join',
  expectedSalary: 'salary / CTC they expect',
  currentSalary: 'salary / CTC they earn now',
  school: 'college / university name',
  degree: 'degree / qualification',
  field: 'field of study / major',
  graduationYear: 'year of graduation',
  preferredLocation: 'preferred work location',
  summary: 'short professional summary',
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const cacheKey = (label: string) => `intent:${norm(label).slice(0, 160)}`;

/** field.idx → profile key, for the fields no rule recognised. */
export async function classifyIntents(fields: FormField[], book: AnswerBook, userId: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const todo: FormField[] = [];
  for (const f of fields) {
    if (f.type === 'file' || f.type === 'password' || f.type === 'captcha' || f.value || !f.label || ruleFor(f)) continue;
    const cached = await answerMemory.recall(userId, cacheKey(f.label)).catch(() => null);
    if (cached) {
      if (cached !== 'none' && INTENT_KEYS[cached]) out.set(f.idx, cached);
    } else todo.push(f);
  }
  if (!todo.length || isDummyLLMKey()) return out;
  const keys = Object.keys(INTENT_KEYS).filter((k) => book[k]);
  if (!keys.length) return out;
  try {
    const { data } = await completeJSON<{ intents?: { id: number; key: string | null }[] }>({
      purpose: 'field_intent',
      userId,
      maxTokens: 500,
      temperature: 0,
      timeoutMs: 20_000,
      messages: [
        {
          role: 'system',
          content:
            'You classify job-application form questions, in any language. For each question pick the ONE key whose fact it asks for, or null if none fits exactly (open-ended questions, yes/no questions, anything about opinions or skills are null). Do not answer the question. Return JSON: {"intents":[{"id":<id>,"key":<key or null>}]}.\nKeys:\n' +
            keys.map((k) => `- ${k}: ${INTENT_KEYS[k]}`).join('\n'),
        },
        { role: 'user', content: JSON.stringify(todo.slice(0, 20).map((f) => ({ id: f.idx, question: f.label, type: f.type }))) },
      ],
    });
    for (const i of data.intents ?? []) {
      const f = todo.find((x) => x.idx === i.id);
      if (!f) continue;
      const key = i.key && keys.includes(i.key) ? i.key : 'none';
      if (key !== 'none') out.set(f.idx, key);
      await answerMemory.remember(userId, cacheKey(f.label), key, 'intent-cache').catch(() => {});
    }
    logger.info('field-intent:done', { asked: todo.length, matched: out.size });
  } catch (err) {
    logger.warn('field-intent:failed', { error: (err as Error).message });
  }
  return out;
}
