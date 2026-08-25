import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import type {
  CrawlJob, ExecuteJob, RemapJob,
  JobPriority,
} from '../shared/types/index.js';
import { enqueueJob, getAllQueueStats, getJobPosition } from '../shared/queue/index.js';
import { getPgPool, getRedisClient, runMigrations, CacheKeys } from '../shared/db/index.js';
import { getBrowserPool } from '../execution-service/browser-pool.js';
import { ProxyManager } from '../execution-service/proxy-manager.js';
import { getAIPlanner, buildSyntheticSnapshot } from '../ai-service/planner.js';
import { register as promRegister, Gauge } from 'prom-client';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { chatOrchestrator } from './chat-orchestrator.js';
import { ADMIN_OBSERVABILITY_CHANNEL } from './observability.service.js';
import { memoryService } from './user-memory.service.js';
import { siteWorkflowService } from './site-workflow.service.js';
import type { ActionStep, JobRuntimeState } from '../shared/types/index.js';
import { fileStorageService } from './file-storage.service.js';
import { workflowLoader } from '../shared/workflow-loader.js';
import { createLogger } from '../shared/logger/index.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerObservabilityAdminRoutes, registerClientTelemetryRoutes } from './observability-routes.js';
import { persistErrorReport } from './observability.service.js';
import { initNodeTelemetry } from './telemetry.js';
import { registerAuthRoutes, requireUser, SESSION_COOKIE, ADMIN_SESSION_COOKIE } from './auth-routes.js';
import { verifySession, verifyAdminSession } from '../shared/auth/index.js';

// ============================================================
// API SERVICE — Fastify gateway
// All user requests are converted to async jobs.
// No direct execution from API layer.
// ============================================================

const logger = createLogger('api-service');

function normalizeAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const defaults = [
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
  ];

  return [...new Set([...configured, ...defaults])];
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// ─── Auth Middleware (simple API key) ─────────────────────────

async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key'];
  const expectedKey = process.env.API_KEY;
  if (!expectedKey) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  if (!key || key !== expectedKey) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

