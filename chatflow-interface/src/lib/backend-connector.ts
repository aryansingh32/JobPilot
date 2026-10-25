// ============================================================
// BACKEND CONNECTOR
// Replaces mock-bot.ts — bridges the real backend (REST + Socket.IO)
// to the frontend chat store. This is the main integration layer.
// ============================================================

import { uid } from "./chat-store";
import { api, type UserFile } from "./api-client";
import {
  socketService,
  type PauseEvent,
  type FileEvent,
  type JobStartedEvent,
  type ReceiptEvent,
  type ChatUiCard,
} from "./socket-service";
import type {
  ChatMessage,
  InputCardKind,
  ReviewMessage,
  ReviewSection,
  TimelineStep,
} from "./chat-types";
import { createLogger } from "./logger";
import { showIsland, type IslandTarget } from "./island";
import { toast } from "sonner";

const logger = createLogger("frontend-backend-connector");

export interface BotEmitter {
  pushMessage: (m: ChatMessage) => void;
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void;
  setLiveFrame: (url: string | null, hot?: boolean) => void;
  setTyping: (typing: boolean) => void;
  setBusy: (busy: boolean) => void;
}

// ─── Pause-type → InputCardKind mapping ──────────────────────

function mapPauseToCardKind(type: string): InputCardKind | null {
  switch (type) {
    case "otp":
      return "otp";
    case "captcha":
      return "captcha";
    case "clickCaptcha":
      return "clickCaptcha";
    case "gridCaptcha":
      return "gridCaptcha";
    case "sliderCaptcha":
      return "sliderCaptcha";
    case "paymentPending":
      return "paymentPending";
    case "upi_id":
      return "upi";
    case "credentialFill":
      return "credentialFill";
    case "confirmation":
      return "confirm";
    case "text":
    case "password":
    case "email":
    case "mobile":
    case "emailLink":
      return "text";
    default:
      return null;
  }
}

// ─── File Upload Helper ──────────────────────────────────────

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function guessCategoryFromMime(mime: string, name: string): UserFile["category"] {
  const lower = name.toLowerCase();
  if (/resume|cv/i.test(lower)) return "resume";
  if (/sign/i.test(lower)) return "signature";
  if (/photo|passport|headshot|selfie/i.test(lower)) return "photo";
  if (/receipt/i.test(lower)) return "receipt";
  if (mime.startsWith("image/")) return "photo";
  return "document";
}

// ─── Session ID management ──────────────────────────────────

let currentSessionId: string | null = null;
let currentEmitter: BotEmitter | null = null;
let currentJobId: string | null = null;
let timelineMessageId: string | null = null;
let isInitialized = false;

function setTrackedJobId(jobId: string | null): void {
  currentJobId = jobId;
  if (jobId) {
    socketService.joinJob(jobId);
  }
}

/** Called once the user is known: the chat session id is per user on this device. */
export function scopeSessionToUser(userId: string): void {
  sessionScope = userId;
  currentSessionId = null;
}
let sessionScope = "anon";
const SESSION_KEY = () => `agent-session-id:${sessionScope}`;

export function getSessionId(): string {
  if (!currentSessionId) {
    // Try to restore from localStorage
    if (typeof window !== "undefined") {
      currentSessionId = window.localStorage.getItem(SESSION_KEY());
    }
    if (!currentSessionId) {
      currentSessionId = uid() + "-" + uid();
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SESSION_KEY(), currentSessionId);
      }
    }
  }
  return currentSessionId;
}

/**
 * Reset the backend session — generates a fresh session ID,
 * cancels any running job, and reconnects the socket.
 * Call this when the user starts a "New chat".
 */
export function resetSession(): void {
  // Cancel any running job before switching sessions
  if (currentJobId) {
    cancelActiveJob();
  }

  // Generate a brand-new session ID
  currentSessionId = uid() + "-" + uid();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY(), currentSessionId);
  }

  // Reconnect socket with the new session
  if (isInitialized && currentEmitter) {
    socketService.disconnect();
    isInitialized = false;
    initializeBackend(currentEmitter);
  }

  currentJobId = null;
  timelineMessageId = null;
  logger.info("session:reset", { newSessionId: currentSessionId });
}

/**
 * Cancel the currently active automation job on the backend.
 */
export async function cancelActiveJob(): Promise<void> {
  if (!currentJobId) return;
  const jobId = currentJobId;
  currentJobId = null;
  try {
    await api.cancelJob(jobId);
    logger.info("job:cancelled", { jobId });
  } catch (err) {
    logger.warn("job:cancel-failed", { jobId, error: (err as Error).message });
  }
}

// ─── Initialize Socket Connection ────────────────────────────

export function initializeBackend(emitter: BotEmitter): void {
  if (isInitialized) {
    // Just update the emitter reference
    currentEmitter = emitter;
    socketService.updateCallbacks(buildCallbacks(emitter));
    return;
  }

  currentEmitter = emitter;
  const sessionId = getSessionId();

  socketService.connect(sessionId, buildCallbacks(emitter));
  isInitialized = true;
}

