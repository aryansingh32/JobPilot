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

    await redis.incrByFloat(spendKey, CAPTCHA_COST);
    if (currentSpend === 0) {
      await redis.expire(spendKey, 31 * 24 * 60 * 60);
    }

    // Placeholder for 2Captcha / Anti-Captcha / CapSolver integration
    // For now, we'll log and fallback to human if API key is missing
    const apiKey = process.env.CAPTCHA_SOLVER_API_KEY;
    if (!apiKey) {
      logger.warn('captcha:premium-api-key-missing', { id: challenge.id });
      return this.solveWithHumanInTheLoop(challenge);
    }

    // Actual API call logic would go here
    // return await premiumProvider.solve(challenge);
    
    // For simulation:
    logger.info('captcha:premium-api-solving-simulated', { id: challenge.id });
    throw new Error('Premium API solver not fully implemented — falling back to human');
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
