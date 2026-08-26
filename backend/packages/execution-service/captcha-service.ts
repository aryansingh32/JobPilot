import { createLogger } from '../shared/logger/index.js';
import { getRedisClient } from '../shared/db/index.js';

const logger = createLogger('captcha-service');

export interface CaptchaChallenge {
  id: string;
  type: 'text' | 'image' | 'click';
  imageUrl?: string;
  siteId: string;
  userId: string;
  premium: boolean;
}

export class CaptchaService {
  private static instance: CaptchaService;

  private constructor() {}

  public static getInstance(): CaptchaService {
    if (!CaptchaService.instance) {
      CaptchaService.instance = new CaptchaService();
    }
    return CaptchaService.instance;
  }

  async solve(challenge: CaptchaChallenge): Promise<string> {
    logger.info('captcha:solving', { id: challenge.id, type: challenge.type, premium: challenge.premium });

    if (challenge.premium) {
      return this.solveWithPremiumAPI(challenge);
    }

    return this.solveWithHumanInTheLoop(challenge);
  }

  private async solveWithPremiumAPI(challenge: CaptchaChallenge): Promise<string> {
    const redis = await getRedisClient();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const spendKey = `captcha:spend:${currentMonth}`;
    
    const CAPTCHA_COST = 0.002;
    const MAX_MONTHLY_SPEND = parseFloat(process.env.MAX_CAPTCHA_SPEND ?? '5.0');
    
    const currentSpend = parseFloat((await redis.get(spendKey)) || '0');
    if (currentSpend + CAPTCHA_COST > MAX_MONTHLY_SPEND) {
      logger.warn('captcha:spend-cap-reached', { id: challenge.id, currentSpend });
      return this.solveWithHumanInTheLoop(challenge);
    }

    const apiKey = process.env.CAPTCHA_SOLVER_API_KEY;
    if (!apiKey) {
      logger.warn('captcha:premium-api-key-missing', { id: challenge.id });
      return this.solveWithHumanInTheLoop(challenge);
    }

    if (!challenge.imageUrl) {
      logger.warn('captcha:premium-api-no-image', { id: challenge.id });
      return this.solveWithHumanInTheLoop(challenge);
    }

    try {
      const solution = await this.solveViaProvider(challenge.imageUrl, apiKey);
      await redis.incrByFloat(spendKey, CAPTCHA_COST);
      if (currentSpend === 0) {
        await redis.expire(spendKey, 31 * 24 * 60 * 60);
      }
      logger.info('captcha:premium-api-solved', { id: challenge.id });
      return solution;
    } catch (err) {
      logger.warn('captcha:premium-api-failed-falling-back', { id: challenge.id, error: (err as Error).message });
      return this.solveWithHumanInTheLoop(challenge);
    }
  }

  // 2Captcha-compatible HTTP API (in.php submit / res.php poll). Works
  // unmodified against 2Captcha and most CapSolver/Anti-Captcha-style
  // drop-in clones — override CAPTCHA_SOLVER_BASE_URL to point elsewhere.
  private async solveViaProvider(imageUrl: string, apiKey: string): Promise<string> {
    const baseUrl = process.env.CAPTCHA_SOLVER_BASE_URL ?? 'https://2captcha.com';
    const base64 = imageUrl.startsWith('data:') ? imageUrl.slice(imageUrl.indexOf(',') + 1) : imageUrl;

    const submitRes = await fetch(`${baseUrl}/in.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: apiKey, method: 'base64', body: base64, json: '1' }),
    });
    const submitData = (await submitRes.json()) as { status: number; request: string };
    if (submitData.status !== 1) {
      throw new Error(`Captcha provider submit failed: ${submitData.request}`);
    }
    const providerId = submitData.request;

    const pollUrl = `${baseUrl}/res.php?key=${apiKey}&action=get&id=${providerId}&json=1`;
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(pollUrl);
      const pollData = (await pollRes.json()) as { status: number; request: string };
      if (pollData.status === 1) return pollData.request;
      if (pollData.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`Captcha provider poll failed: ${pollData.request}`);
      }
    }
    throw new Error('Captcha provider solve timed out');
  }

  private async solveWithHumanInTheLoop(challenge: CaptchaChallenge): Promise<string> {
    const redis = await getRedisClient();
    
    // Publish to pending queue for admin panel visibility
    await redis.setEx(`captcha:pending:${challenge.id}`, 300, JSON.stringify({
      id: challenge.id,
      siteId: challenge.siteId,
      type: challenge.type,
      payload: { imageUrl: challenge.imageUrl },
      status: 'pending',
      createdAt: new Date().toISOString()
    }));

    // Wait for solution from redis pub/sub (published by admin or user)
    return new Promise((resolve, reject) => {
      const subRedis = redis.duplicate();
      const timeout = setTimeout(async () => {
        await subRedis.quit();
        reject(new Error('Captcha solution timeout (120s)'));
      }, 120000);

      subRedis.connect().then(() => {
        subRedis.subscribe(`captcha:solved:${challenge.id}`, (message) => {
          clearTimeout(timeout);
          const { solution } = JSON.parse(message);
          logger.info('captcha:solved-human', { id: challenge.id });
          subRedis.quit().then(() => resolve(solution));
        });
      });
    });
  }
}

export const captchaService = CaptchaService.getInstance();
