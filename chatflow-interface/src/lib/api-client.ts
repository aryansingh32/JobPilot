// ============================================================
// REST API CLIENT
// Typed wrapper for all backend REST endpoints.
// Every call includes x-api-key authentication.
// ============================================================

import { config } from "./config";
import { createLogger } from "./logger";
import { nativeHeaders } from "./native";

const logger = createLogger("frontend-api");

// ─── Types (mirrors backend shared/types) ──────────────────

export interface JobResponse {
  jobId: string;
  sessionId?: string;
  status: string;
  message?: string;
}

export interface UserProfile {
  id: string;
  userId: string;
  profileName: string;
  data: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface UserFile {
  id: string;
  userId: string;
  profileName?: string;
  category: "resume" | "signature" | "photo" | "document" | "receipt" | "other";
  originalName: string;
  storedName: string;
  mimeType: string;
  fileSizeBytes: number;
  storagePath: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  references?: {
    fileRef: string;
    latestCategoryRef: string;
    templateRef: string;
  };
}

export interface SiteWorkflow {
  id: string;
  workflowKey?: string;
  siteId: string;
  category?: string;
  name: string;
  trigger: string;
  triggerPhrases?: string[];
  portalType?: string;
  requiredInputs?: string[];
  requiredFiles?: string[];
  instructions: string;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  status: "healthy" | "degraded";
  db: string;
  redis: string;
  browsers: Record<string, unknown>;
  uptime: number;
  timestamp: string;
}

export interface JobRuntimeState {
  jobId: string;
  userId: string;
  sessionId: string;
  siteId: string;
  task: string;
  status: "queued" | "running" | "paused" | "completed" | "failed";
  activeStepId?: string;
  lastInputType?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── HTTP helpers ───────────────────────────────────────────

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${config.apiBaseUrl}${path}`;
  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    ...(await nativeHeaders()),
    ...((options.headers as Record<string, string>) || {}),
  };

  // Add content-type for JSON bodies
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  logger.debug("request:start", {
    url,
    method: options.method ?? "GET",
    origin: typeof window !== "undefined" ? window.location.origin : "server",
  });

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers, credentials: "include" });
  } catch (error) {
    logger.error("request:network-error", error, {
      url,
      method: options.method ?? "GET",
      origin: typeof window !== "undefined" ? window.location.origin : "server",
      corsHint: "Check backend CORS_ORIGIN and x-api-key allowed headers",
    });
    throw error;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `API ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch {}
    logger.warn("request:failed", {
      url,
      method: options.method ?? "GET",
      status: res.status,
      statusText: res.statusText,
      responseBody: body.slice(0, 500),
    });
    throw new ApiError(msg, res.status);
  }

  logger.debug("request:success", {
    url,
    method: options.method ?? "GET",
    status: res.status,
  });
  return res.json() as Promise<T>;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

// ─── API Methods ────────────────────────────────────────────

export const api = {
  // Health
  health: () => get<HealthResponse>("/health"),

  // Execute
  execute: (payload: {
    siteId: string;
    task: string;
    sessionId?: string;
    priority?: "critical" | "high" | "normal" | "low";
  }) => post<JobResponse>("/execute", payload),

  // Jobs
  getJob: (jobId: string) => get<{ job: Record<string, unknown> }>(`/jobs/${jobId}`),
  getJobRuntime: (jobId: string) => get<{ runtime: JobRuntimeState }>(`/jobs/${jobId}/runtime`),
  resumeJob: (jobId: string, input: string) =>
    post<{ jobId: string; resumed: boolean }>(`/jobs/${jobId}/resume`, { input }),
  cancelJob: (jobId: string) =>
    post<{ jobId: string; cancelled: boolean }>(`/jobs/${jobId}/cancel`, {}),

  // Profiles — identity comes from the session cookie now, never from the caller
  getProfiles: () => get<{ profiles: UserProfile[] }>(`/memory/profiles`),

  getProfile: (profileName: string) =>
    get<{ profile: UserProfile }>(`/memory/profiles/${encodeURIComponent(profileName)}`),

  saveProfile: (profileName: string, data: Record<string, string>) =>
    post<{ saved: boolean; profileName: string }>("/memory/profiles", {
      profileName,
      data,
    }),

  updateProfile: (profileName: string, data: Record<string, string>, newName?: string) =>
    put<{ profile: UserProfile }>(`/memory/profiles/${encodeURIComponent(profileName)}`, {
      data,
      newProfileName: newName,
    }),

  deleteProfile: (profileName: string) =>
    del<{ deleted: boolean }>(`/memory/profiles/${encodeURIComponent(profileName)}`),

  // Files
  uploadFile: (payload: {
    originalName: string;
    mimeType: string;
    base64Data: string;
    category?: UserFile["category"];
    profileName?: string;
  }) => post<{ file: UserFile; references: UserFile["references"] }>("/files/upload", payload),

  listFiles: (category?: string) =>
    get<{ files: UserFile[] }>(`/files${category ? `?category=${category}` : ""}`),

  getFile: (fileId: string) => get<{ file: UserFile }>(`/files/${fileId}`),

  getFileDownloadUrl: (fileId: string) => `${config.apiBaseUrl}/files/${fileId}/download`,

  deleteFile: (fileId: string) => del<{ deleted: boolean }>(`/files/${fileId}`),

  // Workflows
  listWorkflows: (siteId?: string) =>
    get<{ workflows: SiteWorkflow[] }>(`/workflows${siteId ? `?siteId=${siteId}` : ""}`),

  getWorkflow: (workflowId: string) => get<{ workflow: SiteWorkflow }>(`/workflows/${workflowId}`),

  // Queues
  getQueues: () => get<{ queues: Record<string, unknown> }>("/queues"),
} as const;

// ─── JobPilot user API (profile, jobs feed, applications, inbox) ────────────

export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    mobileNumber: string | null;
    displayName: string | null;
  };
  profile: {
    completeness: number;
    onboardingStatus: "pending" | "done" | "skipped";
    fullName: string | null;
    hasResume?: boolean;
  };
  applications: ApplicationCounts;
  inbox: { address: string | null; unread: number };
  credits?: { enabled: boolean; balance: number | null; costPerApplication: number };
  notifications?: { unread: number };
}

