#!/usr/bin/env node
/**
 * verify-live-e2e.mjs — Real end-to-end verification against a LIVE,
 * already-running API server + worker (not imported code, not mocks):
 * real HTTP requests, a real Playwright browser navigating a real local
 * test site, real Postgres/Redis. Covers:
 *   A. Auth — email OTP, admin login, protected-route gating, logout
 *   B. Core execution engine — a real structured workflow run end to
 *      end (navigate/fill/select/check/extractData/click/assertText/
 *      download/screenshot) against a real local HTTP server
 *   C. Concurrency — several of those jobs fired at once
 *
 * Prereqs: API on API_BASE (default http://localhost:3000) and the
 * worker process both already running against the same Postgres/Redis,
 * with ADMIN_API_KEY and API_KEY known to this script via env.
 */

import http from 'http';
import { randomUUID } from 'crypto';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? 'dev-key-change-in-prod';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
const failures = [];
function ok(l) { console.log(`  ${GREEN}✓${RESET} ${l}`); passed++; }
function bad(l, d) { console.log(`  ${RED}✗${RESET} ${l}${d ? ` — ${d}` : ''}`); failed++; failures.push(l); }
function assert(c, l, d) { c ? ok(l) : bad(l, d); }
function section(t) { console.log(`\n${CYAN}▶ ${t}${RESET}`); }

// ── tiny cookie jar ──────────────────────────────────────────
function makeJar() {
  const jar = new Map();
  return {
    header() { return [...jar.values()].join('; '); },
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] ?? []);
      for (const c of set) {
        const [pair] = c.split(';');
        const [name] = pair.split('=');
        jar.set(name.trim(), pair.trim());
      }
    },
  };
}

async function api(path, { method = 'GET', body, jar, apiKey = API_KEY, admin = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['x-api-key'] = apiKey;
  if (admin) headers['x-admin-key'] = ADMIN_API_KEY;
  if (jar) headers['Cookie'] = jar.header();
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (jar) jar.absorb(res);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await predicate();
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  return null;
}

// ============================================================
// A. AUTH
// ============================================================
section('A. Auth — email OTP, admin login, protected-route gating');

const testEmail = `verify-e2e-${randomUUID().slice(0, 8)}@example.test`;
let capturedOtp = null;

{
  // Tail the API log for the dev-fallback OTP console line.
  const { execSync } = await import('child_process');
  const req1 = await api('/auth/email/request-otp', { method: 'POST', body: { email: testEmail } });
  assert(req1.status === 200 && req1.json?.sent === true, 'email OTP request accepted');

  await new Promise((r) => setTimeout(r, 300));
  try {
    const logTail = execSync(`tail -n 200 ${process.env.API_LOG_PATH ?? '/tmp/api-server2.log'}`).toString();
    const m = logTail.match(new RegExp(`DEV EMAIL\\] To: ${testEmail.replace('.', '\\.')}[\\s\\S]*?(\\d{6})`));
    capturedOtp = m?.[1] ?? null;
  } catch {}
  assert(!!capturedOtp, 'captured the OTP code from the dev-fallback console log', capturedOtp);
}

{
  const wrong = await api('/auth/email/verify', { method: 'POST', body: { email: testEmail, code: '000000' } });
  assert(wrong.status === 401, 'wrong OTP code is rejected with 401', wrong.status);
}

const userJar = makeJar();
if (capturedOtp) {
  const verify = await api('/auth/email/verify', { method: 'POST', jar: userJar, body: { email: testEmail, code: capturedOtp } });
  assert(verify.status === 200 && verify.json?.user?.email === testEmail, 'correct OTP logs in and returns the user', JSON.stringify(verify.json));

  const me = await api('/auth/me', { jar: userJar });
  assert(me.status === 200 && me.json?.user?.email === testEmail, '/auth/me confirms the session cookie authenticates the user');
}

{
  const noAuth = await api('/execute', { method: 'POST', body: { siteId: randomUUID(), task: 'anything' } });
  assert(noAuth.status === 401, '/execute without a user session is rejected (401)', noAuth.status);
}
{
  const badKey = await api('/sites', { apiKey: 'totally-wrong-key' });
  assert(badKey.status === 401 || badKey.status === 403, 'wrong x-api-key is rejected', badKey.status);
}

const adminJar = makeJar();
{
  const badLogin = await api('/auth/admin/login', { method: 'POST', body: { username: 'nope', password: 'wrong' } });
  assert(badLogin.status === 401, 'wrong admin credentials rejected (401)', badLogin.status);
}
{
  const noAdmin = await api('/admin/captcha/providers', { admin: false });
  assert(noAdmin.status === 401 || noAdmin.status === 403, 'admin route without any admin credential is rejected', noAdmin.status);
}
{
  // The admin API-key path (adminAuth accepts x-admin-key OR a valid admin session).
  const viaKey = await api('/admin/captcha/providers', { admin: true });
  assert(viaKey.status === 200, 'admin route accessible via x-admin-key', viaKey.status);
}
{
  const logout = await api('/auth/logout', { method: 'POST', jar: userJar });
  assert(logout.status === 200, 'logout succeeds', `status=${logout.status} body=${JSON.stringify(logout.json)}`);
  const meAfter = await api('/auth/me', { jar: userJar });
  assert(meAfter.status === 401, '/auth/me rejects the session after logout', `status=${meAfter.status} cookieSent="${userJar.header()}"`);
}

// ============================================================
// B. CORE EXECUTION ENGINE — real Playwright against a real local site
// ============================================================
section('B. Core execution engine — real Playwright run against a local test site');

const marker = `SERVER-MARKER-${randomUUID().slice(0, 8)}`;
const testServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <span id="server-marker">${marker}</span>
      <form action="/thanks" method="get">
        <input id="name" name="name" type="text" />
        <select id="color" name="color"><option>Red</option><option>Green</option><option>Blue</option></select>
        <input id="agree" name="agree" type="checkbox" />
        <button id="submit-btn" type="submit">Submit</button>
      </form>
      <a id="dl-link" href="/download.txt" download="report.txt">Download report</a>
    </body></html>`);
  } else if (url.pathname === '/thanks') {
    const name = url.searchParams.get('name') ?? '';
    const color = url.searchParams.get('color') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body>Thanks, ${name}! You picked ${color}.</body></html>`);
  } else if (url.pathname === '/download.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report.txt"' });
    res.end('e2e-test-report-content-12345');
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => testServer.listen(0, '127.0.0.1', r));
const testServerPort = testServer.address().port;
const testUrl = `http://127.0.0.1:${testServerPort}`;
console.log(`  (local test site: ${testUrl})`);

