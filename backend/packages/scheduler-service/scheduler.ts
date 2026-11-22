import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import type { RemapJob, PollBoardJob } from '../shared/types/index.js';
import { dueBoards, seedBoardsIfEmpty } from '../shared/jobs/poller.js';
import { getBool, getNumber } from '../shared/config/settings.js';
import { enqueueJob, getQueue } from '../shared/queue/index.js';
import { applicationsService } from '../shared/applications/index.js';
import { autoApplyService } from '../shared/applications/auto-apply.js';
import { gmailService } from '../shared/gmail/index.js';
import { enqueueDiscovery } from '../shared/jobs/discovery.js';
import { getPgPool, runMigrations } from '../shared/db/index.js';
import { ProxyManager } from '../execution-service/proxy-manager.js';
import { SessionManager } from '../execution-service/session-manager.js';
import { ChangeDetector } from './change-detector.js';

// ============================================================
// SCHEDULER SERVICE
// Cron-driven background tasks:
//   • Change detection → incremental remap
//   • Full site remap (weekly)
//   • Proxy health checks
//   • Session cleanup
//   • Selector health reporting
// ============================================================

const proxyManager  = new ProxyManager();
const sessionMgr    = new SessionManager();
const changeDetector = new ChangeDetector();

// ─── Job Definitions ─────────────────────────────────────────