export interface ApplicationCounts {
  all: number;
  needs: number;
  active: number;
  done: number;
  failed: number;
}

export type ApplicationStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "awaiting_review"
  | "submitted"
  | "completed"
  | "failed"
  | "cancelled";

/** Where an application stands with the employer after it was sent (from their emails). */
export type ApplicationOutcome = "confirmed" | "assessment" | "interview" | "offer" | "rejected";

export interface ApplicationSummary {
  id: string;
  source?: "manual" | "chat" | "auto" | "admin_test";
  outcome?: ApplicationOutcome | null;
  title: string;
  company: string | null;
  url: string | null;
  status: ApplicationStatus;
  status_detail: string | null;
  reference: string | null;
  error: string | null;
  job_id: string | null;
  exec_job_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface PendingFieldDTO {
  id: string;
  label: string;
  kind: string;
  value: string;
  source: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  /** Answered on an earlier page of a multi-page form: shown, not editable here. */
  locked?: boolean;
}

/** What a paused application is waiting for: a question, or a review before submit. */
export interface PendingDTO {
  type: string;
  contextMessage?: string;
  question?: string;
  options?: string[];
  /** Several questions asked together; answered as one JSON object keyed by id. */
  questions?: { id: string; question: string; options?: string[] }[];
  title?: string;
  sections?: { id: string; title: string; fields: PendingFieldDTO[] }[];
  missing?: string[];
  /** Captchas: a cropped screenshot of just the captcha (no live view). */
  captchaUrl?: string;
  captchaKind?: "text" | "click";
  /** OTP: digits expected, and where it was sent (already masked). */
  length?: number;
  destination?: string;
  /** OTP: where it arrives. 'email' is read from the inbox automatically; 'sms' only you can type. */
  channel?: "email" | "email-manual" | "sms";
  /** Aadhaar, codes, PINs: sent straight to the site, never to the AI. */
  sensitive?: boolean;
}

export interface ApplicationDetail extends ApplicationSummary {
  events: { phase: string; detail: Record<string, unknown>; at: string }[];
  pending?: PendingDTO | null;
}

/** The live line on the jobs screen (GET /jobboard/pulse). */
export interface JobPulseDTO {
  fits: number;
  fitsWindowDays: number;
  fitsNewToday: number;
  fitCompanies: number;
  city: { name: string; roles: number; companies: number; newToday: number } | null;
  latest: { id: string; title: string; company: string; location: string | null; seenAt: string }[];
  platform: { jobs: number; companies: number; addedLastHour: number; checkedAt: string | null };
  firstName: string | null;
  role: string | null;
}

export interface GmailStatusDTO {
  available: boolean;
  connection: {
    address: string;
    status: "active" | "revoked" | "error";
    last_sync_at: string | null;
    last_error: string | null;
    messages_kept: number;
  } | null;
}

export interface JobListingDTO {
  id: string;
  title: string;
  company: string;
  location: string;
  workplace?: "Remote" | "Hybrid" | "On-site";
  employmentType?: string;
  salary?: string;
  postedAt: number | null;
  matchScore?: number;
  matchReasons?: string[];
  matchedSkills?: string[];
  atsType: string;
  url: string;
  /** Government notices: application deadline (epoch ms) and head-count. */
  closesAt?: number;
  vacancies?: number;
}

/** One email in full (the list only carries a snippet). */
export interface EmailDetailDTO extends InboxEmailDTO {
  to_address: string;
  body_text: string | null;
  extracted_link: string | null;
  source: string;
}

export interface JobDetailDTO extends JobListingDTO {
  description: string;
  department?: string;
  skills: string[];
  seniority?: string;
  experienceMin?: number;
  experienceMax?: number;
  country?: string;
}

export interface JobSearchParams {
  q?: string;
  location?: string;
  workplace?: string;
  type?: string;
  page?: number;
}

export interface InboxEmailDTO {
  id: string;
  from_name: string | null;
  from_address: string;
  subject: string;
  snippet: string;
  category: "code" | "confirmation" | "reply" | "other";
  intent?: "interview" | "assessment" | "offer" | "rejection" | null;
  extracted_code: string | null;
  read: boolean;
  received_at: string;
  application_id: string | null;
  application_title: string | null;
}

/** Typed applicant profile (backend shared/profile ProfileData). */
export interface ProfileDataDTO {
  personal?: Record<string, string | boolean | undefined>;
  work?: Record<string, string | number | undefined>;
  authorization?: { statement?: string; needsSponsorship?: boolean; countries?: string[] };
  preferences?: {
    roles?: string[];
    locations?: string[];
    workplace?: string[];
    jobTypes?: string[];
  };
  education?: unknown[];
  experience?: unknown[];
  skills?: string[];
  about?: string;
  projects?: unknown[];
  documents?: {
    resumeFileId?: string;
    resumeFileName?: string;
    photoFileId?: string;
    signatureFileId?: string;
  };
  settings?: Record<string, string | boolean | undefined>;
}

export interface ProfileDTO {
  userId: string;
  data: ProfileDataDTO;
  version: number;
  onboardingStatus: "pending" | "done" | "skipped";
  completeness: number;
  updatedAt: string;
}

export interface ResumeParseDTO {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  result?: ProfileDataDTO | null;
  error?: string | null;
}

/** A fact nearly every application form needs that the profile doesn't have yet. */
export interface ProfileGapDTO {
  key: string;
  label: string;
  hint?: string;
  input: "text" | "choice";
  options?: string[];
  blocking: boolean;
}

export interface AutoApplySettingsDTO {
  enabled: boolean;
  dailyCap: number;
  minScore: number;
  excludeCompanies: string[];
  lastRunAt: string | null;
}

export interface AutoApplyRunDTO {
  id: string;
  trigger: "schedule" | "manual" | "admin";
  status: "running" | "done" | "skipped" | "failed";
  considered: number;
  started: number;
  note: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AutoApplyPreviewDTO {
  blockers: string[];
  capacity: {
    now: number;
    leftToday: number;
    freeSlots: number;
    affordable: number | null;
    dailyLimitLeft: number;
  };
  candidates: { jobId: string; title: string; company: string; score: number; atsType: string }[];
  /** Matches held back by the guard rules (company cooldown, repeated failures, a failing applicant system). */
  guards?: { companyCooldown: number; repeatedFailures: number; unhealthySystem: string[] };
  total: number;
}

export type PayCurrency = "INR" | "USD";

export interface CreditPackDTO {
  id: string;
  label: string;
  credits: number;
  /** Smallest unit: paise / cents. */
  amount: number;
  currency: PayCurrency;
}

export type CheckoutDTO =
  | {
      provider: "razorpay";
      paymentId: string;
      orderId: string;
      keyId: string;
      amount: number;
      currency: PayCurrency;
      credits: number;
      label: string;
    }
  | {
      provider: "stripe";
      paymentId: string;
      url: string;
      amount: number;
      currency: PayCurrency;
      credits: number;
      label: string;
    };

export const jp = {
  me: () => get<MeResponse>("/me"),

  profile: () => get<ProfileDTO>("/me/profile"),
  geo: () => get<{ country: string | null; nationality: string | null }>("/me/geo"),
  patchProfile: (patch: ProfileDataDTO) => put<ProfileDTO>("/me/profile", patch),
  setOnboarding: (status: "done" | "skipped" | "pending") =>
    post<ProfileDTO>("/me/onboarding", { status }),

  uploadResume: (payload: { originalName: string; mimeType: string; base64Data: string }) =>
    post<{ file: { id: string; name: string }; parse: ResumeParseDTO | null }>(
      "/me/resume",
      payload,
    ),
  latestResumeParse: () => get<{ parse: ResumeParseDTO | null }>("/me/resume/parses/latest"),
  applyResumeParse: (id: string) => post<ProfileDTO>(`/me/resume/parses/${id}/apply`, {}),

  recommendations: (limit = 20) =>
    get<{ jobs: JobListingDTO[]; profileCompleteness: number }>(
      `/jobboard/recommendations?limit=${limit}`,
    ),
  pulse: () => get<JobPulseDTO>("/jobboard/pulse"),
  searchJobs: (p: JobSearchParams) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return get<{ jobs: JobListingDTO[]; page: number; hasMore: boolean }>(`/jobboard/search?${qs}`);
  },
  job: (id: string) => get<{ job: JobDetailDTO; saved: boolean }>(`/jobboard/jobs/${id}`),
  integrations: () => get<{ gmail: GmailStatusDTO }>("/me/integrations"),
  connectGmail: () => post<{ url: string }>("/me/integrations/gmail/connect", {}),
  disconnectGmail: () => del<{ ok: boolean }>("/me/integrations/gmail"),
  syncGmail: () => post<{ kept: number }>("/me/integrations/gmail/sync", {}),
  saveJob: (id: string) => post<{ saved: boolean }>(`/jobboard/jobs/${id}/save`, {}),
  unsaveJob: (id: string) => del<{ saved: boolean }>(`/jobboard/jobs/${id}/save`),
  passJob: (id: string) =>
    post<{ ok: boolean }>(`/jobboard/jobs/${id}/feedback`, { action: "pass" }),