// Register a site + a structured workflow via the real admin API.
const siteRes = await api('/sites', { method: 'POST', body: { domain: `127.0.0.1:${testServerPort}` } });
const siteId = siteRes.json?.site?.id;
assert(!!siteId, 'registered a test site via POST /sites', JSON.stringify(siteRes.json));

const actionPlan = [
  { id: 's1', order: 1, action: 'navigate', value: testUrl, description: 'open the test form' },
  { id: 's2', order: 2, action: 'fill', target: { value: '#name', type: 'css' }, value: 'Test User', humanType: false },
  { id: 's3', order: 3, action: 'select', target: { value: '#color', type: 'css' }, value: 'Green' },
  { id: 's4', order: 4, action: 'check', target: { value: '#agree', type: 'css' } },
  { id: 's5', order: 5, action: 'extractData', target: { value: '#server-marker', type: 'css' }, metadata: { key: 'marker', mode: 'text' } },
  { id: 's6', order: 6, action: 'click', target: { value: '#submit-btn', type: 'css' }, waitFor: 'body' },
  { id: 's7', order: 7, action: 'assertText', target: { value: 'body', type: 'css' }, value: 'Thanks, Test User!' },
  { id: 's8', order: 8, action: 'navigate', value: testUrl, description: 'back to the form for the download link' },
  { id: 's9', order: 9, action: 'download', target: { value: '#dl-link', type: 'css' }, value: 'user-file-download:document:e2e-test-report.txt', timeout: 15000 },
  { id: 's10', order: 10, action: 'screenshot' },
];

const wfKey = `verify-e2e-${siteId.slice(0, 8)}`;
const wfCreate = await api('/admin/workflows', {
  method: 'POST', admin: true,
  body: {
    siteId, workflowKey: wfKey, name: 'E2E Verify Workflow', trigger: 'run the e2e verify test workflow',
    triggerPhrases: ['e2e verify test'], instructions: 'test fixture', starterActionPlan: actionPlan,
    status: 'published', isActive: true,
  },
});
assert(wfCreate.status === 201, 'created + published a real structured workflow via the admin API', JSON.stringify(wfCreate.json));

