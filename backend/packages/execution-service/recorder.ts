import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import { getBrowserPool } from './browser-pool.js';
import { getRedisClient } from '../shared/db/index.js';
import { RECORD_FRAME_CHANNEL, RECORD_STEP_CHANNEL } from '../shared/control-bus/index.js';

// ============================================================
// RECORDER — runs on a worker. The browser is headless, so the admin drives
// it remotely: the page is streamed as JPEG frames (CDP screencast) and the
// admin's clicks / keys come back as `record.input` commands. Every DOM
// event the page sees (from those inputs) is captured as a raw step.
// ============================================================

export { RECORD_STEP_CHANNEL };

export interface RawStep {
  action: string;
  target?: {
    selectors?: string[];
    text?: string;
    tag?: string;
    label?: string;
    metadata?: { name?: string; placeholder?: string; autocomplete?: string; type?: string };
  };
  value?: string;
  url?: string;
  /** action 'page': what the page asks (labels / options / buttons / gates), never typed values. */
  snapshot?: {
    title: string;
    headings: string[];
    fields: { label: string; type: string; required: boolean; options?: string[]; secret?: string; hint?: string }[];
    buttons: string[];
    gates: string[];
  };
  timestamp: number;
}

/** Back-compat name used by the LLM generalizer. */
export type ActionStep = RawStep;

export type RecordInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'navigate'; url: string }
  /** Attach a file to the Nth file input on the page (the browser is remote, so the bytes travel with the command). */
  | { type: 'upload'; fileName: string; dataBase64: string; index?: number }
  | { type: 'back' };

interface Session {
  contextId: string;
  page: Page;
  cdp?: CDPSession;
  steps: RawStep[];
  viewport: { width: number; height: number };
  lastActivity: number;
  idleTimer: NodeJS.Timeout;
}

const IDLE_LIMIT_MS = 20 * 60_000;

export class RecorderService {
  private sessions = new Map<string, Session>();

