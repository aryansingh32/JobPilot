import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import type { Session, ProxyConfig } from '../shared/types/index.js';
import pidusage from 'pidusage';

// Initialize playwright-extra with stealth plugin
// playwright-extra wraps chromium but returns standard Playwright Browser instances
chromium.use(StealthPlugin());

// ============================================================
// BROWSER POOL
// Pre-launched browsers with context-per-user isolation.
// One browser serves 5-10 users via isolated BrowserContexts.
// Massive memory savings vs launching per-task.
// ============================================================

interface PooledBrowser {
  id: string;
  browser: Browser;
  contextCount: number;
  createdAt: Date;
  isHealthy: boolean;
}

interface ContextLease {
  contextId: string;
  browserId: string;
  context: BrowserContext;
  sessionId: string;
  userId: string;
  acquiredAt: Date;
  page?: Page;
  fingerprint: ReturnType<typeof createFingerprintProfile>;
}

interface BrowserPoolConfig {
  minBrowsers: number;      // always keep this many warm
  maxBrowsers: number;      // hard cap
  maxContextsPerBrowser: number;
  contextIdleTimeoutMs: number;   // reclaim idle contexts
  browserMaxAgeMs: number;        // restart old browsers
  launchArgs?: string[];
}

const DEFAULT_CONFIG: BrowserPoolConfig = {
  minBrowsers: 0,
  maxBrowsers: 5,
  maxContextsPerBrowser: 10,
  contextIdleTimeoutMs: 5 * 60 * 1000,   // 5 minutes
  browserMaxAgeMs: 30 * 60 * 1000,        // 30 minutes
};

const STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--disable-features=IsolateOrigins,site-per-process',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--lang=en-US,en',
  '--window-size=1280,800',
];

// ─── Locale inference ───────────────────────────────────────
// Workflows run against sites all over the world now, not just Indian
// government portals — a fixed en-IN/Asia/Kolkata fingerprint on a
// non-Indian site is itself a bot signal. Derive a locale/timezone from
// the target site's TLD instead, falling back to a neutral US default.

export interface LocaleHint {
  locale: string;
  timezoneId: string;
}

const DEFAULT_LOCALE_HINT: LocaleHint = { locale: 'en-US', timezoneId: 'America/New_York' };

const TLD_LOCALE_MAP: Record<string, LocaleHint> = {
  in: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  uk: { locale: 'en-GB', timezoneId: 'Europe/London' },
  gb: { locale: 'en-GB', timezoneId: 'Europe/London' },
  ca: { locale: 'en-CA', timezoneId: 'America/Toronto' },
  au: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  nz: { locale: 'en-NZ', timezoneId: 'Pacific/Auckland' },
  sg: { locale: 'en-SG', timezoneId: 'Asia/Singapore' },
  ae: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
  de: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
  es: { locale: 'es-ES', timezoneId: 'Europe/Madrid' },
  it: { locale: 'it-IT', timezoneId: 'Europe/Rome' },
  br: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  jp: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
};

/** Best-effort locale/timezone guess from a URL's TLD; used to seed the browser fingerprint. */
export function localeForUrl(url: string | undefined): LocaleHint {
  if (!url) return DEFAULT_LOCALE_HINT;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const tld = hostname.split('.').pop() ?? '';
    return TLD_LOCALE_MAP[tld] ?? DEFAULT_LOCALE_HINT;
  } catch {
    return DEFAULT_LOCALE_HINT;
  }
}

// ─── Browser Pool ────────────────────────────────────────────

export class BrowserPool extends EventEmitter {
  private config: BrowserPoolConfig;
  private browsers: Map<string, PooledBrowser> = new Map();
  private contexts: Map<string, ContextLease> = new Map();
  private contextLastUsed: Map<string, number> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;
  private reclaimInterval?: NodeJS.Timeout;

  constructor(config: Partial<BrowserPoolConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async init(): Promise<void> {
    console.log(`[BrowserPool] Initializing with ${this.config.minBrowsers} browsers`);
    await Promise.all(
      Array.from({ length: this.config.minBrowsers }, () => this.spawnBrowser())
    );
    this.startHealthCheck();
    this.startIdleReclaim();
    console.log(`[BrowserPool] ✅ Ready — ${this.browsers.size} browsers available`);
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.reclaimInterval) clearInterval(this.reclaimInterval);
    await Promise.all([...this.browsers.values()].map((b) => b.browser.close().catch(() => {})));
    this.browsers.clear();
    this.contexts.clear();
    console.log('[BrowserPool] Shutdown complete');
  }

  // ─── Acquire / Release ──────────────────────────────────────