function buildCallbacks(emitter: BotEmitter) {
  return {
    onChatReceive: (message: string) => {
      emitter.setTyping(false);
      emitter.setBusy(false);
      emitter.pushMessage({
        id: uid(),
        role: "bot" as const,
        type: "text" as const,
        createdAt: Date.now(),
        content: message,
      });
    },

    onChatUi: ({ cards }: { cards: ChatUiCard[] }) => {
      for (const c of cards) {
        const base = { id: uid(), role: "bot" as const, createdAt: Date.now() };
        if (c.type === "jobs")
          emitter.pushMessage({
            ...base,
            type: "job-cards",
            title: c.title,
            jobs: c.jobs,
            empty: c.empty,
          });
        else if (c.type === "ask")
          emitter.pushMessage({
            ...base,
            type: "ask",
            kind: c.kind,
            prompt: c.prompt,
            options: c.options,
            length: c.length,
          });
        else if (c.type === "open")
          emitter.pushMessage({
            ...base,
            type: "actions",
            actions: [{ view: c.view, label: c.label }],
          });
        else if (c.type === "applications")
          emitter.pushMessage({ ...base, type: "apps-status", ids: c.items.map((i) => i.id) });
        else if (c.type === "island")
          showIsland({
            tone: c.tone,
            title: c.title,
            body: c.body,
            action: c.view ? { label: c.label || "Open", view: c.view as IslandTarget } : undefined,
          });
      }
    },

    onChatPause: (event: PauseEvent) => {
      emitter.setTyping(false);
      emitter.setBusy(true);
      setTrackedJobId(event.jobId);

      if (event.type === "invisibleCaptcha") {
        toast.info("Invisible Captcha Detected", {
          description: "Agent is handling security checks in the background.",
        });
        resolveCard(`pause-${event.stepId}`, "auto-solved", event.jobId);
        return;
      }

      if (event.type === "review") {
        const d = (event.data ?? {}) as Partial<ReviewMessage>;
        emitter.pushMessage({
          id: `pause-${event.stepId}`,
          role: "bot" as const,
          type: "review" as const,
          createdAt: Date.now(),
          title: d.title || event.contextMessage || "Review before submit",
          site: d.site,
          siteUrl: d.siteUrl,
          actionLabel: d.actionLabel || "Submit",
          sections: (d.sections as ReviewSection[]) || [],
          jobId: event.jobId,
          stepId: event.stepId,
        });
        return;
      }

      const cardKind = mapPauseToCardKind(event.type);

      if (cardKind) {
        // Push an interactive input card
        emitter.pushMessage({
          id: `pause-${event.stepId}`,
          role: "bot" as const,
          type: "input-card" as const,
          createdAt: Date.now(),
          kind: cardKind,
          prompt: event.contextMessage || `Please provide ${event.type}`,
          jobId: event.jobId,
          stepId: event.stepId,
          data: {
            ...((event as any).data || {}),
            ...(event.type === "confirmation"
              ? { confirmLabel: "Confirm", cancelLabel: "Cancel" }
              : {}),
            ...(["text", "password", "email", "mobile"].includes(event.type)
              ? { inputType: event.type }
              : {}),
          },
        });
      } else {
        // For text/email/mobile/password/file — show a text prompt
        emitter.pushMessage({
          id: uid(),
          role: "bot" as const,
          type: "text" as const,
          createdAt: Date.now(),
          content: event.contextMessage || `Please provide: ${event.type}`,
        });
      }
    },

    onChatFile: (event: FileEvent) => {
      setTrackedJobId(event.jobId);
      emitter.pushMessage({
        id: uid(),
        role: "bot" as const,
        type: "download" as const,
        createdAt: Date.now(),
        title: event.originalName,
        description: event.message,
        fileName: event.originalName,
        mime: "application/octet-stream",
        sizeLabel: "",
        fileId: event.fileId,
        downloadUrl: event.fileId ? api.getFileDownloadUrl(event.fileId) : undefined,
      });
    },

    onChatReceipt: (event: ReceiptEvent) => {
      emitter.setBusy(false);
      emitter.pushMessage({
        id: `receipt-${event.jobId}`,
        role: "bot" as const,
        type: "receipt" as const,
        createdAt: Date.now(),
        status: event.status,
        title: event.title,
        site: event.site,
        siteUrl: event.siteUrl,
        reference: event.reference,
        durationMs: event.durationMs,
        completedAt: event.completedAt ?? Date.now(),
        sections: event.sections ?? [],
        files: event.files?.map((f) => ({
          ...f,
          downloadUrl: f.fileId ? api.getFileDownloadUrl(f.fileId) : undefined,
        })),
        steps: event.steps,
        nextSteps: event.nextSteps,
      });
    },

    onJobStarted: (event: JobStartedEvent) => {
      setTrackedJobId(event.jobId);
      emitter.setBusy(true);
      emitter.pushMessage({
        id: uid(),
        role: "bot" as const,
        type: "status" as const,
        createdAt: Date.now(),
        variant: "info" as const,
        content: "Starting a secure browser for this task…",
      });
    },

    onJobQueuePosition: (event: { jobId: string; position: number }) => {
      emitter.pushMessage({
        id: `queue-${event.jobId}`,
        role: "bot" as const,
        type: "status" as const,
        createdAt: Date.now(),
        variant: "warning" as const,
        content: `Queued — ${event.position} ahead of you, about ${event.position * 2} min.`,
      });
    },

    onLiveFrame: (base64: string) => {
      emitter.setLiveFrame(`data:image/jpeg;base64,${base64}`, true);
    },

    onConnect: () => {
      logger.info("socket:connected");
    },

    onDisconnect: (reason: string) => {
      logger.warn("socket:disconnected", { reason });
    },

    onError: (error: Error) => {
      logger.error("socket:error", error);
      emitter.setTyping(false);
      emitter.setBusy(false);
    },
  };
}