const jobs: Array<{ name: string; cron: string; handler: () => Promise<void> }> = [
  {
    // Jobs feed: every minute, queue the boards that are due (each board
    // carries its own next poll time) plus a share of new candidates.
    name: 'job-boards-poll',
    cron: '* * * * *',
    handler: async () => {
      if (!(await getBool('jobs.poll.enabled'))) return;
      const batch = await getNumber('jobs.poll.batch_size');
      const candidates = await getNumber('jobs.poll.candidates_per_tick');
      // Backpressure: while workers still have ~2 ticks of polls waiting, don't claim
      // more — claimed boards whose lease ran out in the queue would be polled twice.
      const waiting = await getQueue('jobs-poll').getWaitingCount();
      if (waiting > (batch + candidates) * 2) {
        console.log(`[Scheduler] ${waiting} polls still waiting — skipping this tick`);
        return;
      }
      const ids = await dueBoards(batch, candidates);
      for (const boardId of ids) {
        const job: PollBoardJob = {
          id: `poll-${boardId}-${Date.now()}`,
          type: 'jobs-poll',
          priority: 'low',
          createdAt: new Date(),
          userId: 'scheduler',
          payload: { boardId },
        };
        await enqueueJob(job).catch(() => {});
      }
      if (ids.length) console.log(`[Scheduler] Queued ${ids.length} job board polls`);
    },
  },

  {
    name: 'change-detection',
    cron: '*/10 * * * *',   // every 10 minutes
    handler: async () => {
      console.log('[Scheduler] 🔍 Running change detection');
      const pool = getPgPool();

      // Get all active sites
      const { rows: sites } = await pool.query(
        `SELECT id, domain FROM sites WHERE status = 'active'`
      );

      for (const site of sites) {
        const changedUrls = await changeDetector.detectChanges(site.id);

        if (changedUrls.length > 0) {
          console.log(`[Scheduler] Changes detected on ${site.domain}: ${changedUrls.length} pages`);

          const job: RemapJob = {
            id:        randomUUID(),
            type:      'remap',
            priority:  'normal',
            createdAt: new Date(),
            userId:    'scheduler',
            payload: {
              siteId:       site.id,
              affectedUrls: changedUrls,
              reason:       'change-detected',
            },
          };

          await enqueueJob(job);
        }
      }
    },
  },

  {
    name: 'full-remap',
    cron: '0 2 * * 0',      // Sunday at 2 AM
    handler: async () => {
      console.log('[Scheduler] 🗺️  Running full site remaps');
      const pool = getPgPool();
      const { rows: sites } = await pool.query(
        `SELECT id FROM sites WHERE status = 'active' AND updated_at < NOW() - INTERVAL '6 days'`
      );

      for (const site of sites) {
        const job: RemapJob = {
          id:        randomUUID(),
          type:      'remap',
          priority:  'low',
          createdAt: new Date(),
          userId:    'scheduler',
          payload:   { siteId: site.id, reason: 'scheduled' },
        };
        await enqueueJob(job);
      }

      console.log(`[Scheduler] Enqueued ${sites.length} full remaps`);
    },
  },

  {
    // Weekly: new company boards from the latest crawl + verified seeds.
    name: 'board-discovery',
    cron: '0 3 * * 0',
    handler: async () => {
      if (!(await getBool('jobs.discovery.enabled'))) return;
      await enqueueDiscovery({ source: 'seed' });
      await enqueueDiscovery({ source: 'commoncrawl' });
      console.log('[Scheduler] Board discovery queued');
    },
  },

  {
    // Auto Apply: users whose interval elapsed get their best new matches applied to.
    name: 'auto-apply',
    cron: '*/10 * * * *',
    handler: async () => {
      const users = await autoApplyService.runDue();
      if (users) console.log(`[Scheduler] Auto Apply ran for ${users} users`);
    },
  },

  {
    // Connected Gmail accounts: codes, verification links and employer replies
    // (every minute for users with an application waiting, else gmail.sync_minutes).
    name: 'gmail-sync',
    cron: '* * * * *',
    handler: async () => {
      const kept = await gmailService.syncDue();
      if (kept) console.log(`[Scheduler] Gmail: ${kept} job emails`);
    },
  },

  {
    // Applications whose run died (worker restart/crash) → failed, retryable.
    name: 'reconcile-applications',
    cron: '*/5 * * * *',
    handler: async () => {
      const closed = await applicationsService.reconcileOrphans();
      if (closed) console.log(`[Scheduler] Closed ${closed} interrupted applications`);
    },
  },

  {
    name: 'proxy-health-check',
    cron: '*/5 * * * *',    // every 5 minutes
    handler: async () => {
      console.log('[Scheduler] 🌐 Checking proxy health');
      await proxyManager.healthCheckAll();
    },
  },

  {
    name: 'session-cleanup',
    cron: '0 * * * *',      // every hour
    handler: async () => {
      console.log('[Scheduler] 🧹 Cleaning stale sessions');
      const removed = await sessionMgr.cleanupStale(24);
      console.log(`[Scheduler] Removed ${removed} stale sessions`);
    },
  },

  {
    name: 'selector-health-report',
    cron: '0 6 * * *',      // daily at 6 AM
    handler: async () => {
      console.log('[Scheduler] 📊 Generating selector health reports');
      const pool = getPgPool();

      const { rows } = await pool.query(`
        SELECT
          p.site_id,
          s.domain,
          COUNT(sel.id) AS total_selectors,
          COUNT(CASE WHEN sel.failure_count >= 5 THEN 1 END) AS broken,
          AVG(sel.confidence) AS avg_confidence,
          SUM(sel.failure_count) AS total_failures
        FROM selectors sel
        JOIN elements e ON sel.element_id = e.id
        JOIN pages p ON e.page_id = p.id
        JOIN sites s ON p.site_id = s.id
        GROUP BY p.site_id, s.domain
        ORDER BY broken DESC
      `);

      for (const row of rows) {
        const brokenPct = (row.broken / row.total_selectors) * 100;
        if (brokenPct > 20) {
          console.warn(
            `[Scheduler] ⚠️  Site ${row.domain}: ${brokenPct.toFixed(1)}% selectors broken — triggering remap`
          );
          const job: RemapJob = {
            id:        randomUUID(),
            type:      'remap',
            priority:  'high',
            createdAt: new Date(),
            userId:    'scheduler',
            payload:   { siteId: row.site_id, reason: 'selector-failure' },
          };
          await enqueueJob(job);
        }
      }
    },
  },

  {
    name: 'reliability-decay',
    cron: '0 0 * * *',      // midnight — decay stale pages
    handler: async () => {
      console.log('[Scheduler] 📉 Applying reliability decay to stale pages');
      await getPgPool().query(`
        UPDATE pages
        SET reliability_score = GREATEST(0.1, reliability_score * 0.95)
        WHERE last_verified < NOW() - INTERVAL '7 days'
      `);
    },
  },

  {
    name: 'flow-cache-cleanup',
    cron: '0 3 * * *',      // 3 AM daily
    handler: async () => {
      console.log('[Scheduler] 🗑️  Removing stale cached flows');
      const { rowCount } = await getPgPool().query(`
        DELETE FROM cached_flows
        WHERE last_used < NOW() - INTERVAL '30 days'
          AND failure_count > success_count
      `);
      console.log(`[Scheduler] Removed ${rowCount} stale cached flows`);
    },
  },
];

// ─── Job Runner ───────────────────────────────────────────────

async function safeRun(name: string, handler: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await handler();
    console.log(`[Scheduler] ✅ ${name} completed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[Scheduler] ❌ ${name} failed:`, (err as Error).message);
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  await runMigrations();
  await seedBoardsIfEmpty().catch((err) => console.error('[Scheduler] Board seed failed:', err));
  console.log('\n⏰ Scheduler Service starting...\n');

  const cronJobs = jobs.map(({ name, cron, handler }) => {
    const job = new CronJob(
      cron,
      () => safeRun(name, handler),
      null,
      true,           // start immediately
      'UTC'
    );

    const nextRun = job.nextDate().toFormat('yyyy-MM-dd HH:mm:ss');
    console.log(`  ✓ ${name.padEnd(30)} [${cron.padEnd(15)}] next: ${nextRun} UTC`);
    return job;
  });

  console.log(`\n[Scheduler] ${cronJobs.length} jobs scheduled\n`);

  // Run proxy health check immediately on startup
  await safeRun('proxy-health-check (initial)', () => proxyManager.healthCheckAll());

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Scheduler] Stopping...');
    cronJobs.forEach((j) => j.stop());
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Scheduler] Fatal:', err);
  process.exit(1);
});
