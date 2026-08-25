import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  PanelLeft,
  Monitor,
  Sparkles,
  Wifi,
  WifiOff,
  ShieldCheck,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useChatStore, uid } from "@/lib/chat-store";
import { PROFILES } from "@/lib/chat-types";
import type { ChatMessage, FileAttachment, InputCardMessage } from "@/lib/chat-types";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { LiveScreenPanel } from "@/components/chat/LiveScreenPanel";
import { Composer } from "@/components/chat/Composer";
import { MessageItem, TypingIndicator } from "@/components/chat/MessageItem";
import {
  sendChatMessage,
  initializeBackend,
  resetSession,
  type BotEmitter,
} from "@/lib/backend-connector";
import { api } from "@/lib/api-client";
import { socketService } from "@/lib/socket-service";
import { authClient, type AuthUser } from "@/lib/auth-client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("frontend-index-route");

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Agent — your personal automation chat" },
      {
        name: "description",
        content:
          "Chat with your agent. Watch it work in real time, approve OTPs and payments, get files back instantly.",
      },
    ],
  }),
  component: Index,
});

const SUGGESTIONS = [
  "Download my Aadhaar e-card",
  "Check my PAN card status",
  "Fill an SSC job application for me",
  "What government services can you help with?",
  "Update my name in Aadhaar",
  "Check my passport application status",
];

