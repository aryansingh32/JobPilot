/** Drives the recorder's in-page script on the mock portal: snapshots, typed redaction, compile. */
import { chromium } from 'playwright';
import { RECORDER_SCRIPT, type RawStep } from '../packages/execution-service/recorder.js';
import { compileRecording } from '../packages/shared/workflows/compile-recording.js';
// @ts-ignore plain-JS mock portal
import { startPortal } from './gov-mock-portal.mjs';

const portal = await startPortal(0);
portal.state.requireAadhaar = true;
const steps: RawStep[] = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
const page = await browser.newPage();
await page.exposeFunction('reportAction', (s: RawStep) => steps.push(s));
await page.addInitScript(RECORDER_SCRIPT);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
let failed = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => { console.log(ok ? '  ✓' : '  ✗', msg, ok ? '' : JSON.stringify(extra)); if (!ok) failed++; };

await page.goto(`${portal.url}/register`);
await page.fill('input[name=fullName]', 'Asha Verma');
await page.fill('input[name=emailOtp]', '482913');
await page.fill('input[name=password]', 'Sup3r-secret!');
await page.fill('input[name=captcha]', 'K7P2Q');
await page.locator('input[name=captcha]').blur();
await page.waitForTimeout(1600);
await page.goto(`${portal.url}/verify`);
await page.fill('input[name=aadhaar]', '123412341234');
await page.fill('input[name=aadhaarOtp]', '654321');
await page.locator('input[name=aadhaarOtp]').blur();
await page.waitForTimeout(1600);

const fills = steps.filter((s) => s.action === 'fill');
const val = (n: string) => fills.find((f) => f.target?.metadata?.name === n)?.value;
check(val('fullName') === 'Asha Verma', 'ordinary values recorded');
check(val('password') === '[REDACTED:password]', 'password redacted', val('password'));
check(val('emailOtp') === '[REDACTED:otp]', 'email OTP redacted', val('emailOtp'));
check(val('captcha') === '[REDACTED:captcha]', 'captcha redacted', val('captcha'));
check(val('aadhaar') === '[REDACTED:aadhaar]', 'Aadhaar redacted (by label)', val('aadhaar'));
check(val('aadhaarOtp') === '[REDACTED:otp]', 'Aadhaar OTP redacted', val('aadhaarOtp'));
check(!JSON.stringify(steps).match(/123412341234|654321|482913|Sup3r-secret/), 'no secret appears anywhere in the recording');
const pages = steps.filter((s) => s.action === 'page');
check(pages.length >= 2, `page snapshots captured (${pages.length})`);
const gate = pages.find((p) => p.snapshot?.gates.includes('aadhaar'));
check(!!gate && gate.snapshot!.fields.some((f) => f.secret === 'aadhaar') && gate.snapshot!.buttons.some((b) => /verify/i.test(b)), 'Aadhaar gate page detected with its fields and buttons', gate?.snapshot);
const compiled = compileRecording(steps as any);
const asks = compiled.filter((c) => c.action === 'pauseForUserInput').map((c) => c.expectedInput);
check(['password', 'otp', 'captcha', 'aadhaar'].every((k) => asks.includes(k as any)), `compiled into the right ask cards (${asks.join(', ')})`, asks);
await browser.close();
portal.server.close();
process.exit(failed ? 1 : 0);
