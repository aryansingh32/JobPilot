import OpenAI from 'openai';

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const DEFAULT_COARENA_BASE_URL = 'https://coarena.ai/api/v1';
const DEFAULT_COARENA_MODEL = 'claude-haiku-5-5';
// Selector resolution and error recovery are single-shot classification /
// short structured-JSON tasks, not multi-step reasoning — the reasoning
// variant above is needless latency/cost for them. This is the same
// free-tier Nemotron 3 Nano family, just without the reasoning trace.
// (nemotron-3-nano-30b-a3b lost its free tier on OpenRouter in 2026.)
const DEFAULT_LIGHTWEIGHT_MODEL = 'nvidia/nemotron-3.5-lightning:free';

type LLMProviderConfig = {
  apiKey: string;
  baseURL?: string;
  chatModel: string;
  plannerModel: string;
  selectorModel: string;
  recoveryModel: string;
  reasoningEnabled: boolean;
};

export interface LLMProvider {
  name: 'coarena' | 'openrouter' | 'openai';
  apiKey: string;
  baseURL?: string;
  client: OpenAI;
}

const clients = new Map<string, OpenAI>();

function isTruthy(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function getLLMProviderConfig(): LLMProviderConfig {
  const coarenaEnabled = Boolean(process.env.COARENA_API_KEY);
  const usingOpenRouter = Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_BASE_URL);
  const apiKey = coarenaEnabled
    ? process.env.COARENA_API_KEY!
    : process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || 'dummy-key-for-local';
  const baseURL = coarenaEnabled
    ? process.env.COARENA_BASE_URL || DEFAULT_COARENA_BASE_URL
    : process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL
      || (usingOpenRouter ? DEFAULT_OPENROUTER_BASE_URL : undefined);

  return {
    apiKey,
    baseURL,
    chatModel: process.env.CHAT_LLM_MODEL || process.env.LLM_MODEL || (coarenaEnabled ? DEFAULT_COARENA_MODEL : DEFAULT_OPENROUTER_MODEL),
    plannerModel: process.env.AI_PLANNER_MODEL || process.env.LLM_MODEL || (coarenaEnabled ? DEFAULT_COARENA_MODEL : DEFAULT_OPENROUTER_MODEL),
    // Deliberately does NOT fall through to the reasoning planner/chat model
    // chain — element-matching and recovery-step suggestion are cheap
    // classification tasks, so an unset override should land on the
    // lightweight non-reasoning model, not silently inherit the expensive one.
    selectorModel: process.env.AI_SELECTOR_MODEL || DEFAULT_LIGHTWEIGHT_MODEL,
    recoveryModel: process.env.AI_RECOVERY_MODEL || DEFAULT_LIGHTWEIGHT_MODEL,
    reasoningEnabled: isTruthy(process.env.OPENROUTER_ENABLE_REASONING, true),
  };
}

function provider(name: LLMProvider['name'], apiKey: string | undefined, baseURL: string | undefined): LLMProvider | null {
  if (!apiKey) return null;
  const cacheKey = `${name}:${baseURL ?? ''}:${apiKey}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL });
    clients.set(cacheKey, client);
  }
  return { name, apiKey, baseURL, client };
}

/** Primary provider is Coarena when configured; OpenRouter is the quota fallback. */
export function getLLMProviders(): LLMProvider[] {
  const coarenaKey = process.env.COARENA_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const providers = coarenaKey
    ? [
        provider('coarena', coarenaKey, process.env.COARENA_BASE_URL || DEFAULT_COARENA_BASE_URL),
        provider('openrouter', openRouterKey, process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL),
      ]
    : [
        provider('openrouter', openRouterKey, process.env.OPENROUTER_BASE_URL || (openRouterKey ? DEFAULT_OPENROUTER_BASE_URL : undefined)),
        provider('openai', process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL),
      ];
  return providers.filter((item): item is LLMProvider => item !== null);
}

export function getProviderFallbackModel(providerName: LLMProvider['name']): string {
  if (providerName === 'openrouter') return process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_OPENROUTER_MODEL;
  if (providerName === 'coarena') return process.env.COARENA_MODEL || DEFAULT_COARENA_MODEL;
  return process.env.LLM_MODEL || DEFAULT_OPENROUTER_MODEL;
}

export function getOpenAICompatibleClient(): OpenAI {
  const { apiKey, baseURL } = getLLMProviderConfig();
  return provider(process.env.COARENA_API_KEY ? 'coarena' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'openai', apiKey, baseURL)!.client;
}

export function getReasoningRequestBody(): Record<string, unknown> | undefined {
  return getLLMProviderConfig().reasoningEnabled
    ? { reasoning: { enabled: true } }
    : undefined;
}

export function isDummyLLMKey(): boolean {
  return getLLMProviders().length === 0;
}

