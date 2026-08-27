import { BaseCaptchaProvider, failedResult, pollUntilReady } from './base.js';
import type { ProviderSolveRequest, ProviderSolveResult } from '../types.js';
import type { ChallengeType } from '../types.js';

// ============================================================
// Anti-Captcha — https://anti-captcha.com/apidoc
// createTask / getTaskResult JSON API.
// ============================================================

const TASK_TYPE_BY_CHALLENGE: Partial<Record<ChallengeType, string>> = {
  'recaptcha-v2': 'NoCaptchaTaskProxyless',
  'recaptcha-v3': 'RecaptchaV3TaskProxyless',
  'hcaptcha': 'HCaptchaTaskProxyless',
  'cloudflare-turnstile': 'TurnstileTaskProxyless',
  'image-text': 'ImageToTextTask',
};

function buildTask(request: ProviderSolveRequest, taskType: string): Record<string, unknown> {
  if (taskType === 'ImageToTextTask') {
    const body = request.imageUrl?.startsWith('data:')
      ? request.imageUrl.slice(request.imageUrl.indexOf(',') + 1)
      : request.imageUrl;
    return { type: taskType, body };
  }
  const task: Record<string, unknown> = {
    type: taskType,
    websiteURL: request.pageUrl,
    websiteKey: request.sitekey,
  };
  if (taskType === 'RecaptchaV3TaskProxyless') {
    task.pageAction = 'verify';
    task.minScore = 0.3;
  }
  return task;
}

interface CreateTaskResponse { errorId: number; errorDescription?: string; taskId?: number; }
interface GetTaskResultResponse {
  errorId: number;
  errorDescription?: string;
  status?: 'processing' | 'ready';
  cost?: string;
  solution?: { gRecaptchaResponse?: string; token?: string; text?: string };
}

export class AntiCaptchaProvider extends BaseCaptchaProvider {
  readonly id = 'anti-captcha';
  protected apiKeyEnvVar = 'CAPTCHA_PROVIDER_ANTICAPTCHA_KEY';
  readonly supports: ReadonlySet<ChallengeType> = new Set(
    Object.keys(TASK_TYPE_BY_CHALLENGE) as ChallengeType[]
  );

  private baseUrl(): string {
    return process.env.ANTICAPTCHA_BASE_URL ?? 'https://api.anti-captcha.com';
  }

  async solve(request: ProviderSolveRequest): Promise<ProviderSolveResult> {
    const taskType = TASK_TYPE_BY_CHALLENGE[request.challengeType];
    if (!taskType) return failedResult(`anti-captcha does not support challenge type ${request.challengeType}`);

    const clientKey = this.requireApiKey();
    const baseUrl = this.baseUrl();

    try {
      const createRes = await fetch(`${baseUrl}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, task: buildTask(request, taskType) }),
      });
      const created = (await createRes.json()) as CreateTaskResponse;
      if (created.errorId !== 0 || !created.taskId) {
        return failedResult(`anti-captcha createTask failed: ${created.errorDescription ?? created.errorId}`);
      }

      const final = await pollUntilReady<GetTaskResultResponse>({
        poll: async () => {
          const res = await fetch(`${baseUrl}/getTaskResult`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey, taskId: created.taskId }),
          });
          return (await res.json()) as GetTaskResultResponse;
        },
        isReady: (r) => r.status === 'ready',
        isFailed: (r) => (r.errorId !== 0 ? `anti-captcha getTaskResult failed: ${r.errorDescription ?? r.errorId}` : null),
      });

      const token = final.solution?.gRecaptchaResponse ?? final.solution?.token ?? final.solution?.text;
      if (!token) return failedResult('anti-captcha returned no solution token');

      return {
        solved: true,
        token,
        costUsd: parseFloat(final.cost ?? '0') || parseFloat(process.env.ANTICAPTCHA_COST_USD ?? '0.002'),
        providerTaskId: String(created.taskId),
      };
    } catch (err) {
      return failedResult((err as Error).message);
    }
  }
}
