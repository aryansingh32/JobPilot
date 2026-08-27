#!/usr/bin/env node
/**
 * verify-captcha-fallback.mjs — Real, end-to-end verification of the
 * CAPTCHA/human-verification subsystem against a live Postgres + Redis.
 *
 * This does NOT mock the orchestrator, the plan-gate, the event log, or
 * the executor's actual pauseForUserInput handler — it imports and calls
 * the real production code (ACTION_HANDLERS.pauseForUserInput, exported
 * from executor.ts specifically for this). Only two things are faked:
 *   - the Playwright `Page` (DOM inspection is replaced with canned
 *     results per scenario — no real browser needed)
 *   - the solver-provider HTTP endpoint (a tiny local server standing in
 *     for 2Captcha's in.php/res.php contract)
 * Redis pub/sub, Postgres writes, and the pause/resume/timeout/cancel
 * state machine are all real.
 */

import { randomUUID } from 'crypto';
import http from 'http';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
const failures = [];

function ok(label) { console.log(`  ${GREEN}✓${RESET} ${label}`); passed++; }
function bad(label, detail) { console.log(`  ${RED}✗${RESET} ${label}${detail ? ` — ${detail}` : ''}`); failed++; failures.push(label); }
function section(title) { console.log(`\n${CYAN}▶ ${title}${RESET}`); }
function assert(cond, label, detail) { cond ? ok(label) : bad(label, detail); }

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'verify-script-admin-key';
process.env.CAPTCHA_MAX_AUTO_ATTEMPTS = process.env.CAPTCHA_MAX_AUTO_ATTEMPTS || '2';

const { runMigrations, getPgPool, getRedisClient } = await import('../packages/shared/db/index.js');
const { ACTION_HANDLERS } = await import('../packages/execution-service/executor.js');

console.log(`${YELLOW}Setting up: migrations, test site, test users...${RESET}`);
await runMigrations();
const pool = getPgPool();
const redis = await getRedisClient();

const siteId = randomUUID();
await pool.query(
  `INSERT INTO sites (id, domain) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
  [siteId, `verify-captcha-${siteId.slice(0, 8)}.test`]
);

const freeUserId = randomUUID();
const premiumUserId = randomUUID();
await pool.query(`INSERT INTO users (id, plan) VALUES ($1, 'free') ON CONFLICT (id) DO NOTHING`, [freeUserId]);
await pool.query(`INSERT INTO users (id, plan) VALUES ($1, 'premium') ON CONFLICT (id) DO NOTHING`, [premiumUserId]);

const workflowKey = `verify-checkpoint-${siteId.slice(0, 8)}`;
await pool.query(
  `INSERT INTO site_workflows (site_id, workflow_key, name, trigger, instructions, starter_action_plan, status)
   VALUES ($1, $2, 'Verify Checkpoint Workflow', 'verify checkpoint', 'test fixture', '[]', 'draft')
   ON CONFLICT (workflow_key) DO NOTHING`,
  [siteId, workflowKey]
);

// ── Fake solver-provider HTTP server (2Captcha in.php/res.php contract) ──
let providerHits = [];
let providerMode = 'succeed'; // 'succeed' | 'unreachable'
const providerServer = http.createServer((req, res) => {
  providerHits.push(req.url);
  const url = new URL(req.url, 'http://localhost');
  if (req.url.startsWith('/in.php')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 1, request: 'fake-provider-task-id' }));
  } else if (req.url.startsWith('/res.php')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 1, request: 'FAKE-SOLVED-TOKEN-42' }));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
const providerPort = providerServer.address().port;

// ── Mock Playwright Page ─────────────────────────────────────────────
function makeMockPage({ widget, security } = {}) {
  const defaultWidget = { detected: false, type: 'unknown' };
  const defaultSecurity = { title: '', bodyText: '', hasCfWrapper: false };
  return {
    url: () => 'https://verify-captcha-test.example/form',
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('hasCfWrapper')) return security ?? defaultSecurity;
      return widget ?? defaultWidget;
    },
    locator: () => ({
      first: () => ({
        screenshot: async () => Buffer.from('fake-jpeg-bytes'),
        getAttribute: async () => null,
        boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 80 }),
        textContent: async () => 'ok',
        click: async () => {},
      }),
    }),
    frameLocator: () => ({
      locator: (sel) => ({
        click: async () => {},
        count: async () => (sel.includes('checkbox-checked') || sel.includes('aria-checked') ? 1 : 0),
      }),
    }),
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {} },
  };
}

function makeCtx({ userId, sessionId, workflowKeyOverride } = {}) {
  const jobId = randomUUID();
  return {
    jobId,
    userId: userId ?? freeUserId,
    sessionId: sessionId ?? randomUUID(),
    siteId,
    workflowKey: workflowKeyOverride,
    task: 'verify-captcha-fallback test task',
    page: null, // set per-test
    runtimeInputs: {},
    extractedData: {},
    workflowStack: [],
    metrics: { aiCallCount: 0, selectorFallbackCount: 0, retryCount: 0 },
    cancellation: { cancelled: false },
  };
}

async function getEvent(jobId, stepId) {
  const { rows } = await pool.query(
    `SELECT * FROM human_intervention_events WHERE job_id = $1 AND step_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [jobId, stepId]
  );
  return rows[0] ?? null;
}

