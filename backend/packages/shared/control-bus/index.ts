import os from 'os';
import { randomUUID } from 'crypto';
import { getRedisClient } from '../db/index.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// CONTROL BUS — how the admin service talks to workers.
//
// The admin service never imports worker internals (a browser pool imported
// into another process is a different, empty pool). Instead:
//   • workers publish a heartbeat (real stats) into a Redis hash
//   • admin sends commands over pub/sub; workers run them and reply on a
//     per-request channel. Broadcast commands collect every reply until the
//     timeout; targeted ones resolve on the first reply.
// ============================================================

const logger = createLogger('control-bus');

/** Recorder steps streamed live to the admin panel. */
export const RECORD_STEP_CHANNEL = 'admin:record-step';
/** Live frames (and URL changes) of a recording session, for the admin's remote view. */
export const RECORD_FRAME_CHANNEL = 'admin:record-frame';

const HEARTBEAT_KEY = 'control:workers';
const COMMAND_CHANNEL = 'control:commands';
const replyChannel = (id: string) => `control:reply:${id}`;

/** A worker is considered gone if it hasn't reported for this long. */
export const HEARTBEAT_STALE_MS = 30_000;
const HEARTBEAT_EVERY_MS = 10_000;

export interface WorkerHeartbeat {
  workerId: string;
  host: string;
  pid: number;
  role: string;
  startedAt: string;
  at: string;
  draining: boolean;
  browsers?: { browsers: number; healthyBrowsers: number; activeContexts: number; totalCapacity: number };
  activeJobs?: number;
  load: number[];
  memory: { rss: number; systemTotal: number; systemFree: number };
}

export interface ControlCommand<P = unknown> {
  id: string;
  command: string;
  payload: P;
  /** Only this worker should handle it; omit to broadcast. */
  target?: string;
  sentAt: string;
}

export interface ControlReply<R = unknown> {
  workerId: string;
  ok: boolean;
  result?: R;
  error?: string;
}

export type CommandHandler = (payload: unknown, cmd: ControlCommand) => Promise<unknown>;

// ─── Worker side ─────────────────────────────────────────────

export function newWorkerId(role: string): string {
  return `${role}@${os.hostname()}:${process.pid}`;
}

/**
 * Start reporting this worker's health. `snapshot` is called on every beat so
 * the numbers are always live. Returns a stop function (call on shutdown).
 */
export function startHeartbeat(
  workerId: string,
  role: string,
  snapshot: () => Partial<Pick<WorkerHeartbeat, 'browsers' | 'activeJobs' | 'draining'>>,
): () => Promise<void> {
  const startedAt = new Date().toISOString();
  const beat = async () => {
    try {
      const redis = await getRedisClient();
      const mem = process.memoryUsage();
      const hb: WorkerHeartbeat = {
        workerId,
        host: os.hostname(),
        pid: process.pid,
        role,
        startedAt,
        at: new Date().toISOString(),
        draining: false,
        load: os.loadavg(),
        memory: { rss: mem.rss, systemTotal: os.totalmem(), systemFree: os.freemem() },
        ...snapshot(),
      };
      await redis.hSet(HEARTBEAT_KEY, workerId, JSON.stringify(hb));
    } catch (err) {
      logger.warn('heartbeat:failed', { workerId, error: (err as Error).message });
    }
  };
  void beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  return async () => {
    clearInterval(timer);
    try {
      const redis = await getRedisClient();
      await redis.hDel(HEARTBEAT_KEY, workerId);
    } catch {
      /* shutting down anyway */
    }
  };
}

/** Subscribe to admin commands. Returns an unsubscribe function. */
export async function registerCommandHandlers(
  workerId: string,
  handlers: Record<string, CommandHandler>,
): Promise<() => Promise<void>> {
  const redis = await getRedisClient();
  const sub = redis.duplicate();
  sub.on('error', (err) => logger.warn('commands:sub-error', { workerId, error: (err as Error).message }));
  await sub.connect();
  await sub.subscribe(COMMAND_CHANNEL, async (raw) => {
    let cmd: ControlCommand;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return;
    }
    if (cmd.target && cmd.target !== workerId) return;
    const handler = handlers[cmd.command];
    if (!handler) return; // another role handles it
    let reply: ControlReply;
    try {
      reply = { workerId, ok: true, result: await handler(cmd.payload, cmd) };
    } catch (err) {
      reply = { workerId, ok: false, error: (err as Error).message };
    }
    logger.info('command:handled', { workerId, command: cmd.command, ok: reply.ok });
    await redis.publish(replyChannel(cmd.id), JSON.stringify(reply));
  });
  logger.info('commands:registered', { workerId, commands: Object.keys(handlers) });
  return async () => {
    await sub.unsubscribe(COMMAND_CHANNEL).catch(() => {});
    await sub.quit().catch(() => {});
  };
}

