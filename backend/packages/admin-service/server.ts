import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { register as promRegister } from 'prom-client';
import { getPgPool, getRedisClient } from '../shared/db/index.js';
import { verifyAdminSession } from '../shared/auth/index.js';
import { createLogger } from '../shared/logger/index.js';
import { ADMIN_OBSERVABILITY_CHANNEL, persistErrorReport } from '../api-service/observability.service.js';
import { RECORD_FRAME_CHANNEL, RECORD_STEP_CHANNEL } from '../shared/control-bus/index.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerObservabilityAdminRoutes } from './observability-admin-routes.js';
import { ADMIN_SESSION_COOKIE, registerAdminAuthRoutes } from './admin-auth-routes.js';
import { registerAuditLog } from './admin-auth.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerProductRoutes } from './product-routes.js';
import { registerOperatorRoutes } from './operator-routes.js';
import { registerAutomationRoutes } from './automation-routes.js';
import { registerAccountRoutes } from './accounts-routes.js';

// ============================================================
// ADMIN SERVICE — the admin panel's API, separate from the user API:
// own port/domain, own CORS allowlist, own session cookie, optional IP
// allowlist. Talks to workers only through the control bus; never runs
// browsers or user-facing routes. Schema migrations are run by the API /
// migrate step, not here.
// ============================================================

const logger = createLogger('admin-service');

function allowedOrigins(): string[] {
  const configured = (process.env.ADMIN_CORS_ORIGIN ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const devDefaults =
    process.env.NODE_ENV === 'production'
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://localhost:8080'];
  return [...new Set([...configured, ...devDefaults])];
}

/** Optional comma-separated IPs; empty = no IP restriction (dev). */
function ipAllowlist(): Set<string> {
  return new Set(
    (process.env.ADMIN_IP_ALLOWLIST ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export async function buildAdminApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });
  const origins = allowedOrigins();
  const allowIps = ipAllowlist();

  if (allowIps.size) {
    app.addHook('onRequest', async (req, reply) => {
      if (!allowIps.has(req.ip)) {
        logger.warn('admin:ip-blocked', { ip: req.ip, url: req.url });
        return reply.status(403).send({ error: 'Forbidden' });
      }
    });
  }

  // Reject foreign browser origins up front with a clean 403 (the CORS plugin
  // would otherwise turn a rejection into a 500 and pollute error reports).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      logger.warn('admin:origin-blocked', { origin, url: req.url });
      return reply.status(403).send({ error: 'Origin not allowed' });
    }
  });

  await app.register(import('@fastify/cors'), {
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-key'],
    credentials: true,
  });
  await app.register(import('@fastify/cookie'));
  await app.register(import('@fastify/rate-limit'), {
    max: parseInt(process.env.ADMIN_RATE_LIMIT ?? '300'),
    timeWindow: '1 minute',
  });

  app.setErrorHandler(async (error, req, reply) => {
    const status = error.statusCode ?? 500;
    logger.error('request:error', error, { method: req.method, url: req.url, status });
    if (status >= 500) {
      await persistErrorReport({
        message: error.message || 'Internal Server Error',
        stack: error.stack,
        requestId: String(req.id),
        route: req.url,
        method: req.method,
        httpStatus: status,
        source: 'admin',
      }).catch(() => {});
    }
    reply.status(status).send({ error: error.message || 'Internal Server Error' });
  });

  app.get('/health', async () => {
    let db = false;
    try {
      await getPgPool().query('SELECT 1');
      db = true;
    } catch {}
    const redis = await getRedisClient().catch(() => null);
    const redisOk = redis ? await redis.ping().then(() => true).catch(() => false) : false;
    return { service: 'admin', status: db && redisOk ? 'healthy' : 'degraded', db, redis: redisOk };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', promRegister.contentType);
    return promRegister.metrics();
  });

  registerAuditLog(app);
  registerAdminAuthRoutes(app);
  await registerAdminRoutes(app);
  await registerPlatformRoutes(app);
  await registerProductRoutes(app);
  await registerOperatorRoutes(app);
  await registerAutomationRoutes(app);
  await registerAccountRoutes(app);
  await registerObservabilityAdminRoutes(app);
  return app;
}

