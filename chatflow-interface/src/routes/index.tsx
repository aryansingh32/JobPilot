import { toast } from "sonner";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useChatStore, uid } from "@/lib/chat-store";
import { useTheme } from "@/hooks/use-theme";
import type {
  ChatMessage,
  FileAttachment,
  InputCardMessage,
  ReviewMessage,
  TimelineMessage,
  StatusMessage,
} from "@/lib/chat-types";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatHeader, WorkingStrip, type MainView } from "@/components/chat/Shell";
import { HomeScreen } from "@/components/chat/JobsHome";
import { Splash } from "@/components/Splash";
import { ViewBoundary } from "@/components/ViewBoundary";
import { JobsExplorer } from "@/components/chat/JobsExplorer";
import { JobDetailSheet } from "@/components/chat/JobDetail";
import { TasksView } from "@/components/chat/TasksView";
import { InboxView } from "@/components/chat/InboxView";
import { AutoApplyView } from "@/components/chat/AutoApplyView";
import { BuyCreditsDialog } from "@/components/chat/BuyCredits";
import { ProfileGapsDialog } from "@/components/chat/ProfileGapsDialog";
import { PortalPasswordCard } from "@/components/chat/PortalPasswordCard";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { taskStatus } from "@/lib/task-status";
import {
  APPLY_JOB_EVENT,
  NAVIGATE_EVENT,
  OPEN_JOB_EVENT,
  SEND_EVENT,
} from "@/components/chat/AiCards";
import { DynamicIsland } from "@/components/chat/DynamicIsland";
import type { IslandTarget } from "@/lib/island";
import { NeedsYouHint } from "@/components/chat/NeedsYouHint";
import { LiveScreenPanel } from "@/components/chat/LiveScreenPanel";
import { Composer } from "@/components/chat/Composer";
import { MessageItem, TypingIndicator } from "@/components/chat/MessageItem";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  BACK_EVENT,
  OPEN_APPLICATION_EVENT,
  OPEN_INBOX_EVENT,
  registerPush,
  unregisterPush,
} from "@/lib/native-app";
import {
  sendChatMessage,
  initializeBackend,
  resetSession,
  scopeSessionToUser,
  type BotEmitter,
} from "@/lib/backend-connector";
import { api } from "@/lib/api-client";
import { socketService } from "@/lib/socket-service";
import { authClient, type AuthUser } from "@/lib/auth-client";
import { jp, type ApplicationSummary, type JobListingDTO, type ProfileGapDTO } from "@/lib/api-client";
import {
  useApplications,
  useInbox,
  useAutoApply,
  useJobActions,
  useApplicationActions,
  useMe,
  useRecommendations,
} from "@/lib/live";
import { createLogger } from "@/lib/logger";

