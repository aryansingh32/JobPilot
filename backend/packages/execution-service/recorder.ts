import { getBrowserPool } from './browser-pool.js';
import { getRedisClient } from '../shared/db/index.js';
import { Page } from 'playwright';
import { createLogger } from '../shared/logger/index.js';

const logger = createLogger('recorder');

export interface ActionStep {
  action: string;
  target?: any;
  value?: string;
  timestamp: number;
}

// Redis channel a recorded step is published on — bridged to the admin
// Socket.IO namespace by server.ts (`workflow:record-step`), since the
// recorder runs inside the api-service process but Socket.IO isn't wired
// up yet at the point routes are registered.
export const RECORD_STEP_CHANNEL = 'admin:record-step';

// Live screenshot frames for the recording session — same bridging pattern
// as RECORD_STEP_CHANNEL, mirrors the live-stream:<jobId> approach executor.ts
// uses for job execution (see streamLiveView in executor.ts).
export const RECORD_FRAME_CHANNEL = 'admin:record-frame';

const FRAME_INTERVAL_MS = 400; // ~2.5 FPS — recording is a human clicking, not fast-moving video

// Passed to page.addInitScript as raw `content`, NOT a function reference.
// A function reference gets serialized via `.toString()` and re-evaluated
// in the page — but tsx/esbuild's dev transform of this file injects a
// `__name(...)` helper-function call around these nested arrow functions
// (for stack-trace naming), and that helper only exists in the Node-side
// bundle, not in the browser. The stringified function would throw
// "__name is not defined" the instant it runs, before any of the
// addEventListener calls below ever execute — silently killing every
// click/input/change capture. Raw string content sidesteps the whole
// transform pipeline.
const RECORDER_INIT_SCRIPT = `
(function () {
  function getSelectors(el) {
    var selectors = [];
    if (el.id) selectors.push('#' + el.id);
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) selectors.push('[aria-label="' + ariaLabel + '"]');
    var testId = el.getAttribute('data-testid');
    if (testId) selectors.push('[data-testid="' + testId + '"]');

    var path = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\\s+/).join('.');
      if (cls) selectors.push(path + '.' + cls);
    }
    if (!selectors.length) selectors.push(path);
    return selectors;
  }

  function getInputMetadata(el) {
    return {
      name: el.name || undefined,
      placeholder: el.placeholder || undefined,
      autocomplete: el.autocomplete || undefined,
      type: el.type || undefined
    };
  }

  function detectWidgets() {
    var hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile');
    var hasPayment = !!document.querySelector('iframe[src*="stripe"], iframe[src*="razorpay"], iframe[src*="paypal"]');
    if (hasCaptcha || hasPayment) {
      window.reportAction({
        action: hasPayment ? 'paymentGateway' : 'captcha',
        timestamp: Date.now()
      });
    }
  }

  function redactValue(val, el) {
    if (el.type === 'password') return '[REDACTED]';
    var piiRegex = /aadhaar|pan|passport|cvv|cc|credit card|otp/i;
    if (piiRegex.test(el.name || '') || piiRegex.test(el.placeholder || '') || piiRegex.test(el.id || '')) {
      return '[REDACTED_PII]';
    }
    return val;
  }

  setInterval(detectWidgets, 5000);

  window.addEventListener('click', function (e) {
    var target = e.target;
    window.reportAction({
      action: 'click',
      target: { selectors: getSelectors(target), text: target.innerText ? target.innerText.slice(0, 50) : undefined },
      timestamp: Date.now()
    });
  }, true);

  window.addEventListener('input', function (e) {
    var target = e.target;
    window.reportAction({
      action: 'input',
      target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
      value: redactValue(target.value, target),
      timestamp: Date.now()
    });
  }, true);

  window.addEventListener('change', function (e) {
    var target = e.target;
    window.reportAction({
      action: 'change',
      target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
      value: redactValue(target.value, target),
      timestamp: Date.now()
    });
  }, true);
})();
`;

export class RecorderService {
  private sessions = new Map<string, { contextId: string, page: Page, steps: ActionStep[] }>();
  private frameLoops = new Map<string, { stop: () => void }>();

  private async startFrameLoop(sessionId: string, page: Page): Promise<void> {
    const redis = await getRedisClient();
    let active = true;
    let lastFrame: string | null = null;

    this.frameLoops.set(sessionId, { stop: () => { active = false; } });

    (async () => {
      while (active) {
        const start = Date.now();
        try {
          if (!page.isClosed()) {
            const buffer = await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
            const base64 = buffer.toString('base64');
            if (base64 !== lastFrame) {
              lastFrame = base64;
              await redis.publish(RECORD_FRAME_CHANNEL, JSON.stringify({ sessionId, frame: base64 }));
            }
          }
        } catch {
          // Page may be mid-navigation — just retry next tick.
        }
        const elapsed = Date.now() - start;
        await new Promise((r) => setTimeout(r, Math.max(10, FRAME_INTERVAL_MS - elapsed)));
      }
    })();
  }

  private stopFrameLoop(sessionId: string): void {
    this.frameLoops.get(sessionId)?.stop();
    this.frameLoops.delete(sessionId);
  }

  /**
   * Translate a click at (xPct, yPct) — fractions of the streamed frame,
   * origin top-left — into a real mouse click at the page's current
   * viewport coordinates, so a click on the admin's screenshot lands on the
   * same element it visually appears over regardless of viewport size.
   */
  async click(sessionId: string, xPct: number, yPct: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Recording session not found');
    const viewport = session.page.viewportSize();
    if (!viewport) throw new Error('Page has no viewport');
    const x = Math.min(viewport.width - 1, Math.max(0, viewport.width * xPct));
    const y = Math.min(viewport.height - 1, Math.max(0, viewport.height * yPct));
    await session.page.mouse.click(x, y);
  }

  async type(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Recording session not found');
    await session.page.keyboard.type(text, { delay: 20 });
  }

  async pressKey(sessionId: string, key: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Recording session not found');
    await session.page.keyboard.press(key);
  }

  async startRecording(sessionId: string, url: string): Promise<void> {
    const pool = getBrowserPool();
    const lease = await pool.acquireContext(sessionId, 'admin');
    const page = await pool.getOrCreatePage(lease.contextId);
    const contextId = lease.contextId;

    this.sessions.set(sessionId, { contextId, page, steps: [] });

    // Surfaces real errors inside the recorded page (including a broken
    // init script) instead of failing silently — this is how the
    // __name-is-not-defined bug above was actually found.
    page.on('pageerror', (err) => logger.warn('recorder:page-error', { sessionId, error: err.message }));

    await page.exposeFunction('reportAction', (step: ActionStep) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.steps.push(step);
        getRedisClient()
          .then((r) => r.publish(RECORD_STEP_CHANNEL, JSON.stringify({ sessionId, step })))
          .catch(() => {});
      }
    });

    await page.addInitScript({ content: RECORDER_INIT_SCRIPT });

    await page.goto(url, { waitUntil: 'networkidle' });
    await this.startFrameLoop(sessionId, page);
  }

  async stopRecording(sessionId: string): Promise<ActionStep[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    this.stopFrameLoop(sessionId);
    const pool = getBrowserPool();
    pool.releaseContext(session.contextId);

    const steps = session.steps;
    this.sessions.delete(sessionId);

    return steps;
  }
}

export const recorderService = new RecorderService();
