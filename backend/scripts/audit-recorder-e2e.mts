import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPgPool, getRedisClient, CacheKeys } from '../packages/shared/db/index.js';
const base = 'http://127.0.0.1:3101';
const receipts: string[] = [];
const fixture = http.createServer((req, res) => {
  if (req.url?.startsWith('/saved')) { receipts.push(new URL(req.url, 'http://localhost').searchParams.get('value') ?? ''); res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><body><input aria-label="Task title" id="title" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><button data-qa="save" style="position:absolute;left:20px;top:80px;width:100px;height:30px" onclick="fetch('/saved?value='+encodeURIComponent(document.querySelector('#title').value)).then(()=>document.querySelector('#result').textContent='Task saved')">Save task</button><p id="result" style="position:absolute;top:130px"></p></body></html>`);
});
await new Promise<void>(r => fixture.listen(3188, '127.0.0.1', r));
async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY! }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`); return data as any;
}
let active: string | undefined;
try {
  assert.equal((await fetch(base + '/admin/record/status')).status, 401);
  assert.equal((await api('/admin/record/status')).workerOnline, true);
  const id = randomUUID(); active = id;
  const started = await api('/admin/record/start', { sessionId: id, url: 'http://127.0.0.1:3188/' });
  const { width, height } = started.viewport;
  await api('/admin/record/input', { sessionId: id, input: { type: 'click', x: 100 / width, y: 35 / height } });
  await api('/admin/record/input', { sessionId: id, input: { type: 'type', text: 'Audit task' } });
  await api('/admin/record/input', { sessionId: id, input: { type: 'click', x: 70 / width, y: 95 / height } });
  const stopped = await api('/admin/record/stop', { sessionId: id }); active = undefined;
  assert.equal(receipts[0], 'Audit task');
  const compiled = await api('/admin/record/compile', { steps: stopped.steps, jobApply: false });
  assert.ok(compiled.steps.some((s: any) => s.action === 'fill' && s.value === 'Audit task'));
  compiled.steps.push({ id: 'verify', order: compiled.steps.length + 1, action: 'assertText', target: { value: '#result' }, value: 'Task saved', timeout: 5000 });
  const imported = await api('/admin/workflows/import', { id: 'audit-generic-task', name: 'Audit generic task', entryUrl: 'http://127.0.0.1:3188/', category: 'general', portalType: 'general-web', starterActionPlan: compiled.steps, isActive: false });
  assert.equal(imported.results[0].ok, true);
  const run = await api(`/admin/workflows/${imported.results[0].dbId}/test-run`, { submit: true });
  const redis = await getRedisClient();
  let runtime: any;
  for (let i = 0; i < 60; i++) {
    runtime = JSON.parse(await redis.get(CacheKeys.jobRuntime(run.execJobId)) ?? '{}');
    if (['completed', 'failed', 'cancelled'].includes(runtime.status)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(runtime.status, 'completed', JSON.stringify(runtime));
  assert.deepEqual(receipts, ['Audit task', 'Audit task']);
  console.log(JSON.stringify({ status: 'PASS', checks: ['unauthenticated request rejected', 'worker discovered', 'remote browser input', 'capture', 'deterministic compile', 'draft persisted', 'queued worker replay', 'fixture receipt verified'], capturedEvents: stopped.steps.length, compiledSteps: compiled.steps.length, receipts: receipts.length, runtimeStatus: runtime.status }));
} finally {
  if (active) await api('/admin/record/stop', { sessionId: active }).catch(() => {});
  fixture.close(); await getPgPool().end(); await (await getRedisClient()).quit();
}
