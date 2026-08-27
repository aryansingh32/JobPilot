import { BaseCaptchaProvider, failedResult, pollUntilReady } from './base.js';
import type { ProviderSolveRequest, ProviderSolveResult } from '../types.js';
import type { ChallengeType } from '../types.js';

// ============================================================
// 2Captcha — https://2captcha.com/2captcha-api
// in.php submit / res.php poll, method varies by challenge type.
// Also the default target for CAPTCHA_SOLVER_BASE_URL overrides, so any
// 2Captcha-protocol-compatible clone (not just 2captcha.com itself) works
// unmodified by pointing that env var elsewhere.
// ============================================================

const METHOD_BY_TYPE: Partial<Record<ChallengeType, string>> = {
  'recaptcha-v2': 'userrecaptcha',
  'recaptcha-v3': 'userrecaptcha',
  'hcaptcha': 'hcaptcha',
  'cloudflare-turnstile': 'turnstile',
  'image-text': 'base64',
};

const COST_PER_SOLVE_USD = parseFloat(process.env.TWOCAPTCHA_COST_USD ?? '0.002');

export class TwoCaptchaProvider extends BaseCaptchaProvider {
  readonly id = '2captcha';
  protected apiKeyEnvVar = 'CAPTCHA_PROVIDER_2CAPTCHA_KEY';
  readonly supports: ReadonlySet<ChallengeType> = new Set(
    Object.keys(METHOD_BY_TYPE) as ChallengeType[]
  );

  private baseUrl(): string {
    return process.env.CAPTCHA_SOLVER_BASE_URL ?? 'https://2captcha.com';
  }

  // Backward-compatible: honor the older single-key CAPTCHA_SOLVER_API_KEY
  // if the new provider-specific key isn't set.
  isConfigured(): boolean {
    return Boolean(process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY || process.env.CAPTCHA_SOLVER_API_KEY);
  }

  private apiKey(): string {
    const key = process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY || process.env.CAPTCHA_SOLVER_API_KEY;
    if (!key) throw new Error('2captcha: no API key configured');
    return key;
  }

  async solve(request: ProviderSolveRequest): Promise<ProviderSolveResult> {
    const method = METHOD_BY_TYPE[request.challengeType];
    if (!method) return failedResult(`2captcha does not support challenge type ${request.challengeType}`);

    const apiKey = this.apiKey();
    const baseUrl = this.baseUrl();

    try {
      const params = new URLSearchParams({ key: apiKey, method, json: '1' });
      if (method === 'base64') {
        if (!request.imageUrl) return failedResult('image-text solve requires imageUrl');
        const base64 = request.imageUrl.startsWith('data:')
          ? request.imageUrl.slice(request.imageUrl.indexOf(',') + 1)
          : request.imageUrl;
        params.set('body', base64);
      } else {
        if (!request.sitekey) return failedResult(`${method} solve requires a sitekey`);
        params.set(method === 'userrecaptcha' ? 'googlekey' : 'sitekey', request.sitekey);
        params.set('pageurl', request.pageUrl);
        if (request.challengeType === 'recaptcha-v3') {
          params.set('version', 'v3');
          params.set('action', 'verify');
          params.set('min_score', '0.3');
        }
      }

      const submitRes = await fetch(`${baseUrl}/in.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const submitData = (await submitRes.json()) as { status: number; request: string };
      if (submitData.status !== 1) return failedResult(`2captcha submit failed: ${submitData.request}`);
      const providerTaskId = submitData.request;

      const pollUrl = `${baseUrl}/res.php?key=${apiKey}&action=get&id=${providerTaskId}&json=1`;
      const final = await pollUntilReady({
        poll: async () => {
          const res = await fetch(pollUrl);
          return (await res.json()) as { status: number; request: string };
        },
        isReady: (r) => r.status === 1,
        isFailed: (r) => (r.status !== 1 && r.request !== 'CAPCHA_NOT_READY' ? `2captcha poll failed: ${r.request}` : null),
      });

      return { solved: true, token: final.request, costUsd: COST_PER_SOLVE_USD, providerTaskId };
    } catch (err) {
      return failedResult((err as Error).message);
    }
  }
}
