import { getPgPool } from '../../shared/db/index.js';
import { createLogger } from '../../shared/logger/index.js';
import type { HumanInterventionEventType, InterventionResolvedBy } from '../../shared/types/index.js';

const logger = createLogger('captcha-events');

// ============================================================
// EVENT LOG
// Every CAPTCHA/OTP/MFA/login-verification/security-block checkpoint,
// persisted for metrics, retry-cap enforcement, and — via
// updateWorkflowCheckpoint — so a workflow "remembers" what it hit
// last time and how it got resolved.
// ============================================================

export interface CreateEventInput {
  jobId: string;
  workflowKey?: string;
  siteId?: string;
  userId?: string;
  stepId?: string;
  eventType: HumanInterventionEventType;
  challengeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveEventInput {
  status: 'resolved' | 'failed' | 'timeout';
  resolvedBy?: InterventionResolvedBy;
  provider?: string;
  attempts: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export async function createEvent(input: CreateEventInput): Promise<string> {
  const { rows } = await getPgPool().query(
    `INSERT INTO human_intervention_events
       (job_id, workflow_key, site_id, user_id, step_id, event_type, challenge_type, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
     RETURNING id`,
    [
      input.jobId, input.workflowKey ?? null, input.siteId ?? null, input.userId ?? null,
      input.stepId ?? null, input.eventType, input.challengeType ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return rows[0].id as string;
}

export async function resolveEvent(eventId: string, patch: ResolveEventInput): Promise<void> {
  try {
    await getPgPool().query(
      `UPDATE human_intervention_events SET
         status = $2, resolved_by = $3, provider = $4, attempts = $5,
         cost_usd = COALESCE($6, cost_usd), duration_ms = $7, error = $8, resolved_at = NOW()
       WHERE id = $1`,
      [
        eventId, patch.status, patch.resolvedBy ?? null, patch.provider ?? null,
        patch.attempts, patch.costUsd ?? null, patch.durationMs ?? null, patch.error ?? null,
      ]
    );
  } catch (err) {
    // Metrics/audit-trail write failure must never fail the workflow itself.
    logger.warn('captcha-events:resolve-failed', { eventId, error: (err as Error).message });
  }
}

/**
 * Retain a successful (or repeatedly-failing) checkpoint on the workflow
 * itself, so the next run of the same workflow can skip straight to the
 * resolution path that actually worked instead of re-discovering it.
 */
export async function updateWorkflowCheckpoint(
  workflowKey: string,
  entry: { stepId: string; eventType: HumanInterventionEventType; challengeType?: string; resolvedBy: InterventionResolvedBy; provider?: string }
): Promise<void> {
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT id, known_checkpoints FROM site_workflows WHERE workflow_key = $1`,
      [workflowKey]
    );
    if (!rows.length) return;

    const checkpoints: Array<Record<string, unknown>> = rows[0].known_checkpoints ?? [];
    const idx = checkpoints.findIndex((c) => c.stepId === entry.stepId);
    if (idx >= 0) {
      const existing = checkpoints[idx];
      checkpoints[idx] = {
        ...existing,
        challengeType: entry.challengeType ?? existing.challengeType,
        lastResolvedBy: entry.resolvedBy,
        lastProvider: entry.provider ?? null,
        successCount: (Number(existing.successCount) || 0) + (entry.resolvedBy === 'failed' ? 0 : 1),
      };
    } else {
      checkpoints.push({
        stepId: entry.stepId,
        eventType: entry.eventType,
        challengeType: entry.challengeType ?? null,
        lastResolvedBy: entry.resolvedBy,
        lastProvider: entry.provider ?? null,
        successCount: entry.resolvedBy === 'failed' ? 0 : 1,
      });
    }

    await pool.query(`UPDATE site_workflows SET known_checkpoints = $2 WHERE id = $1`, [rows[0].id, JSON.stringify(checkpoints)]);
  } catch (err) {
    logger.warn('captcha-events:checkpoint-update-failed', { workflowKey, error: (err as Error).message });
  }
}

export interface CaptchaMetrics {
  days: number;
  totals: { events: number; resolved: number; failed: number; timeout: number; costUsd: number; avgDurationMs: number | null };
  byEventType: Array<{ eventType: string; count: number; resolvedCount: number }>;
  byResolvedBy: Array<{ resolvedBy: string | null; count: number }>;
  byProvider: Array<{ provider: string | null; count: number; costUsd: number }>;
}

export async function getCaptchaMetrics(days: number): Promise<CaptchaMetrics> {
  const pool = getPgPool();
  const [totalsRes, byTypeRes, byResolvedRes, byProviderRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) AS events,
         COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE status = 'timeout') AS timeout,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS avg_duration_ms
       FROM human_intervention_events
       WHERE created_at > NOW() - ($1 || ' days')::interval`,
      [days]
    ),
    pool.query(
      `SELECT event_type, COUNT(*) AS count, COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count
       FROM human_intervention_events
       WHERE created_at > NOW() - ($1 || ' days')::interval
       GROUP BY event_type ORDER BY count DESC`,
      [days]
    ),
    pool.query(
      `SELECT resolved_by, COUNT(*) AS count
       FROM human_intervention_events
       WHERE created_at > NOW() - ($1 || ' days')::interval
       GROUP BY resolved_by ORDER BY count DESC`,
      [days]
    ),
    pool.query(
      `SELECT provider, COUNT(*) AS count, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM human_intervention_events
       WHERE created_at > NOW() - ($1 || ' days')::interval AND provider IS NOT NULL
       GROUP BY provider ORDER BY count DESC`,
      [days]
    ),
  ]);

  const t = totalsRes.rows[0];
  return {
    days,
    totals: {
      events: Number(t?.events ?? 0),
      resolved: Number(t?.resolved ?? 0),
      failed: Number(t?.failed ?? 0),
      timeout: Number(t?.timeout ?? 0),
      costUsd: parseFloat(t?.cost_usd ?? '0'),
      avgDurationMs: t?.avg_duration_ms ? Math.round(Number(t.avg_duration_ms)) : null,
    },
    byEventType: byTypeRes.rows.map((r) => ({ eventType: r.event_type, count: Number(r.count), resolvedCount: Number(r.resolved_count) })),
    byResolvedBy: byResolvedRes.rows.map((r) => ({ resolvedBy: r.resolved_by, count: Number(r.count) })),
    byProvider: byProviderRes.rows.map((r) => ({ provider: r.provider, count: Number(r.count), costUsd: parseFloat(r.cost_usd) })),
  };
}
