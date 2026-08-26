// ============================================================
// ADMIN API CLIENT
// Typed wrapper for all /admin/* backend endpoints.
// Authenticated via the httpOnly jp_admin_session cookie set by
// POST /auth/admin/login — no key is ever held in browser JS.
// ============================================================

import { config } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("admin-api");

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${config.apiBaseUrl}${path}`;
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, { ...options, headers, credentials: "include" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `Admin API ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch {}
    logger.error("admin:request-failed", { url, status: res.status, msg });
    throw new Error(msg);
  }
  // metrics endpoint returns text
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return res.text() as unknown as T;
}

function aGet<T>(path: string) {
  return adminRequest<T>(path, { method: "GET" });
}
function aPost<T>(path: string, body?: unknown) {
  return adminRequest<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}
function aPut<T>(path: string, body?: unknown) {
  return adminRequest<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
}
function aDel<T>(path: string) {
  return adminRequest<T>(path, { method: "DELETE" });
}

// ── Types ─────────────────────────────────────────────────

export interface SystemHealth {
  status: "healthy" | "degraded";
  db: { status: string; latencyMs: number };
  redis: { status: string; latencyMs: number };
  browsers: Record<string, unknown>;
  uptime: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    systemTotal: number;
    systemFree: number;
  };
  cpu: number[];
  nodeVersion: string;
  platform: string;
  timestamp: string;
}

export interface OverviewData {
  health: SystemHealth;
  queues: Record<string, unknown>;
  jobStats: { total: number; completed: number; failed: number; running: number };
  userCount: number;
}

export interface AdminJob {
  job_id: string;
  type: string;
  status: string;
  user_id: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  task?: string;
  result?: unknown;
  runtime?: unknown;
}

export interface AdminUser {
  user_id: string;
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  last_active: string;
  first_seen: string;
}

export interface AdminWorkflow {
  id: string;
  workflow_key?: string;
  site_id: string;
  category?: string;
  name: string;
  trigger: string;
  trigger_phrases?: string[];
  portal_type?: string;
  entry_url?: string;
  page_url?: string;
  instructions: string;
  captcha_policy?: string;
  is_active: boolean;
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface AdminZeroShotRun {
  id: string;
  user_id: string;
  site_id: string;
  prompt: string;
  status: string;
  result?: unknown;
  created_at: string;
}

export interface CaptchaItem {
  id: string;
  siteId: string;
  type: string;
  payload: unknown;
  status: string;
  createdAt: string;
}

export interface LogEntry {
  level?: string;
  message?: string;
  msg?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface CaptchaSpend {
  currentMonth: string;
  currentSpend: number;
  maxMonthlySpend: number;
  remaining: number;
  premiumConfigured: boolean;
  history: { month: string; spend: number }[];
}

export interface SelectorHealthRow {
  type: string;
  total_selectors: string;
  avg_confidence: string | null;
  total_failures: string;
  broken_selectors: string;
}

export interface LLMUsageData {
  days: number;
  totalJobs: number;
  totalAiCalls: number;
  avgAiCallsPerJob: number;
  daily: { day: string; ai_calls: string; jobs: string }[];
  byWorkflow: { key: string; name: string | null; ai_calls: string; jobs: string }[];
  models: {
    plannerModel: string | null;
    selectorModel: string | null;
    recoveryModel: string | null;
    chatModel: string | null;
  };
}

export interface WorkflowAnalyticsRow {
  workflowKey: string;
  name: string | null;
  siteId: string | null;
  totalRuns: string;
  successfulRuns: string;
  successRatePct: string | null;
  avgDurationMs: string | null;
  mostCommonFailureStep: string | null;
  mostCommonFailureCount: string | null;
}

export interface CircuitBreakerRow {
  siteId: string;
  open: boolean;
  resetInSeconds: number;
}

export interface AdminSite {
  id: string;
  domain: string;
  page_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ObsSessionRow {
  session_id: string;
  user_id: string | null;
  last_ts: string;
  event_count: string;
}

export interface ObsTimelineEvent {
  id: string;
  ts: string;
  source: string;
  event_type: string;
  user_id?: string | null;
  session_id?: string | null;
  trace_id?: string | null;
  request_id?: string | null;
  route?: string | null;
  release?: string | null;
  payload?: unknown;
}

export interface ErrorReportRow {
  id: string;
  ts: string;
  source: string;
  fingerprint?: string;
  message: string;
  stack?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  route?: string | null;
  method?: string | null;
  http_status?: number | null;
  severity?: string;
  context?: unknown;
}

// ── API ───────────────────────────────────────────────────

export const adminApi = {
  // Dashboard
  overview: () => aGet<OverviewData>("/admin/overview"),
  health: () => aGet<SystemHealth>("/admin/health"),
  metrics: () => aGet<string>("/admin/metrics"),

  // Queues
  queues: () => aGet<{ queues: Record<string, unknown> }>("/admin/queues"),

  // Jobs
  listJobs: (params?: { status?: string; userId?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.userId) q.set("userId", params.userId);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return aGet<{ jobs: AdminJob[]; total: number }>(`/admin/jobs?${q}`);
  },
  getJob: (jobId: string) => aGet<{ job: AdminJob; runtime: unknown }>(`/admin/jobs/${jobId}`),
  cancelJob: (jobId: string) =>
    aPost<{ jobId: string; cancelled: boolean }>(`/admin/jobs/${jobId}/cancel`),
  retryJob: (jobId: string) =>
    aPost<{ jobId: string; retrying: boolean }>(`/admin/jobs/${jobId}/retry`),

  // Users
  listUsers: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return aGet<{ users: AdminUser[]; total: number }>(`/admin/users?${q}`);
  },
  getUser: (userId: string) =>
    aGet<{ userId: string; jobs: AdminJob[]; profiles: unknown[]; files: unknown[] }>(
      `/admin/users/${userId}`,
    ),
  getUserPrompts: (userId: string, limit = 50) =>
    aGet<{ prompts: { job_id: string; prompt: string; status: string; started_at: string }[] }>(
      `/admin/users/${userId}/prompts?limit=${limit}`,
    ),

