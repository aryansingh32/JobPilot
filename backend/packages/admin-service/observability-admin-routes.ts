// ============================================================
// OBSERVABILITY — admin views (sessions, timelines, errors, copilot)
// ============================================================

import type { FastifyInstance } from 'fastify';
import { createLogger } from '../shared/logger/index.js';
import { adminAuth } from './admin-auth.js';
import {
  listRecentSessions,
  getSessionTimeline,
  listErrorReports,
  getObservabilitySummary,
  copilotAnswer,
} from '../api-service/observability.service.js';

const logger = createLogger('observability-admin-routes');

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
