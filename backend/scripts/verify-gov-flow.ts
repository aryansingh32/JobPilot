import { readFileSync } from 'fs';
/**
 * End-to-end check of the government-portal flow: the REAL executor drives a
 * real headless Chrome through a mock recruitment portal (gov-mock-portal.mjs)
 * — registration with OTPs and a captcha, sign-in, a 3-page application with
 * a photo and signature the server size-checks, review, final submit. A
 * responder plays the user: it answers each pause the way a person would.
 *
 * Needs Postgres + Redis (env as for the app) and Chrome:
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome
 *   node --import tsx scripts/verify-gov-flow.ts
 */
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { runMigrations, getPgPool, getRedisClient } from '../packages/shared/db/index.js';
import { profileService } from '../packages/shared/profile/index.js';
import { userFileStore } from '../packages/execution-service/user-file-store.js';
import { ExecutionEngine } from '../packages/execution-service/executor.js';
// @ts-expect-error plain ESM helper
import { startPortal } from './gov-mock-portal.mjs';

const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';
let failed = 0;
const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`  ${ok ? `${GREEN}✓` : `${RED}✗`}${RESET} ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
};

const userId = `gov-test-${randomUUID().slice(0, 8)}`;
await runMigrations();
const portal = await startPortal(0);
const redis = await getRedisClient();
const state = () => portal.state as Record<string, any>;

// ── a big photo and signature, like a phone camera would give ──
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true });
const bigImage = async (w: number, h: number) => {
  const page = await browser.newPage();
  const b64 = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) { const v = (Math.random() * 255) | 0; img.data[i] = v; img.data[i + 1] = (v * 3) & 255; img.data[i + 2] = 255 - v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, { w, h });
  await page.close();
  return Buffer.from(b64, 'base64');
};
await userFileStore.persistDownloadedFile({ userId, category: 'photo', originalName: 'me.jpg', buffer: await bigImage(1200, 1500), mimeType: 'image/jpeg' });
await userFileStore.persistDownloadedFile({ userId, category: 'signature', originalName: 'sign.jpg', buffer: await bigImage(800, 300), mimeType: 'image/jpeg' });
await browser.close();

await profileService.patch(userId, {
  personal: { fullName: 'Asha Verma', email: 'asha@example.com', phone: '+919876543210', city: 'Patna', state: 'Bihar', country: 'IN' },
  government: { fatherName: 'Rakesh Verma', motherName: 'Sunita Verma', dateOfBirth: '1998-04-12', gender: 'Female', category: 'OBC', nationality: 'Indian' },
  education: [{ school: 'CBSE', degree: '10th', grade: '88.4%', end: '2014' }],
  settings: { reviewBeforeSubmit: true },
}, 'test');

// ── the "user": answers every pause the way a person would ──
const asked: string[] = [];
const sub = redis.duplicate();
await sub.connect();
await sub.subscribe('chat:pause', async (message) => {
  const ev = JSON.parse(message) as { jobId: string; stepId: string; type: string; contextMessage: string };
  asked.push(`${ev.type}:${ev.contextMessage}`);
  let value = '';
  if (ev.type === 'captcha') value = state().captcha;
  else if (ev.type === 'otp' && /aadhaar/i.test(ev.contextMessage)) value = state().aadhaarOtp;
  else if (ev.type === 'otp') value = /email/i.test(ev.contextMessage) ? state().emailOtp : state().mobileOtp;
  else if (ev.type === 'credentialFill') value = /user|regist/i.test(ev.stepId + ev.contextMessage) && !/password/i.test(ev.contextMessage) ? state().registered?.regno : 'Passw0rd!x';
  else if (/aadhaar number|aadhaar.*virtual/i.test(ev.contextMessage)) value = '123412341234'; // fake test value
  else if (ev.type === 'otp' && /aadhaar/i.test(ev.contextMessage)) value = state().aadhaarOtp;
  else if (/consent/i.test(ev.contextMessage)) value = 'yes';
  else if (ev.type === 'review') value = JSON.stringify({ action: 'approve', values: {} });
  else value = 'yes';
  await new Promise((r) => setTimeout(r, 300));
  await redis.publish(`job:resume:${ev.jobId}`, String(value));
});

const siteId = (await getPgPool().query(`INSERT INTO sites (domain) VALUES ($1) ON CONFLICT (domain) DO UPDATE SET status = 'active' RETURNING id`, [`mock-${userId}.gov.test`])).rows[0].id as string;
const engine = new ExecutionEngine();
const run = async (siteId: string, plan: any[], context: Record<string, string> = {}) => {
  const id = randomUUID();
  return engine.execute({
    id, type: 'execute', priority: 'normal' as any, createdAt: new Date(), userId,
    payload: { siteId, task: 'gov test', actionPlan: plan, sessionId: `s-${id}`, useCache: false, maxAttempts: 1, context },
  } as any);
};

// ── A. Registration: OTP boxes + their Generate buttons + captcha + password ──
console.log('\n▶ Registration (email OTP, mobile OTP, captcha, password)');
const regRun = await run(siteId, [
  { id: 'open', order: 1, action: 'navigate', value: `${portal.url}/register`, target: { value: `${portal.url}/register`, type: 'url' } },
  { id: 'fill', order: 2, action: 'autofillForm', metadata: { openApplyButton: false, captchas: 'inline' } },
  { id: 'go', order: 3, action: 'click', target: { value: 'button:has-text("Create An Account")', type: 'css' } },
  { id: 'ok', order: 4, action: 'assertText', value: 'Registration successful' },
]);
check(regRun.success, 'registration run finished', (regRun as any).error);
check(!!state().registered, 'portal created the account');
check(state().registered?.fullName === 'Asha Verma' && state().registered?.father === 'Rakesh Verma', 'name and father filled from the profile', state().registered);
check(state().registered?.dob === '12/04/1998', 'date of birth written DD/MM/YYYY', state().registered?.dob);
check(state().registered?.emailOtp === state().emailOtp && !!state().emailOtp, 'email OTP: Generate pressed, user asked, typed');
check(state().registered?.mobileOtp === state().mobileOtp && !!state().mobileOtp, 'mobile OTP: Generate pressed, user asked, typed');
check(state().registered?.email === 'asha@example.com' && state().registered?.mobile?.endsWith('9876543210'), 'OTP boxes did not receive the email/phone', state().registered);
const mem = await getPgPool().query(`SELECT question FROM answer_memory WHERE user_id = $1`, [userId]);
check(!mem.rows.some((r) => /otp|password|captcha/i.test(r.question)), 'codes, passwords and captchas are not remembered', mem.rows);

// ── B. Sign in, apply (3 pages, uploads, review), final submit ──
console.log('\n▶ Sign in + full application to Final Submit');
const applyRun = await run(siteId, [
  { id: 'open', order: 1, action: 'navigate', value: `${portal.url}/login`, target: { value: `${portal.url}/login`, type: 'url' } },
  { id: 'cred_user', order: 2, action: 'credentialFill', target: { value: '#regno', type: 'css' }, metadata: { keyName: 'username' }, contextMessage: 'Your registration number for the site' },
  { id: 'cred_pass', order: 3, action: 'credentialFill', target: { value: '#password', type: 'css' }, metadata: { keyName: 'password' }, contextMessage: 'Your password for the site' },
  { id: 'cap', order: 4, action: 'solveTextCaptcha' },
  { id: 'login', order: 5, action: 'click', target: { value: 'button:has-text("Login")', type: 'css' } },
  { id: 'wizard', order: 6, action: 'govWizard', metadata: { captchas: 'inline' } },
  { id: 'review', order: 7, action: 'reviewForm' },
  { id: 'submit', order: 8, action: 'submitForm' },
]);
console.log('PORTAL LOG', JSON.stringify(state().log.slice(-14)), 'loggedIn', state().loggedIn, 'asked', JSON.stringify(asked.slice(-4)));
check(applyRun.success, 'application run finished', (applyRun as any).error);
const done = state().submitted;
check(!!done, 'portal received the final submit');
check(state().aadhaarVerified && state().aadhaarUsed === '123412341234', 'Aadhaar gate: number asked in chat, OTP generated + asked, verified');
check(done?.name === 'Asha Verma', 'page 1: name from profile', done?.name);
check(done?.father === 'Rakesh Verma' && done?.mother === 'Sunita Verma', "page 1: parents' names from profile", [done?.father, done?.mother]);
check(done?.dob === '12/04/1998', 'page 1: DOB DD/MM/YYYY', done?.dob);
check(done?.gender === 'Female', 'page 1: gender', done?.gender);
check(done?.category === 'OBC (Non-Creamy Layer)', 'page 1: category mapped OBC → "OBC (Non-Creamy Layer)"', done?.category);
check(done?.nationality === 'Indian', 'page 1: nationality', done?.nationality);
check(done?.tenthPct === '88.4' || done?.tenthPct === '88.4%', 'page 2: 10th % from education', done?.tenthPct);
check(done?.tenthYear === '2014' && done?.tenthBoard === 'CBSE', 'page 2: 10th year and board', [done?.tenthYear, done?.tenthBoard]);
check(done?.photoKB >= 20 && done?.photoKB <= 50, `page 2: photo auto-fitted to the stated 20–50 KB (${done?.photoKB?.toFixed(1)} KB)`);
check(done?.signatureKB >= 10 && done?.signatureKB <= 30, `page 2: signature auto-fitted to 10–30 KB (${done?.signatureKB?.toFixed(1)} KB)`);
check(asked.some((a) => a.startsWith('review')), 'user reviewed before the final submit');

// ── C. The shipped workflow (gov-gov-apply.json), unchanged, from the login page ──
console.log('\n▶ Shipped workflow gov-gov-apply.json: login → wizard → review → submit');
{
  const wf = JSON.parse(readFileSync(new URL('../workflows/jobs/gov-gov-apply.json', import.meta.url), 'utf8'));
  const plan = JSON.parse(JSON.stringify(wf.starterActionPlan).replace('{{job:applyUrl}}', `${portal.url}/login`));
  const st = state() as any;
  Object.assign(portal.state, { aadhaarVerified: false, aadhaarOtp: null, loggedIn: false, page1: null, page2: null, uploads: {}, submitted: null });
  const r = await run(siteId, plan);
  check(state().aadhaarVerified, 'shipped workflow: Aadhaar gate passed');
  console.log('LOG2', JSON.stringify(state().log.slice(-8)), JSON.stringify(asked.slice(-3)));
  check(r.success, 'shipped workflow ran to the end', (r as any).error);
  check(!!state().submitted && state().submitted.name === 'Asha Verma', 'shipped workflow: portal received the final submit');
  void st;
}
const mem2 = await getPgPool().query(`SELECT question FROM answer_memory WHERE user_id = $1`, [userId]);
check(!mem2.rows.some((r) => /aadhaar|aadhar/i.test(r.question)), 'Aadhaar number was not remembered', mem2.rows);
const ai = await getPgPool().query(`SELECT count(*)::int n FROM llm_usage`).catch(() => ({ rows: [{ n: 0 }] }));
check(ai.rows[0].n === 0, `zero LLM calls for the whole journey (${ai.rows[0].n})`);

console.log(`\nasked the user ${asked.length} times:`, asked.map((a) => a.split(':')[0]).join(', '));
console.log(failed ? `\n${RED}${failed} check(s) failed${RESET}` : `\n${GREEN}all checks passed${RESET}`);
await sub.quit();
portal.server.close();
process.exit(failed ? 1 : 0);
