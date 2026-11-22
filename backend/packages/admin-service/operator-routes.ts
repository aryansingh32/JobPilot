import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { CrawlJob, RemapJob, JobPriority } from '../shared/types/index.js';
import { enqueueJob } from '../shared/queue/index.js';
import { getPgPool } from '../shared/db/index.js';
import { ProxyManager } from '../execution-service/proxy-manager.js';
import { siteWorkflowService } from '../api-service/site-workflow.service.js';
import { getAIPlanner, buildSyntheticSnapshot } from '../ai-service/planner.js';
import { adminAuth } from './admin-auth.js';

// ============================================================
// OPERATOR ROUTES — site registry, crawl/remap triggers, proxy pool,
// site graph/elements, planner test. Moved out of the user API (they were
// guarded only by the public x-api-key there).
// ============================================================

export async function registerOperatorRoutes(app: FastifyInstance): Promise<void> {
  const proxyManager = new ProxyManager();

  app.post('/admin/ops/sites', { preHandler: adminAuth }, async (req, reply) => {
    const { domain, config } = req.body as { domain: string; config?: Record<string, unknown> };
    if (!domain) return reply.status(400).send({ error: 'domain required' });

    const pool = getPgPool();
    const { rows } = await pool.query(`
      INSERT INTO sites (domain, config)
      VALUES ($1, $2)
      ON CONFLICT (domain) DO UPDATE SET config = EXCLUDED.config
      RETURNING id, domain, created_at
    `, [domain, JSON.stringify(config ?? {})]);

    return { site: rows[0] };
  });
  app.post('/admin/ops/crawl', { preHandler: adminAuth }, async (req, reply) => {
    const {
      siteId, url,
      maxDepth = 3,
      maxPages = 200,
      strategy = 'hybrid',
      priority = 'normal',
    } = req.body as {
      siteId: string; url: string;
      maxDepth?: number; maxPages?: number;
      strategy?: CrawlJob['payload']['strategy'];
      priority?: JobPriority;
    };

    if (!siteId || !url) return reply.status(400).send({ error: 'siteId and url required' });

    const job: CrawlJob = {
      id:       randomUUID(),
      type:     'crawl',
      priority,
      createdAt: new Date(),
      userId:   (req as any).userId ?? 'system',
      payload: { url, maxDepth, maxPages, strategy, followExternalLinks: false, respectRobots: true },
    };

    const jobId = await enqueueJob(job);
    reply.status(202).send({ jobId, status: 'queued', message: 'Crawl job enqueued' });
  });
  app.post('/admin/ops/remap', { preHandler: adminAuth }, async (req, reply) => {
    const { siteId, urls, reason = 'scheduled' } = req.body as {
      siteId: string; urls?: string[];
      reason?: RemapJob['payload']['reason'];
    };

    if (!siteId) return reply.status(400).send({ error: 'siteId required' });

    const job: RemapJob = {
      id:       randomUUID(),
      type:     'remap',
      priority: 'low',
      createdAt: new Date(),
      userId:   'system',
      payload:  { siteId, affectedUrls: urls, reason },
    };

    const jobId = await enqueueJob(job);
    reply.status(202).send({ jobId, status: 'queued', mode: urls?.length ? 'incremental' : 'full' });
  });
  app.post('/admin/ops/proxies/import', { preHandler: adminAuth }, async (req, reply) => {
    const { proxies } = req.body as {
      proxies: Array<{ host: string; port: number; username?: string; password?: string; protocol?: string; tags?: string[] }>;
    };
    if (!proxies?.length) return reply.status(400).send({ error: 'proxies array required' });
    const count = await proxyManager.importProxies(proxies);
    return { imported: count };
  });
  app.get('/admin/ops/proxies/stats', { preHandler: adminAuth }, async () => {
    const stats = await proxyManager.getStats();
    return { stats };
  });
  app.get('/admin/ops/sites/:siteId/graph', { preHandler: adminAuth }, async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    const pool = getPgPool();

    const [{ rows: nodes }, { rows: edges }] = await Promise.all([
      pool.query(
        `SELECT id, url, title, load_time_ms, reliability_score, last_verified
         FROM pages WHERE site_id = $1 LIMIT 1000`,
        [siteId]
      ),
      pool.query(
        `SELECT from_page_id, to_page_id, link_text, navigation_type
         FROM page_edges WHERE site_id = $1 LIMIT 5000`,
        [siteId]
      ),
    ]);

    return { siteId, nodes: nodes.length, edges: edges.length, graph: { nodes, edges } };
  });
  app.get('/admin/ops/sites/:siteId/elements', { preHandler: adminAuth }, async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    const { type, interactable } = req.query as { type?: string; interactable?: string };

    const pool = getPgPool();
    const { rows } = await pool.query(`
      SELECT e.id, e.type, e.label, e.visible, e.interactable, p.url
      FROM elements e
      JOIN pages p ON e.page_id = p.id
      WHERE p.site_id = $1
        AND ($2::text IS NULL OR e.type = $2)
        AND ($3::boolean IS NULL OR e.interactable = $3)
      LIMIT 500
    `, [siteId, type ?? null, interactable ? interactable === 'true' : null]);

    return { elements: rows };
  });
  app.post('/admin/ops/test/plan', { preHandler: adminAuth }, async (req, reply) => {
    const body = req.body as {
      siteId?: string;
      task?: string;
      pageUrl?: string;
      useCache?: boolean;
    };

    if (!body.siteId || !body.task) {
      return reply.status(400).send({ error: 'siteId and task are required' });
    }

    const workflowContext = await siteWorkflowService.listForSite(body.siteId);
    const fallbackUrl = body.pageUrl
      ?? workflowContext[0]?.pageUrl
      ?? workflowContext[0]?.entryUrl
      ?? workflowContext[0]?.pageUrlPattern
      ?? undefined;

    const decision = await getAIPlanner().planTask(
      body.task,
      body.siteId,
      buildSyntheticSnapshot(fallbackUrl),
      [],
      body.useCache ?? true
    );

    return {
      source: decision.source ?? 'ai-generated',
      matchedWorkflowId: decision.matchedWorkflowId ?? null,
      matchedWorkflowName: decision.matchedWorkflowName ?? null,
      confidence: decision.confidence,
      estimatedDuration: decision.estimatedDuration,
      actionPlanLength: decision.actionPlan.length,
      pauseSteps: decision.actionPlan
        .filter((step) => step.action === 'pauseForUserInput')
        .map((step) => ({
          id: step.id,
          expectedInput: step.expectedInput ?? null,
          description: step.description,
        })),
      actionPlan: decision.actionPlan,
    };
  });
}
