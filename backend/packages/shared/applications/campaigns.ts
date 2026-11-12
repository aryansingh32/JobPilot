import { getPgPool } from '../db/index.js';
import { submissionState } from './index.js';

// ============================================================
// CAMPAIGNS — "apply to N jobs". A target with an honest end state:
//   completed  — N applications the sites confirmed
//   exhausted  — nothing left to apply to, target not reached (the report says how far it got and why)
//   stopped    — the person ended it
// Only confirmed submissions count toward the target. Applications that may have gone through
// ("unconfirmed") and ones still running reserve a place so the run never over-applies, but they are
// reported separately, never as successes.
// ============================================================

export const MAX_TARGET = 500;
export type CampaignStatus = 'active' | 'completed' | 'exhausted' | 'stopped';

export interface CampaignProgress {
  confirmed: number;
  unconfirmed: number;
  inProgress: number;
  failed: number;
}

export interface Campaign {
  id: string;
  userId: string;
  target: number;
  minScore: number;
  status: CampaignStatus;
  stopReason: string | null;
  createdAt: string;
  finishedAt: string | null;
  progress: CampaignProgress;
  /** Places still to fill: target minus everything confirmed, possibly sent or running. */
  remaining: number;
  /** One sentence saying where it stands, in the same words on every screen. */
  summary: string;
}

/** Pure: counts the applications of a campaign by what really happened to each. */
export function tally(apps: { status: string; error?: string | null; status_detail?: string | null; submit_attempted_at?: unknown }[]): CampaignProgress {
  const p: CampaignProgress = { confirmed: 0, unconfirmed: 0, inProgress: 0, failed: 0 };
  for (const a of apps) {
    const s = submissionState(a);
    if (s === 'confirmed') p.confirmed++;
    else if (s === 'unconfirmed') p.unconfirmed++;
    else if (s === 'in_progress') p.inProgress++;
    else p.failed++;
  }
  return p;
}

export function remainingSlots(target: number, p: CampaignProgress): number {
  return Math.max(0, target - p.confirmed - p.unconfirmed - p.inProgress);
}

export function describe(c: { target: number; status: CampaignStatus; stopReason: string | null }, p: CampaignProgress): string {
  const extra = [
    p.inProgress ? `${p.inProgress} in progress` : '',
    p.unconfirmed ? `${p.unconfirmed} may have been sent but weren't confirmed` : '',
    p.failed ? `${p.failed} didn't go through` : '',
  ].filter(Boolean);
  const tail = extra.length ? ` (${extra.join(', ')})` : '';
  if (c.status === 'completed') return `Done: ${p.confirmed} of ${c.target} applications confirmed${tail}.`;
  if (c.status === 'exhausted') return `${p.confirmed} of ${c.target} confirmed — target not reached${c.stopReason ? `: ${c.stopReason}` : ''}${tail}.`;
  if (c.status === 'stopped') return `Stopped at ${p.confirmed} of ${c.target} confirmed${tail}.`;
  return `${p.confirmed} of ${c.target} confirmed so far${tail}.`;
}

const toCampaign = (r: Record<string, unknown>, apps: Parameters<typeof tally>[0]): Campaign => {
  const progress = tally(apps);
  const base = { target: r.target as number, status: r.status as CampaignStatus, stopReason: (r.stop_reason as string | null) ?? null };
  return {
    id: r.id as string,
    userId: r.user_id as string,
    target: base.target,
    minScore: r.min_score as number,
    status: base.status,
    stopReason: base.stopReason,
    createdAt: new Date(r.created_at as string).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
    progress,
    remaining: base.status === 'active' ? remainingSlots(base.target, progress) : 0,
    summary: describe(base, progress),
  };
};

export class CampaignError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function load(where: string, params: unknown[]): Promise<Campaign | null> {
  const pool = getPgPool();
  const { rows } = await pool.query(`SELECT * FROM campaigns WHERE ${where} LIMIT 1`, params);
  if (!rows[0]) return null;
  const { rows: apps } = await pool.query(
    `SELECT status, error, status_detail, submit_attempted_at FROM applications WHERE campaign_id = $1`,
    [rows[0].id],
  );
  return toCampaign(rows[0], apps);
}

export const campaignsService = {
  active: (userId: string) => load(`user_id = $1 AND status = 'active'`, [userId]),
  get: (userId: string, id: string) => load(`user_id = $1 AND id = $2`, [userId, id]),

  async list(userId: string, limit = 10): Promise<Campaign[]> {
    const { rows } = await getPgPool().query(`SELECT id FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.min(limit, 50)]);
    const all = await Promise.all(rows.map((r) => this.get(userId, r.id as string)));
    return all.filter((c): c is Campaign => !!c);
  },

  async start(userId: string, input: { target: number; minScore?: number }, floor = 60): Promise<Campaign> {
    const target = Math.round(Number(input.target));
    if (!Number.isFinite(target) || target < 1 || target > MAX_TARGET) throw new CampaignError(`Pick a number between 1 and ${MAX_TARGET}`);
    const minScore = Math.min(Math.max(Math.round(Number(input.minScore ?? 75)) || floor, floor), 100);
    try {
      const { rows } = await getPgPool().query(
        `INSERT INTO campaigns (user_id, target, min_score) VALUES ($1,$2,$3) RETURNING id`,
        [userId, target, minScore],
      );
      return (await this.get(userId, rows[0].id as string))!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new CampaignError('You already have a campaign running. Stop it first.', 409);
      throw err;
    }
  },

  async stop(userId: string, id: string): Promise<Campaign> {
    const { rowCount } = await getPgPool().query(
      `UPDATE campaigns SET status = 'stopped', finished_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId],
    );
    if (!rowCount) throw new CampaignError('That campaign is not running', 404);
    return (await this.get(userId, id))!;
  },

  /**
   * After a run: finish the campaign if the target is confirmed, or if nothing is left to start and nothing is
   * still running. `nothingLeft` carries why (from the run) so the report can say it.
   */
  async settle(userId: string, nothingLeft?: string | null): Promise<Campaign | null> {
    const c = await this.active(userId);
    if (!c) return null;
    const pool = getPgPool();
    if (c.progress.confirmed >= c.target) {
      await pool.query(`UPDATE campaigns SET status = 'completed', finished_at = NOW() WHERE id = $1 AND status = 'active'`, [c.id]);
    } else if (nothingLeft && c.progress.inProgress === 0) {
      await pool.query(
        `UPDATE campaigns SET status = 'exhausted', stop_reason = $2, finished_at = NOW() WHERE id = $1 AND status = 'active'`,
        [c.id, nothingLeft.slice(0, 300)],
      );
    } else {
      return c;
    }
    return this.get(userId, c.id);
  },
};
