/**
 * The REAL executor drives headless Chrome through a mock Workday-style application
 * (workday-mock-portal.mjs): client-rendered pages, button listboxes, radios, a consent
 * checkbox, a resume upload, and a Next that rejects empty required fields.
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome node --import tsx scripts/verify-workday-flow.ts
 */
import { randomUUID } from 'crypto';
import { runMigrations, getPgPool, getRedisClient } from '../packages/shared/db/index.js';
import { profileService } from '../packages/shared/profile/index.js';
import { userFileStore } from '../packages/execution-service/user-file-store.js';
import { ExecutionEngine } from '../packages/execution-service/executor.js';
// @ts-expect-error plain ESM helper
import { startPortal } from './workday-mock-portal.mjs';

const userId = `wd-test-${randomUUID().slice(0, 8)}`;
await runMigrations();
const portal = await startPortal(0);
const redis = await getRedisClient();
await userFileStore.persistDownloadedFile({ userId, category: 'resume', originalName: 'cv.pdf', buffer: Buffer.from('%PDF-1.4 test'), mimeType: 'application/pdf' });
await profileService.patch(userId, {
  personal: { fullName: 'Asha Verma', email: 'asha@example.com', phone: '+919876543210', city: 'Patna', state: 'Bihar', country: 'IN', address: '12 Park Road', postalCode: '800001' },
  settings: { reviewBeforeSubmit: true },
}, 'test');

const asked: string[] = [];
const sub = redis.duplicate();
await sub.connect();
await sub.subscribe('chat:pause', async (message) => {
  const ev = JSON.parse(message) as { jobId: string; type: string; contextMessage: string };
  asked.push(`${ev.type}:${ev.contextMessage}`);
  const m = ev.contextMessage.match(/asks: "([^"]*)"/)?.[1] ?? ev.contextMessage; // the question only, not its options
  let value = 'No';
  if (ev.type === 'review') value = JSON.stringify({ action: 'approve', values: {} });
  else if (/hear about/i.test(m)) value = 'LinkedIn';
  else if (/^state$/i.test(m)) value = 'Bihar';
  else if (/phone device/i.test(m)) value = 'Mobile';
  else if (/phone code|country phone/i.test(m)) value = 'India (+91)';
  else if (/authorized/i.test(m)) value = 'Yes';
  else if (/salary/i.test(m)) value = '1200000';
  else if (/consent|terms/i.test(m)) value = 'Yes';
  else if (/disability/i.test(m)) value = 'I do not want to answer';
  else if (/veteran/i.test(m)) value = 'I do not wish to answer';
  else if (/gender|hispanic/i.test(m)) value = 'Decline to self identify';
  await new Promise((r) => setTimeout(r, 200));
  await redis.publish(`job:resume:${ev.jobId}`, value);
});

const siteId = (await getPgPool().query(`INSERT INTO sites (domain) VALUES ($1) ON CONFLICT (domain) DO UPDATE SET status = 'active' RETURNING id`, [`mock-${userId}.workday.test`])).rows[0].id as string;
const id = randomUUID();
const result = await new ExecutionEngine().execute({
  id, type: 'execute', priority: 'normal' as any, createdAt: new Date(), userId,
  payload: { siteId, task: 'workday test', sessionId: `s-${id}`, useCache: false, maxAttempts: 1, context: {}, actionPlan: [
    { id: 'open', order: 1, action: 'navigate', value: portal.url, target: { value: portal.url, type: 'url' } },
    { id: 'fill', order: 2, action: 'fillWizard', timeout: 120000 },
    { id: 'review', order: 3, action: 'reviewForm' },
    { id: 'submit', order: 4, action: 'submitForm', target: { value: '[data-automation-id="bottom-navigation-next-button"]' } },
  ] },
} as any);
console.log('run:', result.success, (result as any).error ?? '');
console.log('asked:', asked);
console.log('submitted:', JSON.stringify(portal.state.submitted));
await sub.quit();
process.exit(result.success && portal.state.submitted ? 0 : 1);