  private publishStep(sessionId: string, step: RawStep) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.steps.push(step);
    getRedisClient()
      .then((r) => r.publish(RECORD_STEP_CHANNEL, JSON.stringify({ sessionId, step })))
      .catch(() => {});
  }

  async startRecording(sessionId: string, url: string): Promise<{ viewport: { width: number; height: number } }> {
    if (this.sessions.has(sessionId)) throw new Error('Recording already running for this session');
    const pool = getBrowserPool();
    const lease = await pool.acquireContext(`record-${sessionId}`, 'admin');
    // Without this the pool's 5-minute idle reclaim closes the browser under a slow, human-paced recording.
    pool.markActive(lease.contextId);
    const page = await pool.getOrCreatePage(lease.contextId);
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const session: Session = {
      contextId: lease.contextId,
      page,
      steps: [],
      viewport,
      lastActivity: Date.now(),
      // Abandoned recordings must not hold a browser context forever.
      idleTimer: setInterval(() => {
        if (Date.now() - session.lastActivity > IDLE_LIMIT_MS) void this.stopRecording(sessionId).catch(() => {});
      }, 60_000),
    };
    this.sessions.set(sessionId, session);

    await page.exposeFunction('reportAction', (step: RawStep) => this.publishStep(sessionId, step));
    await page.addInitScript(RECORDER_SCRIPT);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        getRedisClient()
          .then((r) => r.publish(RECORD_FRAME_CHANNEL, JSON.stringify({ sessionId, url: frame.url() })))
          .catch(() => {});
      }
    });

    this.publishStep(sessionId, { action: 'navigate', url, value: url, timestamp: Date.now() });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // Live view: frames only arrive when the page changes.
    const cdp = await page.context().newCDPSession(page);
    session.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
      cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      getRedisClient()
        .then((r) =>
          r.publish(
            RECORD_FRAME_CHANNEL,
            JSON.stringify({ sessionId, data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight, url: page.url() }),
          ),
        )
        .catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: viewport.width, maxHeight: viewport.height });
    return { viewport };
  }

  /** Forward one admin input into the recorded page. */
  async input(sessionId: string, ev: RecordInput): Promise<{ url: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('No active recording for that session');
    s.lastActivity = Date.now();
    const { page, viewport } = s;
    try {
    switch (ev.type) {
      case 'click':
        await page.mouse.click(Math.round(ev.x * viewport.width), Math.round(ev.y * viewport.height));
        break;
      case 'type':
        await page.keyboard.type(ev.text, { delay: 15 });
        break;
      case 'key':
        await page.keyboard.press(ev.key);
        break;
      case 'scroll':
        await page.mouse.wheel(0, ev.dy);
        break;
      case 'navigate':
        this.publishStep(sessionId, { action: 'navigate', url: ev.url, value: ev.url, timestamp: Date.now() });
        await page.goto(ev.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        break;
      case 'upload': {
        const bytes = Buffer.from(ev.dataBase64, 'base64');
        if (bytes.length > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
        // Application forms are often embedded (Greenhouse inside a careers page), so look in every frame.
        const fileInputs = [];
        for (const frame of page.frames()) {
          const loc = frame.locator('input[type=file]');
          for (let i = 0, n = await loc.count().catch(() => 0); i < n; i++) fileInputs.push(loc.nth(i));
        }
        const count = fileInputs.length;
        const index = ev.index ?? 0;
        if (index < 0 || index >= count) throw new Error(`No file field #${index + 1} on this page (found ${count})`);
        const dir = await mkdtemp(join(tmpdir(), 'rec-upload-'));
        try {
          const filePath = join(dir, basename(ev.fileName) || 'upload');
          await writeFile(filePath, bytes);
          await fileInputs[index].setInputFiles(filePath);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        break;
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        break;
    }
    } catch (err) {
      console.error(`[recorder] input '${ev.type}' failed:`, (err as Error).message);
      throw err;
    }
    return { url: page.url() };
  }

  async stopRecording(sessionId: string): Promise<RawStep[]> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Session not found');
    clearInterval(s.idleTimer);
    // The field still focused hasn't fired "change" yet — blur it so its value is captured.
    await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
    await s.page.waitForTimeout(300).catch(() => {});
    this.sessions.delete(sessionId);
    await s.cdp?.send('Page.stopScreencast').catch(() => {});
    await s.cdp?.detach().catch(() => {});
    getBrowserPool().releaseContext(s.contextId);
    return s.steps;
  }

  active(): string[] {
    return [...this.sessions.keys()];
  }
}

// Runs inside the recorded page. Reports clicks and final field values with
// several selector candidates, so the compiled workflow survives redesigns.
export const RECORDER_SCRIPT = `(() => {
  if (window.__jpRecorder) return; window.__jpRecorder = true;
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\\\]/g, '\\\\$&');
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + esc(el.id) + '"]'); if (l) return clean(l.innerText); }
    const w = el.closest('label'); if (w) return clean(w.innerText);
    const pv = el.previousElementSibling; if (pv && pv.tagName === 'LABEL') return clean(pv.innerText);
    return clean(el.getAttribute('aria-label') || el.placeholder || '');
  };
  const selectorsOf = (el) => {
    const out = [];
    const tag = el.tagName.toLowerCase();
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (tid) out.push('[data-testid="' + tid + '"]');
    if (el.id && !/\\d{4,}|^:r/.test(el.id)) out.push('#' + esc(el.id));
    const name = el.getAttribute('name'); if (name) out.push(tag + '[name="' + name + '"]');
    const aria = el.getAttribute('aria-label'); if (aria) out.push(tag + '[aria-label="' + aria + '"]');
    const ph = el.getAttribute('placeholder'); if (ph) out.push(tag + '[placeholder="' + ph + '"]');
    let path = [], n = el;
    while (n && n.nodeType === 1 && path.length < 5 && n !== document.body) {
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) { const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName); if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      path.unshift(part); n = parent;
    }
    out.push(path.join(' > '));
    return out;
  };
  const meta = (el) => ({ name: el.name || undefined, placeholder: el.placeholder || undefined, autocomplete: el.autocomplete || undefined, type: el.type || undefined });
  // What kind of secret a box holds, from its name, label, placeholder and autocomplete hint.
  const kindOf = (el) => {
    const hay = [el.name, el.id, el.placeholder, el.getAttribute && el.getAttribute('aria-label'), el.autocomplete, labelOf(el)].join(' ').toLowerCase();
    if (el.type === 'password') return 'password';
    if (el.autocomplete === 'one-time-code' || /otp|one.?time|verification code/.test(hay)) return 'otp';
    if (/aadhaar|aadhar|\\buid\\b|virtual id/.test(hay)) return 'aadhaar';
    if (/security pin|\\bpin\\b(?!.?code)/.test(hay)) return 'pin';
    if (/captcha|security code/.test(hay)) return 'captcha';
    if (/\\bpan\\b|passport|cvv|card.?number|account.?number|\\bifsc\\b/.test(hay)) return 'pii';
    return null;
  };
  const redact = (el, v) => { const k = kindOf(el); return k ? '[REDACTED:' + k + ']' : v; };
  // A structural snapshot of the page (never any typed values): what the portal asks, step by step.
  let lastSig = '';
  const snapshot = () => {
    try {
      const fields = Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea')).filter((el) => el.offsetParent !== null).slice(0, 60).map((el) => {
        const next = el.nextElementSibling;
        const hint = next && !/^(INPUT|SELECT|TEXTAREA|LABEL|BUTTON)$/.test(next.tagName) ? clean(next.innerText).slice(0, 120) : '';
        return { label: labelOf(el) || el.name || el.id || '', type: el.tagName === 'SELECT' ? 'select' : el.type || 'text', required: !!el.required || /\\*\\s*$/.test(labelOf(el)),
          options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 12).map((o) => clean(o.text)) : undefined, secret: kindOf(el) || undefined, hint: hint || undefined };
      });
      const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a.btn, [role=button]')).filter((b) => b.offsetParent !== null).map((b) => clean(b.innerText || b.value)).filter(Boolean).slice(0, 20);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 6);
      const body = clean(document.body ? document.body.innerText : '').toLowerCase();
      const gates = [];
      if (/aadhaar|aadhar/.test(body) && /otp|verif/.test(body)) gates.push('aadhaar');
      if (/digilocker/.test(body)) gates.push('digilocker');
      if (fields.some((f) => f.secret === 'otp')) gates.push('otp');
      if (fields.some((f) => f.secret === 'captcha') || document.querySelector('img[src*="captcha" i], img[id*="captcha" i]')) gates.push('captcha');
      if (/face authentication|biometric/.test(body)) gates.push('biometric');
      const sig = location.href + '|' + headings.join('/') + '|' + fields.map((f) => f.label + f.type).join(',');
      if (sig === lastSig) return; lastSig = sig;
      report({ action: 'page', url: location.href, value: document.title, snapshot: { title: document.title, headings, fields, buttons, gates } });
    } catch (e) {}
  };
  let snapTimer = null;
  const snapSoon = () => { clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 1200); };
  window.addEventListener('load', snapSoon);
  document.addEventListener('DOMContentLoaded', () => { snapSoon(); new MutationObserver(snapSoon).observe(document.documentElement, { childList: true, subtree: true }); });
  const report = (s) => { try { window.reportAction(Object.assign({ timestamp: Date.now() }, s)); } catch (e) {} };
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('a, button, [role="button"], [role="option"], [role="tab"], input[type="checkbox"], input[type="radio"], label, summary, li, div, span') : null;
    if (!el) return;
    const t = el.tagName.toLowerCase();
    if (t === 'input' && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
    report({ action: 'click', target: { selectors: selectorsOf(el), text: clean(el.innerText || el.value).slice(0, 80), tag: t, label: labelOf(el) } });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target; if (!el || !el.tagName) return;
    const t = el.tagName.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(t) || ['checkbox', 'radio'].includes(el.type)) return;
    const value = t === 'select' ? clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text) : el.type === 'file' ? (el.files && el.files[0] ? el.files[0].name : '') : el.value;
    report({ action: el.type === 'file' ? 'upload' : t === 'select' ? 'select' : 'fill', target: { selectors: selectorsOf(el), tag: t, label: labelOf(el), metadata: meta(el) }, value: redact(el, value) });
  }, true);
  setInterval(() => {
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile') && !window.__jpCaptcha) { window.__jpCaptcha = true; report({ action: 'captcha' }); }
  }, 3000);
})();`;

export const recorderService = new RecorderService();