async function pendingKeyExists(jobId) {
  return (await redis.exists(`captcha:pending:${jobId}`)) === 1;
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ============================================================
// SCENARIO A — OTP checkpoint, no captcha widget: skips auto tiers
// entirely, goes straight to human, end user answers via chat.
// ============================================================
section('A. OTP checkpoint (workflow-authored) — human resolves, end-user path');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage();
  const step = { id: 'otp-step', action: 'pauseForUserInput', expectedInput: 'otp', contextMessage: 'Enter the OTP sent to your phone' };

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  const pendingAppeared = await waitFor(() => pendingKeyExists(ctx.jobId));
  assert(pendingAppeared, 'captcha:pending mirror created for the paused job');

  await redis.publish(`job:resume:${ctx.jobId}`, '482913');
  await handlerPromise;

  assert(ctx.runtimeInputs[step.id] === '482913', 'runtimeInputs received the OTP the user typed');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.event_type === 'otp', 'event logged with event_type=otp', evt?.event_type);
  assert(evt?.status === 'resolved' && evt?.resolved_by === 'human_user', 'event resolved_by=human_user', `${evt?.status}/${evt?.resolved_by}`);
  assert(!(await pendingKeyExists(ctx.jobId)), 'captcha:pending cleaned up after resolve');
}

// ============================================================
// SCENARIO B — Real reCAPTCHA v2 widget, tier-1 free auto-solve
// succeeds: NO human ever involved.
// ============================================================
section('B. reCAPTCHA v2 — tier-1 free auto-solve succeeds, no human reached');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage({ widget: { detected: true, type: 'recaptcha-v2', selector: '.g-recaptcha', sitekey: 'test-sitekey-b' } });
  const step = { id: 'captcha-step', action: 'pauseForUserInput', expectedInput: 'captcha' };

  await ACTION_HANDLERS.pauseForUserInput(step, ctx);

  assert(!(await pendingKeyExists(ctx.jobId)), 'no human-loop pending entry was ever created');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.status === 'resolved' && evt?.resolved_by === 'auto', 'event resolved_by=auto (tier 1)', `${evt?.status}/${evt?.resolved_by}`);
  assert(Number(evt?.cost_usd) === 0, 'tier-1 solve cost $0', evt?.cost_usd);
}

// ============================================================
// SCENARIO C — image-text captcha, no provider configured for this
// call: falls to human. Also proves the image-text selector-capture
// fix (detector now returns a selector for image-text).
// ============================================================
section('C. image-text captcha, no provider reachable — falls to human');
{
  delete process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY;
  delete process.env.CAPTCHA_SOLVER_API_KEY;
  const ctx = makeCtx({ userId: premiumUserId }); // even premium — no provider configured at all
  ctx.page = makeMockPage({ widget: { detected: true, type: 'image-text', selector: 'img[src*="captcha"], img[alt*="captcha" i], canvas[id*="captcha"]' } });
  const step = { id: 'imgcaptcha-step', action: 'pauseForUserInput', expectedInput: 'captcha' };

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  await waitFor(() => pendingKeyExists(ctx.jobId));
  await redis.publish(`job:resume:${ctx.jobId}`, 'H4X9Q2');
  await handlerPromise;

  assert(ctx.runtimeInputs[step.id] === 'H4X9Q2', 'human-provided captcha text was used');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.challenge_type === 'image-text', 'event challenge_type=image-text', evt?.challenge_type);
  assert(evt?.resolved_by === 'human_user', 'fell through to human_user after tier 1+2 exhausted', evt?.resolved_by);
  assert(Number(evt?.attempts) >= 1, 'at least the tier-1 attempt was counted', evt?.attempts);
}