// ─── Resolve Input Cards ─────────────────────────────────────
// When user resolves an input card (OTP, CAPTCHA, etc.), we need to
// resume the paused job via the backend.

export async function resolveCard(id: string, value: string, jobId?: string): Promise<void> {
  // Also fire the local custom event for UI update
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("agent-card-resolve", { detail: { id, value } }));
  }

  // Resume the paused job on the backend
  const targetJobId = jobId || currentJobId;
  if (targetJobId) {
    try {
      await api.resumeJob(targetJobId, value);
    } catch (err) {
      logger.error("job:resume-failed", err, { targetJobId });
    }
  }
}

/**
 * Resolve a review pause. The approved values are sent verbatim as the resume
 * payload — the executor must submit exactly these, never re-generate them.
 */
export async function resolveReview(
  msg: ReviewMessage,
  action: "approved" | "cancelled",
  values: Record<string, string>,
): Promise<void> {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("agent-review-resolve", {
        detail: { id: msg.id, resolved: { action, values, at: Date.now() } },
      }),
    );
  }
  const targetJobId = msg.jobId || currentJobId;
  if (!targetJobId) return;
  try {
    if (action === "cancelled") {
      await api.cancelJob(targetJobId);
    } else {
      await api.resumeJob(targetJobId, JSON.stringify({ action: "approve", values }));
    }
  } catch (err) {
    logger.error("job:review-resolve-failed", err, { targetJobId, action });
  }
}

// ─── Send a chat message ─────────────────────────────────────

export async function sendChatMessage(
  text: string,
  files: File[],
  emitter: BotEmitter,
): Promise<void> {
  initializeBackend(emitter);

  // Handle file uploads first
  if (files.length > 0) {
    for (const file of files) {
      try {
        const base64Data = await fileToBase64(file);
        const category = guessCategoryFromMime(file.type, file.name);
        await api.uploadFile({
          originalName: file.name,
          mimeType: file.type,
          base64Data,
          category,
        });
      } catch (err) {
        logger.error("file:upload-failed", err, { fileName: file.name, mimeType: file.type });
        emitter.pushMessage({
          id: uid(),
          role: "bot" as const,
          type: "text" as const,
          createdAt: Date.now(),
          content: `⚠️ Failed to upload **${file.name}**: ${(err as Error).message}`,
        });
      }
    }

    if (!text) {
      text = `I've uploaded ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`;
    }
  }

  // Show typing indicator
  emitter.setTyping(true);

  // Send via Socket.IO for real-time response
  socketService.sendMessage(text);
  logger.info("chat:sent", { messagePreview: text.slice(0, 120), fileCount: files.length });

  // If the backend's chat orchestrator decides to start a job,
  // it will send back events through Socket.IO — handled by callbacks above.
}

// ─── Upload files via REST ──────────────────────────────────

export async function uploadFiles(files: File[], profileName?: string): Promise<UserFile[]> {
  const results: UserFile[] = [];
  for (const file of files) {
    const base64Data = await fileToBase64(file);
    const category = guessCategoryFromMime(file.type, file.name);
    const { file: uploaded } = await api.uploadFile({
      originalName: file.name,
      mimeType: file.type,
      base64Data,
      category,
      profileName,
    });
    results.push(uploaded);
  }
  return results;
}

// ─── Track active job ─────────────────────────────────────────

export function setActiveJobId(jobId: string | null): void {
  setTrackedJobId(jobId);
}

export function getActiveJobId(): string | null {
  return currentJobId;
}

// ─── Cleanup ─────────────────────────────────────────────────

export function disconnectBackend(): void {
  // Cancel any running job before disconnecting
  if (currentJobId) {
    cancelActiveJob();
  }
  socketService.disconnect();
  isInitialized = false;
  currentEmitter = null;
  currentJobId = null;
  currentSessionId = null;
}
