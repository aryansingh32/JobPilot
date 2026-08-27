import 'dotenv/config';
import { createWorker } from '../shared/queue/index.js';
import { ExecutionEngine } from './executor.js';
import { getBrowserPool } from './browser-pool.js';
import { SiteCrawler, IncrementalRemapper } from '../crawler-service/crawler.js';
import { getAIPlanner, buildSyntheticSnapshot } from '../ai-service/planner.js';
import { runMigrations, getPgPool, CacheKeys, getRedisClient } from '../shared/db/index.js';
import { workflowLoader } from '../shared/workflow-loader.js';
import { collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
import type {
  CrawlJob, ExecuteJob, RemapJob,
  AIPlanJob, JobRuntimeState,
} from '../shared/types/index.js';

// ============================================================
// WORKER SERVICE
// Consumes all queue types:
//   • crawl → SiteCrawler
//   • execute → ExecutionEngine + hybrid planner
//   • remap → IncrementalRemapper
//   • ai-plan → AIPlanner (standalone)
// ============================================================

// ─── Prometheus Metrics ───────────────────────────────────────

collectDefaultMetrics({ prefix: 'worker_' });

const jobCounter = new Counter({
  name: 'worker_jobs_total',
  help: 'Total jobs processed',
  labelNames: ['type', 'status'],
});

const jobDuration = new Histogram({
  name: 'worker_job_duration_seconds',
  help: 'Job execution duration',
  labelNames: ['type'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
});

const activeBrowsers = new Gauge({
  name: 'worker_active_browsers',
  help: 'Active browser contexts in pool',
});

// ─── Worker Handlers ─────────────────────────────────────────

const aiPlanner     = getAIPlanner();
const executionEngine = new ExecutionEngine(
  (page, label, type, ctx) => aiPlanner.resolveSelector(page, label, type, ctx)
);

async function buildPlanningSnapshot(siteId: string) {
  const pool = getPgPool();
  const { rows: pages } = await pool.query(`
    SELECT
      p.id,
      p.url,
      sw.entry_url,
      sw.page_url,
      sw.page_url_pattern,
      s.domain
    FROM sites s
    LEFT JOIN pages p ON p.site_id = s.id
    LEFT JOIN site_workflows sw ON sw.site_id = s.id
    WHERE s.id = $1
    ORDER BY p.reliability_score DESC NULLS LAST, sw.updated_at DESC NULLS LAST
    LIMIT 1
  `, [siteId]);

  const page = pages[0];
  if (!page) {
    return { snapshot: buildSyntheticSnapshot(), elements: [] as any[] };
  }

  if (page.id) {
    const snapshot = await getRedisClient()
      .then((redis) => redis.get(CacheKeys.domSnapshot(page.id)))
      .then((raw) => raw ? JSON.parse(raw) : null)
      .catch(() => null);

    if (snapshot) {
      const { rows: elements } = await pool.query(
        `SELECT * FROM elements WHERE page_id = $1 AND interactable = true`,
        [page.id]
      );
      return { snapshot, elements };
    }
  }

  const fallbackUrl = page.entry_url || page.page_url || page.url
    || (page.domain ? `https://${page.domain}` : undefined);
  return { snapshot: buildSyntheticSnapshot(fallbackUrl), elements: [] as any[] };
}

async function updateRuntime(job: ExecuteJob, patch: Partial<JobRuntimeState>) {
  const redis = await getRedisClient();
  const existing = await redis.get(CacheKeys.jobRuntime(job.id));
  const base: JobRuntimeState = existing
    ? JSON.parse(existing)
    : {
        jobId: job.id,
        userId: job.userId,
        sessionId: job.sessionId ?? job.payload.sessionId,
        siteId: job.payload.siteId,
        task: job.payload.task,
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  await redis.setEx(
    CacheKeys.jobRuntime(job.id),
    86400,
    JSON.stringify({
      ...base,
      ...patch,
      updatedAt: new Date().toISOString(),
    })
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message?.trim() || error.name || 'Unknown execution worker error';
  }
  if (typeof error === 'string') {
    return error.trim() || 'Unknown execution worker error';
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'Unknown execution worker error';
  } catch {
    return String(error) || 'Unknown execution worker error';
  }
}

async function logUnhandledExecutionFailure(job: ExecuteJob, error: string) {
  const pool = getPgPool();
  await pool.query(`
    INSERT INTO job_logs (
      job_id, user_id, session_id, type, site_id, status, completed_at, duration_ms,
      success, ai_call_count, selector_fallback_cnt, retry_count, result, error, task
    ) VALUES ($1, $2, $3, 'execute', $4, 'failed', NOW(), 0, false, 0, 0, 0, $5, $6, $7)
  `, [
    job.id,
    job.userId,
    job.payload.sessionId,
    job.payload.siteId,
    JSON.stringify({ steps: [], source: 'worker-catch' }),
    error,
    job.payload.task,
  ]);
}

async function logDryRunResult(job: ExecuteJob, pauseSteps: Array<{ id: string; expectedInput: string | null; description: string }>) {
  const pool = getPgPool();
  await pool.query(`
    INSERT INTO job_logs (
      job_id, user_id, session_id, type, site_id, status, completed_at, duration_ms,
      success, ai_call_count, selector_fallback_cnt, retry_count, result, task
    ) VALUES ($1, $2, $3, 'execute', $4, 'completed', NOW(), 0, true, 0, 0, 0, $5, $6)
  `, [
    job.id,
    job.userId,
    job.payload.sessionId,
    job.payload.siteId,
    JSON.stringify({
      mode: 'dry-run',
      planSource: job.metadata?.planSource ?? null,
      matchedWorkflowId: job.metadata?.matchedWorkflowId ?? null,
      matchedWorkflowName: job.metadata?.matchedWorkflowName ?? null,
      actionPlanLength: job.payload.actionPlan?.length ?? 0,
      pauseSteps,
    }),
    job.payload.task,
  ]);
}

// Crawl Worker
const crawlWorker = createWorker<CrawlJob>('crawl', async (job) => {
  const end = jobDuration.startTimer({ type: 'crawl' });
  try {
    // Get site info
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT domain FROM sites WHERE id = $1`, [job.payload.url]);
    const domain = rows[0]?.domain ?? new URL(job.payload.url).hostname;

    const crawler = new SiteCrawler(job.id, domain);
    const result = await crawler.crawl(job);

    // Update site page count
    await pool.query(
      `UPDATE sites SET page_count = $1, updated_at = NOW() WHERE id = $2`,
      [result.pagesCrawled, (job as any).siteId ?? job.id]
    );

    jobCounter.inc({ type: 'crawl', status: 'success' });
    console.log(`[Worker] Crawl complete: ${result.pagesCrawled} pages in ${result.duration}ms`);
  } catch (err) {
    jobCounter.inc({ type: 'crawl', status: 'failure' });
    throw err;
  } finally {
    end();
  }
});

// Execution Worker
const executeWorker = createWorker<ExecuteJob>('execute', async (job) => {
  const end = jobDuration.startTimer({ type: 'execute' });
  let warningTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  try {
    await updateRuntime(job, { status: 'running' });

    const redis = await getRedisClient();

    // 10-minute warning
    warningTimer = setTimeout(async () => {
      try {
        await redis.publish('chat:message', JSON.stringify({
          sessionId: job.payload.sessionId,
          message: '⚠️ Your session has been inactive for 10 minutes. It will automatically close in 5 minutes if no action is taken.'
        }));
      } catch {}
    }, 10 * 60 * 1000);

    // 15-minute hard kill
    killTimer = setTimeout(async () => {
      try {
        await redis.publish('chat:message', JSON.stringify({
          sessionId: job.payload.sessionId,
          message: '🛑 Session expired due to 15 minutes of inactivity. Please start a new task.'
        }));
        await redis.setEx(`job-cancel:${job.id}`, 86400, '1');
        await redis.publish(`job:cancel:${job.id}`, 'cancel');
      } catch {}
    }, 15 * 60 * 1000);

    if (!job.payload.actionPlan) {
      const { snapshot, elements } = await buildPlanningSnapshot(job.payload.siteId);
      const decision = await aiPlanner.planTask(
        job.payload.task,
        job.payload.siteId,
        snapshot,
        elements,
        job.payload.useCache
      );
      job.payload.actionPlan = decision.actionPlan;
      job.metadata = {
        ...(job.metadata ?? {}),
        planSource: decision.source ?? 'ai-generated',
        matchedWorkflowId: decision.matchedWorkflowId,
        matchedWorkflowName: decision.matchedWorkflowName,
        fallbackPlan: decision.fallbackPlan,
        zeroShotHistoryId: decision.zeroShotHistoryId,
      };
      console.log(
        `[Worker] Planning source: ${decision.source ?? 'ai-generated'}`
        + (decision.matchedWorkflowName ? ` (${decision.matchedWorkflowName})` : '')
      );
    }

    if (job.payload.dryRun) {
      const pauseSteps = (job.payload.actionPlan ?? [])
        .filter((step) => step.action === 'pauseForUserInput')
        .map((step) => ({
          id: step.id,
          expectedInput: step.expectedInput ?? null,
          description: step.description ?? '',
        }));

      await logDryRunResult(job, pauseSteps);
      await updateRuntime(job, {
        status: pauseSteps.length ? 'paused' : 'completed',
        activeStepId: pauseSteps[0]?.id,
        lastInputType: pauseSteps[0]?.expectedInput as any,
      });

      jobCounter.inc({ type: 'execute', status: 'success' });
      return {
        jobId: job.id,
        success: true,
        steps: [],
        duration: 0,
        screenshots: [],
        sessionId: job.payload.sessionId,
      };
    }

    const result = await executionEngine.execute(job);

    // Record AI flow outcome — feeds the learning flywheel (zero-shot
    // history + cached-flow -> draft-workflow promotion).
    await aiPlanner.recordOutcome(job.payload.siteId, job.payload.task, result.success, {
      zeroShotHistoryId: job.metadata?.zeroShotHistoryId as string | undefined,
    });

    jobCounter.inc({ type: 'execute', status: result.success ? 'success' : 'failure' });

    // Update browser gauge
    activeBrowsers.set(getBrowserPool().getStats().activeContexts);

    return result;
  } catch (err) {
    jobCounter.inc({ type: 'execute', status: 'failure' });
    const error = getErrorMessage(err);
    await updateRuntime(job, { status: 'failed', error }).catch((runtimeError) => {
      console.error('[Worker] Failed to update runtime after execute error:', runtimeError);
    });
    await logUnhandledExecutionFailure(job, error).catch((logError) => {
      console.error('[Worker] Failed to log execute error:', logError);
    });
    throw err;
  } finally {
    if (warningTimer) clearTimeout(warningTimer);
    if (killTimer) clearTimeout(killTimer);
    end();
    if (!job.payload.dryRun) {
      await getBrowserPool().releaseContextBySessionId(job.payload.sessionId, false).catch(() => {});
      activeBrowsers.set(getBrowserPool().getStats().activeContexts);
    }
  }
}, { concurrency: 5 });

// Remap Worker
const remapWorker = createWorker<RemapJob>('remap', async (job) => {
  const end = jobDuration.startTimer({ type: 'remap' });
  try {
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT domain FROM sites WHERE id = $1`, [job.payload.siteId]);
    if (!rows.length) throw new Error(`Site ${job.payload.siteId} not found`);

    const domain = rows[0].domain;
    const remapper = new IncrementalRemapper(job.payload.siteId, domain);

    if (job.payload.affectedUrls?.length) {
      // Incremental remap
      await remapper.remapPages(job.payload.affectedUrls);
      console.log(`[Worker] Incremental remap: ${job.payload.affectedUrls.length} pages`);
    } else {
      // Full remap — re-crawl entire site
      const { rows: pages } = await pool.query(
        `SELECT url FROM pages WHERE site_id = $1`,
        [job.payload.siteId]
      );
      await remapper.remapPages(pages.map((p: any) => p.url));
      console.log(`[Worker] Full remap: ${pages.length} pages`);
    }

    jobCounter.inc({ type: 'remap', status: 'success' });
  } catch (err) {
    jobCounter.inc({ type: 'remap', status: 'failure' });
    throw err;
  } finally {
    end();
  }
}, { concurrency: 2 });

// AI Plan Worker (standalone planning without execution)
const aiPlanWorker = createWorker<AIPlanJob>('ai-plan', async (job) => {
  const end = jobDuration.startTimer({ type: 'ai-plan' });
  try {
    const { rows: elements } = await getPgPool().query(
      `SELECT * FROM elements WHERE page_id IN (
         SELECT id FROM pages WHERE site_id = $1
       ) AND interactable = true LIMIT 100`,
      [job.payload.siteId]
    );

    const decision = await aiPlanner.planTask(
      job.payload.task,
      job.payload.siteId,
      job.payload.domSnapshot,
      elements,
      true
    );

    console.log(`[Worker] AI plan ready: ${decision.actionPlan.length} steps, confidence: ${decision.confidence}`);
    jobCounter.inc({ type: 'ai-plan', status: 'success' });
    return decision;
  } catch (err) {
    jobCounter.inc({ type: 'ai-plan', status: 'failure' });
    throw err;
  } finally {
    end();
  }
});

// ─── Main ────────────────────────────────────────────────────

async function main() {
  await runMigrations();
  if (process.env.WORKFLOW_AUTOLOAD !== 'false') {
    await workflowLoader.loadAllWorkflows();
  }

  const pool = getBrowserPool();
  await pool.init();

  console.log('\n⚙️  Worker Service ready');
  console.log(`  • Crawl concurrency:   3`);
  console.log(`  • Execute concurrency: 5`);
  console.log(`  • Remap concurrency:   2`);
  console.log(`  • AI Plan concurrency: 5\n`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Worker] ${signal} received, stopping new jobs & draining (max 30s)...`);
    
    const drainPromise = Promise.allSettled([
      crawlWorker.close(),
      executeWorker.close(),
      remapWorker.close(),
      aiPlanWorker.close(),
    ]);

    // Timeout after 30 seconds
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 30_000));

    await Promise.race([drainPromise, timeoutPromise]);

    console.log(`[Worker] Draining finished or timed out. Shutting down browser pool...`);
    await pool.shutdown().catch(() => {});

    console.log(`[Worker] Closing database connections...`);
    const { getPgPool, getRedisClient } = await import('../shared/db/index.js');
    await getPgPool().end().catch(() => {});
    const redis = await getRedisClient().catch(() => null);
    if (redis) {
      await redis.quit().catch(() => {});
    }

    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Worker] Fatal:', err);
  process.exit(1);
});