// Log a fresh user in to actually run it.
const runnerJar = makeJar();
const runnerEmail = `verify-e2e-runner-${randomUUID().slice(0, 8)}@example.test`;
await api('/auth/email/request-otp', { method: 'POST', body: { email: runnerEmail } });
await new Promise((r) => setTimeout(r, 300));
let runnerOtp = null;
try {
  const { execSync } = await import('child_process');
  const logTail = execSync(`tail -n 200 ${process.env.API_LOG_PATH ?? '/tmp/api-server2.log'}`).toString();
  const m = logTail.match(new RegExp(`DEV EMAIL\\] To: ${runnerEmail.replace('.', '\\.')}[\\s\\S]*?(\\d{6})`));
  runnerOtp = m?.[1] ?? null;
} catch {}
await api('/auth/email/verify', { method: 'POST', jar: runnerJar, body: { email: runnerEmail, code: runnerOtp } });

async function runOneJob(taskOverride) {
  const exec = await api('/execute', {
    method: 'POST', jar: runnerJar,
    body: { siteId, task: taskOverride ?? 'e2e verify test', useCache: false },
  });
  return exec.json?.jobId ?? null;
}

async function pollJob(jobId) {
  return waitFor(async () => {
    const r = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: { 'x-api-key': API_KEY } });
    const j = await r.json().catch(() => null);
    const status = j?.job?.status;
    if (status === 'completed' || status === 'failed') return j.job;
    return null;
  }, { timeoutMs: 45000, intervalMs: 750 });
}

const jobId = await runOneJob();
assert(!!jobId, 'POST /execute enqueued a real job against the structured workflow', jobId);

if (jobId) {
  const result = await pollJob(jobId);
  assert(!!result, 'job reached a terminal state (completed/failed) within 45s', JSON.stringify(result));
  assert(result?.status === 'completed', 'the real Playwright run completed successfully', JSON.stringify(result));

  const pool = (await import('../packages/shared/db/index.js')).getPgPool();
  const { rows } = await pool.query(`SELECT * FROM job_logs WHERE job_id = $1`, [jobId]);
  const log = rows[0];
  assert(!!log && log.success === true, 'job_logs row recorded success=true');
  assert(log?.verified === true, 'job_logs.verified=true (extractData produced real, non-empty output)', log?.verified);

  // Note: ctx.extractedData itself is never persisted to job_logs (only the
  // StepResult summary is) — success:true here is the available proof the
  // #server-marker locator was actually found and read on the live page;
  // a failed lookup would throw and this step would show success:false.
  const steps = log?.result?.steps ?? [];
  const extractStep = steps.find((s) => s.stepId === 's5') ?? null;
  assert(extractStep?.success === true, 'extractData step succeeded against the real page (locator found + read, not mocked)', JSON.stringify(extractStep));

  const { rows: files } = await pool.query(`SELECT * FROM user_files WHERE original_name = $1 ORDER BY created_at DESC LIMIT 1`, ['e2e-test-report.txt']);
  assert(files.length === 1, 'the downloaded file was actually persisted to user_files + disk', JSON.stringify(files[0]));
  if (files.length) {
    const fs = await import('fs/promises');
    const content = await fs.readFile(files[0].storage_path, 'utf8').catch((e) => `<read failed: ${e.message}>`);
    assert(content === 'e2e-test-report-content-12345', 'the persisted file\'s actual bytes match what the real server served', content);
  }
  await pool.end().catch(() => {});
}

// ============================================================
// C. CONCURRENCY — several real jobs fired at once
// ============================================================
section('C. Concurrency — 4 real jobs fired simultaneously');
{
  const jobIds = await Promise.all([1, 2, 3, 4].map(() => runOneJob()));
  assert(jobIds.every(Boolean), 'all 4 concurrent /execute calls were accepted and enqueued', JSON.stringify(jobIds));

  const results = await Promise.all(jobIds.map((id) => pollJob(id)));
  assert(results.every((r) => r?.status === 'completed'), 'all 4 concurrent jobs completed successfully', JSON.stringify(results.map((r) => r?.status)));

  const cbRes = await api('/admin/circuit-breakers', { admin: true });
  const openForSite = (cbRes.json?.breakers ?? []).find((b) => b.siteId === siteId && b.open);
  assert(!openForSite, 'the circuit breaker did NOT trip for this site despite concurrent load (all runs succeeded)', JSON.stringify(openForSite));
}

testServer.close();

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${GREEN}Passed: ${passed}${RESET}   ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);
console.log('═'.repeat(60));
if (failed > 0) { console.log(`\n${RED}FAILED:${RESET}`); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(failed > 0 ? 1 : 0);