  applications: (filter = "all", limit = 50) =>
    get<{ applications: ApplicationSummary[] }>(`/me/applications?filter=${filter}&limit=${limit}`),
  application: (id: string) => get<ApplicationDetail>(`/me/applications/${id}`),
  /** "I finished it on the company's site" (applied) or "drop it" (skip). */
  resolveApplication: (id: string, action: "applied" | "skip") =>
    post<ApplicationDetail>(`/me/applications/${id}/manual`, { action }),
  cancelApplication: (id: string) => post<ApplicationDetail>(`/me/applications/${id}/cancel`, {}),
  /** Start one from the feed (jobId) or a pasted link (url) — no chat needed. */
  startApplication: (body: { jobId?: string; url?: string }) =>
    post<{
      application: ApplicationSummary;
      workflow: { id: string; name: string };
      applyUrl: string;
    }>("/me/applications", body),
  /** Answer the question it's paused on, or approve the review (JSON {action:"approve", values}). */
  respondToApplication: (id: string, value: string) =>
    post<{ ok: boolean }>(`/me/applications/${id}/respond`, { value }),

  profileGaps: (jobId?: string) =>
    get<{ gaps: ProfileGapDTO[] }>(`/me/profile-gaps${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`),
  saveProfileGaps: (answers: Record<string, string>) =>
    put<{ gaps: ProfileGapDTO[]; completeness: number }>("/me/profile-gaps", { answers }),
  portalPassword: () => get<{ set: boolean }>("/me/portal-password"),
  setPortalPassword: (password: string) => put<{ set: boolean }>("/me/portal-password", { password }),
  clearPortalPassword: () => del<{ set: boolean }>("/me/portal-password"),