const logger = createLogger("frontend-index-route");

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "jobpilot — tell it the task, get proof it's done" },
      {
        name: "description",
        content:
          "Tell jobpilot what to get done on any website. Watch it work, approve before anything is sent, and keep a receipt.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Hidden by default — the panel opens itself when there's something worth
  // watching (a live frame streaming, or a captcha that needs the picture)
  // and folds away again once that's no longer true. See the effect below.
  const [liveOpen, setLiveOpen] = useState(false);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [liveHot, setLiveHot] = useState(false);
  const liveCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typing, setTyping] = useState(false);
  const [view, setView] = useState<MainView>("chat");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const store = useChatStore(authUser?.id ?? null);
  const [focusAppId, setFocusAppId] = useState<string | null>(null);
  /** Application card open on the Applications screen right now. */
  const [watchedApp, setWatchedApp] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<JobListingDTO | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [passedIds, setPassedIds] = useState<Set<string>>(() => new Set());
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { theme, toggleTheme } = useTheme();

  // Live data — only once the session is known to be signed in.
  const signedIn = authChecked && !!authUser;
  const meQ = useMe(signedIn);
  const recsQ = useRecommendations(signedIn);
  const appsQ = useApplications("all", signedIn);
  const inboxQ = useInbox("all", signedIn && view === "inbox");
  const autoApplyQ = useAutoApply(signedIn);
  const [buyOpen, setBuyOpen] = useState(false);
  const credits = meQ.data?.credits?.enabled ? meQ.data.credits.balance : null;
  // Back from Stripe's checkout page.
  useEffect(() => {
    if (!signedIn || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("payment");
    if (!result) return;
    if (result === "success") {
      toast.success("Payment received", { description: "Your credits appear in a moment." });
      setTimeout(() => void meQ.refetch(), 2500);
    } else toast("Payment cancelled — nothing was charged");
    url.searchParams.delete("payment");
    window.history.replaceState(null, "", url.pathname + url.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
  // Back from Google's Gmail consent: show Inbox, where the Gmail card reads ?gmail= and says how it went.
  useEffect(() => {
    if (!signedIn || typeof window === "undefined") return;
    if (new URL(window.location.href).searchParams.has("gmail")) setView("inbox");
  }, [signedIn]);
  /** Errors from starting applications: out of credits offers to buy. */
  const applyError = (err: unknown) => {
    const msg = (err as Error).message;
    if (/out of credits/i.test(msg))
      toast.error(msg, { action: { label: "Buy credits", onClick: () => setBuyOpen(true) } });
    else toast.error(msg);
  };
  const jobActions = useJobActions();
  const appActions = useApplicationActions();

  // The sidebar defaults open for desktop's persistent-panel layout, but on
  // mobile it's a full-screen overlay — starting it open there would bury
  // the chat behind a drawer on first load.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // Require a signed-in session — chat, memory, and files are all scoped to
  // the authenticated user server-side, so there is nothing useful to show
  // before this resolves.
  useEffect(() => {
    let cancelled = false;
    authClient.me().then(async (user) => {
      if (cancelled) return;
      if (!user) {
        setAuthChecked(true);
        navigate({ to: "/login" });
        return;
      }
      // First visit after sign-up: finish (or skip) onboarding before the app.
      const me = await jp.me().catch(() => null);
      if (cancelled) return;
      if (me && me.profile.onboardingStatus === "pending") {
        // Keep Google's "?gmail=…" so onboarding lands on the step that asked for it.
        const gmail = new URLSearchParams(window.location.search).get("gmail") ?? undefined;
        navigate({ to: "/onboarding", search: gmail ? { gmail } : {}, replace: true });
        return;
      }
      scopeSessionToUser(user.id);
      setAuthUser(user);
      setAuthChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // Android app: register for push once signed in; a tapped notification
  // opens its application (or the inbox); hardware Back closes the drawer,
  // then returns to the home view, before leaving the app.
  useEffect(() => {
    if (!signedIn) return;
    void registerPush();
    const openApp = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setFocusAppId(id);
      setView("tasks");
    };
    const openInbox = () => setView("inbox");
    window.addEventListener(OPEN_APPLICATION_EVENT, openApp);
    window.addEventListener(OPEN_INBOX_EVENT, openInbox);
    return () => {
      window.removeEventListener(OPEN_APPLICATION_EVENT, openApp);
      window.removeEventListener(OPEN_INBOX_EVENT, openInbox);
    };
  }, [signedIn]);

  useEffect(() => {
    const onBack = (e: Event) => {
      if (isMobile && sidebarOpen) {
        setSidebarOpen(false);
        e.preventDefault();
      } else if (view !== "chat") {
        setView("chat");
        e.preventDefault();
      }
    };
    window.addEventListener(BACK_EVENT, onBack);
    return () => window.removeEventListener(BACK_EVENT, onBack);
  }, [isMobile, sidebarOpen, view]);

  // "New chat" handler — resets the backend session and creates a fresh UI thread
  const handleNewChat = useCallback(() => {
    resetSession();
    setLiveFrame(null);
    setLiveHot(false);
    setBusy(false);
    setTyping(false);
    store.newThread();
  }, [store]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = store.activeThread?.messages ?? [];
  const activePause = messages.find((m) => m.type === "input-card" && !m.resolved) as
    | InputCardMessage
    | undefined;
  // A review waiting for approval is also "on the user", not "working".
  const pendingReview = messages.some((m) => m.type === "review" && !m.resolved);
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
    // Live view is being retired: captchas show their own cropped image in the
    // card, so the panel only opens if frames actually arrive.
    const needsLiveView = liveHot && !!liveFrame;

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

  // Cards in the conversation (the assistant's job cards, shortcuts, one-tap answers)
  // talk to this screen through window events.
  const sendRef = useRef<((text: string, files: File[]) => Promise<void>) | null>(null);
  const cardActionsRef = useRef<{
    open: (j: JobListingDTO) => void;
    apply: (j: JobListingDTO) => void;
  }>({
    open: () => {},
    apply: () => {},
  });
  useEffect(() => {
    const onOpenJob = (e: Event) =>
      cardActionsRef.current.open((e as CustomEvent<JobListingDTO>).detail);
    const onApplyJob = (e: Event) =>
      cardActionsRef.current.apply((e as CustomEvent<JobListingDTO>).detail);
    const onSend = (e: Event) => void sendRef.current?.((e as CustomEvent<string>).detail, []);
    const onNav = (e: Event) => {
      const [view, id] = String((e as CustomEvent<string>).detail).split(":");
      if (view === "tasks") {
        setFocusAppId(id || null);
        setView("tasks");
      } else if (view === "inbox" || view === "jobs" || view === "autoapply") setView(view);
    };
    window.addEventListener(OPEN_JOB_EVENT, onOpenJob);
    window.addEventListener(APPLY_JOB_EVENT, onApplyJob);
    window.addEventListener(SEND_EVENT, onSend);
    window.addEventListener(NAVIGATE_EVENT, onNav);
    return () => {
      window.removeEventListener(OPEN_JOB_EVENT, onOpenJob);
      window.removeEventListener(APPLY_JOB_EVENT, onApplyJob);
      window.removeEventListener(SEND_EVENT, onSend);
      window.removeEventListener(NAVIGATE_EVENT, onNav);
    };
  }, []);

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

    const handleReviewResolve = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        id: string;
        resolved: ReviewMessage["resolved"];
      };
      if (store.activeId) {
        store.updateMessage(store.activeId, detail.id, {
          resolved: detail.resolved,
        } as Partial<ChatMessage>);
      }
    };
    window.addEventListener("agent-review-resolve", handleReviewResolve);

    return () => {
      clearInterval(interval);
      window.removeEventListener("agent-card-resolve", handleResolve);
      window.removeEventListener("agent-review-resolve", handleReviewResolve);
    };
  }, [store.hydrated, getEmitter]);

  // Update emitter ref when store.activeId changes
  useEffect(() => {
    emitterRef.current = null; // force rebuild with new activeId
    if (store.hydrated) {
      initializeBackend(getEmitter());
    }
  }, [store.activeId, store.hydrated, getEmitter]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gapsFor, setGapsFor] = useState<{ job: JobListingDTO; gaps: ProfileGapDTO[] } | null>(null);

  if (!store.hydrated) {
    return <Splash />;
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

  sendRef.current = send;
  const showEmpty = messages.length === 0;

  if (!authChecked || !authUser) {
    // Either still checking the session, or the redirect to /login is in
    // flight — render nothing rather than a flash of an unauthenticated chat.
    return <Splash />;
  }

  const userLabel =
    meQ.data?.profile.fullName ||
    authUser.displayName ||
    authUser.email ||
    authUser.mobileNumber ||
    null;
  const progress = currentProgress(messages);
  const needsCount = meQ.data?.applications.needs ?? 0;
  const unreadCount = meQ.data?.inbox.unread ?? 0;
  const applications = appsQ.data?.applications ?? [];
  const jobs = (recsQ.data?.jobs ?? []).filter((j) => !passedIds.has(j.id));

  // Applications already on screen in full never go on the island: the open
  // row of the Applications list, and the one this chat thread is running.
  const threadJobId = store.activeThread?.activeJobId;
  const watching = [
    ...(view === "tasks" && watchedApp ? [watchedApp] : []),
    ...(view === "chat" && threadJobId
      ? applications.filter((a) => a.exec_job_id === threadJobId).map((a) => a.id)
      : []),
  ];
  const onIslandNavigate = (to: IslandTarget, appId?: string) => {
    if (to === "tasks") {
      setFocusAppId(appId ?? null);
      setView("tasks");
    } else setView(to);
  };
  const chatHintId =
    view === "chat"
      ? activePause
        ? `msg-${activePause.id}`
        : messages.find((m) => m.type === "review" && !m.resolved)?.id
          ? `msg-${messages.find((m) => m.type === "review" && !m.resolved)!.id}`
          : null
      : null;

  const openApplication = (app: Pick<ApplicationSummary, "id">) => {
    setFocusAppId(app.id);
    setView("tasks");
  };
  // A chat for an application only exists on the device that started it.
  const chatFor = (app: ApplicationSummary) => {
    const thread = store.threads.find(
      (t) => !!app.exec_job_id && t.activeJobId === app.exec_job_id,
    );
    return thread
      ? () => {
          store.setActiveId(thread.id);
          setView("chat");
        }
      : null;
  };
  // What the profile still lacks for this job: asked once, before a browser starts waiting on it.
  const applyToJob = async (job: JobListingDTO, skipGapCheck = false) => {
    if (!skipGapCheck) {
      const { gaps } = await jp.profileGaps(job.id).catch(() => ({ gaps: [] as ProfileGapDTO[] }));
      if (gaps.some((g) => g.blocking)) {
        setGapsFor({ job, gaps: gaps.filter((g) => g.blocking) });
        return;
      }
    }
    // Straight to the apply engine — the run shows up under Applications,
    // where questions and the final review are answered.
    appActions.start.mutate(
      { jobId: job.id },
      {
        onSuccess: (r) => {
          toast.success(`Applying to ${job.title}`, {
            description: "I'll show you every answer before it's submitted.",
          });
          setOpenJob(null);
          openApplication(r.application);
        },
        onError: applyError,
      },
    );
  };
  cardActionsRef.current = { open: setOpenJob, apply: applyToJob };
  const toggleSave = (job: JobListingDTO) => {
    const saved = savedIds.has(job.id);
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (saved) next.delete(job.id);
      else next.add(job.id);
      return next;
    });
    (saved ? jobActions.unsave : jobActions.save).mutate(job.id);
  };
  const passJob = (job: JobListingDTO) => {
    setPassedIds((prev) => new Set(prev).add(job.id));
    jobActions.pass.mutate(job.id);
  };

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">
      <ChatSidebar
        isOpen={sidebarOpen}
        threads={store.threads}
        activeId={store.activeId}
        onSelect={(id) => {
          store.setActiveId(id);
          setView("chat");
        }}
        onNew={() => {
          handleNewChat();
          setView("chat");
        }}
        onDelete={store.deleteThread}
        onOpen={() => setSidebarOpen(true)}
        onClose={() => setSidebarOpen(false)}
        userLabel={userLabel}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={() =>
          unregisterPush()
            .then(() => authClient.logout())
            .then(() => navigate({ to: "/login" }))
        }
        jobsActive={view === "jobs"}
        onShowJobs={() => setView("jobs")}
        tasksActive={view === "tasks"}
        onShowTasks={() => {
          setFocusAppId(null);
          setView("tasks");
        }}
        inboxActive={view === "inbox"}
        onShowInbox={() => setView("inbox")}
        autoApplyActive={view === "autoapply"}
        onShowAutoApply={() => setView("autoapply")}
        onOpenSettings={() => setSettingsOpen(true)}
        autoApplyOn={autoApplyQ.data?.settings.enabled}
        credits={credits}
        onBuyCredits={() => setBuyOpen(true)}
        unreadCount={unreadCount}
        needsCount={needsCount}
      />
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="absolute inset-0 z-30 bg-foreground/20 backdrop-blur-[1px] md:hidden"
        />
      )}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Settings</DialogTitle>
          <PortalPasswordCard />
        </DialogContent>
      </Dialog>
      <ProfileGapsDialog
        gaps={gapsFor?.gaps ?? null}
        title={gapsFor?.job.title}
        onClose={() => setGapsFor(null)}
        onDone={() => {
          const job = gapsFor?.job;
          setGapsFor(null);
          if (job) void applyToJob(job, true);
        }}
      />

      <BuyCreditsDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        email={authUser.email}
        defaultCurrency={
          typeof Intl !== "undefined" &&
          /Calcutta|Kolkata/.test(Intl.DateTimeFormat().resolvedOptions().timeZone)
            ? "INR"
            : "USD"
        }
      />
      <JobDetailSheet
        job={openJob}
        saved={!!openJob && savedIds.has(openJob.id)}
        onClose={() => setOpenJob(null)}
        onApply={applyToJob}
        onToggleSave={toggleSave}
      />
      <DynamicIsland
        applications={applications}
        watching={watching}
        unread={unreadCount}
        inboxOpen={view === "inbox"}
        onNavigate={onIslandNavigate}
      />
      <NeedsYouHint targetId={chatHintId} label="Needs you" />
      <main id="app-main" className="flex h-full min-w-0 flex-1 flex-col">
        <ChatHeader
          onOpenSidebar={() => setSidebarOpen(true)}
          title={
            view === "tasks"
              ? "Applications"
              : view === "jobs"
                ? "Browse jobs"
                : view === "inbox"
                  ? "Inbox"
                  : view === "autoapply"
                    ? "Auto Apply"
                    : showEmpty
                      ? ""
                      : store.activeThread?.title || "New task"
          }
          status={view === "chat" && store.activeThread ? taskStatus(store.activeThread) : null}
          detail={busy ? progress : undefined}
          onStatusClick={() => {
            const st = store.activeThread ? taskStatus(store.activeThread) : null;
            if (st === "working") return liveFrame ? setLiveOpen(true) : undefined;
            const target =
              st === "needs"
                ? messages.find(
                    (m) => (m.type === "input-card" || m.type === "review") && !m.resolved,
                  )
                : [...messages].reverse().find((m) => m.type === "receipt");
            if (target) {
              document
                .getElementById(`msg-${target.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }}
          unreadCount={unreadCount}
          onOpenInbox={() => setView("inbox")}
        />

        <ViewBoundary key={view === "chat" ? `chat-${store.activeId}` : view}>
          {view === "jobs" ? (
            <JobsExplorer
              savedIds={savedIds}
              onOpen={setOpenJob}
              onApply={applyToJob}
              onToggleSave={toggleSave}
            />
          ) : view === "autoapply" ? (
            <AutoApplyView
              credits={credits}
              onBuyCredits={() => setBuyOpen(true)}
              onOpenApplications={() => {
                setFocusAppId(null);
                setView("tasks");
              }}
            />
          ) : view === "inbox" ? (
            <InboxView
              emails={inboxQ.data?.emails ?? []}
              address={inboxQ.data?.address ?? meQ.data?.inbox.address ?? null}
              loading={inboxQ.isLoading}
              onOpenApplication={(id) => openApplication({ id })}
            />
          ) : view === "tasks" ? (
            <TasksView
              key={focusAppId ?? "all"}
              applications={applications}
              loading={appsQ.isLoading}
              focusId={focusAppId}
              onWatching={setWatchedApp}
              onOpenChat={chatFor}
              onNew={() => {
                handleNewChat();
                setView("chat");
              }}
            />
          ) : showEmpty ? (
            <HomeScreen
              greeting={`${greeting()}${firstName(authUser, meQ.data?.profile.fullName) ? `, ${firstName(authUser, meQ.data?.profile.fullName)}` : ""}`}
              notice={
                backendAvailable === false ? (
                  <p className="mb-4 text-center text-[12px] font-medium text-warning-soft-foreground">
                    Can't reach the server right now — tasks will start once it's back.
                  </p>
                ) : undefined
              }
              composer={
                <Composer variant="hero" onSend={send} busy={busy} onStop={() => setBusy(false)} />
              }
              jobs={jobs}
              jobsLoading={recsQ.isLoading}
              savedIds={savedIds}
              applications={applications}
              onOpenJob={setOpenJob}
              onViewMoreJobs={() => setView("jobs")}
              onApply={applyToJob}
              onToggleSave={toggleSave}
              onPass={passJob}
              onOpenApplication={(app) => {
                const open = chatFor(app);
                if (open) open();
                else openApplication(app);
              }}
              hasResume={meQ.data?.profile.hasResume}
              onUploadResume={() =>
                window.dispatchEvent(
                  new CustomEvent("agent-attach", {
                    detail: "Here's my resume — use it for my profile",
                  }),
                )
              }
              onSeeAllApplications={() => {
                setFocusAppId(null);
                setView("tasks");
              }}
            />
          ) : (
            <>
              <div
                ref={scrollRef}
                key={store.activeId ?? "none"}
                className="scroll-thin flex-1 overflow-y-auto"
              >
                <div className="pb-4 pt-2">
                  {messages.map((m) => (
                    <MessageItem key={m.id} msg={m} />
                  ))}
                  {typing && <TypingIndicator />}
                </div>
              </div>
              {busy && !activePause && !pendingReview && (
                <WorkingStrip
                  label={progress}
                  frame={liveFrame}
                  onWatch={() => liveFrame && setLiveOpen(true)}
                />
              )}
              <Composer onSend={send} busy={busy} onStop={() => setBusy(false)} />
            </>
          )}
        </ViewBoundary>
      </main>

      {/* Live view — right column on desktop, bottom sheet on mobile. */}
      <div
        data-state={liveOpen ? "open" : "closed"}
        className="hidden shrink-0 overflow-hidden border-l border-border bg-card transition-[width] duration-300 ease-in-out md:flex md:w-0 md:data-[state=open]:w-[380px] lg:data-[state=open]:w-[440px]"
      >
        <div className="h-full w-[380px] lg:w-[440px]">
          <LiveScreenPanel
            frame={liveFrame}
            hot={liveHot}
            onClose={() => setLiveOpen(false)}
            connected={connected}
            activePause={activePause}
          />
        </div>
      </div>

      {isMobile && (
        <Sheet open={liveOpen} onOpenChange={setLiveOpen}>
          <SheetContent
            side="bottom"
            className="flex h-[75vh] flex-col gap-0 rounded-t-[24px] border-border bg-card p-0"
          >
            <SheetTitle className="sr-only">Live view</SheetTitle>
            <LiveScreenPanel
              frame={liveFrame}
              hot={liveHot}
              onClose={() => setLiveOpen(false)}
              connected={connected}
              activePause={activePause}
              showCloseButton={false}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

/** The latest human-readable thing the agent is doing — shown as "working proof". */
function currentProgress(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // The newest thing wins: a question/review after the last status supersedes it.
    if (m.type === "input-card" || m.type === "review") {
      return m.resolved ? "Continuing with your answer…" : "Waiting for you";
    }
    if (m.type === "timeline") {
      const t = m as TimelineMessage;
      const active = t.steps.find((s) => s.status === "active");
      if (active) return active.label;
      if (!t.done) return t.title;
    }
    if (m.type === "status") return (m as StatusMessage).content;
  }
  return "Working on it…";
}

function firstName(user: AuthUser | null, profileName?: string | null): string | null {
  // The name on the profile (from the résumé / onboarding) beats the email's local part.
  const raw = profileName || user?.displayName || user?.email?.split("@")[0] || null;
  if (!raw) return null;
  const first = raw.split(/[\s._-]+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