function Index() {
  const store = useChatStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Hidden by default — the panel opens itself when there's something worth
  // watching (a live frame streaming, or a captcha that needs the picture)
  // and folds away again once that's no longer true. See the effect below.
  const [liveOpen, setLiveOpen] = useState(false);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [liveHot, setLiveHot] = useState(false);
  const liveCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileId, setProfileId] = useState("personal");
  const [connected, setConnected] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const navigate = useNavigate();

  // Require a signed-in session — chat, memory, and files are all scoped to
  // the authenticated user server-side, so there is nothing useful to show
  // before this resolves.
  useEffect(() => {
    let cancelled = false;
    authClient.me().then((user) => {
      if (cancelled) return;
      setAuthUser(user);
      setAuthChecked(true);
      if (!user) navigate({ to: "/login" });
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // "New chat" handler — resets the backend session and creates a fresh UI thread
  const handleNewChat = useCallback(() => {
    resetSession();
    setLiveFrame(null);
    setLiveHot(false);
    setBusy(false);
    setTyping(false);
    store.newThread();
  }, [store]);

  const profile = useMemo(() => PROFILES.find((p) => p.id === profileId)!, [profileId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = store.activeThread?.messages ?? [];
  const activePause = messages.find((m) => m.type === "input-card" && !m.resolved) as
    | InputCardMessage
    | undefined;
  const emitterRef = useRef<BotEmitter | null>(null);

  // Build the emitter for backend-connector
  const getEmitter = useCallback((): BotEmitter => {
    if (!emitterRef.current) {
      emitterRef.current = {
        pushMessage: (m: ChatMessage) => {
          if (store.activeId) {
            store.appendMessage(store.activeId, m);
          }
        },
        patchMessage: (id: string, patch: Partial<ChatMessage>) => {
          if (store.activeId) {
            store.updateMessage(store.activeId, id, patch);
          }
        },
        setLiveFrame: (url: string | null, hot?: boolean) => {
          setLiveFrame(url);
          setLiveHot(!!hot);
        },
        setTyping: (t: boolean) => setTyping(t),
        setBusy: (b: boolean) => setBusy(b),
      };
    }
    return emitterRef.current;
  }, [store]);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, typing]);

  // Live view visibility is automatic: open the moment there's a real frame
  // streaming or a captcha that genuinely benefits from the picture, fold it
  // back away a few seconds after that's no longer true. A manual toggle
  // (the header button) can always override this in either direction.
  useEffect(() => {
    const visualPauseKinds = new Set(["captcha", "clickCaptcha", "gridCaptcha", "sliderCaptcha"]);
    const needsLiveView = liveHot || (!!activePause && visualPauseKinds.has(activePause.kind));

    if (liveCollapseTimer.current) {
      clearTimeout(liveCollapseTimer.current);
      liveCollapseTimer.current = null;
    }

    if (needsLiveView) {
      setLiveOpen(true);
      return;
    }

    if (liveOpen) {
      liveCollapseTimer.current = setTimeout(() => setLiveOpen(false), 4000);
    }

    return () => {
      if (liveCollapseTimer.current) clearTimeout(liveCollapseTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveHot, activePause?.id, activePause?.kind]);

  // Initialize backend connection
  useEffect(() => {
    if (!store.hydrated) return;

    const emitter = getEmitter();
    initializeBackend(emitter);

    // Check backend health
    api
      .health()
      .then(() => {
        setBackendAvailable(true);
        setConnected(true);
        logger.info("health:ok");
      })
      .catch((error) => {
        setBackendAvailable(false);
        setConnected(false);
        logger.error("health:failed", error);
      });

    // Poll connection status
    const interval = setInterval(() => {
      setConnected(socketService.connected);
    }, 2000);

    const handleResolve = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (store.activeId) {
        store.updateMessage(store.activeId, detail.id, {
          resolved: { value: detail.value, at: Date.now() },
        });
      }
    };
    window.addEventListener("agent-card-resolve", handleResolve);

    return () => {
      clearInterval(interval);
      window.removeEventListener("agent-card-resolve", handleResolve);
    };
  }, [store.hydrated, getEmitter]);

  // Update emitter ref when store.activeId changes
  useEffect(() => {
    emitterRef.current = null; // force rebuild with new activeId
    if (store.hydrated) {
      initializeBackend(getEmitter());
    }
  }, [store.activeId, store.hydrated, getEmitter]);

  if (!store.hydrated) {
    return <div className="h-screen w-screen bg-background" />;
  }

  const send = async (text: string, files: File[]) => {
    if (!store.activeId) return;
    const tid = store.activeId;

    // Push the user message into the chat
    if (files.length) {
      const atts: FileAttachment[] = files.map((f) => ({
        id: uid(),
        name: f.name,
        size: f.size,
        mime: f.type,
        url: URL.createObjectURL(f),
      }));
      store.appendMessage(tid, {
        id: uid(),
        role: "user",
        type: "file-upload",
        createdAt: Date.now(),
        files: atts,
        note: text || undefined,
      });
    } else if (text) {
      store.appendMessage(
        tid,
        {
          id: uid(),
          role: "user",
          type: "text",
          createdAt: Date.now(),
          content: text,
        },
        true,
      );
    }

    setBusy(true);
    // Live view opens itself once a real frame or captcha shows up — see the
    // effect above — rather than eagerly here before there's anything to show.

    try {
      await sendChatMessage(text || "Process my upload", files, getEmitter());
    } catch (err) {
      logger.error("chat:send-failed", err);
      store.appendMessage(tid, {
        id: uid(),
        role: "bot",
        type: "status",
        createdAt: Date.now(),
        variant: "error",
        content: `Failed to send message: ${(err as Error).message}. Is the backend running?`,
      });
    } finally {
      // Don't set busy=false immediately — backend events will do that
      // But set a timeout as a safety net
      setTimeout(() => setBusy(false), 30000);
    }
  };

  const showEmpty = messages.length === 0;

  if (!authChecked || !authUser) {
    // Either still checking the session, or the redirect to /login is in
    // flight — render nothing rather than a flash of an unauthenticated chat.
    return <div className="h-[100dvh] w-screen bg-background" />;
  }

  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden bg-background text-foreground pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] relative">
      <ChatSidebar
        isOpen={sidebarOpen}
        threads={store.threads}
        activeId={store.activeId}
        onSelect={store.setActiveId}
        onNew={handleNewChat}
        onDelete={store.deleteThread}
        onClose={() => setSidebarOpen(false)}
        profile={profile}
        profiles={PROFILES}
        onProfileChange={setProfileId}
      />
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}

      <main className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Show sidebar"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}
            <div className="text-sm font-medium truncate">
              {store.activeThread?.title || "New chat"}
            </div>
            <span className="ml-2 hidden items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
              Profile · {profile.name}
            </span>
            {/* Connection indicator */}
            <span
              className={`ml-1 hidden items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] sm:inline-flex ${
                connected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              {connected ? (
                <>
                  <Wifi className="h-2.5 w-2.5" /> live
                </>
              ) : (
                <>
                  <WifiOff className="h-2.5 w-2.5" /> offline
                </>
              )}
            </span>
          </div>
          <button
            onClick={() => setLiveOpen((v) => !v)}
            aria-label="Toggle live screen"
            className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
              liveOpen
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <Monitor className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Live screen</span>
            {liveHot && <span className="live-dot absolute -right-0.5 -top-0.5 h-1.5 w-1.5" />}
          </button>

          {/* Desktop: inline links. Mobile: collapsed into an overflow menu below. */}
          <a
            href="/admin"
            className="hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground sm:flex"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Admin
          </a>
          {authUser && (
            <button
              onClick={() => authClient.logout().then(() => navigate({ to: "/login" }))}
              className="ml-1 hidden text-xs font-medium text-muted-foreground transition hover:text-foreground sm:inline"
              title={authUser.email ?? authUser.mobileNumber ?? "Signed in"}
            >
              Sign out
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="More options"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="sm:hidden">
              <DropdownMenuItem asChild>
                <a href="/admin" className="flex items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5" /> Admin
                </a>
              </DropdownMenuItem>
              {authUser && (
                <DropdownMenuItem
                  onClick={() => authClient.logout().then(() => navigate({ to: "/login" }))}
                >
                  Sign out
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div
          ref={scrollRef}
          key={store.activeId ?? "none"}
          className="scroll-thin flex-1 overflow-y-auto"
        >
          {showEmpty ? (
            <div className="flex h-full flex-col">
              <EmptyState backendAvailable={backendAvailable} />
              {liveOpen && (
                <div className="mx-auto w-full max-w-3xl pb-4">
                  <LiveScreenPanel
                    frame={liveFrame}
                    hot={liveHot}
                    onClose={() => setLiveOpen(false)}
                    connected={connected}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="py-3">
              {messages.map((m) => (
                <MessageItem key={m.id} msg={m} />
              ))}
              {typing && <TypingIndicator />}
              {liveOpen && (
                <div className="mx-auto w-full max-w-3xl pb-2">
                  <LiveScreenPanel
                    frame={liveFrame}
                    hot={liveHot}
                    onClose={() => setLiveOpen(false)}
                    connected={connected}
                    activePause={activePause}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {showEmpty && (
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 px-4 pb-4">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s, [])}
                className="rounded-full border border-border bg-transparent px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <Composer onSend={send} busy={busy} onStop={() => setBusy(false)} />
      </main>
    </div>
  );
}

function EmptyState({ backendAvailable }: { backendAvailable: boolean | null }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">How can I help you today?</h1>

      {backendAvailable === false && (
        <div className="mt-4 text-sm text-warning">
          Backend not available. Start it with{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">npm run dev:full</code>
        </div>
      )}
    </div>
  );
}
