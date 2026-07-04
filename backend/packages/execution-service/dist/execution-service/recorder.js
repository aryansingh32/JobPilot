import { WebSocketServer, WebSocket } from 'ws';
import { getBrowserPool } from './browser-pool.js';
export class RecorderService {
    wss;
    sessions = new Map();
    constructor(port) {
        this.wss = new WebSocketServer({ port });
        this.wss.on('connection', (ws, req) => {
            const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
            const sessionId = url.searchParams.get('sessionId');
            if (!sessionId || !this.sessions.has(sessionId)) {
                ws.close();
                return;
            }
            const session = this.sessions.get(sessionId);
            session.ws = ws;
            ws.on('close', () => {
                session.ws = undefined;
            });
        });
    }
    async startRecording(sessionId, url) {
        const pool = getBrowserPool();
        const lease = await pool.acquireContext(sessionId, 'admin');
        const page = await pool.getOrCreatePage(lease.contextId);
        const contextId = lease.contextId;
        this.sessions.set(sessionId, { contextId, page, steps: [] });
        await page.exposeFunction('reportAction', (step) => {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.steps.push(step);
                if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                    session.ws.send(JSON.stringify({ type: 'step', step }));
                }
            }
        });
        await page.addInitScript(() => {
            const getSelectors = (el) => {
                const selectors = [];
                if (el.id)
                    selectors.push(`#${el.id}`);
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel)
                    selectors.push(`[aria-label="${ariaLabel}"]`);
                const testId = el.getAttribute('data-testid');
                if (testId)
                    selectors.push(`[data-testid="${testId}"]`);
                let path = el.tagName.toLowerCase();
                if (el.className && typeof el.className === 'string') {
                    const cls = el.className.trim().split(/\s+/).join('.');
                    if (cls)
                        selectors.push(`${path}.${cls}`);
                }
                if (!selectors.length)
                    selectors.push(path);
                return selectors;
            };
            const getInputMetadata = (el) => {
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
                    window.reportAction({
                        action: hasPayment ? 'paymentGateway' : 'captcha',
                        timestamp: Date.now()
                    });
                }
            };
            const redactValue = (val, el) => {
                if (el.type === 'password')
                    return '[REDACTED]';
                const piiRegex = /aadhaar|pan|passport|cvv|cc|credit card|otp/i;
                if (piiRegex.test(el.name || '') || piiRegex.test(el.placeholder || '') || piiRegex.test(el.id || '')) {
                    return '[REDACTED_PII]';
                }
                return val;
            };
            // Periodic check for widgets
            setInterval(detectWidgets, 5000);
            window.addEventListener('click', (e) => {
                const target = e.target;
                window.reportAction({
                    action: 'click',
                    target: { selectors: getSelectors(target), text: target.innerText?.slice(0, 50) },
                    timestamp: Date.now()
                });
            }, true);
            window.addEventListener('input', (e) => {
                const target = e.target;
                window.reportAction({
                    action: 'input',
                    target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
                    value: redactValue(target.value, target),
                    timestamp: Date.now()
                });
            }, true);
            window.addEventListener('change', (e) => {
                const target = e.target;
                window.reportAction({
                    action: 'change',
                    target: { selectors: getSelectors(target), metadata: getInputMetadata(target) },
                    value: redactValue(target.value, target),
                    timestamp: Date.now()
                });
            }, true);
        });
        await page.goto(url, { waitUntil: 'networkidle' });
    }
    async stopRecording(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error('Session not found');
        const pool = getBrowserPool();
        pool.releaseContext(session.contextId);
        const steps = session.steps;
        this.sessions.delete(sessionId);
        if (session.ws) {
            session.ws.close();
        }
        return steps;
    }
}
// Ensure the port matches what the frontend / API would use or configure it from env
export const recorderService = new RecorderService(9092);
//# sourceMappingURL=recorder.js.map