type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined) ?? 'info';
const minimumLevel = LEVEL_PRIORITY[configuredLevel] ?? LEVEL_PRIORITY.info;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= minimumLevel;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { error };
}

// Scopes that get their own admin "Logs" tab regardless of which process
// they run in; everything else buckets under SERVICE_NAME (set per
// docker-compose service — see infrastructure/docker) so the admin tail
// still separates api/worker/scheduler output.
const SCOPE_SERVICE_OVERRIDES: Record<string, string> = {
  'auth-routes': 'auth',
  'execution-engine': 'execution',
};

function resolveServiceBucket(scope: string): string {
  return SCOPE_SERVICE_OVERRIDES[scope] ?? process.env.SERVICE_NAME ?? 'system';
}

// Feeds the admin panel's live "Logs" tail (GET /admin/logs reads this same
// `logs:<service>` Redis list — see admin-routes.ts). Dynamic import avoids a
// circular import: shared/db already imports createLogger from this module.
function tailToRedis(service: string, line: string): void {
  import('../db/index.js')
    .then(async ({ getRedisClient }) => {
      const redis = await getRedisClient();
      const key = `logs:${service}`;
      await redis.rPush(key, line);
      await redis.lTrim(key, -500, -1);
      await redis.expire(key, 86400);
    })
    .catch(() => {});
}

function write(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  if (!shouldLog(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  tailToRedis(resolveServiceBucket(scope), line);
}

export function createLogger(scope: string) {
  return {
    debug(message: string, context?: LogContext) {
      write('debug', scope, message, context);
    },
    info(message: string, context?: LogContext) {
      write('info', scope, message, context);
    },
    warn(message: string, context?: LogContext) {
      write('warn', scope, message, context);
    },
    error(message: string, error?: unknown, context?: LogContext) {
      write('error', scope, message, {
        ...(context ?? {}),
        ...(error === undefined ? {} : serializeError(error)),
      });
    },
    child(childScope: string) {
      return createLogger(`${scope}:${childScope}`);
    },
  };
}
