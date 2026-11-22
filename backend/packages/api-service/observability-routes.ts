// ============================================================
// CLIENT TELEMETRY INGEST ROUTES (admin views live in admin-service)
// ============================================================

import { createHash } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../shared/logger/index.js';
import { safeEqual } from '../shared/security/safe-equal.js';
import { ingestClientEvents } from './observability.service.js';

const logger = createLogger('observability-routes');

async function apiAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key'];
  const expected = process.env.API_KEY;
  if (!expected) {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  if (!safeEqual(key, expected)) {
    await reply.status(401).send({ error: 'Unauthorized' });
  }
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
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
