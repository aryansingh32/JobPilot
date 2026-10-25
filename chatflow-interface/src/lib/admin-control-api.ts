// ============================================================
// ADMIN CONTROL API — product, platform and automation endpoints of the
// admin service (applications, job sources, workflows studio, recorder,
// settings, admins, audit, AI usage, inbox, resume parsing).
// ============================================================

import { aDel, aGet, aPost, aPut } from "./admin-api";

const qs = (p: Record<string, string | number | boolean | undefined | null>) =>
  Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

// ── Applications ────────────────────────────────────────────
export type AppStatus =
  | "queued" | "running" | "needs_input" | "awaiting_review"
  | "submitted" | "completed" | "failed" | "cancelled";

export interface AdminApplication {
  id: string;
  user_id: string;
  title: string;
  company: string | null;
  url: string | null;
  status: AppStatus;
  status_detail: string | null;
  reference: string | null;
  error: string | null;
  exec_job_id: string | null;
  created_at: string;
  updated_at: string;
  user_email?: string | null;
}
export interface AppEvent {
  phase: string;
  detail: Record<string, unknown>;
  at: string;
}
export interface PendingInput {
  type: string;
  contextMessage?: string;
  question?: string;
  options?: string[];
  title?: string;
  sections?: Array<{ id: string; title: string; fields: ReviewFieldDTO[] }>;
  missing?: string[];
  captchaUrl?: string;
  captchaKind?: "text" | "click";
}
export interface ReviewFieldDTO {
  id: string;
  label: string;
  kind: string;
  value: string;
  source: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}
export type AdminApplicationDetail = AdminApplication & { events: AppEvent[]; pending: PendingInput | null };

// ── Job sources ─────────────────────────────────────────────
export interface JobBoard {
  id: string;
  company: string | null;
  ats_type: string;
  board_token: string;
  country: string | null;
  enabled: boolean;
  poll_interval_minutes: number;
  last_polled_at: string | null;
  last_status: string | null;
  last_error: string | null;
  job_count: number;
  config: Record<string, unknown>;
}
export interface SourceType {
  label: string;
  tokenHint: string;
  example: string;
}
export interface SourceTestResult {
  ok: boolean;
  company?: string | null;
  count?: number;
  ms: number;
  error?: string;
  sample?: Array<{ title: string; url: string; location: string | null; country: string | null; workplace: string | null; postedAt: string | null }>;
}
export interface FeedStats {
  boards: { total: number; enabled: number; erroring: number; stale: number; never_polled: number };
  jobs: { active: number; closed: number; hidden: number; new_24h: number; active_india: number; active_us: number; active_remote: number };
  bySystem: Array<{ ats_type: string; boards: number; jobs: number }>;
}
export interface FeedJob {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  country: string | null;
  workplace: string | null;
  status: string;
  posted_at: string | null;
  url: string;
  ats_type: string;
}