// ============================================================
// SCENARIO D — premium user, image-text, a REAL (fake) provider
// configured and reachable: tier-2 auto-solves, no human. Directly
// exercises the selector-capture fix end-to-end (captureChallengeImage
// needs detection.selector to produce an imageUrl for the provider).
// ============================================================
section('D. image-text, premium + provider configured — tier-2 auto-solves, no human');
{
  process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY = 'fake-test-key';
  process.env.CAPTCHA_SOLVER_BASE_URL = `http://127.0.0.1:${providerPort}`;
  providerHits = [];

  const ctx = makeCtx({ userId: premiumUserId });
  ctx.page = makeMockPage({ widget: { detected: true, type: 'image-text', selector: 'img[src*="captcha"], img[alt*="captcha" i], canvas[id*="captcha"]' } });
  const step = { id: 'imgcaptcha-step-2', action: 'pauseForUserInput', expectedInput: 'captcha' };

  await ACTION_HANDLERS.pauseForUserInput(step, ctx);

  assert(!(await pendingKeyExists(ctx.jobId)), 'no human-loop pending entry — resolved automatically');
  assert(providerHits.some((h) => h.startsWith('/in.php')), 'the fake provider actually received a submit call (imageUrl was produced)');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.resolved_by === 'premium_api' && evt?.provider === '2captcha', 'event resolved_by=premium_api via 2captcha', `${evt?.resolved_by}/${evt?.provider}`);
  assert(Number(evt?.cost_usd) > 0, 'a real (non-zero) cost was recorded', evt?.cost_usd);

  const { rows } = await pool.query(
    `SELECT auto_solve_count, spend_usd FROM user_captcha_usage WHERE user_id = $1 AND month = to_char(NOW(), 'YYYY-MM')`,
    [premiumUserId]
  );
  assert(rows.length === 1 && Number(rows[0].auto_solve_count) >= 1, 'per-user monthly usage ledger incremented', JSON.stringify(rows[0]));
}

// ============================================================
// SCENARIO E — premium user, provider configured but UNREACHABLE:
// tier-2 fails gracefully (not a crash) and falls to human. This is
// the realistic "network error" case the outer try/catch guards.
// ============================================================
section('E. provider unreachable (network failure) — falls to human, job does not crash');
{
  process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY = 'fake-test-key';
  process.env.CAPTCHA_SOLVER_BASE_URL = 'http://127.0.0.1:1'; // closed port -> ECONNREFUSED

  const ctx = makeCtx({ userId: premiumUserId });
  ctx.page = makeMockPage({ widget: { detected: true, type: 'recaptcha-v2', selector: '.g-recaptcha', sitekey: 'test-sitekey-e' } });
  const step = { id: 'captcha-step-e', action: 'pauseForUserInput', expectedInput: 'captcha' };

  // tier-1 also needs to fail for this test to exercise tier-2 at all;
  // force that by making the frameLocator checkbox never appear "checked".
  ctx.page.frameLocator = () => ({ locator: () => ({ click: async () => {}, count: async () => 0 }) });

  let threw = null;
  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx).catch((e) => { threw = e; });
  const pendingAppeared = await waitFor(() => pendingKeyExists(ctx.jobId), { timeoutMs: 8000 });
  assert(pendingAppeared, 'provider failure did not crash the step — reached the human tier');
  await redis.publish(`job:resume:${ctx.jobId}`, 'RECOVERED-BY-HUMAN');
  await handlerPromise;

  assert(threw === null, 'pauseForUserInput did not throw despite the provider being unreachable');
  assert(ctx.runtimeInputs[step.id] === 'RECOVERED-BY-HUMAN', 'human answer still made it through after the provider failure');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.resolved_by === 'human_user', 'final event resolved_by=human_user', evt?.resolved_by);
}
delete process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY;
delete process.env.CAPTCHA_SOLVER_BASE_URL;