  async acquireContext(
    sessionId: string,
    userId: string,
    session?: Partial<Session>,
    proxy?: ProxyConfig,
    lightweight?: boolean,
    localeHint?: LocaleHint
  ): Promise<ContextLease> {
    // Reuse existing context if available
    const existing = [...this.contexts.values()].find(
      (c) => c.sessionId === sessionId
    );
    if (existing) {
      this.contextLastUsed.set(existing.contextId, Date.now());
      return existing;
    }

    // Find browser with capacity
    const browser = await this.findOrSpawnBrowser();
    const fingerprint = createFingerprintProfile(localeHint);
    const context = await this.createContext(browser.browser, fingerprint, session, proxy);
    (context as any)._isLightweight = lightweight;

    const lease: ContextLease = {
      contextId: randomId(),
      browserId: browser.id,
      context,
      sessionId,
      userId,
      acquiredAt: new Date(),
      fingerprint,
    };

    browser.contextCount++;
    this.contexts.set(lease.contextId, lease);
    this.contextLastUsed.set(lease.contextId, Date.now());

    console.log(`[BrowserPool] Context ${lease.contextId} acquired for session ${sessionId}`);
    return lease;
  }

  async releaseContext(contextId: string, saveSession = true): Promise<void> {
    const lease = this.contexts.get(contextId);
    if (!lease) return;

    if (saveSession) {
      // Caller should extract cookies before calling this
    }

    await lease.page?.close().catch(() => {});
    await lease.context.close().catch(() => {});
    
    // Immediately destroy the context to free memory
    const pb = this.browsers.get(lease.browserId);
    if (pb) {
      pb.contextCount = Math.max(0, pb.contextCount - 1);
      
      // If browser has no contexts and we are strictly keeping 0 idle browsers, we could kill the browser here
      if (pb.contextCount === 0 && this.config.minBrowsers === 0) {
        await pb.browser.close().catch(() => {});
        this.browsers.delete(lease.browserId);
      }
    }
    
    this.contexts.delete(contextId);
    this.contextLastUsed.delete(contextId);
  }

  async releaseContextBySessionId(sessionId: string, saveSession = true): Promise<void> {
    const existing = [...this.contexts.values()].find((c) => c.sessionId === sessionId);
    if (existing) {
      await this.releaseContext(existing.contextId, saveSession);
    }
  }

  async getOrCreatePage(contextId: string): Promise<Page> {
    const lease = this.contexts.get(contextId);
    if (!lease) throw new Error(`Context ${contextId} not found in pool`);

    if (lease.page && !lease.page.isClosed()) {
      return lease.page;
    }

    const page = await lease.context.newPage();
    if (!(lease.context as any)._isLightweight) {
      await this.applyStealthSettings(page, lease.fingerprint);
    }
    lease.page = page;
    return page;
  }

  // ─── Internal Browser Management ────────────────────────────

  private async spawnBrowser(): Promise<PooledBrowser> {
    const browser = await chromium.launch({
      headless: true,
      args: [...STEALTH_ARGS, ...(this.config.launchArgs ?? [])],
    });

    const pooled: PooledBrowser = {
      id: randomId(),
      browser,
      contextCount: 0,
      createdAt: new Date(),
      isHealthy: true,
    };

    browser.on('disconnected', () => {
      console.warn(`[BrowserPool] Browser ${pooled.id} disconnected`);
      pooled.isHealthy = false;
      this.browsers.delete(pooled.id);
      this.emit('browser:disconnected', pooled.id);
    });

    this.browsers.set(pooled.id, pooled);
    console.log(`[BrowserPool] Spawned browser ${pooled.id}`);
    return pooled;
  }

  private async findOrSpawnBrowser(): Promise<PooledBrowser> {
    // Find healthy browser with capacity
    const available = [...this.browsers.values()].find(
      (b) => b.isHealthy && b.contextCount < this.config.maxContextsPerBrowser
    );
    if (available) return available;

    // Spawn new if under limit
    if (this.browsers.size < this.config.maxBrowsers) {
      return this.spawnBrowser();
    }

    // Wait for capacity — poll 100ms
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const retry = [...this.browsers.values()].find(
        (b) => b.isHealthy && b.contextCount < this.config.maxContextsPerBrowser
      );
      if (retry) return retry;
    }

