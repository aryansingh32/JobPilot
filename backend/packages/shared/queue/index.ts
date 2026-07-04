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

const QUEUE_NAMES: JobType[] = ['crawl', 'execute', 'remap', 'ai-plan'];

const queues: Map<string, Queue> = new Map();

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail:     { count: 500 },
        attempts:         3,
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

export async function enqueueJob(job: import('../types/index.js').CrawlJob | import('../types/index.js').ExecuteJob | import('../types/index.js').RemapJob | import('../types/index.js').AIPlanJob | import('../types/index.js').BaseJob): Promise<string> {
  const queue = getQueue(job.type);

  const bullJob = await queue.add(job.type, job, {
    jobId:    job.id,
    priority: PRIORITY_MAP[job.priority] ?? 5,
  });

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
