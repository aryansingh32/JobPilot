// ============================================================
// OBSERVABILITY ADMIN + CLIENT INGEST ROUTES
// ============================================================

import { createHash } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../shared/logger/index.js';
import { adminAuth } from './admin-auth.js';
import {
  ingestClientEvents,
  listRecentSessions,
  getSessionTimeline,
  listErrorReports,
  getObservabilitySummary,
  copilotAnswer,
} from './observability.service.js';

const logger = createLogger('observability-routes');

async function apiAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key'];
  const expected = process.env.API_KEY;
  if (!expected) {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  if (!key || key !== expected) {
    await reply.status(401).send({ error: 'Unauthorized' });
  }
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export async function registerObservabilityAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/observability/summary', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const summary = await getObservabilitySummary();
      return reply.send(summary);
    } catch (e) {
      logger.error('observability:summary-failed', e);
      return reply.status(500).send({ error: 'summary failed' });
    }
  });

  app.get('/admin/observability/sessions', { preHandler: adminAuth }, async (req, reply) => {
    const { limit = '50' } = req.query as { limit?: string };
    try {
      const sessions = await listRecentSessions(parseInt(limit, 10) || 50);
      return reply.send({ sessions });
    } catch {
      return reply.status(500).send({ error: 'failed' });
    }
  });

  app.get(
    '/admin/observability/sessions/:sessionId/timeline',
    { preHandler: adminAuth },
    async (req, reply) => {
      const { sessionId } = req.params as { sessionId: string };
      const { limit = '500' } = req.query as { limit?: string };
      try {
        const timeline = await getSessionTimeline(sessionId, parseInt(limit, 10) || 500);
        return reply.send({ sessionId, events: timeline });
      } catch {
        return reply.status(500).send({ error: 'failed' });
      }
    }
  );

  app.get('/admin/observability/errors', { preHandler: adminAuth }, async (req, reply) => {
    const { limit = '100' } = req.query as { limit?: string };
    try {
      const errors = await listErrorReports(parseInt(limit, 10) || 100);
      return reply.send({ errors });
    } catch {
      return reply.status(500).send({ error: 'failed' });
    }
  });

  app.post('/admin/observability/copilot', { preHandler: adminAuth }, async (req, reply) => {
    const body = req.body as { question?: string; errorReportId?: string; context?: Record<string, unknown> };
    if (!body?.question?.trim()) return reply.status(400).send({ error: 'question required' });
    try {
      const result = await copilotAnswer({
        question: body.question.trim(),
        errorReportId: body.errorReportId,
        extraContext: body.context,
      });
      return reply.send(result);
    } catch (e) {
      return reply.status(500).send({ error: String(e) });
    }
  });

  logger.info('observability-admin-routes:registered');
}

/** Client telemetry (same API key as rest of app). */
export async function registerClientTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/telemetry/client-events', { preHandler: apiAuth }, async (req, reply) => {
    const body = req.body as { events?: unknown[]; release?: string; gitSha?: string };
    const raw = Array.isArray(body?.events) ? body.events : [];
    const events = raw
      .map((x) => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null))
      .filter(Boolean) as Record<string, unknown>[];

    const mapped = events.map((e) => ({
      eventType: String(e.eventType ?? e.type ?? 'unknown'),
      sessionId: e.sessionId != null ? String(e.sessionId) : undefined,
      userId: e.userId != null ? String(e.userId) : undefined,
      traceId: e.traceId != null ? String(e.traceId) : undefined,
      spanId: e.spanId != null ? String(e.spanId) : undefined,
      requestId: e.requestId != null ? String(e.requestId) : undefined,
      route: e.route != null ? String(e.route) : undefined,
      release: body.release ?? (e.release != null ? String(e.release) : undefined),
      gitSha: body.gitSha ?? (e.gitSha != null ? String(e.gitSha) : undefined),
      payload: typeof e.payload === 'object' && e.payload !== null ? (e.payload as Record<string, unknown>) : { ...e },
    }));

    const ipHash = hashIp(req.ip);
    const n = await ingestClientEvents(mapped, { ipHash: ipHash ?? undefined });
    return reply.send({ accepted: n });
  });

  logger.info('client-telemetry-routes:registered');
}