// ============================================================
// SCENARIO F — free-plan user, provider IS configured and reachable:
// plan gate must still deny automated spend and route to human.
// ============================================================
section('F. free-plan user — plan gate denies paid solve even though a provider is configured');
{
  process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY = 'fake-test-key';
  process.env.CAPTCHA_SOLVER_BASE_URL = `http://127.0.0.1:${providerPort}`;
  providerHits = [];

  const ctx = makeCtx({ userId: freeUserId });
  ctx.page = makeMockPage({ widget: { detected: true, type: 'image-text', selector: 'img[src*="captcha"], img[alt*="captcha" i], canvas[id*="captcha"]' } });
  const step = { id: 'freeplan-captcha', action: 'pauseForUserInput', expectedInput: 'captcha' };

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  await waitFor(() => pendingKeyExists(ctx.jobId));
  await redis.publish(`job:resume:${ctx.jobId}`, 'FREE-PLAN-ANSWER');
  await handlerPromise;

  assert(!providerHits.some((h) => h.startsWith('/in.php')), 'the paid provider was never called for a free-plan user');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.resolved_by === 'human_user', 'free-plan checkpoint resolved by a human despite provider availability', evt?.resolved_by);
}
delete process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY;
delete process.env.CAPTCHA_SOLVER_BASE_URL;

// ============================================================
// SCENARIO G — idle timeout: nobody answers. Job must fail cleanly,
// not hang forever, and the event must record status=timeout.
// ============================================================
section('G. idle timeout — no one answers, job fails cleanly (never hangs)');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage();
  const step = { id: 'timeout-step', action: 'pauseForUserInput', expectedInput: 'otp', timeout: 800 };

  let threw = null;
  try { await ACTION_HANDLERS.pauseForUserInput(step, ctx); } catch (e) { threw = e; }

  assert(threw?.name === 'JobCancelledError' || /cancel/i.test(String(threw?.message)), 'idle timeout raised JobCancelledError', threw?.message);
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.status === 'timeout' && evt?.resolved_by === 'failed', 'event recorded status=timeout, resolved_by=failed', `${evt?.status}/${evt?.resolved_by}`);
  assert(!(await pendingKeyExists(ctx.jobId)), 'captcha:pending cleaned up after timeout');
}

// ============================================================
// SCENARIO H — user cancels the job mid-pause (e.g. closes the chat /
// hits stop). Must resolve promptly, not hang, and log correctly.
// ============================================================
section('H. job cancelled mid-pause — resolves promptly, event marked failed');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage();
  const step = { id: 'cancel-step', action: 'pauseForUserInput', expectedInput: 'otp', timeout: 15000 };

  let threw = null;
  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx).catch((e) => { threw = e; });
  await waitFor(() => pendingKeyExists(ctx.jobId));
  const t0 = Date.now();
  await redis.publish(`job:cancel:${ctx.jobId}`, 'cancel');
  await handlerPromise;
  const elapsedMs = Date.now() - t0;

  assert(elapsedMs < 2000, `cancellation resolved promptly (${elapsedMs}ms), not stuck waiting on the 15s timeout`);
  assert(threw?.name === 'JobCancelledError', 'cancellation raised JobCancelledError', threw?.message);
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.status === 'failed' && evt?.error === 'cancelled', 'event recorded status=failed, error=cancelled', `${evt?.status}/${evt?.error}`);
}

// ============================================================
// SCENARIO I — admin resolves via the admin panel envelope instead of
// the end user: must decode correctly and attribute resolved_by=human_admin.
// ============================================================
section('I. admin resolves via the admin-panel envelope — attributed to human_admin');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage();
  const step = { id: 'admin-resolve-step', action: 'pauseForUserInput', expectedInput: 'otp' };

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  await waitFor(() => pendingKeyExists(ctx.jobId));
  // Mirrors exactly what POST /admin/captcha/:captchaId/solve publishes.
  await redis.publish(`job:resume:${ctx.jobId}`, JSON.stringify({ __hieAdmin: true, solution: '999000' }));
  await handlerPromise;

  assert(ctx.runtimeInputs[step.id] === '999000', 'admin-submitted value was unwrapped correctly (not the raw JSON envelope)');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.resolved_by === 'human_admin', 'event correctly attributed to human_admin, not human_user', evt?.resolved_by);
}

