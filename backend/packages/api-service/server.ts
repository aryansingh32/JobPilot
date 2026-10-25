import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import type {
  CrawlJob, ExecuteJob, RemapJob,
  JobPriority,
} from '../shared/types/index.js';
import { DuplicateTaskError, enqueueJob, getAllQueueStats, getJobPosition, getQueue } from '../shared/queue/index.js';
import { getPgPool, getRedisClient, runMigrations, CacheKeys } from '../shared/db/index.js';
import { aggregateBrowserStats } from '../shared/control-bus/index.js';
import { register as promRegister, Gauge } from 'prom-client';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { chatOrchestrator } from './chat-orchestrator.js';
import { memoryService } from './user-memory.service.js';
import type { ActionStep, JobRuntimeState, SiteWorkflow } from '../shared/types/index.js';
import { fileStorageService } from './file-storage.service.js';
import { workflowLoader } from '../shared/workflow-loader.js';
import { createLogger } from '../shared/logger/index.js';
import { registerClientTelemetryRoutes } from './observability-routes.js';
import { registerPaymentRoutes } from './payment-routes.js';
import { registerMeRoutes, assertOwnsExecJob } from './me-routes.js';
import { applicationsService } from '../shared/applications/index.js';
import { persistErrorReport } from './observability.service.js';
import { initNodeTelemetry } from './telemetry.js';
import { resumeExecJob } from '../shared/applications/apply.js';
import { registerAuthRoutes, requireUser, SESSION_COOKIE, userFromSessionToken, bearerToken } from './auth-routes.js';
import { verifySession } from '../shared/auth/index.js';

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
  // The Android/iOS app (Capacitor) serves its bundled UI from these origins.
  const native = (process.env.NATIVE_APP_ORIGINS ?? 'https://localhost,capacitor://localhost')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set([...configured, ...defaults, ...native])];
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
    allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-key', 'Authorization', 'x-jp-client'],
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

    // Browsers run on workers; these are their heartbeat totals.
    const browserStats = await aggregateBrowserStats().catch(() => null);

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




  // ── Crawl ─────────────────────────────────────────────────────


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

    let jobId: string;
    try {
      jobId = await enqueueJob(job);
    } catch (err) {
      if (err instanceof DuplicateTaskError) return reply.status(409).send({ error: err.message, jobId: err.existingJobId });
      throw err;
    }
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


  // ── Jobs ─────────────────────────────────────────────────────

  app.get('/jobs/:jobId', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!(await assertOwnsExecJob(req, reply, jobId))) return;
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT * FROM job_logs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [jobId]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Job not found' });
    return { job: rows[0] };
  });

  app.get('/jobs/:jobId/runtime', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!(await assertOwnsExecJob(req, reply, jobId))) return;
    const redis = await getRedisClient();
    const runtime = await redis.get(CacheKeys.jobRuntime(jobId));
    if (!runtime) return reply.status(404).send({ error: 'Runtime state not found' });
    return { runtime: JSON.parse(runtime) };
  });


  app.post('/jobs/:jobId/resume', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!(await assertOwnsExecJob(req, reply, jobId))) return;
    const { input } = req.body as { input: string };
    if (!input) return reply.status(400).send({ error: 'input required' });

    // Parked applications continue in a new run; live ones get the value directly.
    const resumed = await resumeExecJob(jobId, input);
    return { jobId, resumed };
  });

  app.post('/jobs/:jobId/cancel', { preHandler: [authMiddleware, requireUser] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!(await assertOwnsExecJob(req, reply, jobId))) return;
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




  // ── Graph / Map ───────────────────────────────────────────────



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









  // ── Auth Routes (Google / email OTP / mobile OTP / admin login) ──
  registerAuthRoutes(app);

  // Admin routes live in admin-service (separate app/port). Only client
  // telemetry ingest stays here.
  await registerClientTelemetryRoutes(app);

  // Tsenta-style user API: profile, resume, jobs feed, applications, inbox.
  registerMeRoutes(app, authMiddleware);
  registerPaymentRoutes(app, authMiddleware);

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
        allowedHeaders: ['x-api-key', 'x-admin-key', 'Authorization'],
        credentials: true, // required for the jp_session cookie to be sent cross-origin
      }
    });

    // Chat is the primary product surface, so it must never trust a
    // client-supplied userId — every connection is tied to the verified
    // session cookie (or the app's bearer token, sent as `auth.token`)
    // instead, and `join`/`chat:send` use that resolved id.
    io.use(async (socket, next) => {
      const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const token =
        (typeof authToken === 'string' && authToken) ||
        bearerToken(socket.handshake.headers.authorization) ||
        parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      if (!token) {
        next(new Error('Unauthorized — please sign in'));
        return;
      }
      const userId = await userFromSessionToken(token);
      if (!userId) {
        next(new Error('Unauthorized — please sign in'));
        return;
      }
      (socket.data as { userId: string }).userId = userId;
      next();
    });

    const pubClient = await getRedisClient();
    const subClient = pubClient.duplicate();
    // A Redis blip on any duplicated subscriber client is otherwise a
    // fatal unhandled 'error' event that crashes the whole API process.
    subClient.on('error', (err) => logger.warn('redis:socketio-adapter-sub-error', { error: (err as Error).message }));
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));

    // Listen for events from ExecutionService (Pause for input)
    const systemSub = pubClient.duplicate();
    systemSub.on('error', (err) => logger.warn('redis:system-sub-error', { error: (err as Error).message }));
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

        await applicationsService
          .updateByExecJob(jobId, {
            status: type === 'review' ? 'awaiting_review' : 'needs_input',
            detail: contextMessage ?? null,
          })
          .catch((err) => logger.warn('application:pause-update-failed', { jobId, error: (err as Error).message }));

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

    // Run receipts — "proof it's done" card shown when a job finishes.
    await systemSub.subscribe('chat:receipt', async (message) => {
      try {
        const { sessionId, ...receipt } = JSON.parse(message);
        if (sessionId) io.to(`session:${sessionId}`).emit('chat:receipt', receipt);
      } catch (e) {
        logger.error('socket:chat-receipt-handler-failed', e);
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

      socket.on('join', async (data: { sessionId: string, activeJobId?: string }) => {
        // A job room carries live frames and progress: only its owner may subscribe.
        if (data.activeJobId) {
          const owner = (await getQueue('execute').getJob(data.activeJobId).catch(() => null))?.data?.userId;
          if (owner && owner !== userId) {
            logger.warn('socket:join-denied', { socketId: socket.id, userId, activeJobId: data.activeJobId });
            data = { ...data, activeJobId: undefined };
          }
        }
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
          streamSub.on('error', (err) => logger.warn('redis:stream-sub-error', { socketId: socket.id, jobId: data.activeJobId, error: (err as Error).message }));
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
          // Replies to code / ID / password questions are single tokens: never logged.
          messagePreview: /\s/.test(data.message.trim()) || data.message.length > 40 ? data.message.slice(0, 120) : '[short reply]',
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
          },
          (cards) => socket.emit('chat:ui', { cards }),
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
      await getPgPool().end().catch(() => {});
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
