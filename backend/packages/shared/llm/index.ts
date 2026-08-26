import OpenAI from 'openai';

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
// Selector resolution and error recovery are single-shot classification /
// short structured-JSON tasks, not multi-step reasoning — the reasoning
// variant above is needless latency/cost for them. This is the same
// free-tier Nemotron 3 Nano family, just without the reasoning trace.
const DEFAULT_LIGHTWEIGHT_MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';

type LLMProviderConfig = {
  apiKey: string;
  baseURL?: string;
  chatModel: string;
  plannerModel: string;
  selectorModel: string;
  recoveryModel: string;
  reasoningEnabled: boolean;
};

let openAICompatibleClient: OpenAI | null = null;

function isTruthy(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function getLLMProviderConfig(): LLMProviderConfig {
  const usingOpenRouter = Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_BASE_URL);
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || 'dummy-key-for-local';
  const baseURL = process.env.OPENROUTER_BASE_URL
    || process.env.OPENAI_BASE_URL
    || (usingOpenRouter ? DEFAULT_OPENROUTER_BASE_URL : undefined);

  return {
    apiKey,
    baseURL,
    chatModel: process.env.CHAT_LLM_MODEL || process.env.LLM_MODEL || DEFAULT_OPENROUTER_MODEL,
    plannerModel: process.env.AI_PLANNER_MODEL || process.env.LLM_MODEL || DEFAULT_OPENROUTER_MODEL,
    // Deliberately does NOT fall through to the reasoning planner/chat model
    // chain — element-matching and recovery-step suggestion are cheap
    // classification tasks, so an unset override should land on the
    // lightweight non-reasoning model, not silently inherit the expensive one.
    selectorModel: process.env.AI_SELECTOR_MODEL || DEFAULT_LIGHTWEIGHT_MODEL,
    recoveryModel: process.env.AI_RECOVERY_MODEL || DEFAULT_LIGHTWEIGHT_MODEL,
    reasoningEnabled: isTruthy(process.env.OPENROUTER_ENABLE_REASONING, true),
  };
}

export function getOpenAICompatibleClient(): OpenAI {
  const { apiKey, baseURL } = getLLMProviderConfig();
  if (!openAICompatibleClient) {
    openAICompatibleClient = new OpenAI({
      apiKey,
      baseURL,
    });
  }
  return openAICompatibleClient;
}

export function getReasoningRequestBody(): Record<string, unknown> | undefined {
  return getLLMProviderConfig().reasoningEnabled
    ? { reasoning: { enabled: true } }
    : undefined;
}

export function isDummyLLMKey(): boolean {
  return getLLMProviderConfig().apiKey === 'dummy-key-for-local';
}

