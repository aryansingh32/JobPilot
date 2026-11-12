import type OpenAI from 'openai';
import { getLLMProviders, getProviderFallbackModel, isDummyLLMKey } from './index.js';
import { getBool, getNumber, getSetting, getString, type SettingKey } from '../config/settings.js';
import { getPgPool, getRedisClient } from '../db/index.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// LLM GATEWAY — the only way the backend calls a model.
// Purpose → model (admin setting), kill switch, per-user + global daily
// budgets, max_tokens always set, retry/fallback, and one llm_usage row per
// call so every token is accounted for.
// ============================================================

const logger = createLogger('llm-gateway');

export type LLMPurpose =
  | 'chat_route'
  | 'chat_answer'
  | 'planner'
  | 'selector'
  | 'recovery'
  | 'resume_parse'
  | 'field_answers'
  | 'answer_bank'
  | 'copilot';

export interface CompleteOptions {
  purpose: LLMPurpose;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  maxTokens: number;
  /** Ask for a JSON object response. */
  json?: boolean;
  temperature?: number;
  /** Only honoured when the llm.reasoning.enabled setting is also on. */
  allowReasoning?: boolean;
  userId?: string;
  jobId?: string;
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  usage: { prompt: number; completion: number; reasoning: number; cached: number; cacheWrite: number };
  costUsd: number;
}

export class LLMBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'killswitch' | 'user_budget' | 'global_budget' | 'no_key',
  ) {
    super(message);
  }
}

const day = () => new Date().toISOString().slice(0, 10);
const userTokensKey = (userId: string) => `llm:tokens:${day()}:${userId}`;
const globalUsdKey = () => `llm:usd:${day()}`;

async function checkBudgets(userId?: string): Promise<void> {
  if (await getBool('llm.killswitch')) throw new LLMBlockedError('AI is turned off by an admin', 'killswitch');
  if (isDummyLLMKey()) throw new LLMBlockedError('No AI provider key configured', 'no_key');
  const redis = await getRedisClient();
  const globalCap = await getNumber('llm.budget.global_daily_usd');
  if (globalCap > 0) {
    const spent = Number((await redis.get(globalUsdKey())) ?? 0);
    if (spent >= globalCap) throw new LLMBlockedError('Daily AI budget reached', 'global_budget');
  }
  if (userId) {
    const userCap = await getNumber('llm.budget.user_daily_tokens');
    if (userCap > 0) {
      const used = Number((await redis.get(userTokensKey(userId))) ?? 0);
      if (used >= userCap) throw new LLMBlockedError('Your daily AI allowance is used up', 'user_budget');
    }
  }
}

async function priceFor(model: string, input: number, output: number): Promise<number> {
  const prices = ((await getSetting('llm.prices')) ?? {}) as Record<string, { input?: number; output?: number }>;
  const p = prices[model];
  if (!p) return 0;
  return (input * (p.input ?? 0) + output * (p.output ?? 0)) / 1_000_000;
}

