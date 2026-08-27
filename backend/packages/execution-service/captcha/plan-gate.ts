import { getPgPool } from '../../shared/db/index.js';
import type { UserPlan } from '../../shared/types/index.js';

// ============================================================
// PLAN GATE
// Governs who may use a PAID solver-provider API vs. who is routed
// straight to human-in-the-loop. Free, no-cost automation (tier-1
// in-browser checkbox/audio/slider solving in captcha-handler.ts)
// is not gated here — only spend against a real provider is.
// ============================================================

const FREE_PLAN_AUTO_SOLVE_LIMIT = parseInt(process.env.FREE_PLAN_AUTO_SOLVE_MONTHLY_LIMIT ?? '0', 10);
const PREMIUM_PLAN_AUTO_SOLVE_LIMIT = parseInt(process.env.PREMIUM_PLAN_AUTO_SOLVE_MONTHLY_LIMIT ?? '500', 10);
const PREMIUM_PLAN_SPEND_CAP_USD = parseFloat(process.env.PREMIUM_PLAN_MONTHLY_SPEND_CAP_USD ?? process.env.MAX_CAPTCHA_SPEND ?? '5.0');

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface PlanGateResult {
  allowed: boolean;
  plan: UserPlan;
  reason?: string;
  usedThisMonth: number;
  spendThisMonth: number;
  monthlyLimit: number;
  monthlySpendCap: number;
}

async function getUserPlan(userId: string): Promise<UserPlan> {
  if (!userId) return 'free';
  const { rows } = await getPgPool().query('SELECT plan FROM users WHERE id = $1', [userId]);
  return (rows[0]?.plan as UserPlan) ?? 'free';
}

async function getUsage(userId: string, month: string): Promise<{ count: number; spend: number }> {
  const { rows } = await getPgPool().query(
    'SELECT auto_solve_count, spend_usd FROM user_captcha_usage WHERE user_id = $1 AND month = $2',
    [userId, month]
  );
  return { count: rows[0]?.auto_solve_count ?? 0, spend: parseFloat(rows[0]?.spend_usd ?? '0') };
}

/**
 * Can this user's job use a paid solver-provider API right now?
 * Free-plan users get FREE_PLAN_AUTO_SOLVE_MONTHLY_LIMIT (default 0 —
 * i.e. always routed to human-in-the-loop). Premium users get a real
 * monthly call count AND a hard spend cap; whichever is hit first wins.
 */
export async function canUsePaidProvider(userId: string): Promise<PlanGateResult> {
  const month = currentMonth();
  const plan = await getUserPlan(userId);
  const usage = await getUsage(userId, month);
  const monthlyLimit = plan === 'premium' ? PREMIUM_PLAN_AUTO_SOLVE_LIMIT : FREE_PLAN_AUTO_SOLVE_LIMIT;
  const monthlySpendCap = plan === 'premium' ? PREMIUM_PLAN_SPEND_CAP_USD : 0;

  const base = {
    plan,
    usedThisMonth: usage.count,
    spendThisMonth: usage.spend,
    monthlyLimit,
    monthlySpendCap,
  };

  if (monthlyLimit <= 0) {
    return { ...base, allowed: false, reason: plan === 'free' ? 'free-plan users use human-in-the-loop verification' : 'automated solving disabled for this plan' };
  }
  if (usage.count >= monthlyLimit) {
    return { ...base, allowed: false, reason: `monthly auto-solve limit reached (${usage.count}/${monthlyLimit})` };
  }
  if (usage.spend >= monthlySpendCap) {
    return { ...base, allowed: false, reason: `monthly spend cap reached ($${usage.spend.toFixed(4)}/$${monthlySpendCap.toFixed(2)})` };
  }
  return { ...base, allowed: true };
}

/** Record a completed paid-provider solve against the user's monthly usage. */
export async function recordPaidProviderUsage(userId: string, costUsd: number): Promise<void> {
  if (!userId) return;
  const month = currentMonth();
  await getPgPool().query(
    `INSERT INTO user_captcha_usage (user_id, month, auto_solve_count, spend_usd)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id, month) DO UPDATE SET
       auto_solve_count = user_captcha_usage.auto_solve_count + 1,
       spend_usd = user_captcha_usage.spend_usd + EXCLUDED.spend_usd,
       updated_at = NOW()`,
    [userId, month, costUsd]
  );
}