// ============================================================
// SCENARIO J — security block (Cloudflare interstitial / WAF), no
// widget present: must NEVER be auto-attempted, always human, with a
// distinct explanatory message — and the provider must not be touched.
// ============================================================
section('J. Cloudflare/WAF interstitial (no widget) — never auto-attempted, always human');
{
  process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY = 'fake-test-key';
  process.env.CAPTCHA_SOLVER_BASE_URL = `http://127.0.0.1:${providerPort}`;
  providerHits = [];

  const ctx = makeCtx({ userId: premiumUserId }); // premium, provider configured — should make no difference
  ctx.page = makeMockPage({
    widget: { detected: false, type: 'unknown' },
    security: { title: 'Just a moment...', bodyText: 'Checking your browser before accessing the site.', hasCfWrapper: true },
  });
  // No expectedInput set — this simulates an *unexpected* mid-workflow
  // block, not a workflow-authored checkpoint.
  const step = { id: 'waf-step', action: 'pauseForUserInput' };

  let pauseMsg = null;
  const sub = redis.duplicate();
  await sub.connect();
  await sub.subscribe('chat:pause', (msg) => { const p = JSON.parse(msg); if (p.jobId === ctx.jobId) pauseMsg = p; });

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  await waitFor(() => pendingKeyExists(ctx.jobId));
  await redis.publish(`job:resume:${ctx.jobId}`, 'manually-cleared-in-browser');
  await handlerPromise;
  await sub.unsubscribe('chat:pause');
  await sub.quit();

  assert(providerHits.length === 0, 'the paid provider was never contacted for a security block');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.event_type === 'security_block' && evt?.challenge_type === 'waf-block', 'event classified as security_block/waf-block', `${evt?.event_type}/${evt?.challenge_type}`);
  assert(evt?.resolved_by === 'human_user', 'resolved via human, exactly as designed', evt?.resolved_by);
  assert(!!pauseMsg?.contextMessage && /security check/i.test(pauseMsg.contextMessage), 'chat:pause message explains this is a security check, not a captcha to solve', pauseMsg?.contextMessage);
}
delete process.env.CAPTCHA_PROVIDER_2CAPTCHA_KEY;
delete process.env.CAPTCHA_SOLVER_BASE_URL;

// ============================================================
// SCENARIO K — "human error": the human submits an empty/garbage
// answer. The subsystem has no way to verify captcha correctness
// itself (only the target site can) — it should still accept and
// record the response rather than hang or crash, exactly like a real
// human typing something wrong. This documents that behavior.
// ============================================================
section('K. human submits an empty answer — accepted as-is, not silently dropped');
{
  const ctx = makeCtx();
  ctx.page = makeMockPage();
  const step = { id: 'human-error-step', action: 'pauseForUserInput', expectedInput: 'captcha' };

  const handlerPromise = ACTION_HANDLERS.pauseForUserInput(step, ctx);
  await waitFor(() => pendingKeyExists(ctx.jobId));
  await redis.publish(`job:resume:${ctx.jobId}`, '');
  await handlerPromise;

  assert(ctx.runtimeInputs[step.id] === '', 'empty human answer was stored as-is (system does not fabricate a value)');
  const evt = await getEvent(ctx.jobId, step.id);
  assert(evt?.status === 'resolved', 'event still marked resolved — correctness of the answer is the target site\'s problem, not this subsystem\'s', evt?.status);
}

// ============================================================
// SCENARIO L — checkpoint retention: after a captcha on a *known*
// workflow resolves, the workflow's known_checkpoints should record
// it, so a future run of the same workflow has this on file.
// ============================================================
section('L. checkpoint retained on the workflow after resolution');
{
  const ctx = makeCtx({ workflowKeyOverride: workflowKey });
  ctx.page = makeMockPage({ widget: { detected: true, type: 'recaptcha-v2', selector: '.g-recaptcha', sitekey: 'test-sitekey-l' } });
  const step = { id: 'checkpoint-step', action: 'pauseForUserInput', expectedInput: 'captcha' };

  await ACTION_HANDLERS.pauseForUserInput(step, ctx);

  const { rows } = await pool.query(`SELECT known_checkpoints FROM site_workflows WHERE workflow_key = $1`, [workflowKey]);
  const checkpoints = rows[0]?.known_checkpoints ?? [];
  const entry = checkpoints.find((c) => c.stepId === 'checkpoint-step');
  assert(!!entry, 'a known_checkpoints entry was written for this step', JSON.stringify(checkpoints));
  assert(entry?.lastResolvedBy === 'auto' && entry?.successCount === 1, 'checkpoint recorded lastResolvedBy=auto, successCount=1', JSON.stringify(entry));
}

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${GREEN}Passed: ${passed}${RESET}   ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);
console.log('═'.repeat(60));
if (failed > 0) {
  console.log(`\n${RED}FAILED checks:${RESET}`);
  failures.forEach((f) => console.log(`  - ${f}`));
}

providerServer.close();
await redis.quit();
await pool.end();
process.exit(failed > 0 ? 1 : 0);
