import { BaseCaptchaProvider, failedResult, pollUntilReady } from './base.js';
import type { ProviderSolveRequest, ProviderSolveResult } from '../types.js';
import type { ChallengeType } from '../types.js';

// ============================================================
// CapSolver — https://docs.capsolver.com
// createTask / getTaskResult JSON API (same shape convention as
// Anti-Captcha, different task-type names).
// ============================================================

const TASK_TYPE_BY_CHALLENGE: Partial<Record<ChallengeType, string>> = {
  'recaptcha-v2': 'ReCaptchaV2TaskProxyLess',
  'recaptcha-v3': 'ReCaptchaV3TaskProxyLess',
  'hcaptcha': 'HCaptchaTaskProxyLess',
  'cloudflare-turnstile': 'AntiTurnstileTaskProxyLess',
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
  if (taskType === 'ReCaptchaV3TaskProxyLess') {
    task.pageAction = 'verify';
  }
  return task;
}

interface CreateTaskResponse { errorId: number; errorDescription?: string; taskId?: string; }
interface GetTaskResultResponse {
  errorId: number;
  errorDescription?: string;
  status?: 'processing' | 'ready';
  solution?: { gRecaptchaResponse?: string; token?: string; text?: string };
}

export class CapSolverProvider extends BaseCaptchaProvider {
  readonly id = 'capsolver';
  protected apiKeyEnvVar = 'CAPTCHA_PROVIDER_CAPSOLVER_KEY';
  readonly supports: ReadonlySet<ChallengeType> = new Set(
    Object.keys(TASK_TYPE_BY_CHALLENGE) as ChallengeType[]
  );

  private baseUrl(): string {
    return process.env.CAPSOLVER_BASE_URL ?? 'https://api.capsolver.com';
  }

  async solve(request: ProviderSolveRequest): Promise<ProviderSolveResult> {
    const taskType = TASK_TYPE_BY_CHALLENGE[request.challengeType];
    if (!taskType) return failedResult(`capsolver does not support challenge type ${request.challengeType}`);

    const clientKey = this.requireApiKey();
    const baseUrl = this.baseUrl();
    const costUsd = parseFloat(process.env.CAPSOLVER_COST_USD ?? '0.0015');

    try {
      const createRes = await fetch(`${baseUrl}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, task: buildTask(request, taskType) }),
      });
      const created = (await createRes.json()) as CreateTaskResponse;
      if (created.errorId !== 0 || !created.taskId) {
        return failedResult(`capsolver createTask failed: ${created.errorDescription ?? created.errorId}`);
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
        isFailed: (r) => (r.errorId !== 0 ? `capsolver getTaskResult failed: ${r.errorDescription ?? r.errorId}` : null),
      });

      const token = final.solution?.gRecaptchaResponse ?? final.solution?.token ?? final.solution?.text;
      if (!token) return failedResult('capsolver returned no solution token');

      return { solved: true, token, costUsd, providerTaskId: created.taskId };
    } catch (err) {
      return failedResult((err as Error).message);
    }
  }
}
