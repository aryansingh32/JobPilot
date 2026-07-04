// ============================================================
// SOCKET.IO SERVICE
// Manages real-time WebSocket connection to the backend.
// Handles: live screenshots, chat messages, pause events,
// file events, and action updates.
// ============================================================

import { io, type Socket } from "socket.io-client";
import { config } from "./config";
import { createLogger } from "./logger";

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
  | "password"
  | "file";

export interface PauseEvent {
  jobId: string;
  stepId: string;
  type: PauseType;
  contextMessage: string;
}

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
  onJobStarted?: (event: JobStartedEvent) => void;
  onJobQueuePosition?: (event: { jobId: string; position: number }) => void;
  onLiveFrame?: (base64: string) => void;
  onActionUpdate?: (update: ActionUpdate) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  onRecordStep?: (step: any) => void;
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

      // Join the user's rooms
      this.socket?.emit("join", {
        userId: config.userId,
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

    this.socket.on("chat:file", (event: FileEvent) => {
      this.callbacks.onChatFile?.(event);
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

    this.socket.on("workflow:record-step", (step: any) => {
      this.callbacks.onRecordStep?.(step);
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
      userId: config.userId,
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
      userId: config.userId,
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