// ─── Build App ────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    },
  });
  const allowedOrigins = normalizeAllowedOrigins();

  // Plugins
  await app.register(import('@fastify/cors'), {
    origin(origin, callback) {
      if (isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-key', 'Authorization'],
    exposedHeaders: ['Content-Type', 'Content-Disposition'],
    credentials: true, // session cookies (jp_session / jp_admin_session) are cross-origin
  });

  await app.register(import('@fastify/cookie'));

  await app.register(import('@fastify/rate-limit'), {
    max: parseInt(process.env.RATE_LIMIT ?? '100'),
    timeWindow: '1 minute',
  });

  app.addHook('onRequest', async (req) => {
    logger.info('request:start', {
      requestId: req.id,
      method: req.method,
      url: req.url,
      origin: req.headers.origin,
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    logger.info('request:done', {
      requestId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime,
    });
  });

  app.setErrorHandler(async (error, req, reply) => {
    logger.error('request:error', error, {
      requestId: req.id,
      method: req.method,
      url: req.url,
    });
    const status = error.statusCode ?? 500;
    if (status >= 500 || status === 429) {
      let traceId: string | undefined;
      try {
        const { trace } = await import('@opentelemetry/api');
        traceId = trace.getActiveSpan()?.spanContext().traceId;
      } catch {
        traceId = undefined;
      }
      try {
        await persistErrorReport({
          message: error.message || 'Internal Server Error',
          stack: error.stack,
          requestId: String(req.id),
          traceId,
          route: req.url,
          method: req.method,
          httpStatus: status,
          source: 'api',
          context: {
            validation: (error as { validation?: unknown }).validation,
            code: (error as { code?: string }).code,
          },
        });
      } catch {
        /* never block response on observability persistence */
      }
    }
    reply.status(status).send({ error: error.message || 'Internal Server Error' });
  });

  // ── Health ──────────────────────────────────────────────────

  app.get('/health', async () => {
    const pool = getPgPool();
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {}

    const redis = await getRedisClient().catch(() => null);
    const redisOk = redis ? await redis.ping().then(() => true).catch(() => false) : false;

    const browserStats = getBrowserPool().getStats();

    return {
      status: dbOk && redisOk ? 'healthy' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
      browsers: browserStats,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // Prometheus metrics
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', promRegister.contentType);
    return promRegister.metrics();
  });

  // ── Sites ────────────────────────────────────────────────────

  app.post('/sites', { preHandler: authMiddleware }, async (req, reply) => {
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

  app.get('/sites', { preHandler: authMiddleware }, async () => {
    const pool = getPgPool();
    const { rows } = await pool.query(`
      SELECT id, domain, page_count, status, created_at, updated_at
      FROM sites ORDER BY created_at DESC LIMIT 50
    `);
    return { sites: rows };
  });

  app.get('/sites/:siteId', { preHandler: authMiddleware }, async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT * FROM sites WHERE id = $1`, [siteId]);
    if (!rows.length) return reply.status(404).send({ error: 'Site not found' });
    return { site: rows[0] };
  });

  // ── Crawl ─────────────────────────────────────────────────────

  app.post('/crawl', { preHandler: authMiddleware }, async (req, reply) => {
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

  // ── Execute Task ──────────────────────────────────────────────

  app.post('/execute', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const {
      siteId, task,
      sessionId = randomUUID(),
      priority = 'normal',
      useCache = true,
      dryRun = false,
    } = req.body as {
      siteId: string; task: string;
      sessionId?: string; priority?: JobPriority;
      useCache?: boolean;
      dryRun?: boolean;
    };

    if (!siteId || !task) return reply.status(400).send({ error: 'siteId and task required' });

    const job: ExecuteJob = {
      id:       randomUUID(),
      type:     'execute',
      priority,
      createdAt: new Date(),
      userId,
      sessionId,
      payload:  { siteId, task, sessionId, useCache, dryRun },
    };

    const jobId = await enqueueJob(job);
    const redis = await getRedisClient();
    const runtimeState: JobRuntimeState = {
      jobId,
      userId,
      sessionId,
      siteId,
      task,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await redis.setEx(CacheKeys.jobRuntime(jobId), 86400, JSON.stringify(runtimeState));
    reply.status(202).send({ jobId, sessionId, status: 'queued' });
  });

  // ── Remap ─────────────────────────────────────────────────────

  app.post('/remap', { preHandler: authMiddleware }, async (req, reply) => {
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

  // ── Jobs ─────────────────────────────────────────────────────

  app.get('/jobs/:jobId', { preHandler: authMiddleware }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT * FROM job_logs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [jobId]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Job not found' });
    return { job: rows[0] };
  });

  app.get('/jobs/:jobId/runtime', { preHandler: authMiddleware }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const redis = await getRedisClient();
    const runtime = await redis.get(CacheKeys.jobRuntime(jobId));
    if (!runtime) return reply.status(404).send({ error: 'Runtime state not found' });
    return { runtime: JSON.parse(runtime) };
  });

  app.get('/queues', { preHandler: authMiddleware }, async () => {
    const stats = await getAllQueueStats();
    return { queues: stats };
  });

  app.post('/jobs/:jobId/resume', { preHandler: authMiddleware }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const { input } = req.body as { input: string };
    if (!input) return reply.status(400).send({ error: 'input required' });

    const redis = await getRedisClient();
    await redis.publish(`job:resume:${jobId}`, input);
    return { jobId, resumed: true };
  });

  app.post('/jobs/:jobId/cancel', { preHandler: authMiddleware }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const redis = await getRedisClient();
    await redis.setEx(CacheKeys.jobCancel(jobId), 86400, '1');
    await redis.publish(`job:cancel:${jobId}`, 'cancel');
    const runtime = await redis.get(CacheKeys.jobRuntime(jobId));
    if (runtime) {
      const parsed = JSON.parse(runtime) as JobRuntimeState;
      await redis.setEx(
        CacheKeys.jobRuntime(jobId),
        86400,
        JSON.stringify({
          ...parsed,
          status: 'failed',
          updatedAt: new Date().toISOString(),
        })
      );
    }
    logger.warn('job:cancel-requested', { jobId });
    return { jobId, cancelled: true };
  });

  // ── Proxies ───────────────────────────────────────────────────

  const proxyManager = new ProxyManager();

  app.post('/proxies/import', { preHandler: authMiddleware }, async (req, reply) => {
    const { proxies } = req.body as {
      proxies: Array<{ host: string; port: number; username?: string; password?: string; protocol?: string; tags?: string[] }>;
    };
    if (!proxies?.length) return reply.status(400).send({ error: 'proxies array required' });
    const count = await proxyManager.importProxies(proxies);
    return { imported: count };
  });

  app.get('/proxies/stats', { preHandler: authMiddleware }, async () => {
    const stats = await proxyManager.getStats();
    return { stats };
  });

  // ── Graph / Map ───────────────────────────────────────────────

  app.get('/sites/:siteId/graph', { preHandler: authMiddleware }, async (req, reply) => {
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

  app.get('/sites/:siteId/elements', { preHandler: authMiddleware }, async (req, reply) => {
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

  // ── User Memory ──────────────────────────────────────────────

  app.get('/memory/profiles', { preHandler: [authMiddleware, requireUser] }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    return { profiles: await memoryService.getProfiles(userId) };
  });

  app.get('/memory/profiles/:profileName', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { profileName } = req.params as { profileName: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const profile = await memoryService.getProfileByName(userId, profileName);
    if (!profile) return reply.status(404).send({ error: 'Profile not found' });
    return { profile };
  });

  app.post('/memory/profiles', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { profileName, data } = req.body as {
      profileName: string;
      data: Record<string, string>;
    };

    if (!profileName || !data) {
      return reply.status(400).send({ error: 'profileName and data are required' });
    }

    await memoryService.saveProfile(userId, profileName, data);
    return {
      saved: true,
      profileName,
      data: memoryService.sanitizeProfileData(data),
    };
  });

  app.put('/memory/profiles/:profileName', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { profileName } = req.params as { profileName: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const body = req.body as {
      data?: Record<string, string>;
      newProfileName?: string;
    };

    if (body.newProfileName && body.newProfileName !== profileName) {
      const renamed = await memoryService.renameProfile(userId, profileName, body.newProfileName);
      if (!renamed) return reply.status(404).send({ error: 'Profile not found' });
    }

    if (body.data) {
      await memoryService.saveProfile(userId, body.newProfileName ?? profileName, body.data);
    }

    const updated = await memoryService.getProfileByName(userId, body.newProfileName ?? profileName);
    return { profile: updated };
  });

  app.delete('/memory/profiles/:profileName', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { profileName } = req.params as { profileName: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const deleted = await memoryService.deleteProfile(userId, profileName);
    if (!deleted) return reply.status(404).send({ error: 'Profile not found' });
    return { deleted: true, profileName };
  });

  // ── File Upload / Download ───────────────────────────────────

  const FILE_CATEGORIES = ['resume', 'signature', 'photo', 'document', 'receipt', 'other'] as const;
  type FileCategory = (typeof FILE_CATEGORIES)[number];

  app.post('/files/upload', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const body = req.body as {
      originalName: string;
      mimeType: string;
      base64Data: string;
      category?: FileCategory;
      profileName?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.originalName || !body.mimeType || !body.base64Data) {
      return reply.status(400).send({ error: 'originalName, mimeType, and base64Data are required' });
    }
    if (body.category && !FILE_CATEGORIES.includes(body.category)) {
      return reply.status(400).send({ error: `category must be one of: ${FILE_CATEGORIES.join(', ')}` });
    }

    const file = await fileStorageService.uploadBase64({ ...body, userId });
    return { file, references: fileStorageService.buildAutomationReferences(file) };
  });

  app.get('/files', { preHandler: [authMiddleware, requireUser] }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { category } = req.query as { category?: FileCategory };
    if (category && !FILE_CATEGORIES.includes(category)) {
      return { files: [] };
    }
    const files = await fileStorageService.listFiles(userId, category);
    return {
      files: files.map((file) => ({
        ...file,
        references: fileStorageService.buildAutomationReferences(file),
      })),
    };
  });

  app.get('/files/:fileId', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const file = await fileStorageService.getFile(fileId, userId);
    if (!file) return reply.status(404).send({ error: 'File not found' });
    return { file, references: fileStorageService.buildAutomationReferences(file) };
  });

  app.get('/files/:fileId/download', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const fileData = await fileStorageService.getFileContent(fileId, userId);
    if (!fileData) return reply.status(404).send({ error: 'File not found' });

    reply
      .header('Content-Type', fileData.file.mimeType)
      .header('Content-Disposition', `attachment; filename="${fileData.file.originalName}"`);

    // Auto-delete after download (Cost reduction)
    fileStorageService.deleteFile(fileId, userId).catch(() => {});

    return reply.send(fileData.buffer);
  });

  app.delete('/files/:fileId', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const userId = (req as typeof req & { userId: string }).userId;
    const deleted = await fileStorageService.deleteFile(fileId, userId);
    if (!deleted) return reply.status(404).send({ error: 'File not found' });
    return { deleted: true, fileId };
  });

  // ── Site Workflow Mapping ────────────────────────────────────

  app.get('/site-workflows/:siteId', { preHandler: authMiddleware }, async (req) => {
    const { siteId } = req.params as { siteId: string };
    return { workflows: await siteWorkflowService.listForSite(siteId) };
  });

  app.get('/workflows', { preHandler: authMiddleware }, async (req) => {
    const { siteId } = req.query as { siteId?: string };
    return {
      workflows: siteId
        ? await siteWorkflowService.listForSite(siteId)
        : await siteWorkflowService.listAll(),
    };
  });

  app.get('/workflow/:workflowId', { preHandler: authMiddleware }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const workflow = await siteWorkflowService.getWorkflow(workflowId);
    if (!workflow) return reply.status(404).send({ error: 'Workflow not found' });
    return { workflow };
  });

  app.get('/workflows/:workflowId', { preHandler: authMiddleware }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const workflow = await siteWorkflowService.getWorkflow(workflowId);
    if (!workflow) return reply.status(404).send({ error: 'Workflow not found' });
    return { workflow };
  });

  app.post('/site-workflows', { preHandler: authMiddleware }, async (req, reply) => {
    const body = req.body as {
      workflowKey?: string;
      siteId: string;
      category?: string;
      name: string;
      trigger: string;
      triggerPhrases?: string[];
      portalType?: 'government' | 'jobs' | 'education' | 'banking' | 'general' | 'aadhaar';
      siteSection?: string;
      entryUrl?: string;
      pageUrl?: string;
      pageUrlPattern?: string;
      pageUrlPatterns?: string[];
      requiredInputs?: string[];
      requiredFiles?: Array<'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other'>;
      instructions: string;
      defaultProfileName?: string;
      starterActionPlan?: ActionStep[];
      errorRecoveryPlan?: ActionStep[];
      version?: number;
      isActive?: boolean;
      completionArtifact?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.siteId || !body.name || !body.trigger || !body.instructions) {
      return reply.status(400).send({ error: 'siteId, name, trigger, and instructions are required' });
    }

    const workflow = await siteWorkflowService.saveWorkflow(body);
    return { workflow };
  });

  app.put('/workflow/:workflowId', { preHandler: authMiddleware }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const existing = await siteWorkflowService.getWorkflow(workflowId);
    if (!existing) return reply.status(404).send({ error: 'Workflow not found' });

    const body = req.body as {
      siteId?: string;
      workflowKey?: string;
      category?: string;
      name?: string;
      trigger?: string;
      triggerPhrases?: string[];
      portalType?: 'government' | 'jobs' | 'education' | 'banking' | 'general' | 'aadhaar';
      siteSection?: string;
      entryUrl?: string;
      pageUrl?: string;
      pageUrlPattern?: string;
      pageUrlPatterns?: string[];
      requiredInputs?: string[];
      requiredFiles?: Array<'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other'>;
      instructions?: string;
      defaultProfileName?: string;
      starterActionPlan?: ActionStep[];
      errorRecoveryPlan?: ActionStep[];
      version?: number;
      isActive?: boolean;
      completionArtifact?: string;
      metadata?: Record<string, unknown>;
    };

    const workflow = await siteWorkflowService.saveWorkflow({
      siteId: body.siteId ?? existing.siteId,
      workflowKey: body.workflowKey ?? existing.workflowKey,
      category: body.category ?? existing.category,
      name: body.name ?? existing.name,
      trigger: body.trigger ?? existing.trigger,
      triggerPhrases: body.triggerPhrases ?? existing.triggerPhrases,
      portalType: body.portalType ?? existing.portalType,
      siteSection: body.siteSection ?? existing.siteSection,
      entryUrl: body.entryUrl ?? existing.entryUrl,
      pageUrl: body.pageUrl ?? existing.pageUrl,
      pageUrlPattern: body.pageUrlPattern ?? existing.pageUrlPattern,
      pageUrlPatterns: body.pageUrlPatterns ?? existing.pageUrlPatterns,
      requiredInputs: body.requiredInputs ?? existing.requiredInputs,
      requiredFiles: body.requiredFiles ?? existing.requiredFiles,
      instructions: body.instructions ?? existing.instructions,
      defaultProfileName: body.defaultProfileName ?? existing.defaultProfileName,
      starterActionPlan: body.starterActionPlan ?? existing.starterActionPlan,
      errorRecoveryPlan: body.errorRecoveryPlan ?? existing.errorRecoveryPlan,
      version: body.version ?? existing.version,
      isActive: body.isActive ?? existing.isActive,
      completionArtifact: body.completionArtifact ?? existing.completionArtifact,
      metadata: body.metadata ?? existing.metadata,
    });

    return { workflow };
  });

  app.delete('/workflow/:workflowId', { preHandler: authMiddleware }, async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const deleted = await siteWorkflowService.deleteWorkflow(workflowId);
    if (!deleted) return reply.status(404).send({ error: 'Workflow not found' });
    return { deleted: true, workflowId };
  });

  app.post('/test/plan', { preHandler: authMiddleware }, async (req, reply) => {
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

  // ── Auth Routes (Google / email OTP / mobile OTP / admin login) ──
  registerAuthRoutes(app);

  // ── Admin Panel Routes ─────────────────────────────────────
  await registerAdminRoutes(app);
  await registerObservabilityAdminRoutes(app);
  await registerClientTelemetryRoutes(app);

  return app;
}

// ─── Entry Point ──────────────────────────────────────────────

async function main() {
  try {
    // Initialize infrastructure (OTEL first so migrations/HTTP are traced when enabled)
    await initNodeTelemetry();
    await runMigrations();
    if (process.env.WORKFLOW_AUTOLOAD !== 'false') {
      await workflowLoader.loadAllWorkflows();
    }

    const pool = getBrowserPool();
    await pool.init();

    const app = await buildApp();

    const port = parseInt(process.env.PORT ?? '3000');
    const host = process.env.HOST ?? '0.0.0.0';

    await app.listen({ port, host });
    logger.info('service:ready', { host, port, allowedOrigins: normalizeAllowedOrigins() });

    // ── WebSocket (Socket.io) Setup ─────────────────────────────
    const io = new SocketIOServer(app.server, {
      cors: {
        origin(origin, callback) {
          if (isAllowedOrigin(origin, normalizeAllowedOrigins())) {
            callback(null, true);
            return;
          }
          callback(new Error(`Origin ${origin} is not allowed by Socket.IO CORS`), false);
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['x-api-key', 'x-admin-key'],
        credentials: true, // required for the jp_session cookie to be sent cross-origin
      }
    });

    // Chat is the primary product surface, so it must never trust a
    // client-supplied userId — every connection is tied to the verified
    // session cookie instead, and `join`/`chat:send` use that resolved id.
    io.use(async (socket, next) => {
      const cookieHeader = socket.handshake.headers.cookie;
      const token = parseCookie(cookieHeader, SESSION_COOKIE);
      if (!token) {
        next(new Error('Unauthorized — please sign in'));
        return;
      }
      const claims = await verifySession(token);
      if (!claims) {
        next(new Error('Unauthorized — please sign in'));
        return;
      }
      (socket.data as { userId: string }).userId = claims.sub;
      next();
    });

    const pubClient = await getRedisClient();
    const subClient = pubClient.duplicate();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));

    const adminNs = io.of('/admin');
    adminNs.use(async (socket, next) => {
      // Prefer the admin session cookie (what the browser now uses — no key
      // ever touches client JS); fall back to the legacy x-admin-key header
      // for scripted/CI callers.
      const cookieToken = parseCookie(socket.handshake.headers.cookie, ADMIN_SESSION_COOKIE);
      if (cookieToken) {
        const claims = await verifyAdminSession(cookieToken);
        if (!claims) {
          next(new Error('Unauthorized'));
          return;
        }
        next();
        return;
      }

      const auth = socket.handshake.auth as { adminKey?: string } | undefined;
      const headerKey = socket.handshake.headers['x-admin-key'];
      const key = (typeof headerKey === 'string' ? headerKey : undefined) ?? auth?.adminKey;

      if (!key) {
        next(new Error('Unauthorized'));
        return;
      }

      try {
        const pool = getPgPool();
        const { rows } = await pool.query('SELECT id FROM admins WHERE api_key = $1', [key]);
        if (!rows.length) {
          next(new Error('Unauthorized'));
          return;
        }
        next();
      } catch (err) {
        next(new Error('Internal Server Error'));
      }
    });
    adminNs.on('connection', (socket) => {
      logger.info('admin-socket:connected', { socketId: socket.id });
      socket.emit('ready', { channel: 'observability' });
    });
    const adminObsSub = pubClient.duplicate();
    await adminObsSub.connect();
    await adminObsSub.subscribe(ADMIN_OBSERVABILITY_CHANNEL, (msg) => {
      try {
        adminNs.emit('feed', JSON.parse(msg));
      } catch {
        adminNs.emit('feed', { raw: msg });
      }
    });

    // Listen for events from ExecutionService (Pause for input)
    const systemSub = pubClient.duplicate();
    await systemSub.connect();
    
    await systemSub.subscribe('chat:pause', async (message) => {
      try {
        const payload = JSON.parse(message);
        const { jobId, stepId, type, contextMessage, data } = payload;
        const redis = await getRedisClient();
        const runtime = payload.userId && payload.sessionId
          ? payload
          : JSON.parse((await redis.get(CacheKeys.jobRuntime(jobId))) || '{}');

        if (!runtime?.userId || !runtime?.sessionId) return;

        await redis.setEx(
          CacheKeys.jobRuntime(jobId),
          86400,
          JSON.stringify({
            ...(runtime as JobRuntimeState),
            status: 'paused',
            activeStepId: stepId,
            lastInputType: type,
            updatedAt: new Date().toISOString(),
          })
        );

        io.to(`session:${runtime.sessionId}`).emit('chat:pause', {
          jobId,
          stepId,
          type,
          contextMessage,
          data
        });

        await chatOrchestrator.handleJobPauseRequest(
          runtime.userId,
          runtime.sessionId,
          jobId,
          stepId,
          type,
          contextMessage,
          (replyText) => { /* Ignored to prevent duplicate text message if frontend uses cards */ }
        );
      } catch (e) {
        logger.error('socket:chat-pause-handler-failed', e);
      }
    });

    await systemSub.subscribe('chat:file', async (message) => {
      try {
        const payload = JSON.parse(message);
        const redis = await getRedisClient();
        const runtime = payload.userId && payload.sessionId
          ? payload
          : JSON.parse((await redis.get(CacheKeys.jobRuntime(payload.jobId))) || '{}');

        if (!runtime?.sessionId) return;

        io.to(`session:${runtime.sessionId}`).emit('chat:file', {
          jobId: payload.jobId,
          fileId: payload.fileId,
          category: payload.category,
          originalName: payload.originalName,
          sourceFilename: payload.sourceFilename,
          message: `Saved ${payload.category} file "${payload.originalName}" for download.`,
        });
        io.to(`session:${runtime.sessionId}`).emit(
          'chat:receive',
          `Saved ${payload.category} file "${payload.originalName}" to your account files.`
        );
      } catch (e) {
        logger.error('socket:chat-file-handler-failed', e);
      }
    });

    await systemSub.subscribe('chat:message', async (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.sessionId && payload.message) {
          io.to(`session:${payload.sessionId}`).emit('chat:receive', payload.message);
        }
      } catch (e) {
        logger.error('socket:chat-message-handler-failed', e);
      }
    });

    // Track socket → active jobs for cleanup on disconnect
    const socketJobMap = new Map<string, { userId: string; sessionId: string; jobIds: Set<string> }>();

const systemMemoryGauge = new Gauge({
  name: 'system_memory_usage_bytes',
  help: 'Current system memory usage',
});
const activeSessionsGauge = new Gauge({
  name: 'system_active_sessions_total',
  help: 'Total number of active user sessions via WebSocket',
});

// Periodically update metrics
setInterval(() => {
  systemMemoryGauge.set(process.memoryUsage().rss);
  activeSessionsGauge.set(socketJobMap.size);
}, 10000);


    // Handle incoming connections
    io.on('connection', (socket) => {
      logger.info('socket:connected', { socketId: socket.id });
      
      const userId = (socket.data as { userId: string }).userId;

      socket.on('join', (data: { sessionId: string, activeJobId?: string }) => {
        logger.info('socket:join', {
          socketId: socket.id,
          userId,
          sessionId: data.sessionId,
          activeJobId: data.activeJobId,
        });
        socket.join(`user:${userId}`);
        socket.join(`session:${data.sessionId}`);

        // Track this socket's user/session
        if (!socketJobMap.has(socket.id)) {
          socketJobMap.set(socket.id, { userId, sessionId: data.sessionId, jobIds: new Set() });
        }

        if (data.activeJobId) {
          socket.join(`job:${data.activeJobId}`);
          socketJobMap.get(socket.id)!.jobIds.add(data.activeJobId);
          
          // Subscribe to live stream for this job
          const streamSub = pubClient.duplicate();
          streamSub.connect().then(() => {
            streamSub.subscribe(`live-stream:${data.activeJobId}`, (frame) => {
              socket.emit('live-stream:frame', frame);
            });
            
            socket.on('disconnect', () => {
              streamSub.unsubscribe();
              streamSub.quit();
            });
          });

          // Queue Position polling
          let queueInterval: NodeJS.Timeout;
          const pollQueue = async () => {
            try {
               const pos = await getJobPosition('execute', data.activeJobId!);
               if (pos !== null) {
                 socket.emit('job:queue-position', { jobId: data.activeJobId, position: pos });
               } else {
                 clearInterval(queueInterval);
               }
            } catch (err) {}
          };
          queueInterval = setInterval(pollQueue, 3000);
          pollQueue();

          socket.on('disconnect', () => clearInterval(queueInterval));
        }
      });

      socket.on('chat:send', async (data: { sessionId: string, message: string }) => {
        logger.info('socket:chat-send', {
          socketId: socket.id,
          userId,
          sessionId: data.sessionId,
          messagePreview: data.message.slice(0, 120),
        });
        await chatOrchestrator.handleMessage(
          userId,
          data.sessionId,
          data.message,
          (reply) => socket.emit('chat:receive', reply),
          (job) => {
            // Track the newly started job for this socket
            const tracked = socketJobMap.get(socket.id);
            if (tracked) tracked.jobIds.add(job.jobId);
            io.to(`session:${data.sessionId}`).emit('job:started', job);
          }
        );
      });

      socket.on('disconnect', async (reason) => {
        logger.info('socket:disconnected', { socketId: socket.id, reason });

        const tracked = socketJobMap.get(socket.id);
        if (tracked && tracked.jobIds.size > 0) {
          for (const jobId of tracked.jobIds) {
            logger.info('job:socket-detached-keeping-running', { jobId, socketId: socket.id, reason });
          }
        }
        socketJobMap.delete(socket.id);
      });

      socket.on('error', (error) => {
        logger.error('socket:error', error, { socketId: socket.id });
      });
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.warn('service:shutdown', { signal });
      io.close();
      await app.close();
      await pool.shutdown();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('service:fatal-startup-error', err);
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  logger.error('process:uncaught-exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('process:unhandled-rejection', reason);
});

main();
