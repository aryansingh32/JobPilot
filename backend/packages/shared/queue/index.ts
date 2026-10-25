import { Queue, Worker, Job, QueueEvents, type WorkerOptions } from 'bullmq';
import type { BaseJob, JobPriority, JobType } from '../types/index.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// QUEUE LAYER — BullMQ
// Typed job queues with priority support.
// Every user action → async job via queue.
// ============================================================

// ─── Redis Connection for BullMQ ─────────────────────────────

function getRedisConnection() {
  return {
    host:     process.env.REDIS_HOST ?? 'localhost',
    port:     parseInt(process.env.REDIS_PORT ?? '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,  // required by BullMQ
  };
}

// ─── Queue Registry ──────────────────────────────────────────

const QUEUE_NAMES: JobType[] = ['crawl', 'execute', 'remap', 'ai-plan', 'parse', 'jobs-poll', 'jobs-discover'];

const queues: Map<string, Queue> = new Map();

// Execute jobs drive a real browser and can have side effects outside our
// system (a submitted form, a sent message). An automatic retry after a
// failure that happened *after* the submit click would submit twice, so they
// run exactly once; retries are explicit (admin "retry" / user re-run).
// Crawl / remap / planning are read-only and safe to retry.
const QUEUE_ATTEMPTS: Partial<Record<string, number>> = { execute: 1, 'jobs-discover': 1 };

export function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail:     { count: 500 },
        attempts:         QUEUE_ATTEMPTS[name] ?? 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });
    queues.set(name, q);
  }
  return q;
}

// ─── Priority Mapping ────────────────────────────────────────

const PRIORITY_MAP: Record<JobPriority, number> = {
  critical: 1,
  high:     2,
  normal:   5,
  low:      10,
};

// ─── Enqueue Job ─────────────────────────────────────────────

type AnyJob = import('../types/index.js').CrawlJob | import('../types/index.js').ExecuteJob | import('../types/index.js').RemapJob | import('../types/index.js').AIPlanJob | import('../types/index.js').BaseJob;

// ─── Per-account task lock ───────────────────────────────────
// One in-flight browser task per account per kind of task. A double click, a
// chat resend or a scheduler overlap must not open a second run (and a second
// captcha / submission) for the same thing. Apply runs are keyed by the
// posting, so different jobs still run side by side.

const TASK_LOCK_TTL_S = 30 * 60;

export class DuplicateTaskError extends Error {
  constructor(public readonly existingJobId: string) {
    super('This task is already running for your account');
    this.name = 'DuplicateTaskError';
  }
}

function taskLockKey(job: AnyJob): string | null {
  if (job.type !== 'execute') return null;
  const p = (job as import('../types/index.js').ExecuteJob).payload;
  if (!p || p.dryRun) return null;
  const scope = p.context?.applyUrl ? `apply:${p.context.applyUrl}` : `task:${p.workflowKey ?? p.siteId}`;
  return `exec:inflight:${job.userId}:${scope}`;
}

/** Take the task lock for a job; throws DuplicateTaskError if a live run holds it. */
export async function acquireTaskLock(job: AnyJob): Promise<void> {
  const key = taskLockKey(job);
  if (!key) return;
  const queue = getQueue('execute');
  const redis = await queue.client;
  for (let tries = 0; tries < 2; tries++) {
    if (await redis.set(key, job.id, 'EX', TASK_LOCK_TTL_S, 'NX')) return;
    const holder = await redis.get(key);
    if (!holder || holder === job.id) continue;
    const state = await queue.getJob(holder).then((j) => j?.getState()).catch(() => undefined);
    if (state && ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
      throw new DuplicateTaskError(holder);
    }
    // Holder finished, vanished or died: the lock is stale, take it over.
    await redis.del(key);
  }
  throw new DuplicateTaskError((await redis.get(key)) ?? job.id);
}

/** Release only if this job still owns the lock. Safe to call twice. */
export async function releaseTaskLock(job: AnyJob): Promise<void> {
  const key = taskLockKey(job);
  if (!key) return;
  const redis = await getQueue('execute').client;
  if ((await redis.get(key)) === job.id) await redis.del(key);
}

// ─── Enqueue Job ─────────────────────────────────────────────

export async function enqueueJob(job: AnyJob): Promise<string> {
  const queue = getQueue(job.type);

  const alreadyLocked = (job.metadata as Record<string, unknown> | undefined)?.taskLocked === true;
  if (!alreadyLocked) await acquireTaskLock(job);

  let bullJob;
  try {
    bullJob = await queue.add(job.type, job, {
      jobId:    job.id,
      priority: PRIORITY_MAP[job.priority] ?? 5,
    });
  } catch (err) {
    await releaseTaskLock(job).catch(() => {});
    throw err;
  }

  logger.info('job:enqueued', { queue: job.type, jobId: job.id, priority: job.priority });
  return bullJob.id ?? job.id;
}

// ─── Create Worker ───────────────────────────────────────────

export function createWorker<T extends BaseJob>(
  queueName: string,
  handler: (job: T) => Promise<unknown>,
  options: Partial<WorkerOptions> = {}
): Worker {
  const worker = new Worker(
    queueName,
    async (bullJob: Job) => {
      const jobData = bullJob.data as T;
      logger.info('worker:processing', { queueName, jobId: jobData.id });
      return handler(jobData);
    },
    {
      connection: getRedisConnection(),
      concurrency: options.concurrency ?? 5,
      ...options,
    }
  );

  worker.on('completed', (job) => {
    logger.info('worker:completed', { queueName, jobId: job?.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('worker:failed', err, { queueName, jobId: job?.id });
  });

  worker.on('error', (err) => {
    logger.error('worker:error', err, { queueName });
  });

  logger.info('worker:registered', { queueName, concurrency: options.concurrency ?? 5 });
  return worker;
}

// ─── Queue Stats ─────────────────────────────────────────────

export async function getJobPosition(jobType: JobType, jobId: string): Promise<number | null> {
  const queue = getQueue(jobType);
  const waitingJobs = await queue.getWaiting();
  const index = waitingJobs.findIndex((j) => j.id === jobId);
  if (index === -1) return null;
  return index + 1; // 1-based position
}

export async function getAllQueueStats() {
  const stats: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }> = {};

  for (const name of QUEUE_NAMES) {
    const q = getQueue(name);
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    stats[name] = { waiting, active, completed, failed, delayed };
  }

  return stats;
}

// ─── Graceful Shutdown ───────────────────────────────────────

export async function closeAllQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
const logger = createLogger('shared-queue');