async function record(opts: CompleteOptions, model: string, res: Partial<CompleteResult>, latencyMs: number, error?: string) {
  const u = res.usage ?? { prompt: 0, completion: 0, reasoning: 0, cached: 0, cacheWrite: 0 };
  try {
    await getPgPool().query(
      `INSERT INTO llm_usage (purpose, model, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cache_write_tokens,
                              cost_usd, latency_ms, user_id, job_id, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [opts.purpose, model, u.prompt, u.completion, u.reasoning, u.cached, u.cacheWrite, res.costUsd ?? 0, latencyMs,
        opts.userId ?? null, opts.jobId ?? null, !error, error ?? null],
    );
    if (!error) {
      const redis = await getRedisClient();
      const multi = redis.multi();
      if (opts.userId) {
        multi.incrBy(userTokensKey(opts.userId), u.prompt + u.completion);
        multi.expire(userTokensKey(opts.userId), 2 * 86400);
      }
      if (res.costUsd) {
        multi.incrByFloat(globalUsdKey(), res.costUsd);
        multi.expire(globalUsdKey(), 2 * 86400);
      }
      await multi.exec();
    }
  } catch (err) {
    logger.warn('llm-usage:record-failed', { error: (err as Error).message });
  }
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  await checkBudgets(opts.userId);
  const primary = await getString(`llm.model.${opts.purpose}` as SettingKey);
  const reasoning = opts.allowReasoning && (await getBool('llm.reasoning.enabled'));
  const providers = getLLMProviders();
  const modelFor = (providerIndex: number) => {
    const providerName = providers[providerIndex].name;
    if (providerIndex > 0) return getProviderFallbackModel(providerName);
    // Runtime settings can outlive provider changes. Avoid sending a model ID
    // from the other provider's namespace after an operator removes a key.
    if (providerName === 'openrouter' && ['gemini-3-8-flash', 'claude-haiku-5-5'].includes(primary)) {
      return getProviderFallbackModel('openrouter');
    }
    if (providerName === 'coarena' && primary.startsWith('nvidia/')) {
      return getProviderFallbackModel('coarena');
    }
    return primary;
  };

  let lastErr: unknown;
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
    const currentProvider = providers[providerIndex];
    const model = modelFor(providerIndex);
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        const body: Record<string, unknown> = {
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0.2,
        };
        if (opts.json) body.response_format = { type: 'json_object' };
        // Off unless asked for: models that think by default spend the whole budget on it and say nothing.
        body.reasoning = { enabled: !!reasoning };
        const resp = (await currentProvider.client.chat.completions.create(body as never, {
          timeout: opts.timeoutMs ?? 30_000,
        })) as OpenAI.Chat.Completions.ChatCompletion;
        const raw = resp.choices[0]?.message?.content;
        const text = typeof raw === 'string' ? raw : '';
        // An empty answer is no answer: the next model gets its turn.
        if (!text.trim()) throw Object.assign(new Error(`Empty reply from ${model}`), { emptyReply: true });
        const u = resp.usage as
          | (OpenAI.Completions.CompletionUsage & {
              completion_tokens_details?: { reasoning_tokens?: number };
              prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
              input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            })
          | undefined;
        const promptDetails = u?.prompt_tokens_details ?? u?.input_tokens_details;
        const usage = {
          prompt: u?.prompt_tokens ?? 0,
          completion: u?.completion_tokens ?? 0,
          reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0,
          cached: promptDetails?.cached_tokens ?? u?.cache_read_input_tokens ?? 0,
          cacheWrite: promptDetails?.cache_write_tokens ?? promptDetails?.cache_creation_tokens ?? u?.cache_creation_input_tokens ?? 0,
        };
        const result: CompleteResult = {
          text,
          model: resp.model ?? model,
          usage,
          costUsd: await priceFor(model, usage.prompt, usage.completion),
        };
        await record(opts, model, result, Date.now() - t0);
        return result;
      } catch (err) {
        lastErr = err;
        await record(opts, model, {}, Date.now() - t0, (err as Error).message?.slice(0, 500));
        const status = (err as { status?: number }).status;
        // Quota/rate limits and provider capacity are provider-wide: move to
        // the next provider immediately instead of retrying a spent quota.
        if ((err as { emptyReply?: boolean }).emptyReply || !isRetryable(err) || status === 429 || status === 503) break;
        await sleep(800 * (attempt + 1));
      }
    }
    if (providerIndex + 1 < providers.length) {
      logger.warn('llm-provider:fallback', { from: currentProvider.name, to: providers[providerIndex + 1].name });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('LLM call failed');
}

/** Pull a JSON object out of a model reply (handles fences / <think> preambles). */
export function parseJsonReply<T = unknown>(text: string): T {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in reply: ${clean.slice(0, 120)}`);
  return JSON.parse(clean.slice(start, end + 1)) as T;
}

export async function completeJSON<T = unknown>(opts: Omit<CompleteOptions, 'json'>): Promise<{ data: T } & CompleteResult> {
  const res = await complete({ ...opts, json: true });
  return { ...res, data: parseJsonReply<T>(res.text) };
}
