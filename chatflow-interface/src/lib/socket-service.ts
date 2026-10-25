// ============================================================
// SOCKET.IO SERVICE
// Manages real-time WebSocket connection to the backend.
// Handles: live screenshots, chat messages, pause events,
// file events, and action updates.
// ============================================================

import { io, type Socket } from "socket.io-client";
import { config } from "./config";
import { createLogger } from "./logger";
import { getSessionToken } from "./native";

const logger = createLogger("frontend-socket");

export type PauseType =
  | "otp"
  | "upi_id"
  | "captcha"
  | "clickCaptcha"
  | "confirmation"
  | "text"
  | "email"
  | "mobile"
  | "emailLink"
  | "password"
  | "gridCaptcha"
  | "sliderCaptcha"
  | "paymentPending"
  | "invisibleCaptcha"
  | "review"
  | "file";

export interface PauseEvent {
  jobId: string;
  stepId: string;
  type: PauseType;
  contextMessage: string;
  /** Type-specific payload — for "review": { title, site, siteUrl, actionLabel, sections } */
  data?: Record<string, unknown>;
}

/** Emitted when a run finishes — the "what was actually sent" receipt. */
export interface ReceiptEvent {
  jobId: string;
  status: "submitted" | "completed" | "failed";
  title: string;
  site?: string;
  siteUrl?: string;
  reference?: string;
  durationMs?: number;
  completedAt?: number;
  sections?: { title: string; items: { label: string; value: string }[] }[];
  files?: { name: string; fileId?: string; sizeLabel?: string }[];
  steps?: { label: string; atMs: number }[];
  nextSteps?: string[];
}

/** Rich cards the assistant attached to a reply (jobs, a question, an island notice, shortcuts, live status). */
export type ChatUiCard =
  | { type: "jobs"; title: string; jobs: import("./api-client").JobListingDTO[]; empty?: string }
  | {
      type: "ask";
      kind: "otp" | "number" | "text" | "choice" | "confirm";
      prompt: string;
      options?: string[];
      length?: number;
    }
  | {
      type: "island";
      tone: "info" | "success" | "warn" | "error";
      title: string;
      body?: string;
      view?: string;
      label?: string;
    }
  | { type: "open"; view: string; label: string }
  | {
      type: "applications";
      items: {
        id: string;
        title: string;
        company: string | null;
        status: string;
        detail: string | null;
        updatedAt: string;
      }[];
    };

export interface FileEvent {
  jobId: string;
  fileId?: string;
  category: string;
  originalName: string;
  sourceFilename: string;
  message: string;
}

export interface JobStartedEvent {
  jobId: string;
  siteId: string;
  task: string;
  sessionId: string;
  userId: string;
}

export interface ActionUpdate {
  jobId: string;
  stepId: string;
  status: "active" | "done" | "error";
  description?: string;
}

export interface SocketCallbacks {
  onChatReceive?: (message: string) => void;
  onChatPause?: (event: PauseEvent) => void;
  onChatFile?: (event: FileEvent) => void;
  onChatUi?: (event: { cards: ChatUiCard[] }) => void;
  onChatReceipt?: (event: ReceiptEvent) => void;
  onJobStarted?: (event: JobStartedEvent) => void;
  onJobQueuePosition?: (event: { jobId: string; position: number }) => void;
  onLiveFrame?: (base64: string) => void;
  onActionUpdate?: (update: ActionUpdate) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
}

class SocketService {
  private socket: Socket | null = null;
  private callbacks: SocketCallbacks = {};
  private _connected = false;
  private _sessionId: string | null = null;
  private _activeJobId: string | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Connect to the backend Socket.IO server
   */
  connect(sessionId: string, callbacks: SocketCallbacks): void {
    // Disconnect any existing connection
    if (this.socket) {
      this.disconnect();
    }

    this._sessionId = sessionId;
    this.callbacks = callbacks;

    // If apiBaseUrl is a relative path (e.g., "/api" for a proxy), use an empty string
    // for the socket URL so it connects to the default namespace ("/") on the current host.
    const socketUrl = config.apiBaseUrl.startsWith("/") ? "" : config.apiBaseUrl;

    this.socket = io(socketUrl, {
      path: config.socketPath,
      withCredentials: true, // sends the httpOnly jp_session cookie — the server derives userId from it
      // The Android app has no cookie; it proves who it is with its stored token.
      auth: (cb: (data: object) => void) => {
        void getSessionToken().then((token) => cb(token ? { token } : {}));
      },
      // Never reuse a cached connection: its handshake carried whoever was signed
      // in when it opened (a stale account after sign-in/out).
      forceNew: true,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.socket.on("connect", () => {
      this._connected = true;
      logger.info("socket:connected", { socketId: this.socket?.id, apiBaseUrl: config.apiBaseUrl });

      // Join the user's rooms — the server derives userId from the httpOnly
      // session cookie (sent via withCredentials above), not from this payload.
      this.socket?.emit("join", {
        sessionId,
        activeJobId: this._activeJobId ?? undefined,
      });

      this.callbacks.onConnect?.();
    });

    this.socket.on("disconnect", (reason) => {
      this._connected = false;
      logger.warn("socket:disconnected", { reason });
      this.callbacks.onDisconnect?.(reason);
    });

    this.socket.on("connect_error", (err) => {
      logger.error("socket:connect-error", err, { message: err.message });
      this.callbacks.onError?.(err);
    });

    // ── Chat Events ──

    this.socket.on("chat:receive", (message: string) => {
      this.callbacks.onChatReceive?.(message);
    });

    this.socket.on("chat:pause", (event: PauseEvent) => {
      this.callbacks.onChatPause?.(event);
    });

    this.socket.on("chat:ui", (event: { cards: ChatUiCard[] }) => {
      this.callbacks.onChatUi?.(event);
    });

    this.socket.on("chat:file", (event: FileEvent) => {
      this.callbacks.onChatFile?.(event);
    });

    this.socket.on("chat:receipt", (event: ReceiptEvent) => {
      this.callbacks.onChatReceipt?.(event);
    });

    this.socket.on("job:started", (event: JobStartedEvent) => {
      this.callbacks.onJobStarted?.(event);
    });

    this.socket.on("job:queue-position", (event: { jobId: string; position: number }) => {
      this.callbacks.onJobQueuePosition?.(event);
    });

    // ── Live Screenshot Stream ──

    this.socket.on("live-stream:frame", (base64: string) => {
      this.callbacks.onLiveFrame?.(base64);
    });

    // ── Action Updates ──

    this.socket.on("action_update", (update: ActionUpdate) => {
      this.callbacks.onActionUpdate?.(update);
    });
  }

  /**
   * Send a chat message through Socket.IO
   */
  sendMessage(message: string): void {
    if (!this.socket || !this._sessionId) {
      logger.warn("socket:send-skipped-not-connected", { sessionId: this._sessionId });
      return;
    }

    this.socket.emit("chat:send", {
      sessionId: this._sessionId,
      message,
    });
  }

  /**
   * Join a specific job's room to receive live frames
   */
  joinJob(jobId: string): void {
    this._activeJobId = jobId;
    if (!this.socket || !this._sessionId) return;

    this.socket.emit("join", {
      sessionId: this._sessionId,
      activeJobId: jobId,
    });
  }

  /**
   * Update callbacks without reconnecting
   */
  updateCallbacks(callbacks: Partial<SocketCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Disconnect from Socket.IO
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this._connected = false;
    this._sessionId = null;
    this._activeJobId = null;
  }
}

// Singleton instance
export const socketService = new SocketService();