/** Live admin feed (observability events, recorder steps) over Socket.IO namespace /admin. */
async function attachAdminSocket(app: FastifyInstance): Promise<void> {
  const io = new SocketIOServer(app.server, {
    cors: { origin: allowedOrigins(), credentials: true },
  });
  const pub = await getRedisClient();
  const sub = pub.duplicate();
  sub.on('error', (err) => logger.warn('redis:socketio-sub-error', { error: (err as Error).message }));
  await sub.connect();
  io.adapter(createAdapter(pub, sub));

  const adminNs = io.of('/admin');
  adminNs.use(async (socket, next) => {
    const token = parseCookie(socket.handshake.headers.cookie, ADMIN_SESSION_COOKIE);
    if (token && (await verifyAdminSession(token))) return next();
    // Legacy key auth for scripts/CI.
    const auth = socket.handshake.auth as { adminKey?: string } | undefined;
    const header = socket.handshake.headers['x-admin-key'];
    const key = (typeof header === 'string' ? header : undefined) ?? auth?.adminKey;
    if (!key) return next(new Error('Unauthorized'));
    try {
      const { rows } = await getPgPool().query('SELECT id FROM admins WHERE api_key = $1', [key]);
      return rows.length ? next() : next(new Error('Unauthorized'));
    } catch {
      return next(new Error('Internal Server Error'));
    }
  });
  adminNs.on('connection', (socket) => {
    logger.info('admin-socket:connected', { socketId: socket.id });
    socket.emit('ready', { channel: 'observability' });

    // Live view of any run (test runs, a user's stuck job): frames the executor streams.
    let watch: ReturnType<typeof pub.duplicate> | null = null;
    let keepAlive: NodeJS.Timeout | undefined;
    const unwatch = async () => {
      const w = watch;
      watch = null;
      clearInterval(keepAlive);
      await w?.quit().catch(() => {});
    };
    socket.on('watch-job', async (data: { jobId?: string }) => {
      await unwatch();
      if (!data?.jobId) return;
      // The executor only streams frames while this key exists.
      const mark = () => pub.setEx(`live:watch:${data.jobId}`, 30, '1').catch(() => {});
      await mark();
      keepAlive = setInterval(mark, 15_000);
      const w = pub.duplicate();
      w.on('error', () => {});
      await w.connect();
      watch = w;
      await w.subscribe(`live-stream:${data.jobId}`, (frame) => socket.emit('job:frame', { jobId: data.jobId, data: frame }));
    });
    socket.on('unwatch-job', unwatch);
    socket.on('disconnect', unwatch);
  });

  const feed = pub.duplicate();
  feed.on('error', (err) => logger.warn('redis:admin-feed-error', { error: (err as Error).message }));
  await feed.connect();
  await feed.subscribe(ADMIN_OBSERVABILITY_CHANNEL, (msg) => {
    try {
      adminNs.emit('feed', JSON.parse(msg));
    } catch {
      adminNs.emit('feed', { raw: msg });
    }
  });
  await feed.subscribe(RECORD_FRAME_CHANNEL, (msg) => {
    try {
      adminNs.emit('workflow:record-frame', JSON.parse(msg));
    } catch {
      /* ignore malformed frames */
    }
  });
  await feed.subscribe(RECORD_STEP_CHANNEL, (msg) => {
    try {
      adminNs.emit('workflow:record-step', JSON.parse(msg));
    } catch {
      /* ignore malformed recorder payloads */
    }
  });
}

async function main() {
  const app = await buildAdminApp();
  await attachAdminSocket(app);
  const port = parseInt(process.env.ADMIN_PORT ?? '3100');
  await app.listen({ port, host: '0.0.0.0' });
  logger.info('admin-service:listening', { port });

  const shutdown = async (signal: string) => {
    logger.info('admin-service:shutdown', { signal });
    await app.close().catch(() => {});
    await getPgPool().end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('admin-service:fatal', err);
  process.exit(1);
});
