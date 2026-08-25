import { getBrowserPool } from './browser-pool.js';
import { getRedisClient } from '../shared/db/index.js';
import { Page } from 'playwright';

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

export class RecorderService {
  private sessions = new Map<string, { contextId: string, page: Page, steps: ActionStep[] }>();

  async startRecording(sessionId: string, url: string): Promise<void> {
    const pool = getBrowserPool();
    const lease = await pool.acquireContext(sessionId, 'admin');
    const page = await pool.getOrCreatePage(lease.contextId);
    const contextId = lease.contextId;

    this.sessions.set(sessionId, { contextId, page, steps: [] });

    await page.exposeFunction('reportAction', (step: ActionStep) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.steps.push(step);
        getRedisClient()
          .then((r) => r.publish(RECORD_STEP_CHANNEL, JSON.stringify({ sessionId, step })))
          .catch(() => {});
      }
    });

    await page.addInitScript(() => {
      const getSelectors = (el: Element) => {
        const selectors: string[] = [];
        if (el.id) selectors.push(`#${el.id}`);
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) selectors.push(`[aria-label="${ariaLabel}"]`);
        const testId = el.getAttribute('data-testid');
        if (testId) selectors.push(`[data-testid="${testId}"]`);
        
        let path = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).join('.');
          if (cls) selectors.push(`${path}.${cls}`);
        }
        if (!selectors.length) selectors.push(path);
        return selectors;
      };

      const getInputMetadata = (el: HTMLInputElement) => {
        return {
          name: el.name || undefined,
          placeholder: el.placeholder || undefined,
          autocomplete: el.autocomplete || undefined,
          type: el.type || undefined
        };
      };

      const detectWidgets = () => {
        // Simple live detection
        const hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile');
        const hasPayment = !!document.querySelector('iframe[src*="stripe"], iframe[src*="razorpay"], iframe[src*="paypal"]');
        if (hasCaptcha || hasPayment) {
           (window as any).reportAction({
             action: hasPayment ? 'paymentGateway' : 'captcha',
             timestamp: Date.now()
           });
        }
      };

      const redactValue = (val: string, el: HTMLInputElement) => {
        if (el.type === 'password') return '[REDACTED]';
        const piiRegex = /aadhaar|pan|passport|cvv|cc|credit card|otp/i;
        if (piiRegex.test(el.name || '') || piiRegex.test(el.placeholder || '') || piiRegex.test(el.id || '')) {
          return '[REDACTED_PII]';
        }
        return val;
      };

      // Periodic check for widgets
      setInterval(detectWidgets, 5000);

      window.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        (window as any).reportAction({
          action: 'click',
          target: { selectors: getSelectors(target), text: target.innerText?.slice(0, 50) },
          timestamp: Date.now()
        });
      }, true);

      window.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        (window as any).reportAction({
          action: 'input',
          target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
          value: redactValue(target.value, target),
          timestamp: Date.now()
        });
      }, true);

      window.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        (window as any).reportAction({
          action: 'change',
          target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
          value: redactValue(target.value, target),
          timestamp: Date.now()
        });
      }, true);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
  }

  async stopRecording(sessionId: string): Promise<ActionStep[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const pool = getBrowserPool();
    pool.releaseContext(session.contextId);
    
    const steps = session.steps;
    this.sessions.delete(sessionId);

    return steps;
  }
}

export const recorderService = new RecorderService();
