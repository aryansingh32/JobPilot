#!/usr/bin/env node
/**
 * verify-redis-reconnect.mjs — Real Redis-outage test.
 *
 * Starts an actual pauseForUserInput call (a live human-verification
 * checkpoint, exactly as a real workflow would hit), then KILLS the local
 * Redis server process out from under it mid-pause, waits, restarts
 * Redis, and checks whether the paused step's subscriber connection
 * (a `redis.duplicate()` client, same as executor.ts uses for real) comes
 * back on its own and still receives the human's answer — i.e. whether a
 * Redis blip during a live pause is actually recoverable, not just
 * "configured to try."
 *
 * Requires a local `redis-server` on the PATH and nothing else already
 * bound to REDIS_PORT (default 6379) — this script owns starting/killing
 * it. Does not touch Postgres.
 */

import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
function ok(label) { console.log(`  ${GREEN}✓${RESET} ${label}`); passed++; }
function bad(label, detail) { console.log(`  ${RED}✗${RESET} ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
function assert(cond, label, detail) { cond ? ok(label) : bad(label, detail); }
function section(t) { console.log(`\n${CYAN}▶ ${t}${RESET}`); }

const REDIS_PORT = process.env.REDIS_PORT ?? '6379';

function redisAlive() {
  try {
    execSync(`redis-cli -p ${REDIS_PORT} ping`, { stdio: 'pipe' }).toString().trim();
    return true;
  } catch {
    return false;
  }
}

function killRedis() {
  try { execSync(`redis-cli -p ${REDIS_PORT} shutdown nosave`, { stdio: 'pipe' }); } catch { /* connection drops as part of shutdown — expected */ }
}

function startRedis() {
  spawn('redis-server', ['--daemonize', 'yes', '--port', REDIS_PORT], { stdio: 'ignore' });
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

console.log(`${YELLOW}Pre-flight: confirming Redis is up before we start...${RESET}`);
if (!redisAlive()) { startRedis(); await waitFor(() => redisAlive(), { timeoutMs: 5000 }); }
assert(redisAlive(), 'Redis reachable before test starts');

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'verify-script-admin-key';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'changeme';

const { getRedisClient } = await import('../packages/shared/db/index.js');
const { runMigrations, getPgPool } = await import('../packages/shared/db/index.js');
const { ACTION_HANDLERS } = await import('../packages/execution-service/executor.js');

await runMigrations();
const pool = getPgPool();
const redis = await getRedisClient();

const siteId = randomUUID();
await pool.query(`INSERT INTO sites (id, domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [siteId, `verify-redis-reconnect-${siteId.slice(0, 8)}.test`]);
const userId = randomUUID();
await pool.query(`INSERT INTO users (id, plan) VALUES ($1, 'free') ON CONFLICT (id) DO NOTHING`, [userId]);

function makeMockPage() {
  return {
    url: () => 'https://verify-redis-reconnect.example/form',
    evaluate: async () => ({ detected: false, type: 'unknown' }),
    locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('x'), getAttribute: async () => null, boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }), textContent: async () => '' }) }),
    frameLocator: () => ({ locator: () => ({ click: async () => {}, count: async () => 0 }) }),
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {} },
  };
}

section('Live pause survives Redis being killed and restarted mid-wait');

const jobId = randomUUID();
const ctx = {
  jobId, userId, sessionId: randomUUID(), siteId, task: 'verify redis reconnect',
  page: makeMockPage(), runtimeInputs: {}, extractedData: {}, workflowStack: [],
  metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 }, cancellation: { cancelled: false },
};
const step = { id: 'redis-outage-step', action: 'pauseForUserInput', expectedInput: 'otp', timeout: 60000 };

let handlerSettled = false;
let handlerError = null;
const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx)
  .catch((e) => { handlerError = e; })
  .finally(() => { handlerSettled = true; });

const pendingAppeared = await waitFor(async () => (await redis.exists(`captcha:pending:${jobId}`)) === 1);
assert(pendingAppeared, 'pause is live — captcha:pending entry exists, subscriber is subscribed');

console.log(`${YELLOW}  Killing Redis (redis-cli shutdown nosave) with the pause still open...${RESET}`);
killRedis();
await waitFor(() => Promise.resolve(!redisAlive()), { timeoutMs: 5000 });
assert(!redisAlive(), 'Redis process is actually down');
assert(!handlerSettled, 'the pause did NOT immediately crash/reject just because Redis went away');

console.log(`${YELLOW}  Redis down for 2s (letting the reconnect backoff actually engage)...${RESET}`);
await new Promise((r) => setTimeout(r, 2000));
assert(!handlerSettled, 'still not settled after 2s of outage — waiting, not failing');

console.log(`${YELLOW}  Restarting Redis...${RESET}`);
startRedis();
const cameBack = await waitFor(() => Promise.resolve(redisAlive()), { timeoutMs: 10000 });
assert(cameBack, 'Redis process is back up');

console.log(`${YELLOW}  Waiting for the main client to report itself reconnected...${RESET}`);
const mainReconnected = await waitFor(async () => { try { return (await redis.ping()) === 'PONG'; } catch { return false; } }, { timeoutMs: 10000 });
assert(mainReconnected, 'this process\'s own Redis client (getRedisClient()) reconnected on its own');

console.log(`${YELLOW}  Publishing the human's answer now that Redis is back...${RESET}`);
// Give the internal subRedis duplicate a brief moment to finish its own
// reconnect + resubscribe before we publish — this is the real question:
// does node-redis's pub/sub client resubscribe automatically?
await new Promise((r) => setTimeout(r, 500));
await redis.publish(`job:resume:${jobId}`, 'ANSWERED-AFTER-OUTAGE');

const resolved = await waitFor(() => Promise.resolve(handlerSettled), { timeoutMs: 15000 });
assert(resolved, 'the paused step actually resolved after Redis came back (subscriber resubscribed on its own)');
assert(handlerError === null, 'no error was thrown recovering from the outage', handlerError?.message);
assert(ctx.runtimeInputs[step.id] === 'ANSWERED-AFTER-OUTAGE', 'the post-outage answer was correctly received');

const pendingGone = await waitFor(async () => (await redis.exists(`captcha:pending:${jobId}`)) === 0, { timeoutMs: 5000 });
assert(pendingGone, 'captcha:pending was cleaned up after recovery, not left dangling');

const { rows } = await pool.query(`SELECT status, resolved_by FROM human_intervention_events WHERE job_id = $1 AND step_id = $2`, [jobId, step.id]);
assert(rows[0]?.status === 'resolved' && rows[0]?.resolved_by === 'human_user', 'the event was still correctly logged despite the mid-flight outage', JSON.stringify(rows[0]));

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${GREEN}Passed: ${passed}${RESET}   ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);
console.log('═'.repeat(60));

await redis.quit().catch(() => {});
await pool.end().catch(() => {});
process.exit(failed > 0 ? 1 : 0);
