import type { CaptchaProvider, ProviderSolveRequest, ProviderSolveResult } from '../types.js';

export type { CaptchaProvider, ProviderSolveRequest, ProviderSolveResult } from '../types.js';

/**
 * Shared submit/poll loop for the two "createTask / getTaskResult" JSON
 * APIs (Anti-Captcha, CapSolver — same shape by convention). Polls until
 * `isReady` reports true, `isFailed` reports a terminal error, or the
 * attempt budget is exhausted — never spins forever.
 */
export async function pollUntilReady<T>(opts: {
  poll: () => Promise<T>;
  isReady: (result: T) => boolean;
  isFailed: (result: T) => string | null;
  maxAttempts?: number;
  intervalMs?: number;
}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 20;
  const intervalMs = opts.intervalMs ?? 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await opts.poll();
    const failure = opts.isFailed(result);
    if (failure) throw new Error(failure);
    if (opts.isReady(result)) return result;
  }
  throw new Error('Captcha provider solve timed out waiting for a ready result');
}

export function failedResult(error: string): ProviderSolveResult {
  return { solved: false, error, costUsd: 0 };
}

/** Base class giving each provider a consistent isConfigured()/id shape. */
export abstract class BaseCaptchaProvider implements CaptchaProvider {
  abstract readonly id: string;
  abstract readonly supports: CaptchaProvider['supports'];
  protected abstract apiKeyEnvVar: string;

  isConfigured(): boolean {
    return Boolean(process.env[this.apiKeyEnvVar]);
  }

  protected requireApiKey(): string {
    const key = process.env[this.apiKeyEnvVar];
    if (!key) throw new Error(`${this.id}: ${this.apiKeyEnvVar} is not configured`);
    return key;
  }

  abstract solve(request: ProviderSolveRequest): Promise<ProviderSolveResult>;
}