  // Workflows
  listWorkflows: (params?: {
    siteId?: string;
    isActive?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.siteId) q.set("siteId", params.siteId);
    if (params?.isActive) q.set("isActive", params.isActive);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return aGet<{ workflows: AdminWorkflow[]; total: number }>(`/admin/workflows?${q}`);
  },
  createWorkflow: (data: Partial<AdminWorkflow>) =>
    aPost<{ workflow: AdminWorkflow }>("/admin/workflows", data),
  updateWorkflow: (id: string, data: Partial<AdminWorkflow>) =>
    aPut<{ workflow: AdminWorkflow }>(`/admin/workflows/${id}`, data),
  deleteWorkflow: (id: string) => aDel<{ deleted: boolean }>(`/admin/workflows/${id}`),

  // Zero-Shot Runs
  listZeroShotRuns: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return aGet<{ runs: AdminZeroShotRun[]; total: number }>(`/admin/zero-shot-runs?${q}`);
  },
  promoteToWorkflow: (runId: string, data: Partial<AdminWorkflow>) =>
    aPost<{ workflow: AdminWorkflow }>(`/admin/zero-shot-runs/${runId}/promote`, data),

  // Browsers
  browsers: () => aGet<{ browsers: Record<string, unknown> }>("/admin/browsers"),
  recycleBrowsers: () => aPost<{ recycled: boolean }>("/admin/browsers/recycle"),

  // Cache
  flushCache: (pattern?: string) => aPost<{ flushed: number }>("/admin/cache/flush", { pattern }),

  // Captcha
  pendingCaptchas: () => aGet<{ captchas: CaptchaItem[] }>("/admin/captcha/pending"),
  solveCaptcha: (captchaId: string, solution: string) =>
    aPost<{ captchaId: string; solved: boolean }>(`/admin/captcha/${captchaId}/solve`, {
      solution,
    }),

  // Analytics
  workflowAnalytics: (days = 30) =>
    aGet<{ days: number; workflows: WorkflowAnalyticsRow[] }>(
      `/admin/analytics/workflows?days=${days}`,
    ),
  llmUsage: (days = 30) => aGet<LLMUsageData>(`/admin/analytics/llm-usage?days=${days}`),

  // Reliability
  captchaSpend: () => aGet<CaptchaSpend>("/admin/captcha/spend"),
  selectorHealth: (siteId: string) =>
    aGet<{ siteId: string; report: SelectorHealthRow[] }>(
      `/admin/selectors/health?siteId=${encodeURIComponent(siteId)}`,
    ),
  circuitBreakers: () => aGet<{ breakers: CircuitBreakerRow[] }>("/admin/circuit-breakers"),

  // Logs
  getLogs: (service = "api", limit = 200) =>
    aGet<{ service: string; entries: LogEntry[] }>(`/admin/logs?service=${service}&limit=${limit}`),

  // Network
  networkStats: () =>
    aGet<{
      requestsTotal: number;
      requestsFailed: number;
      avgLatencyMs: number;
      timestamp: string;
    }>("/admin/network/stats"),

  // Errors
  getErrors: (limit = 100) => aGet<{ errors: LogEntry[] }>(`/admin/errors?limit=${limit}`),

  // Sites
  listSites: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return aGet<{ sites: AdminSite[]; total: number }>(`/admin/sites?${q}`);
  },

  // Observability
  observabilitySummary: () =>
    aGet<{ events24h: number; errors24h: number; sessions24h: number }>(
      "/admin/observability/summary",
    ),
  listObsSessions: (limit = 50) =>
    aGet<{ sessions: ObsSessionRow[] }>(`/admin/observability/sessions?limit=${limit}`),
  sessionTimeline: (sessionId: string, limit = 500) =>
    aGet<{ sessionId: string; events: ObsTimelineEvent[] }>(
      `/admin/observability/sessions/${encodeURIComponent(sessionId)}/timeline?limit=${limit}`,
    ),
  listObsErrors: (limit = 100) =>
    aGet<{ errors: ErrorReportRow[] }>(`/admin/observability/errors?limit=${limit}`),
  observabilityCopilot: (body: {
    question: string;
    errorReportId?: string;
    context?: Record<string, unknown>;
  }) =>
    aPost<{ answer: string; model?: string; structured?: unknown }>(
      "/admin/observability/copilot",
      body,
    ),
  generalizeSteps: (body: { steps: any[]; starterActionPlan?: any }) =>
    aPost<{ generalized: any[] }>("/admin/record/generalize", body),
} as const;
