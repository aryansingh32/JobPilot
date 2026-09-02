// ============================================================
// OBSERVABILITY — persistence, fan-out, AI copilot helpers
// ============================================================

import { createHash, randomUUID } from 'crypto';
import { getPgPool, getRedisClient } from '../shared/db/index.js';
import { createLogger } from '../shared/logger/index.js';

const logger = createLogger('observability');

export const ADMIN_OBSERVABILITY_CHANNEL = 'admin:observability';

function fingerprint(message: string, route?: string | null): string {
  return createHash('sha256')
    .update(`${message}|${route ?? ''}`)
    .digest('hex')
    .slice(0, 24);
}

async function publishAdminFeed(payload: Record<string, unknown>): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.publish(ADMIN_OBSERVABILITY_CHANNEL, JSON.stringify({ ...payload, _ts: new Date().toISOString() }));
  } catch (e) {
    logger.warn('observability:publish-failed', { err: String(e) });
  }
}

export interface ClientEventInput {
  eventType: string;
  sessionId?: string;
  userId?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  route?: string;
  release?: string;
  gitSha?: string;
  payload?: Record<string, unknown>;
}

export async function ingestClientEvents(
  events: ClientEventInput[],
  opts: { ipHash?: string }
): Promise<number> {
  if (!events.length) return 0;
  const pool = getPgPool();
  let inserted = 0;
  for (const e of events.slice(0, 500)) {
    try {
      await pool.query(
        `INSERT INTO observability_events
          (source, event_type, user_id, session_id, trace_id, span_id, request_id, route, release, git_sha, ip_hash, payload)
         VALUES ('client', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          e.eventType,
          e.userId ?? null,
          e.sessionId ?? null,
          e.traceId ?? null,
          e.spanId ?? null,
          e.requestId ?? null,
          e.route ?? null,
          e.release ?? null,
          e.gitSha ?? null,
          opts.ipHash ?? null,
          JSON.stringify(e.payload ?? {}),
        ]
      );
      inserted++;
      if (e.eventType === 'error.client' || e.eventType.startsWith('error.')) {
        await publishAdminFeed({ type: 'client_error', sessionId: e.sessionId, eventType: e.eventType });
      }
    } catch (err) {
      logger.error('observability:insert-client-event-failed', err);
    }
  }
  if (inserted) await publishAdminFeed({ type: 'client_batch', count: inserted });
  return inserted;
}

export async function recordServerEvent(
  eventType: string,
  fields: {
    userId?: string | null;
    sessionId?: string | null;
    traceId?: string | null;
    requestId?: string | null;
    route?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  const pool = getPgPool();
  try {
    await pool.query(
      `INSERT INTO observability_events
        (source, event_type, user_id, session_id, trace_id, request_id, route, payload)
       VALUES ('server', $1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        eventType,
        fields.userId ?? null,
        fields.sessionId ?? null,
        fields.traceId ?? null,
        fields.requestId ?? null,
        fields.route ?? null,
        JSON.stringify(fields.payload ?? {}),
      ]
    );
    await publishAdminFeed({ type: 'server_event', eventType });
  } catch (e) {
    logger.error('observability:server-event-failed', e);
  }
}

export interface ErrorReportInput {
  message: string;
  stack?: string;
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  route?: string | null;
  method?: string | null;
  httpStatus?: number;
  source?: string;
  context?: Record<string, unknown>;
}

export async function persistErrorReport(input: ErrorReportInput): Promise<string | null> {
  const pool = getPgPool();
  const fp = fingerprint(input.message, input.route);
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO error_reports
        (id, source, fingerprint, message, stack, user_id, session_id, request_id, trace_id, route, method, http_status, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        id,
        input.source ?? 'api',
        fp,
        input.message,
        input.stack ?? null,
        input.userId ?? null,
        input.sessionId ?? null,
        input.requestId ?? null,
        input.traceId ?? null,
        input.route ?? null,
        input.method ?? null,
        input.httpStatus ?? null,
        JSON.stringify(input.context ?? {}),
      ]
    );
    const redis = await getRedisClient().catch(() => null);
    if (redis) {
      const line = JSON.stringify({
        level: 'error',
        message: input.message,
        timestamp: new Date().toISOString(),
        fingerprint: fp,
        requestId: input.requestId,
        traceId: input.traceId,
        route: input.route,
        errorReportId: id,
      });
      await redis.lPush('logs:errors', line).catch(() => {});
      await redis.lTrim('logs:errors', 0, 1999).catch(() => {});
    }
    await publishAdminFeed({ type: 'error', id, fingerprint: fp, message: input.message.slice(0, 200) });
    return id;
  } catch (e) {
    logger.error('observability:persist-error-failed', e);
    return null;
  }
}

export async function listRecentSessions(limit = 50): Promise<
  { session_id: string; user_id: string | null; last_ts: string; event_count: string }[]
> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT session_id, MAX(user_id) AS user_id, MAX(ts) AS last_ts, COUNT(*)::text AS event_count
     FROM observability_events
     WHERE session_id IS NOT NULL
     GROUP BY session_id
     ORDER BY MAX(ts) DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getSessionTimeline(sessionId: string, limit = 500) {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT id, ts, source, event_type, user_id, session_id, trace_id, request_id, route, release, payload
     FROM observability_events
     WHERE session_id = $1
     ORDER BY ts ASC
     LIMIT $2`,
    [sessionId, limit]
  );
  return rows;
}

export async function listErrorReports(limit = 100) {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT id, ts, source, fingerprint, message, stack, user_id, session_id, request_id, trace_id, route, method, http_status, severity, context
     FROM error_reports
     ORDER BY ts DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getObservabilitySummary() {
  const pool = getPgPool();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [ev, err, sess] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM observability_events WHERE ts > $1`, [since]),
    pool.query(`SELECT COUNT(*)::int AS c FROM error_reports WHERE ts > $1`, [since]),
    pool.query(
      `SELECT COUNT(DISTINCT session_id)::int AS c FROM observability_events WHERE ts > $1 AND session_id IS NOT NULL`,
      [since]
    ),
  ]);
  return {
    events24h: ev.rows[0]?.c ?? 0,
    errors24h: err.rows[0]?.c ?? 0,
    sessions24h: sess.rows[0]?.c ?? 0,
  };
}

/** Rule-based analysis when no LLM key is configured */
export function heuristicErrorAnalysis(row: {
  message: string;
  route?: string | null;
  http_status?: number | null;
  context?: unknown;
  stack?: string | null;
}) {
  const hints: string[] = [];
  const status = row.http_status;
  if (status === 401 || status === 403) hints.push('Authentication or authorization failure — verify API keys, admin keys, or session tokens.');
  if (status === 429) hints.push('Rate limiting triggered — check client burst traffic or raise limits.');
  if (status && status >= 500) hints.push('Server-side exception — inspect stack trace and correlated logs for the same request_id/trace_id.');
  const msg = row.message.toLowerCase();
  if (msg.includes('postgres') || msg.includes('relation') || msg.includes('syntax error'))
    hints.push('Database layer — validate migrations, SQL, and connection pool health.');
  if (msg.includes('redis') || msg.includes('econnrefused')) hints.push('Redis connectivity — verify REDIS_HOST and network from API pods.');
  if (msg.includes('timeout')) hints.push('Timeout — look for slow downstream calls in Tempo for this trace_id.');
  if (!hints.length) hints.push('Review context JSON, recent deploys (git_sha), and user session timeline for events leading to this error.');
  return {
    severity: status && status >= 500 ? 'high' : status === 401 || status === 403 ? 'medium' : 'medium',
    probableRootCauses: hints,
    suggestedNextSteps: [
      'Open the session timeline for this user/session in the Session Intel tab.',
      'Search Loki for request_id or trace_id from this row.',
      'Compare error rate by fingerprint against the previous release.',
    ],
  };
}

export async function copilotAnswer(params: {
  question: string;
  errorReportId?: string;
  extraContext?: Record<string, unknown>;
}): Promise<{ answer: string; model?: string; structured?: Record<string, unknown> }> {
  let errorRow: Record<string, unknown> | null = null;
  if (params.errorReportId) {
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT * FROM error_reports WHERE id = $1`, [params.errorReportId]);
    errorRow = rows[0] ?? null;
  }

  const structured = errorRow
    ? heuristicErrorAnalysis({
        message: String(errorRow.message ?? ''),
        route: errorRow.route as string | null,
        http_status: errorRow.http_status as number | null,
        context: errorRow.context,
        stack: errorRow.stack as string | null,
      })
    : undefined;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const base =
      errorRow != null
        ? `**Error:** ${errorRow.message}\n**Route:** ${errorRow.route ?? 'n/a'} **HTTP:** ${errorRow.http_status ?? 'n/a'}\n**Fingerprint:** ${errorRow.fingerprint}\n\n`
        : '';
    const heur = structured
      ? `**Heuristic assessment**\n- Severity: ${structured.severity}\n- Root-cause hints:\n${structured.probableRootCauses.map((h) => `  - ${h}`).join('\n')}\n`
      : '';
    return {
      answer:
        base +
        heur +
        `**Q:** ${params.question}\n\n*(Set OPENAI_API_KEY for full LLM-powered correlation across logs and traces.)*`,
      structured,
    };
  }

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const sys = `You are an expert SRE assistant for ChatFlow (Fastify API, Postgres, Redis, BullMQ-style queues, Playwright workers).
Answer concisely in Markdown. Prefer: root cause hypothesis, affected components, concrete grep/search steps (trace_id, request_id), and mitigation.
If data is missing, say what to collect next.`;

    const userPayload = {
      question: params.question,
      error: errorRow,
      extra: params.extraContext ?? {},
      heuristics: structured,
    };

    const completion = await client.chat.completions.create({
      model: process.env.OBSERVABILITY_COPILOT_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      temperature: 0.2,
      max_tokens: 1200,
    });
    const text = completion.choices?.[0]?.message?.content ?? 'No response.';
    return { answer: text, model: completion.model, structured };
  } catch (e) {
    logger.error('observability:copilot-llm-failed', e);
    return {
      answer: `LLM call failed: ${String(e)}. Heuristics: ${JSON.stringify(structured ?? {}, null, 2)}`,
      structured,
    };
  }
}
