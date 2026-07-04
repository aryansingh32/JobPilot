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

export type ChatMessage =
  | TextMessage
  | FileMessage
  | DownloadMessage
  | InputCardMessage
  | TimelineMessage
  | StatusMessage;

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
