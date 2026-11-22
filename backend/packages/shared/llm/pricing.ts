export interface TokenRates { input: number; output: number; cachedInput?: number; cacheWrite?: number }
export function estimateTokenCost(usage: { prompt: number; completion: number; cached: number; cacheWrite: number }, rates?: TokenRates): number | null {
  if (!rates || [rates.input, rates.output, rates.cachedInput ?? rates.input, rates.cacheWrite ?? rates.input].some(n => !Number.isFinite(n) || n < 0)) return null;
  const prompt = Math.max(0, usage.prompt);
  const cached = Math.min(prompt, Math.max(0, usage.cached));
  const writes = Math.min(prompt - cached, Math.max(0, usage.cacheWrite));
  // Cache counters are subsets of prompt tokens in the gateway's OpenAI-compatible contract.
  return ((prompt - cached - writes) * rates.input + cached * (rates.cachedInput ?? rates.input) + writes * (rates.cacheWrite ?? rates.input) + Math.max(0, usage.completion) * rates.output) / 1_000_000;
}
