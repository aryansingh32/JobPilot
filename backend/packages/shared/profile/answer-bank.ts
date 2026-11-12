import { profileService } from './index.js';
import { buildAnswerBank, bankFacts, bankHash, type AnswerBank } from './resume-analysis.js';
import { completeJSON } from '../llm/gateway.js';
import { isDummyLLMKey } from '../llm/index.js';
import { getBool } from '../config/settings.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// ANSWER BANK — the personal answers forms ask for ("tell us about yourself", strengths, biggest achievement,
// career goals), prepared once when the résumé or profile changes, saved on the profile and used at fill time
// with no model call. The rule-built version is always there; ONE small model call may polish the wording, and
// only when the facts changed. A polished answer is kept only if it adds no number the facts do not contain.
// ============================================================

const logger = createLogger('answer-bank');
const KEYS = ['aboutYou', 'strengths', 'achievement', 'careerGoal'] as const;

const numbersIn = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

/** A model answer is only kept if it is first person, sensible in length, has no placeholders and invents no numbers. */
export function acceptable(answer: unknown, facts: string): answer is string {
  if (typeof answer !== 'string') return false;
  const a = answer.trim();
  if (a.length < 30 || a.length > 600 || /\[[^\]]+\]|\{\{|lorem/i.test(a)) return false;
  const known = new Set(numbersIn(facts));
  return numbersIn(a).every((n) => known.has(n));
}

export async function refreshAnswerBank(userId: string, opts: { polish?: boolean; force?: boolean } = {}): Promise<AnswerBank> {
  const profile = await profileService.get(userId);
  const hash = bankHash(profile.data);
  const current = profile.data.answerBank;
  const wantAi = (opts.polish ?? true) && (await getBool('ai.answer_bank').catch(() => false)) && !isDummyLLMKey();
  if (!opts.force && current?.hash === hash && (current.source === 'ai' || !wantAi)) return current;

  const base = buildAnswerBank(profile.data);
  const edited = new Set(current?.edited ?? []);
  let bank: AnswerBank = { ...base, edited: [...edited] };

  if (wantAi && (base.aboutYou || base.strengths)) {
    const facts = JSON.stringify(bankFacts(profile.data));
    try {
      const { data } = await completeJSON<Partial<Record<(typeof KEYS)[number], string>>>({
        purpose: 'answer_bank',
        userId,
        maxTokens: 700,
        temperature: 0.3,
        timeoutMs: 30_000,
        messages: [
          {
            role: 'system',
            content:
              'You write short first-person answers for a job seeker\'s application profile, using ONLY the JSON facts given. Never invent employers, numbers, tools or achievements; leave a key out if the facts do not support it. Plain, specific, no filler or flattery ("passionate", "dynamic"). Keys: aboutYou (3–4 sentences), strengths (1–2 sentences naming real skills), achievement (1–2 sentences from the achievement fact), careerGoal (1–2 sentences from the target roles). Return JSON with those keys.',
          },
          { role: 'user', content: facts },
        ],
      });
      for (const k of KEYS) if (acceptable(data[k], facts)) bank = { ...bank, [k]: data[k]!.trim(), source: 'ai' };
    } catch (err) {
      logger.warn('answer-bank:polish-failed', { userId, error: (err as Error).message });
    }
  }
  // What the person edited themselves is never overwritten.
  for (const k of edited) if (current?.[k as (typeof KEYS)[number]]) (bank as Record<string, unknown>)[k] = current[k as (typeof KEYS)[number]];
  await profileService.patch(userId, { answerBank: bank }, 'answer-bank');
  return bank;
}
