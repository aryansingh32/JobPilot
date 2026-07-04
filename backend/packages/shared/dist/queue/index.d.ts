import { Worker, type WorkerOptions } from 'bullmq';
import type { BaseJob, JobType } from '../types/index.js';
export declare function enqueueJob(job: import('../types/index.js').CrawlJob | import('../types/index.js').ExecuteJob | import('../types/index.js').RemapJob | import('../types/index.js').AIPlanJob | import('../types/index.js').BaseJob): Promise<string>;
export declare function createWorker<T extends BaseJob>(queueName: string, handler: (job: T) => Promise<unknown>, options?: Partial<WorkerOptions>): Worker;
export declare function getJobPosition(jobType: JobType, jobId: string): Promise<number | null>;
export declare function getAllQueueStats(): Promise<Record<string, {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
}>>;
export declare function closeAllQueues(): Promise<void>;
//# sourceMappingURL=index.d.ts.map