// ── Workflows ───────────────────────────────────────────────
export interface PlanStep {
  id: string;
  order?: number;
  action: string;
  target?: { value: string; type?: string; fallbackSelectors?: string[] };
  value?: string;
  description?: string;
  timeout?: number;
  retries?: number;
  expectedInput?: string;
  contextMessage?: string;
  metadata?: Record<string, unknown>;
}
export interface WorkflowRow {
  id: string;
  workflow_key: string | null;
  site_id: string;
  category: string | null;
  name: string;
  trigger: string;
  trigger_phrases: string[] | null;
  portal_type: string | null;
  entry_url: string | null;
  page_url_patterns: string[] | null;
  required_inputs: string[] | null;
  required_files: string[] | null;
  instructions: string | null;
  starter_action_plan: PlanStep[];
  error_recovery_plan: PlanStep[] | null;
  version: number;
  is_active: boolean;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
export interface WorkflowDefinition {
  id: string;
  name: string;
  category?: string;
  trigger?: string;
  triggerPhrases?: string[];
  portalType?: string;
  entryUrl: string;
  pageUrlPatterns?: string[];
  requiredFiles?: string[];
  instructions?: string;
  starterActionPlan: PlanStep[];
  errorRecoveryPlan?: PlanStep[];
  isActive?: boolean;
  version?: number;
  metadata?: Record<string, unknown>;
}
export interface WorkflowRun {
  job_id: string;
  user_id: string;
  status: string;
  success: boolean | null;
  verified: boolean | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

// ── Platform ────────────────────────────────────────────────
export interface SettingRow {
  key: string;
  group: string;
  kind: "string" | "number" | "boolean" | "json";
  description: string;
  default: unknown;
  value: unknown;
  overridden: boolean;
  min?: number;
  max?: number;
  options?: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface AdminAccount {
  id: string;
  username: string;
  role: "viewer" | "support" | "editor" | "super-admin";
  created_at: string;
  has_api_key?: boolean;
}
export interface AuditEntry {
  id: number;
  at: string;
  username: string | null;
  role: string;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  body: unknown;
}
export interface AiUsage {
  days: number;
  totals: { calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number; errors: number; avg_latency_ms: number };
  byPurpose: Array<{ purpose: string; calls: number; tokens: number; cost_usd: number; errors: number }>;
  byModel: Array<{ model: string; calls: number; tokens: number; cost_usd: number }>;
  byDay: Array<{ day: string; calls: number; tokens: number; cost_usd: number }>;
  topUsers: Array<{ user_id: string; calls: number; tokens: number; cost_usd: number }>;
}
export interface AiStatus {
  killswitch: boolean;
  reasoningEnabled: boolean;
  todaySpendUsd: number;
  globalDailyBudgetUsd: number;
  userDailyTokenBudget: number;
}
export interface AdminEmail {
  id: string;
  user_id: string;
  to_address: string;
  from_name: string | null;
  from_address: string;
  subject: string;
  snippet: string;
  category: string;
  has_code: boolean;
  application_id: string | null;
  match_method: string | null;
  received_at: string;
}
export interface ResumeParseRow {
  id: string;
  user_id: string;
  status: string;
  text_chars: number | null;
  model: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RegistryStats {
  bySystem: { ats_type: string; status: "candidate" | "active" | "empty" | "dead"; boards: number; jobs: number | null; focus_jobs: number | null; focus_boards: number }[];
  runs: { id: string; source: string; status: string; found: number; added: number; error: string | null; started_at: string; finished_at: string | null }[];
  due_now: number;
  polled_24h: number;
}

export const controlApi = {
  // Applications
  applications: (p: { status?: string; q?: string; userId?: string; limit?: number; offset?: number } = {}) =>
    aGet<{ applications: AdminApplication[]; last7Days: Record<string, number> }>(`/admin/applications?${qs(p)}`),
  applicationsBySite: (days = 7) =>
    aGet<{
      days: number;
      sites: {
        site: string; attempts: number; submitted: number; failed: number; waiting: number; by_user: number;
        median_seconds: number | null; successRate: number | null; topErrors: { error: string; n: number }[];
      }[];
    }>(`/admin/applications/by-site?days=${days}`),
  application: (id: string) => aGet<AdminApplicationDetail>(`/admin/applications/${id}`),
  cancelApplication: (id: string) => aPost(`/admin/applications/${id}/cancel`),
  markApplication: (id: string, status: AppStatus, note?: string) =>
    aPost(`/admin/applications/${id}/mark`, { status, note }),

  // Running jobs (test runs, any execute job)
  jobPending: (jobId: string) =>
    aGet<{ pending: { type: string; payload: PendingInput } | null; runtime: { status: string; error?: string } | null }>(
      `/admin/jobs/${jobId}/pending`,
    ),
  respondToJob: (jobId: string, value: string) => aPost(`/admin/jobs/${jobId}/respond`, { value }),
  cancelJob: (jobId: string) => aPost(`/admin/jobs/${jobId}/cancel`),

  // Job sources
  feedStats: () => aGet<FeedStats>("/admin/jobs-feed/stats"),
  registry: () => aGet<RegistryStats>("/admin/jobs-feed/registry"),
  discover: (b: { source: "dataset" | "commoncrawl" | "seed"; systems?: string[]; crawls?: string[] }) =>
    aPost<{ queued: string }>("/admin/jobs-feed/discover", b),
  sourceTypes: () => aGet<{ types: Record<string, SourceType> }>("/admin/jobs-feed/source-types"),
  boards: (p: { status?: string; q?: string } = {}) => aGet<{ boards: JobBoard[] }>(`/admin/jobs-feed/boards?${qs(p)}`),
  testSource: (b: { atsType: string; token: string; config?: unknown }) => aPost<SourceTestResult>("/admin/jobs-feed/sources/test", b),
  addBoard: (b: { atsType: string; token: string; company: string; country?: string; pollIntervalMinutes?: number; config?: unknown }) =>
    aPost<{ board: JobBoard }>("/admin/jobs-feed/boards", b),
  updateBoard: (id: string, b: { enabled?: boolean; pollIntervalMinutes?: number; country?: string | null; config?: unknown }) =>
    aPut<{ board: JobBoard }>(`/admin/jobs-feed/boards/${id}`, b),
  deleteBoard: (id: string) => aDel(`/admin/jobs-feed/boards/${id}`),
  pollBoard: (id: string) => aPost(`/admin/jobs-feed/boards/${id}/poll`),
  seedBoards: () => aPost<{ added: number }>("/admin/jobs-feed/seed"),
  feedJobs: (p: { q?: string; status?: string; country?: string; limit?: number; offset?: number } = {}) =>
    aGet<{ jobs: FeedJob[] }>(`/admin/jobs-feed/jobs?${qs(p)}`),
  hideJob: (id: string) => aPost(`/admin/jobs-feed/jobs/${id}/hide`),
  unhideJob: (id: string) => aPost(`/admin/jobs-feed/jobs/${id}/unhide`),

  // Workflows studio
  workflows: () => aGet<{ workflows: WorkflowRow[]; total: number }>("/admin/workflows?limit=500"),
  updateWorkflow: (id: string, body: Record<string, unknown>) => aPut<{ workflow: WorkflowRow }>(`/admin/workflows/${id}`, body),
  deleteWorkflow: (id: string) => aDel(`/admin/workflows/${id}`),
  importWorkflow: (def: WorkflowDefinition | WorkflowDefinition[]) =>
    aPost<{ results: Array<{ id?: string; dbId?: string; ok: boolean; error?: string }> }>("/admin/workflows/import", def),
  exportWorkflow: (id: string) => aGet<WorkflowDefinition>(`/admin/workflows/${id}/export`),
  duplicateWorkflow: (id: string) => aPost<{ id: string }>(`/admin/workflows/${id}/duplicate`),
  workflowHistory: (id: string) =>
    aGet<{ history: Array<{ id: string; action: string; diff: unknown; timestamp: string; username: string | null }> }>(
      `/admin/workflows/${id}/history`,
    ),
  restoreWorkflow: (id: string, entryId: string) => aPost(`/admin/workflows/${id}/restore/${entryId}`),
  workflowRuns: (id: string) =>
    aGet<{ runs: WorkflowRun[]; stats: { runs: number; ok: number; avg_ms: number | null } }>(`/admin/workflows/${id}/runs`),
  testRun: (id: string, body: { url?: string; jobId?: string; submit?: boolean }) =>
    aPost<{ execJobId: string; applicationId?: string; applyUrl?: string }>(`/admin/workflows/${id}/test-run`, body),

  // Test profile
  testProfile: () =>
    aGet<{ userId: string; profile: Record<string, unknown>; resume: { id: string; name: string } | null }>("/admin/test-profile"),
  saveTestProfile: (body: { profile?: unknown; resume?: { name: string; base64: string } }) => aPut("/admin/test-profile", body),

  // Recorder
  recorderStatus: () => aGet<{ workerOnline: boolean; workerId: string | null }>("/admin/record/status"),
  recordStart: (url: string, sessionId: string) =>
    aPost<{ success: boolean; viewport?: { width: number; height: number } }>("/admin/record/start", { url, sessionId }),
  recordInput: (sessionId: string, input: Record<string, unknown>) =>
    aPost<{ url: string }>("/admin/record/input", { sessionId, input }),
  recordStop: (sessionId: string) => aPost<{ steps: unknown[] }>("/admin/record/stop", { sessionId }),
  recordCompile: (steps: unknown[], jobApply: boolean) =>
    aPost<{ steps: PlanStep[] }>("/admin/record/compile", { steps, jobApply }),
  dryRun: (url: string, steps: PlanStep[]) =>
    aPost<{ success: boolean; steps: Array<{ stepId: string; action: string; status: string; note?: string }>; error?: string }>(
      "/admin/record/dry-run",
      { url, steps },
    ),

  // Platform
  settings: () => aGet<{ settings: SettingRow[] }>("/admin/settings"),
  setSetting: (key: string, value: unknown) => aPut(`/admin/settings/${encodeURIComponent(key)}`, { value }),
  resetSetting: (key: string) => aDel(`/admin/settings/${encodeURIComponent(key)}`),
  settingHistory: (key: string) =>
    aGet<{ history: Array<{ old_value: unknown; new_value: unknown; changed_at: string; changed_by: string | null }> }>(
      `/admin/settings/${encodeURIComponent(key)}/history`,
    ),
  admins: () => aGet<{ admins: AdminAccount[] }>("/admin/admins"),
  createAdmin: (b: { username: string; password: string; role: string }) => aPost("/admin/admins", b),
  updateAdmin: (id: string, b: { role?: string; password?: string }) => aPut(`/admin/admins/${id}`, b),
  deleteAdmin: (id: string) => aDel(`/admin/admins/${id}`),
  audit: (p: { path?: string; before?: number } = {}) =>
    aGet<{ entries: AuditEntry[]; nextBefore: number | null }>(`/admin/audit?${qs(p)}`),
  aiUsage: (days = 7) => aGet<AiUsage>(`/admin/ai/usage?days=${days}`),
  aiStatus: () => aGet<AiStatus>("/admin/ai/status"),
  emails: (p: { unmatched?: boolean; userId?: string } = {}) => aGet<{ emails: AdminEmail[] }>(`/admin/emails?${qs(p)}`),
  matchEmail: (id: string, applicationId: string) => aPost(`/admin/emails/${id}/match`, { applicationId }),
  resumeParses: (status?: string) => aGet<{ parses: ResumeParseRow[] }>(`/admin/resume-parses?${qs({ status })}`),
};
