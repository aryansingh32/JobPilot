import type { PoolClient } from 'pg';
import { getPgPool } from '../db/index.js';
import { getBool, getNumber } from '../config/settings.js';

// ============================================================
// CREDITS — append-only ledger; balance = SUM(delta).
// Starting an application reserves its cost; a submitted one keeps it
// (commit), one that sent nothing gets it back (refund). Every account
// gets the signup grant once, lazily, the first time credits are touched.
// ============================================================

export class InsufficientCreditsError extends Error {
  statusCode = 402;
}

export type LedgerReason = 'grant' | 'reserve' | 'commit' | 'refund' | 'admin' | 'purchase';

async function withUserLock<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('credits:' || $1))`, [userId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function balanceIn(client: PoolClient, userId: string): Promise<number> {
  const { rows } = await client.query('SELECT COALESCE(SUM(delta), 0)::int AS balance FROM credit_ledger WHERE user_id = $1', [userId]);
  return rows[0].balance;
}

async function append(
  client: PoolClient,
  e: {
    userId: string; delta: number; reason: LedgerReason; applicationId?: string | null; note?: string | null;
    actor?: string | null; paymentId?: string | null;
  },
): Promise<number> {
  const after = (await balanceIn(client, e.userId)) + e.delta;
  await client.query(
    `INSERT INTO credit_ledger (user_id, delta, reason, application_id, note, actor, balance_after, payment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.userId, e.delta, e.reason, e.applicationId ?? null, e.note ?? null, e.actor ?? null, after, e.paymentId ?? null],
  );
  return after;
}

/** First touch: the signup grant (once per account). */
async function ensureGrant(client: PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query(`SELECT 1 FROM credit_ledger WHERE user_id = $1 AND reason = 'grant' LIMIT 1`, [userId]);
  if (rows.length) return;
  const grant = await getNumber('credits.signup_grant');
  await append(client, { userId, delta: grant, reason: 'grant', note: 'Welcome credits' });
}

export const creditsService = {
  async enabled(): Promise<boolean> {
    return getBool('credits.enabled');
  },

  async balance(userId: string): Promise<number> {
    return withUserLock(userId, async (client) => {
      await ensureGrant(client, userId);
      return balanceIn(client, userId);
    });
  },

  /** Cheap pre-check before any work starts. */
  async assertCanAfford(userId: string): Promise<void> {
    if (!(await this.enabled())) return;
    const cost = await getNumber('credits.cost_per_application');
    if (cost > 0 && (await this.balance(userId)) < cost) {
      throw new InsufficientCreditsError('You are out of credits. Each application costs ' + cost + ' — nothing is charged for ones that fail.');
    }
  },

  /** Hold the cost of one application; remembered on the row for settle(). */
  async reserve(userId: string, applicationId: string): Promise<number> {
    if (!(await this.enabled())) return 0;
    const cost = await getNumber('credits.cost_per_application');
    if (cost <= 0) return 0;
    return withUserLock(userId, async (client) => {
      await ensureGrant(client, userId);
      // A retry for the same application must reuse its hold. Without this
      // row lock/idempotency check, two callers can append duplicate debits
      // while credits_reserved only remembers the last one.
      const { rows: applicationRows } = await client.query(
        `SELECT credits_reserved FROM applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [applicationId, userId],
      );
      if (!applicationRows[0]) throw new Error('Application not found for credit reservation');
      const existingReservation = Number(applicationRows[0].credits_reserved ?? 0);
      if (existingReservation > 0) return existingReservation;
      if ((await balanceIn(client, userId)) < cost) throw new InsufficientCreditsError('You are out of credits.');
      await append(client, { userId, delta: -cost, reason: 'reserve', applicationId });
      await client.query('UPDATE applications SET credits_reserved = $2 WHERE id = $1', [applicationId, cost]);
      return cost;
    });
  },

  /**
   * Final outcome of an application: keep the reservation (sent) or give it
   * back (nothing sent). Idempotent — the reservation is cleared once.
   */
  async settle(applicationId: string, outcome: 'commit' | 'refund'): Promise<void> {
    const { rows } = await getPgPool().query('SELECT user_id FROM applications WHERE id = $1 AND credits_reserved > 0', [applicationId]);
    if (!rows[0]) return;
    const userId = rows[0].user_id as string;
    await withUserLock(userId, async (client) => {
      const { rows: held } = await client.query(
        `WITH old AS (SELECT id, credits_reserved FROM applications WHERE id = $1 AND credits_reserved > 0 FOR UPDATE)
         UPDATE applications a SET credits_reserved = 0 FROM old WHERE a.id = old.id RETURNING old.credits_reserved AS amount`,
        [applicationId],
      );
      if (!held[0]) return;
      const amount = held[0].amount as number;
      await append(client, {
        userId,
        delta: outcome === 'refund' ? amount : 0,
        reason: outcome,
        applicationId,
        note: outcome === 'refund' ? 'Nothing was sent' : 'Application sent',
      });
    });
  },

  /**
   * Credits bought: one ledger entry per payment (a unique index makes a
   * second confirmation a no-op). Returns false if it was already granted.
   */
  async purchase(userId: string, paymentId: string, credits: number, note: string): Promise<boolean> {
    return withUserLock(userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM credit_ledger WHERE payment_id = $1 AND reason = 'purchase'`, [paymentId]);
      if (rows.length) return false;
      await ensureGrant(client, userId);
      await append(client, { userId, delta: credits, reason: 'purchase', note, paymentId });
      return true;
    });
  },

  /** Admin grant (+) or deduction (−), always with a note and the admin's name. */
  async adjust(userId: string, delta: number, note: string, actor: string): Promise<number> {
    return withUserLock(userId, async (client) => {
      await ensureGrant(client, userId);
      return append(client, { userId, delta, reason: 'admin', note, actor });
    });
  },

  async ledger(userId: string, limit = 50) {
    const { rows } = await getPgPool().query(
      `SELECT l.id, l.delta, l.reason, l.note, l.actor, l.balance_after, l.created_at, l.application_id, a.title AS application_title
         FROM credit_ledger l LEFT JOIN applications a ON a.id = l.application_id
        WHERE l.user_id = $1 ORDER BY l.id DESC LIMIT $2`,
      [userId, Math.min(limit, 500)],
    );
    return rows;
  },

  /** Platform totals for the admin overview. */
  async summary() {
    const { rows } = await getPgPool().query(
      `SELECT COALESCE(SUM(delta) FILTER (WHERE reason = 'grant'), 0)::int AS granted,
              COALESCE(SUM(delta) FILTER (WHERE reason = 'admin'), 0)::int AS admin_adjusted,
              COUNT(*) FILTER (WHERE reason = 'commit')::int AS committed,
              COUNT(*) FILTER (WHERE reason = 'refund')::int AS refunded,
              COALESCE((SELECT SUM(credits_reserved) FROM applications WHERE credits_reserved > 0), 0)::int AS held,
              COALESCE(SUM(delta), 0)::int AS outstanding
         FROM credit_ledger`,
    );
    return rows[0];
  },
};