// ─── Admin side ──────────────────────────────────────────────

export async function listWorkers(includeStale = false): Promise<WorkerHeartbeat[]> {
  const redis = await getRedisClient();
  const all = await redis.hGetAll(HEARTBEAT_KEY);
  const now = Date.now();
  const workers: WorkerHeartbeat[] = [];
  for (const raw of Object.values(all)) {
    try {
      const hb = JSON.parse(raw) as WorkerHeartbeat;
      const stale = now - new Date(hb.at).getTime() > HEARTBEAT_STALE_MS;
      if (!stale || includeStale) workers.push(hb);
    } catch {
      /* skip malformed */
    }
  }
  return workers.sort((a, b) => a.workerId.localeCompare(b.workerId));
}

/** Remove heartbeats of workers that stopped without cleaning up. */
export async function pruneStaleWorkers(): Promise<number> {
  const redis = await getRedisClient();
  const all = await redis.hGetAll(HEARTBEAT_KEY);
  const now = Date.now();
  const stale = Object.entries(all)
    .filter(([, raw]) => {
      try {
        return now - new Date((JSON.parse(raw) as WorkerHeartbeat).at).getTime() > HEARTBEAT_STALE_MS;
      } catch {
        return true;
      }
    })
    .map(([id]) => id);
  if (stale.length) await redis.hDel(HEARTBEAT_KEY, stale);
  return stale.length;
}

/** Sum browser stats across live workers. */
export async function aggregateBrowserStats() {
  const workers = await listWorkers();
  return workers.reduce(
    (acc, w) => {
      acc.workers += 1;
      acc.browsers += w.browsers?.browsers ?? 0;
      acc.healthyBrowsers += w.browsers?.healthyBrowsers ?? 0;
      acc.activeContexts += w.browsers?.activeContexts ?? 0;
      acc.totalCapacity += w.browsers?.totalCapacity ?? 0;
      return acc;
    },
    { workers: 0, browsers: 0, healthyBrowsers: 0, activeContexts: 0, totalCapacity: 0 },
  );
}

/**
 * Send a command. Targeted → resolves with the first reply. Broadcast →
 * collects replies until `timeoutMs`. Rejects a targeted command on timeout.
 */
export async function sendCommand<R = unknown>(
  command: string,
  payload: unknown = {},
  opts: { target?: string; timeoutMs?: number } = {},
): Promise<ControlReply<R>[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const redis = await getRedisClient();
  const sub = redis.duplicate();
  sub.on('error', () => {});
  await sub.connect();
  const cmd: ControlCommand = {
    id: randomUUID(),
    command,
    payload,
    target: opts.target,
    sentAt: new Date().toISOString(),
  };
  const replies: ControlReply<R>[] = [];
  try {
    return await new Promise<ControlReply<R>[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (opts.target && replies.length === 0) {
          reject(new Error(`Worker ${opts.target} did not answer "${command}" within ${timeoutMs}ms`));
        } else {
          resolve(replies);
        }
      }, timeoutMs);
      sub
        .subscribe(replyChannel(cmd.id), (raw) => {
          try {
            replies.push(JSON.parse(raw));
          } catch {
            return;
          }
          if (opts.target) {
            clearTimeout(timer);
            resolve(replies);
          }
        })
        .then(() => redis.publish(COMMAND_CHANNEL, JSON.stringify(cmd)))
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  } finally {
    await sub.unsubscribe(replyChannel(cmd.id)).catch(() => {});
    await sub.quit().catch(() => {});
  }
}

/** Pick the live worker with the most spare browser capacity (for recording, dry-runs). */
export async function pickWorker(role = 'execute'): Promise<WorkerHeartbeat | null> {
  const workers = (await listWorkers()).filter((w) => w.role === role && !w.draining);
  if (!workers.length) return null;
  const spare = (w: WorkerHeartbeat) => (w.browsers?.totalCapacity ?? 0) - (w.browsers?.activeContexts ?? 0);
  return workers.sort((a, b) => spare(b) - spare(a))[0];
}
