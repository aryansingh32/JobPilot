import { WebSocketServer, WebSocket } from 'ws';
import { getBrowserPool } from './browser-pool.js';
import { Page } from 'playwright';

export interface ActionStep {
  action: string;
  target?: any;
  value?: string;
  timestamp: number;
}

export class RecorderService {
  private wss: WebSocketServer;
  private sessions = new Map<string, { contextId: string, page: Page, ws?: WebSocket, steps: ActionStep[] }>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const sessionId = url.searchParams.get('sessionId');
      
      if (!sessionId || !this.sessions.has(sessionId)) {
        ws.close();
        return;
      }

      const session = this.sessions.get(sessionId)!;
      session.ws = ws;

      ws.on('close', () => {
        session.ws = undefined;
      });
    });
  }

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
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'step', step }));
        }
      }
    });

    await page.addInitScript(() => {
      const getSelector = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        let path = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          path += '.' + el.className.trim().split(/\s+/).join('.');
        }
        return path;
      };

      window.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        (window as any).reportAction({
          action: 'click',
          target: { selector: getSelector(target), text: target.innerText?.slice(0, 50) },
          timestamp: Date.now()
        });
      }, true);

      window.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        (window as any).reportAction({
          action: 'input',
          target: { selector: getSelector(target) },
          value: target.value,
          timestamp: Date.now()
        });
      }, true);

      window.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        (window as any).reportAction({
          action: 'change',
          target: { selector: getSelector(target) },
          value: target.value,
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
    
    if (session.ws) {
      session.ws.close();
    }

    return steps;
  }
}

// Ensure the port matches what the frontend / API would use or configure it from env
export const recorderService = new RecorderService(9092);