    throw new Error('[BrowserPool] No browser capacity available after 10s');
  }

  private async createContext(
    browser: Browser,
    fingerprint: ReturnType<typeof createFingerprintProfile>,
    session?: Partial<Session>,
    proxy?: ProxyConfig
  ): Promise<BrowserContext> {
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: fingerprint.viewport,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      colorScheme: fingerprint.colorScheme,
      ignoreHTTPSErrors: false,
    };

    if (proxy && proxy.host && proxy.port && proxy.protocol) {
      const proxyOpts: { server: string; username?: string; password?: string } = {
        server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      };
      if (typeof proxy.username === 'string' && proxy.username) {
        proxyOpts.username = proxy.username;
      }
      if (typeof proxy.password === 'string' && proxy.password) {
        proxyOpts.password = proxy.password;
      }
      contextOptions.proxy = proxyOpts;
    }

    const context = await browser.newContext(contextOptions);
    await context.setExtraHTTPHeaders({
      'Accept-Language': `${fingerprint.locale},en;q=0.9`,
      'sec-ch-ua': '"Google Chrome";v="122", "Not(A:Brand";v="8", "Chromium";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': fingerprint.platform === 'Win32' ? '"Windows"' : '"macOS"',
    });

    // Restore session cookies
    if (session?.cookies?.length) {
      await context.addCookies(session.cookies as any);
    }

    // Restore localStorage
    if (session?.localStorage && Object.keys(session.localStorage).length > 0) {
      await context.addInitScript((storage: Record<string, string>) => {
        Object.entries(storage).forEach(([k, v]) => localStorage.setItem(k, v));
      }, session.localStorage);
    }

    return context;
  }

  private async applyStealthSettings(page: Page, fingerprint: ReturnType<typeof createFingerprintProfile>): Promise<void> {
    // playwright-extra-plugin-stealth handles most basic evasions.
    // We add advanced fingerprinting spoofing here to strengthen it further.

    await page.addInitScript((profile: any) => {
      // Hardware Concurrency & Memory
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => profile.hardwareConcurrency });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => profile.deviceMemory });
      
      // Platform & Plugins
      Object.defineProperty(navigator, 'platform', { get: () => profile.platform });
      Object.defineProperty(navigator, 'plugins', { get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ] });

      // Screen & Window
      Object.defineProperty(screen, 'width', { get: () => profile.screen.width });
      Object.defineProperty(screen, 'height', { get: () => profile.screen.height });
      Object.defineProperty(screen, 'availWidth', { get: () => profile.screen.width });
      Object.defineProperty(screen, 'availHeight', { get: () => profile.screen.height - 40 });
      Object.defineProperty(window, 'devicePixelRatio', { get: () => profile.devicePixelRatio });

      // Canvas Fingerprinting (Seed-based noise for consistency within session)
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, attributes?: any) {
        const ctx = originalGetContext.call(this, type, attributes);
        if (type === '2d' && ctx) {
          const originalFillText = (ctx as any).fillText;
          (ctx as any).fillText = function(...args: any[]) {
            // Add a tiny invisible offset to change the hash slightly
            args[1] += profile.canvasNoise;
            return originalFillText.apply(this, args);
          };
        }
        return ctx;
      } as any;

      // WebGL Fingerprinting
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
        if (parameter === 37445) return profile.webgl.vendor;
        if (parameter === 37446) return profile.webgl.renderer;
        return originalGetParameter.call(this, parameter);
      };

      // Audio Fingerprinting
      const originalAnalyser = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(this: AnalyserNode, array: Float32Array) {
        originalAnalyser.call(this, array as any);
        if (array.length > 0) array[0] = array[0] + profile.audioNoise;
      };

      // Font Fingerprinting - subtle shift
      const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function(text: string) {
        const result = originalMeasureText.call(this, text);
        return {
          ...result,
          width: result.width + profile.fontNoise,
        };
      };
    }, fingerprint);
  }

  // ─── Health Check ─────────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      const now = Date.now();
      for (const [id, browser] of this.browsers) {
        const age = now - browser.createdAt.getTime();

        // Memory check > 3GB
        const pid = (browser.browser as any).process?.()?.pid;
        if (pid) {
          try {
            const stats = await pidusage(pid);
            if (stats.memory > 3 * 1024 * 1024 * 1024) {
              console.warn(`[BrowserPool] Browser ${id} exceeded 3GB memory usage (${Math.round(stats.memory / 1024 / 1024)}MB). Killing.`);
              browser.isHealthy = false;
              await browser.browser.close().catch(() => {});
              this.browsers.delete(id);
              continue;
            }
          } catch (e) {
            // pidusage fails if process is dead
          }
        }

        // Restart browsers that are too old
        if (age > this.config.browserMaxAgeMs && browser.contextCount === 0) {
          console.log(`[BrowserPool] Retiring aged browser ${id}`);
          await browser.browser.close().catch(() => {});
          this.browsers.delete(id);
          await this.spawnBrowser(); // replace it
        }
      }

      // Ensure minimum browser count (if minBrowsers > 0)
      const healthy = [...this.browsers.values()].filter((b) => b.isHealthy).length;
      if (healthy < this.config.minBrowsers) {
        const toSpawn = this.config.minBrowsers - healthy;
        for (let i = 0; i < toSpawn; i++) {
          await this.spawnBrowser();
        }
      }
    }, 60_000); // every minute
  }

  // ─── Idle Context Reclaim ─────────────────────────────────────

  private startIdleReclaim(): void {
    this.reclaimInterval = setInterval(async () => {
      const now = Date.now();
      for (const [contextId, lastUsed] of this.contextLastUsed) {
        if (now - lastUsed > this.config.contextIdleTimeoutMs) {
          const lease = this.contexts.get(contextId);
          if (lease) {
            console.log(`[BrowserPool] Reclaiming idle context ${contextId}`);
            await lease.page?.close().catch(() => {});
            await lease.context.close().catch(() => {});

            const browser = this.browsers.get(lease.browserId);
            if (browser) browser.contextCount = Math.max(0, browser.contextCount - 1);

            this.contexts.delete(contextId);
            this.contextLastUsed.delete(contextId);
          }
        }
      }
    }, 30_000); // every 30 seconds
  }

  // ─── Manual Reclaim ──────────────────────────────────────────
  
  async reclaimIdleBrowsers(): Promise<void> {
    console.log('[BrowserPool] Manual reclaim triggered');
    const now = Date.now();
    
    // 1. Reclaim idle contexts
    for (const [contextId, lastUsed] of this.contextLastUsed) {
      const lease = this.contexts.get(contextId);
      if (lease) {
        console.log(`[BrowserPool] Reclaiming context ${contextId}`);
        await lease.page?.close().catch(() => {});
        await lease.context.close().catch(() => {});
        
        const browser = this.browsers.get(lease.browserId);
        if (browser) browser.contextCount = Math.max(0, browser.contextCount - 1);
        
        this.contexts.delete(contextId);
        this.contextLastUsed.delete(contextId);
      }
    }

    // 2. Close browsers with no contexts that are older than 1 minute (to avoid churn)
    for (const [id, browser] of this.browsers) {
      const age = now - browser.createdAt.getTime();
      if (browser.contextCount === 0 && age > 60_000) {
        // Keep minBrowsers alive
        const healthy = [...this.browsers.values()].filter((b) => b.isHealthy).length;
        if (healthy > this.config.minBrowsers) {
          console.log(`[BrowserPool] Closing idle browser ${id}`);
          await browser.browser.close().catch(() => {});
          this.browsers.delete(id);
        }
      }
    }
  }

  // ─── Stats ────────────────────────────────────────────────────


  getStats() {
    return {
      browsers: this.browsers.size,
      healthyBrowsers: [...this.browsers.values()].filter((b) => b.isHealthy).length,
      activeContexts: this.contexts.size,
      totalCapacity: this.config.maxBrowsers * this.config.maxContextsPerBrowser,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function createFingerprintProfile(localeHint?: LocaleHint) {
  const { locale, timezoneId } = localeHint ?? DEFAULT_LOCALE_HINT;

  const viewport = {
    width: 1280 + randInt(0, 220),
    height: 780 + randInt(0, 140),
  };

  return {
    userAgent: pickUserAgent(),
    locale,
    timezoneId,
    viewport,
    screen: {
      width: viewport.width + randInt(0, 40),
      height: viewport.height + randInt(80, 160),
    },
    devicePixelRatio: pickOne([1, 1.25, 1.5]),
    platform: pickOne(['Win32', 'MacIntel']),
    hardwareConcurrency: pickOne([4, 8, 12, 16]),
    deviceMemory: pickOne([8, 16]),
    colorScheme: pickOne(['light', 'dark']) as 'light' | 'dark',
    webgl: {
      vendor: pickOne(['Intel Inc.', 'Google Inc. (Intel)', 'Apple Inc.']),
      renderer: pickOne([
        'Intel Iris OpenGL Engine',
        'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
        'Apple M1',
      ]),
    },
    canvasNoise: (Math.random() - 0.5) * 0.02,
    audioNoise: Math.random() * 0.0000005,
    fontNoise: (Math.random() - 0.5) * 0.1,
  };
}

// ─── Singleton ───────────────────────────────────────────────

let globalPool: BrowserPool | null = null;

export function getBrowserPool(): BrowserPool {
  if (!globalPool) {
    globalPool = new BrowserPool({
      minBrowsers: parseInt(process.env.MIN_BROWSERS ?? '2'),
      maxBrowsers: parseInt(process.env.MAX_BROWSERS ?? '10'),
      maxContextsPerBrowser: parseInt(process.env.MAX_CONTEXTS_PER_BROWSER ?? '8'),
    });
  }
  return globalPool;
}