  autoApply: () =>
    get<{ settings: AutoApplySettingsDTO; lastRun: AutoApplyRunDTO | null }>("/me/auto-apply"),
  saveAutoApply: (patch: Partial<Omit<AutoApplySettingsDTO, "lastRunAt">>) =>
    put<{ settings: AutoApplySettingsDTO }>("/me/auto-apply", patch),
  autoApplyPreview: () => get<AutoApplyPreviewDTO>("/me/auto-apply/preview"),
  runAutoApply: () => post<AutoApplyRunDTO>("/me/auto-apply/run", {}),
  autoApplyRuns: () => get<{ runs: AutoApplyRunDTO[] }>("/me/auto-apply/runs"),

  creditPacks: (currency: PayCurrency) =>
    get<{
      enabled: boolean;
      provider: "razorpay" | "stripe";
      currency: PayCurrency;
      packs: CreditPackDTO[];
    }>(`/me/payments/packs?currency=${currency}`),
  checkout: (packId: string, currency: PayCurrency) =>
    post<CheckoutDTO>("/me/payments/checkout", { packId, currency }),
  confirmRazorpay: (r: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => post<{ ok: boolean; granted: boolean }>("/me/payments/razorpay/confirm", r),

  inbox: (category = "all") =>
    get<{ address: string | null; unread: number; emails: InboxEmailDTO[] }>(
      `/me/inbox?category=${category}`,
    ),
  email: (id: string) => get<EmailDetailDTO>(`/me/inbox/${id}`),
  markEmailRead: (id: string, read = true) =>
    post<{ ok: boolean }>(`/me/inbox/${id}/read`, { read }),
};
