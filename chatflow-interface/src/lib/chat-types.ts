export type Role = "user" | "bot" | "system";

export type InputCardKind =
  | "otp"
  | "captcha"
  | "clickCaptcha"
  | "upi"
  | "confirm"
  | "text"
  | "credentialFill"
  | "gridCaptcha"
  | "sliderCaptcha"
  | "paymentPending";

export interface BaseMessage {
  id: string;
  role: Role;
  createdAt: number;
}

export interface TextMessage extends BaseMessage {
  type: "text";
  content: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  url?: string; // local object URL (preview only)
}

export interface FileMessage extends BaseMessage {
  type: "file-upload";
  files: FileAttachment[];
  note?: string;
}

export interface DownloadMessage extends BaseMessage {
  type: "download";
  title: string;
  description?: string;
  fileName: string;
  mime: string;
  sizeLabel?: string;
  /** Backend file ID for authenticated download */
  fileId?: string;
  /** Direct download URL (constructed from backend) */
  downloadUrl?: string;
}

export interface InputCardMessage extends BaseMessage {
  type: "input-card";
  kind: InputCardKind;
  prompt: string;
  data?: {
    captchaUrl?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    amount?: string;
    inputType?: string;
    domain?: string;
    /** OTP length when the site states it (usually 4 or 6, sometimes 8) */
    length?: number;
    /** Where the code was sent, already masked — e.g. "+91 •••• ••501" */
    destination?: string;
    /** A form question the run is paused on, with the site's fixed answers if any. */
    question?: string;
    options?: string[];
  };
  resolved?: { value: string; at: number };
  /** Backend job ID, used when resuming a paused job */
  jobId?: string;
  /** Backend step ID, used to target the exact paused step */
  stepId?: string;
}

export interface TimelineStep {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  at: number;
}

export interface TimelineMessage extends BaseMessage {
  type: "timeline";
  title: string;
  steps: TimelineStep[];
  done: boolean;
}

/** System status message (connection, errors, etc.) */
export interface StatusMessage extends BaseMessage {
  type: "status";
  variant: "info" | "success" | "warning" | "error";
  content: string;
}

/** Where a filled value came from — shown on every field so the user knows what to check. */
export type FieldSource =
  | "profile"
  | "memory"
  | "user"
  | "edited"
  | "workflow"
  | "default"
  | "ai"
  | "missing";

export type ReviewFieldKind =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "number"
  | "date"
  | "select"
  | "boolean"
  | "file";

export interface ReviewField {
  id: string;
  label: string;
  kind: ReviewFieldKind;
  value: string;
  source: FieldSource;
  required?: boolean;
  /** Locked fields come straight from the saved profile and are edited there, not here. */
  locked?: boolean;
  options?: { label: string; value: string }[];
  /** Short note on why the agent chose this value (shown under AI-written fields). */
  hint?: string;
}

export interface ReviewSection {
  id: string;
  title: string;
  fields: ReviewField[];
}

/** U3 — the run is paused before an irreversible step; the user approves the exact values. */
export interface ReviewMessage extends BaseMessage {
  type: "review";
  title: string;
  site?: string;
  siteUrl?: string;
  /** What happens on approve, e.g. "Submit application". */
  actionLabel: string;
  sections: ReviewSection[];
  jobId?: string;
  stepId?: string;
  resolved?: { action: "approved" | "cancelled"; values: Record<string, string>; at: number };
}

export interface ReceiptItem {
  label: string;
  value: string;
}

/** U5 — proof of what was actually sent once the run finishes. */
export interface ReceiptMessage extends BaseMessage {
  type: "receipt";
  status: "submitted" | "completed" | "failed";
  title: string;
  site?: string;
  siteUrl?: string;
  reference?: string;
  durationMs?: number;
  completedAt: number;
  sections: { title: string; items: ReceiptItem[] }[];
  files?: { name: string; fileId?: string; downloadUrl?: string; sizeLabel?: string }[];
  steps?: { label: string; atMs: number }[];
  nextSteps?: string[];
}

/** Real roles the assistant picked for the user, shown as cards. */
export interface JobCardsMessage extends BaseMessage {
  type: "job-cards";
  title: string;
  jobs: import("./api-client").JobListingDTO[];
  empty?: string;
}

/** A one-tap question the assistant asked (code, number, choice, yes/no). */
export interface AskMessage extends BaseMessage {
  type: "ask";
  kind: "otp" | "number" | "text" | "choice" | "confirm";
  prompt: string;
  options?: string[];
  length?: number;
  resolved?: { value: string; at: number };
}

/** Shortcut buttons to other screens. */
export interface ActionsMessage extends BaseMessage {
  type: "actions";
  actions: { view: string; label: string }[];
}

/** Live status of recent applications, updated in place. */
export interface AppsStatusMessage extends BaseMessage {
  type: "apps-status";
  ids: string[];
}

export type ChatMessage =
  | JobCardsMessage
  | AskMessage
  | ActionsMessage
  | AppsStatusMessage
  | TextMessage
  | FileMessage
  | DownloadMessage
  | InputCardMessage
  | TimelineMessage
  | StatusMessage
  | ReviewMessage
  | ReceiptMessage;

export interface Thread {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  /** Backend session ID associated with this thread */
  sessionId?: string;
  /** Active job ID for this thread */
  activeJobId?: string;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
}

export const PROFILES: Profile[] = [
  { id: "personal", name: "Personal", description: "Your default profile" },
  { id: "work", name: "Work", description: "Professional context" },
  { id: "family", name: "Family", description: "Shared family tasks" },
];
