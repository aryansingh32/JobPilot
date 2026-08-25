// ============================================================
// Browser → API telemetry batching (session replay primitives)
// ============================================================

import { config } from "./config";

const STORAGE_KEY = "cf_telemetry_session";

export function getTelemetrySessionId(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

type TelemetryEvent = Record<string, unknown>;

const queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTelemetryQueue();
  }, 4000);
}

export function enqueueTelemetryEvent(event: TelemetryEvent): void {
  queue.push({
    ...event,
    ts: new Date().toISOString(),
    sessionId: getTelemetrySessionId(),
  });
  if (queue.length >= 30) void flushTelemetryQueue();
  else scheduleFlush();
}

export async function flushTelemetryQueue(): Promise<void> {
  if (!queue.length || flushing) return;
  flushing = true;
  const batch = queue.splice(0, 100);
  try {
    const env = typeof import.meta !== "undefined" ? (import.meta as any).env : {};
    await fetch(`${config.apiBaseUrl}/telemetry/client-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({
        events: batch,
        release: env?.VITE_APP_RELEASE ?? "dev",
        gitSha: env?.VITE_GIT_SHA ?? "",
      }),
      keepalive: true,
    });
  } catch {
    queue.unshift(...batch);
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushTelemetryQueue();
  });
}

export function trackNavigation(pathname: string): void {
  enqueueTelemetryEvent({
    eventType: "navigation",
    route: pathname,
    payload: { pathname, href: typeof location !== "undefined" ? location.href : "" },
  });
}

export function trackClick(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const el = target.closest("[data-track], button, a") ?? target;
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  const dataTrack = el.getAttribute("data-track");
  enqueueTelemetryEvent({
    eventType: "click",
    route: typeof location !== "undefined" ? location.pathname : "",
    payload: { tag, id, dataTrack, text: (el.textContent ?? "").slice(0, 120) },
  });
}

export function trackClientError(err: Error, info?: Record<string, unknown>): void {
  enqueueTelemetryEvent({
    eventType: "error.client",
    route: typeof location !== "undefined" ? location.pathname : "",
    payload: {
      message: err.message,
      stack: err.stack,
      ...info,
    },
  });
  void flushTelemetryQueue();
}
