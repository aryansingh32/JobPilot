import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bell,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { ApplicationSummary, CampaignDTO, PendingDTO } from "@/lib/api-client";
import { applyProgress } from "@/lib/apply-progress";
import { useApplication, useApplicationActions, useCampaign } from "@/lib/live";
import { ISLAND_EVENT, type IslandEvent, type IslandTone, type IslandTarget } from "@/lib/island";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useSequentialQuestions } from "@/lib/sequential-questions";

const ACTIVE = ["queued", "running", "needs_input", "awaiting_review"];
const NEEDS = ["needs_input", "awaiting_review"];

const COLOR: Record<IslandTone | "ask", string> = {
  ask: "var(--island-ask)",
  info: "var(--island-info)",
  success: "var(--island-success)",
  warn: "var(--island-warn)",
  error: "var(--island-error)",
};
const ICON: Record<IslandTone | "ask", React.ReactNode> = {
  ask: <CircleAlert className="h-4 w-4" />,
  info: <Sparkles className="h-4 w-4" />,
  success: <Check className="h-4 w-4" />,
  warn: <CircleAlert className="h-4 w-4" />,
  error: <X className="h-4 w-4" />,
};
const mix = (c: string, pct: number) => `color-mix(in oklab, ${c} ${pct}%, transparent)`;

/** The content area's box (it moves when the sidebar opens or closes), so the island stays centred in it. */
function useMainBox() {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    let ro: ResizeObserver | undefined;
    let raf = 0;
    const read = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setBox((p) =>
        p && p.left === r.left && p.width === r.width ? p : { left: r.left, width: r.width },
      );
    };
    const attach = () => {
      const el = document.getElementById("app-main");
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }
      read(el);
      // Fires on every frame of the sidebar's width transition, so the island glides with it.
      ro = new ResizeObserver(() => read(el));
      ro.observe(el);
      window.addEventListener("resize", onResize);
    };
    const onResize = () => {
      const el = document.getElementById("app-main");
      if (el) read(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return box;
}

/**
 * The island: sits at the top of every screen and speaks up only when
 * something matters — a question or code a background application is waiting
 * on, a result, a new email, or a note from the assistant. Applications the
 * user is looking at right now (`watching`) never appear here: they already
 * show their own card in place.
 */
export function DynamicIsland({
  applications,
  watching,
  unread,
  inboxOpen,
  onNavigate,
}: {
  applications: ApplicationSummary[];
  /** Application ids already visible on screen in full (open row / chat thread). */
  watching: string[];
  unread: number;
  inboxOpen: boolean;
  onNavigate: (to: IslandTarget, appId?: string) => void;
}) {
  const [event, setEvent] = useState<IslandEvent | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** The "working" pill opened into the list of what is running. */
  const [workingOpen, setWorkingOpen] = useState(false);
  /** The ask key the user minimised; a new/changed ask opens again. */
  const [snoozed, setSnoozed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What is on screen, and what is waiting its turn: several results arriving together are all shown, never lost.
  const current = useRef<IslandEvent | null>(null);
  const queue = useRef<IslandEvent[]>([]);

  const present = (ev: IslandEvent | null) => {
    if (timer.current) clearTimeout(timer.current);
    current.current = ev;
    setEvent(ev);
    if (ev) timer.current = setTimeout(() => present(queue.current.shift() ?? null), ev.ttl ?? 6000);
  };
  const merged = (a: IslandEvent, b: IslandEvent): IslandEvent => {
    const names = [...(a.names ?? []), ...(b.names ?? [])];
    const count = (a.count ?? 1) + (b.count ?? 1);
    return {
      ...b,
      id: a.id,
      count,
      names,
      title: `${count} applications sent`,
      body: `${names.slice(0, 2).join(" · ")}${names.length > 2 ? ` · +${names.length - 2} more` : ""}`,
      action: { label: "View", view: "tasks" },
    };
  };
  const show = (ev: IslandEvent) => {
    // Same group as what's showing (or waiting): fold in.
    if (ev.group) {
      if (current.current?.group === ev.group) return present(merged(current.current, ev));
      const i = queue.current.findIndex((q) => q.group === ev.group);
      if (i >= 0) {
        queue.current[i] = merged(queue.current[i], ev);
        return;
      }
    }
    if (current.current && current.current.id !== ev.id) {
      queue.current = [...queue.current.filter((q) => q.id !== ev.id), ev].slice(-5);
      return;
    }
    present(ev);
  };
  // Reading takes a moment: hovering holds a notice on screen, leaving gives it a little longer.
  const hold = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const release = () => {
    if (!current.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => present(queue.current.shift() ?? null), 2500);
  };

  // Notices from the AI and the rest of the app.
  useEffect(() => {
    const on = (e: Event) => show((e as CustomEvent<IslandEvent>).detail);
    window.addEventListener(ISLAND_EVENT, on);
    return () => window.removeEventListener(ISLAND_EVENT, on);
  }, []);

  // Results: an application finishing in the background.
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const next = new Map(applications.map((a) => [a.id, a.status]));
    seen.current = next;
    if (!prev) return; // first load: don't announce history
    for (const a of applications) {
      const before = prev.get(a.id);
      if (!before || before === a.status || watching.includes(a.id)) continue;
      const who = a.company ? `${a.title} · ${a.company}` : a.title;
      if (a.status === "submitted" || a.status === "completed")
        show({
          id: `done-${a.id}`,
          tone: "success",
          title: "Application sent",
          body: a.reference ? `${who} — ref ${a.reference}` : who,
          action: { label: "View", view: "tasks", appId: a.id },
          group: "sent",
          count: 1,
          names: [a.company || a.title],
        });
      // The click was made but nothing confirmed it: say so rather than "couldn't finish".
      else if ((a.status === "failed" || a.status === "cancelled") && a.submission === "unconfirmed")
        show({
          id: `maybe-${a.id}`,
          tone: "warn",
          title: "May already be sent",
          body: `${who} — check your email before applying again`,
          action: { label: "Check", view: "tasks", appId: a.id },
          ttl: 9000,
        });
      else if (a.status === "failed")
        show({
          id: `fail-${a.id}`,
          tone: "error",
          title: "Couldn't finish an application",
          body: a.error || who,
          action: { label: "See why", view: "tasks", appId: a.id },
          ttl: 9000,
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applications]);

  // New mail while somewhere else.
  const lastUnread = useRef<number | null>(null);
  useEffect(() => {
    const before = lastUnread.current;
    lastUnread.current = unread;
    if (before !== null && unread > before && !inboxOpen)
      show({
        id: `mail-${unread}`,
        tone: "info",
        title: unread - before === 1 ? "New email" : `${unread - before} new emails`,
        body: "From an employer or a site you applied on",
        action: { label: "Open inbox", view: "inbox" },
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  const asks = applications
    .filter((a) => NEEDS.includes(a.status) && !watching.includes(a.id))
    .sort((x, y) => +new Date(x.updated_at) - +new Date(y.updated_at));
  const running = applications.filter(
    (a) => ["queued", "running"].includes(a.status) && !watching.includes(a.id),
  );
  const ask = asks[0] ?? null;
  const campaign = useCampaign().data?.active ?? null;
  const sentToday = applications.filter(
    (a) => ["submitted", "completed"].includes(a.status) && new Date(a.updated_at).toDateString() === new Date().toDateString(),
  ).length;
  useEffect(() => {
    if (!running.length && !campaign) setWorkingOpen(false);
  }, [running.length, campaign]);

  // Pending detail for the application that's asking.
  const detail = useApplication(ask?.id ?? null).data;
  const pending = detail?.pending ?? null;
  const askKey = ask
    ? `${ask.id}:${pending?.type}:${pending?.contextMessage ?? pending?.question ?? ""}:${pending?.captchaUrl?.length ?? 0}`
    : null;

  // A new ask opens the island (and buzzes a phone once).
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!askKey || !pending || announced.current === askKey) return;
    announced.current = askKey;
    setExpanded(true);
    setSnoozed(null);
    try {
      navigator.vibrate?.([40, 60, 40]);
    } catch {
      /* not supported */
    }
  }, [askKey, pending]);
  useEffect(() => {
    if (!ask) setExpanded(false);
  }, [ask]);

  const mode: "ask" | "event" | "working" | null =
    ask && pending && snoozed !== askKey
      ? "ask"
      : event
        ? "event"
        : ask
          ? "ask"
          : running.length || campaign
            ? "working"
            : null;

  const go = (to: IslandTarget, appId?: string) => {
    queue.current = [];
    present(null);
    setExpanded(false);
    onNavigate(to, appId);
  };

  const box = useMainBox();
  return (
    <div
      style={box ? { left: box.left, width: box.width } : { left: 0, right: 0 }}
      className="pointer-events-none fixed top-[max(env(safe-area-inset-top),10px)] z-[60] flex justify-center px-3"
    >
      <AnimatePresence mode="wait" initial={false}>
        {mode === "ask" && ask && (
          <IslandShell
            key="ask"
            tone="ask"
            open={expanded && !!pending && snoozed !== askKey}
            onToggle={() => {
              if (expanded && snoozed !== askKey) {
                setSnoozed(askKey);
                setExpanded(false);
              } else {
                setSnoozed(null);
                setExpanded(true);
              }
            }}
            compact={
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span
                    style={{ background: COLOR.ask }}
                    className="island-motion absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                  />
                  <span
                    style={{ background: COLOR.ask }}
                    className="relative inline-flex h-2.5 w-2.5 rounded-full"
                  />
                </span>
                <span className="min-w-0 truncate text-[13px] font-semibold">
                  {asks.length > 1 ? `${asks.length} applications need you` : "Needs you"}
                </span>
                <span className="hidden min-w-0 max-w-[9rem] truncate text-[12px] text-white/60 sm:inline">
                  {ask.company || ask.title}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/60" />
              </>
            }
          >
            {pending && (
              <AskBody
                app={ask}
                pending={pending}
                queued={asks.length - 1}
                onOpen={() => {
                  setSnoozed(askKey);
                  setExpanded(false);
                  go("tasks", ask.id);
                }}
              />
            )}
          </IslandShell>
        )}

        {mode === "event" && event && (
          <IslandShell
            key={event.id}
            tone={event.tone}
            open
            onToggle={() => present(queue.current.shift() ?? null)}
            compact={null}
            onHold={hold}
            onRelease={release}
          >
            <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
              <span
                style={{ color: COLOR[event.tone], background: mix(COLOR[event.tone], 18) }}
                className="island-motion mt-0.5 grid h-8 w-8 shrink-0 animate-[island-pop_0.5s_cubic-bezier(.2,1.4,.4,1)_both] place-items-center rounded-full"
              >
                {ICON[event.tone]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-snug">{event.title}</p>
                {event.body && (
                  <p className="mt-0.5 line-clamp-3 text-[12.5px] text-white/65">{event.body}</p>
                )}
              </div>
              {event.action && (
                <button
                  onClick={() => go(event.action!.view ?? "tasks", event.action!.appId)}
                  className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-[12px] font-semibold text-neutral-950 transition-transform active:scale-95"
                >
                  {event.action.label}
                </button>
              )}
            </div>
            <Countdown key={`${event.id}-${event.count ?? 1}`} ms={event.ttl ?? 6000} tone={event.tone} />
          </IslandShell>
        )}

        {mode === "working" && (running[0] || campaign) && (
          <IslandShell
            key="working"
            tone="info"
            open={workingOpen}
            tuck
            onToggle={() => setWorkingOpen((o) => !o)}
            compact={<WorkingPill apps={running} campaign={campaign} />}
          >
            <RunningList
              apps={running}
              campaign={campaign}
              sentToday={sentToday}
              onOpen={(id) => {
                setWorkingOpen(false);
                go("tasks", id);
              }}
              onCampaign={() => {
                setWorkingOpen(false);
                go("autoapply");
              }}
            />
          </IslandShell>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Shell: the morphing black pill ─────────────────────────────────────────

function IslandShell({
  tone,
  open,
  onToggle,
  compact,
  onHold,
  onRelease,
  tuck,
  children,
}: {
  tone: IslandTone | "ask";
  /** Esc, a tap outside or the chevron tucks it back to the pill (questions always do). */
  tuck?: boolean;
  open: boolean;
  onToggle: () => void;
  compact: React.ReactNode;
  /** Pointer or focus is on it: don't dismiss. */
  onHold?: () => void;
  onRelease?: () => void;
  children?: React.ReactNode;
}) {
  const calm = useReducedMotion();
  // Desktop: Esc tucks a question away (the pill stays). Phones have no Esc; the chevron does it.
  useEffect(() => {
    if (!open || (tone !== "ask" && !tuck)) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onToggle();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, tone, tuck, onToggle]);
  const color = COLOR[tone];
  const shellRef = useRef<HTMLDivElement>(null);
  // Click or tap anywhere outside a question tucks it away (the pill stays).
  useEffect(() => {
    if (!open || (tone !== "ask" && !tuck)) return;
    const onDown = (e: PointerEvent) => {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, tone, tuck, onToggle]);
  // A slowly turning ring marks a waiting question; the rest sit still.
  const ring = tone === "ask";
  return (
    <motion.div
      ref={shellRef}
      layout={!calm}
      initial={calm ? { opacity: 0 } : { y: -56, opacity: 0, scale: 0.7 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={calm ? { opacity: 0 } : { y: -44, opacity: 0, scale: 0.8 }}
      transition={
        calm ? { duration: 0.12 } : { type: "spring", stiffness: 380, damping: 24, mass: 0.9 }
      }
      style={{
        borderRadius: open ? 28 : 999,
        boxShadow: `0 18px 50px -14px ${mix(color, 45)}, 0 6px 18px -8px rgba(0,0,0,0.45)`,
      }}
      onPointerEnter={onHold}
      onPointerLeave={onRelease}
      onFocus={onHold}
      onBlur={onRelease}
      role={open && tone === "ask" ? "dialog" : open ? "status" : undefined}
      aria-label={open && tone === "ask" ? "JobPilot needs your input" : undefined}
      className={`pointer-events-auto relative text-[color:var(--island-fg)] ${
        // Phones: full width minus the gutter, scrolls if the keyboard leaves little room.
        // Desktop: a roomier card that stays centred in the content area.
        open
          ? "w-full max-w-[460px] overflow-hidden md:max-w-[540px]"
          : "w-auto max-w-[calc(100vw-9.5rem)] overflow-hidden md:max-w-[92vw]"
      }`}
    >
      {/* turning accent ring (clipped by the shell) */}
      {ring && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        >
          <span
            className="island-motion absolute left-1/2 top-1/2 aspect-square w-[260%] -translate-x-1/2 -translate-y-1/2 animate-[island-spin_7s_linear_infinite] opacity-80"
            style={{
              background: `conic-gradient(from 0deg, transparent 0 55%, ${color} 75%, transparent 90%)`,
            }}
          />
        </span>
      )}
      {/* the island's body, inset by the ring's width */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-[1.5px] overflow-hidden rounded-[inherit] bg-[color:var(--island-bg)]"
      >
        {/* soft glow that tells the tone, breathing */}
        <span
          className="island-motion absolute -top-12 left-1/2 h-28 w-[130%] -translate-x-1/2 animate-[island-breathe_3.2s_ease-in-out_infinite] blur-2xl"
          style={{ background: `radial-gradient(closest-side, ${mix(color, 55)}, transparent)` }}
        />
        {/* a faint glass highlight along the top edge */}
        <span className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
      </span>
      {open ? (
        <div className="relative max-h-[calc(100dvh-24px)] overflow-y-auto overflow-x-hidden overscroll-contain p-4 [scrollbar-width:thin]">
          <motion.div
            initial={calm ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.22 }}
          >
            {children}
          </motion.div>
          {(tone === "ask" || tuck) && (
            <button
              onClick={onToggle}
              aria-label="Minimise"
              className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronDown className="h-4 w-4 rotate-180" />
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={onToggle}
          className="relative flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[inherit] px-3 sm:gap-2.5 sm:px-4 outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/50 md:h-11 md:px-5"
          aria-live="polite"
        >
          {compact}
        </button>
      )}
    </motion.div>
  );
}

function Countdown({ ms, tone }: { ms: number; tone: IslandTone }) {
  return (
    <span className="absolute inset-x-0 bottom-0 block h-[2px] bg-white/5">
      <motion.span
        initial={{ width: "100%" }}
        animate={{ width: "0%" }}
        transition={{ duration: ms / 1000, ease: "linear" }}
        style={{ background: COLOR[tone] }}
        className="block h-full"
      />
    </span>
  );
}

// ─── Working pill: real-time progress for background applications ───────────

function WorkingPill({
  apps,
  campaign,
}: {
  apps: ApplicationSummary[];
  campaign: CampaignDTO | null;
}) {
  const first = apps[0];
  const { data } = useApplication(first?.id ?? null);
  const p = first ? applyProgress(data ?? first, data?.events) : null;
  // A campaign is a goal with a count: show how far it is, honestly (only confirmed ones count).
  const goal = campaign ? Math.min(1, campaign.progress.confirmed / campaign.target) : null;
  const counted = campaign ? `${campaign.progress.confirmed} of ${campaign.target}` : null;
  return (
    <>
      <Loader2
        style={{ color: COLOR.info }}
        className={`island-motion h-3.5 w-3.5 shrink-0 ${first ? "animate-spin" : "opacity-60"}`}
      />
      <span className="max-w-[10rem] truncate text-[13px] font-semibold">
        {!first
          ? `Campaign · ${counted}`
          : apps.length > 1
            ? `Applying to ${apps.length} jobs`
            : first.company || first.title}
      </span>
      <span className="max-w-[9rem] truncate text-[12px] text-white/60 sm:max-w-[14rem]">
        {p ? p.now : "Looking for your next match"}
      </span>
      <span className="relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-white/15">
        <motion.span
          style={{ background: COLOR.info }}
          className="absolute inset-y-0 left-0 overflow-hidden rounded-full"
          animate={{ width: `${Math.max(8, Math.round((first ? (p?.fraction ?? 0) : (goal ?? 0)) * 100))}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        >
          <span className="island-motion absolute inset-y-0 w-1/3 animate-[island-shimmer_1.6s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/70 to-transparent" />
        </motion.span>
      </span>
      {first && counted && (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-white/55 sm:inline">{counted}</span>
      )}
    </>
  );
}

// ─── What is running: the pill opened up ────────────────────────────────────

function RunningList({
  apps,
  campaign,
  sentToday,
  onOpen,
  onCampaign,
}: {
  apps: ApplicationSummary[];
  campaign: CampaignDTO | null;
  sentToday: number;
  onOpen: (id: string) => void;
  onCampaign: () => void;
}) {
  return (
    <div className="pr-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-[14.5px] font-semibold">
          {apps.length ? `Applying to ${apps.length} job${apps.length === 1 ? "" : "s"}` : "Between applications"}
        </p>
        <p className="text-[12px] tabular-nums text-white/55">{sentToday} sent today</p>
      </div>
      {campaign && (
        <button
          onClick={onCampaign}
          className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5 text-left transition-colors hover:bg-white/10"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-medium">
              Campaign · {campaign.progress.confirmed} of {campaign.target} confirmed
            </span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/15">
              <span
                style={{ width: `${Math.round((campaign.progress.confirmed / campaign.target) * 100)}%`, background: COLOR.success }}
                className="block h-full rounded-full transition-all"
              />
            </span>
          </span>
        </button>
      )}
      <ul className="space-y-1">
        {apps.slice(0, 5).map((a) => (
          <li key={a.id}>
            <button
              onClick={() => onOpen(a.id)}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/10"
            >
              <Loader2 style={{ color: COLOR.info }} className="island-motion h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{a.company || a.title}</span>
                <span className="block truncate text-[11.5px] text-white/55">
                  {a.status === "queued" ? "Waiting for a free browser…" : a.status_detail && !/^started$/i.test(a.status_detail) ? a.status_detail : "Working on it…"}
                </span>
              </span>
            </button>
          </li>
        ))}
        {apps.length > 5 && <li className="px-2 pt-1 text-[11.5px] text-white/50">+{apps.length - 5} more</li>}
        {!apps.length && <li className="px-2 py-1 text-[12.5px] text-white/60">Looking for your next match…</li>}
      </ul>
    </div>
  );
}

// ─── The question itself ────────────────────────────────────────────────────

const INPUT =
  "h-11 w-full min-w-0 rounded-xl border border-white/15 bg-white/10 px-3.5 text-base text-white placeholder:text-white/40 md:text-[15px] outline-none transition-colors focus:border-white/40 focus:bg-white/15";
const SEND =
  "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white px-5 text-[14px] font-semibold text-neutral-950 transition-transform hover:bg-white/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40";

function AskBody({
  app,
  pending,
  queued,
  onOpen,
}: {
  app: ApplicationSummary;
  pending: PendingDTO;
  queued: number;
  onOpen: () => void;
}) {
  const { respond } = useApplicationActions();
  const [sent, setSent] = useState(false);
  const send = (value: string, onSuccess?: () => void) => {
    setSent(true);
    respond.mutate({ id: app.id, value }, {
      onSuccess: onSuccess ? () => onSuccess() : undefined,
      onError: () => setSent(false),
    });
  };
  const type = pending.type;
  const who = [app.title, app.company].filter(Boolean).join(" · ");

  const head = (icon: React.ReactNode, label: string, title: string, sub?: string) => (
    <div className="mb-3 flex items-start gap-3 pr-7">
      <span
        style={{ color: COLOR.ask, background: mix(COLOR.ask, 18) }}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p
          style={{ color: COLOR.ask }}
          className="text-[11px] font-semibold uppercase tracking-[0.12em]"
        >
          {label}
        </p>
        <p className="mt-0.5 text-[14.5px] font-semibold leading-snug">{title}</p>
        {sub && <p className="mt-0.5 text-[12px] text-white/55">{sub}</p>}
      </div>
    </div>
  );
  const foot = (
    <p className="mt-3 flex items-center justify-between gap-2 text-[11px] text-white/40">
      <span className="min-w-0 truncate">{who}</span>
      {queued > 0 && (
        <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-white/70">
          +{queued} more waiting
        </span>
      )}
    </p>
  );

  if (sent)
    return (
      <div className="flex items-center gap-3 py-3 text-[14px] font-semibold">
        <Loader2 style={{ color: COLOR.success }} className="h-4 w-4 animate-spin" /> Sent —
        continuing your application…
      </div>
    );

  // Older parked forms may still contain a group; present those questions sequentially.
  if (pending.questions?.length) {
    return <IslandQuestionSequence app={app} pending={pending} queued={queued} />;
  }

  if (pending.applicationQuestion) {
    return <IslandApplicationQuestion app={app} pending={pending} queued={queued} send={send} />;
  }

  // Review before submit: summarise, send the user to the full review.
  if (type === "review") {
    const fields = pending.sections?.flatMap((s) => s.fields) ?? [];
    const preview = fields.filter((f) => f.kind !== "file" && f.value).slice(0, 4);
    const blank = pending.missing?.length ?? 0;
    return (
      <>
        {head(
          <ClipboardCheck className="h-4 w-4" />,
          "Ready to submit",
          "Check your answers before they're sent",
          blank
            ? `${blank} left blank: ${pending.missing!.slice(0, 3).join(", ")}${blank > 3 ? "…" : ""}`
            : pending.contextMessage?.startsWith("Held for your review")
              ? pending.contextMessage.replace(/^Held for your review — /, "Held because ")
              : `${fields.length} answers filled for you`,
        )}
        <ul className="mb-3 space-y-1 rounded-2xl bg-white/5 p-3 text-[12.5px]">
          {preview.map((f) => (
            <li key={f.id} className="flex justify-between gap-3">
              <span className="shrink-0 text-white/50">{f.label}</span>
              <span className="min-w-0 truncate text-right font-medium">{f.value}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button onClick={onOpen} className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center rounded-full border border-white/20 px-5 text-[14px] font-semibold text-white hover:bg-white/10">
            Review all
          </button>
          <button
            disabled={sent || blank > 0}
            onClick={() => send(JSON.stringify({ action: "approve" }))}
            className={`${SEND} flex-1`}
            title={blank > 0 ? "Some answers are blank — open the review to fill them" : undefined}
          >
            {sent ? "Submitting…" : "Submit now"}
          </button>
        </div>
        {foot}
      </>
    );
  }

  if (pending.captchaUrl) {
    return (
      <CaptchaAsk app={app} pending={pending} head={head} foot={foot} send={send} onOpen={onOpen} />
    );
  }

  if (type === "aadhaar")
    return <AadhaarAsk pending={pending} head={head} foot={foot} send={send} />;

  if (type === "otp" || type === "mfa" || type === "loginVerification")
    return <OtpAsk pending={pending} head={head} foot={foot} send={send} />;

  const password = type === "credentialFill" || type === "password";
  const question = pending.question || pending.contextMessage || "I need one thing from you";
  return (
    <TextAsk
      pending={pending}
      password={password}
      mobile={type === "mobile"}
      head={head(
        password ? (
          <ShieldCheck className="h-4 w-4" />
        ) : type === "emailLink" ? (
          <Mail className="h-4 w-4" />
        ) : (
          <Bell className="h-4 w-4" />
        ),
        password ? "Sign-in needed" : type === "mobile" ? "Phone number" : "A question",
        question,
        password
          ? "Stored encrypted, only used to sign in to this site."
          : type === "confirmation" || pending.sensitive
            ? undefined
            : "I'll remember your answer for next time.",
      )}
      foot={foot}
      send={send}
    />
  );
}

function IslandApplicationQuestion({
  app,
  pending,
  queued,
  send,
}: {
  app: ApplicationSummary;
  pending: PendingDTO;
  queued: number;
  send: (value: string, onSuccess?: () => void) => void;
}) {
  const question = pending.question || pending.contextMessage || "What would you like to answer?";
  const flow = useSequentialQuestions(app.exec_job_id ?? app.id, [{ id: "current", question, options: pending.options }]);
  const answer = flow.answers.current ?? "";
  const head = (
    <div className="mb-3 flex items-start gap-3 pr-7">
      <span style={{ color: COLOR.ask, background: mix(COLOR.ask, 18) }} className="grid h-9 w-9 shrink-0 place-items-center rounded-full">
        <Bell className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p style={{ color: COLOR.ask }} className="text-[11px] font-semibold uppercase tracking-[0.12em]">Application question</p>
        <p className="mt-0.5 text-[14.5px] font-semibold leading-snug">{question}</p>
        <p className="mt-0.5 text-[12px] text-white/55">{pending.sensitive ? "Only used for this application." : "I’ll look for saved answers for the next questions too."}</p>
      </div>
    </div>
  );
  return (
    <>
      {head}
      {pending.options?.length ? (
        <select className={INPUT} value={answer} onChange={(e) => flow.setAnswer("current", e.target.value)} aria-label={question}>
          <option value="">Choose an answer…</option>
          {pending.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <textarea
          rows={2}
          className="w-full resize-y rounded-xl border border-white/15 bg-white/10 px-3.5 py-2.5 text-base text-white placeholder:text-white/40 outline-none transition-colors focus:border-white/40 focus:bg-white/15 md:text-[14px]"
          inputMode={pending.sensitive ? "numeric" : undefined}
          autoComplete={pending.sensitive ? "off" : undefined}
          value={answer}
          onChange={(e) => flow.setAnswer("current", e.target.value)}
          placeholder="Your answer"
          aria-label={question}
        />
      )}
      <button onClick={() => send(answer.trim(), flow.clear)} disabled={!answer.trim()} className={`${SEND} mt-3 w-full`}>
        Continue
      </button>
      <p className="mt-3 flex items-center justify-between gap-2 text-[11px] text-white/40">
        <span className="min-w-0 truncate">{[app.title, app.company].filter(Boolean).join(" · ")}</span>
        {queued > 0 && <span className="shrink-0">+{queued} more waiting</span>}
      </p>
    </>
  );
}

function IslandQuestionSequence({
  app,
  pending,
  queued,
}: {
  app: ApplicationSummary;
  pending: PendingDTO;
  queued: number;
}) {
  const { respond } = useApplicationActions();
  const questions = pending.questions ?? [];
  const flow = useSequentialQuestions(app.exec_job_id ?? app.id, questions);
  const question = flow.current;
  const [sent, setSent] = useState(false);
  if (!question) return null;
  const answer = flow.answers[question.id] ?? "";
  const continueSequence = () => {
    const values = { ...flow.answers, [question.id]: answer.trim() };
    if (flow.index < flow.count - 1) {
      flow.setAnswer(question.id, answer.trim());
      flow.advance();
      return;
    }
    setSent(true);
    respond.mutate(
      { id: app.id, value: JSON.stringify(values) },
      { onSuccess: flow.clear, onError: () => setSent(false) },
    );
  };
  if (sent) {
    return (
      <div className="flex items-center gap-3 py-3 text-[14px] font-semibold">
        <Loader2 style={{ color: COLOR.success }} className="h-4 w-4 animate-spin" />
        Sending your answers…
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p style={{ color: COLOR.ask }} className="text-[11px] font-semibold uppercase tracking-[0.12em]">Question {flow.index + 1} of {flow.count}</p>
          <p className="mt-1 text-[14px] font-semibold leading-snug">{question.question}</p>
        </div>
        <span className="shrink-0 text-[11px] text-white/50">{flow.count - flow.index - 1} left</span>
      </div>
      <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-white/75 transition-[width]" style={{ width: `${((flow.index + 1) / flow.count) * 100}%` }} />
      </div>
      {question.options?.length ? (
        <select
          className={INPUT}
          value={answer}
          onChange={(e) => flow.setAnswer(question.id, e.target.value)}
          aria-label={question.question}
        >
          <option value="">Choose an answer…</option>
          {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <textarea
          rows={2}
          className="w-full resize-y rounded-xl border border-white/15 bg-white/10 px-3.5 py-2.5 text-base text-white placeholder:text-white/40 outline-none transition-colors focus:border-white/40 focus:bg-white/15 md:text-[14px]"
          value={answer}
          onChange={(e) => flow.setAnswer(question.id, e.target.value)}
          placeholder="Your answer"
          aria-label={question.question}
        />
      )}
      <button onClick={continueSequence} disabled={!answer.trim() || respond.isPending} className={`${SEND} mt-3 w-full`}>
        {respond.isPending ? "Sending…" : flow.index === flow.count - 1 ? "Send answers" : "Next question"}
      </button>
      <p className="mt-2 text-[11px] text-white/45">I’ve used saved details where possible.</p>
      {queued > 0 && <p className="mt-1 text-[11px] text-white/45">{queued} other application{queued === 1 ? "" : "s"} waiting.</p>}
    </div>
  );
}

type HeadFn = (
  icon: React.ReactNode,
  label: string,
  title: string,
  sub?: string,
) => React.ReactNode;

function OtpAsk({
  pending,
  head,
  foot,
  send,
}: {
  pending: PendingDTO;
  head: HeadFn;
  foot: React.ReactNode;
  send: (v: string) => void;
}) {
  const msg = pending.question || pending.contextMessage || "Enter the code the site sent you";
  const explicit = Number(pending.length);
  const length =
    explicit >= 4 && explicit <= 8
      ? explicit
      : Number(msg.match(/\b([4-8])\s*-?\s*digit/i)?.[1]) || 6;
  const [value, setValue] = useState("");
  return (
    <>
      {head(
        <KeyRound className="h-4 w-4" />,
        "One-time code",
        msg,
        pending.channel === "email"
          ? "It fills itself from your inbox — or type it"
          : pending.destination
            ? `Sent to ${pending.destination}`
            : pending.channel === "sms"
              ? "Sent by SMS — only you can see it. Goes straight to the site, never to the AI."
              : undefined,
      )}
      <InputOTP
        maxLength={length}
        value={value}
        onChange={(v) => setValue(v.replace(/\D/g, ""))}
        onComplete={send}
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        containerClassName="justify-center"
      >
        <InputOTPGroup className="gap-1 sm:gap-1.5">
          {Array.from({ length }).map((_, i) => (
            <InputOTPSlot
              key={i}
              index={i}
              className="h-12 w-[2.15rem] rounded-xl border-white/20 bg-white/10 text-[20px] font-semibold text-white first:rounded-xl last:rounded-xl min-[400px]:w-10 md:h-14 md:w-12 md:text-[22px]"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <p className="mt-2 hidden text-center text-[11px] text-white/40 md:block">
        Type or paste (Ctrl/⌘+V) · it sends itself on the last digit · Esc to tuck away
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={async () => {
            try {
              const t = await navigator.clipboard.readText();
              const code = (t.match(new RegExp(`\\b\\d{${length}}\\b`)) ?? [
                t.replace(/\D/g, ""),
              ])[0].slice(0, length);
              setValue(code);
              if (code.length === length) send(code);
            } catch {
              /* clipboard blocked: type it */
            }
          }}
          className="h-11 rounded-full border border-white/20 px-5 text-[14px] font-medium text-white/80 transition-colors hover:bg-white/10"
        >
          Paste
        </button>
        <button
          disabled={value.length < length}
          onClick={() => send(value)}
          className={`${SEND} flex-1`}
        >
          Verify
        </button>
      </div>
      {foot}
    </>
  );
}

/** 12-digit Aadhaar / 16-digit Virtual ID, grouped 4-4-4(-4). Typed straight into the portal, never to the AI. */
function AadhaarAsk({
  pending,
  head,
  foot,
  send,
}: {
  pending: PendingDTO;
  head: HeadFn;
  foot: React.ReactNode;
  send: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const digits = value.replace(/\D/g, "").slice(0, 16);
  const grouped = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  const ok = digits.length === 12 || digits.length === 16;
  return (
    <>
      {head(
        <ShieldCheck className="h-4 w-4" />,
        "Aadhaar / Virtual ID",
        pending.question || pending.contextMessage || "Your Aadhaar number",
        "Typed straight into the government site — never shown to the AI, never saved.",
      )}
      <div className="flex gap-2">
        <input
          autoFocus
          value={grouped}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok && send(digits)}
          style={{ WebkitTextSecurity: show ? "none" : "disc" } as React.CSSProperties}
          inputMode="numeric"
          autoComplete="off"
          placeholder="1234 5678 9012"
          className={INPUT}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="h-11 rounded-full border border-white/20 px-4 text-[13px] text-white/80 hover:bg-white/10"
        >
          {show ? "Hide" : "Show"}
        </button>
        <button disabled={!ok} onClick={() => send(digits)} className={SEND}>
          Send
        </button>
      </div>
      {foot}
    </>
  );
}

function TextAsk({
  pending,
  password,
  mobile,
  head,
  foot,
  send,
}: {
  pending: PendingDTO;
  password: boolean;
  mobile: boolean;
  head: React.ReactNode;
  foot: React.ReactNode;
  send: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  const options = pending.options ?? [];
  return (
    <>
      {head}
      {options.length > 0 && options.length <= 8 ? (
        // Fixed answers: one tap sends.
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o}
              onClick={() => send(o)}
              className="rounded-full border border-white/20 bg-white/10 px-4 py-2 text-[13.5px] font-medium transition-all hover:bg-white hover:text-neutral-950 active:scale-95"
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2">
          {options.length > 0 ? (
            <select className={INPUT} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="" className="text-black">
                Choose…
              </option>
              {options.map((o) => (
                <option key={o} className="text-black">
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && value.trim() && send(value.trim())}
              type={password ? "password" : mobile ? "tel" : "text"}
              inputMode={mobile ? "tel" : undefined}
              autoComplete={password ? "current-password" : "off"}
              placeholder={password ? "Password" : mobile ? "+91 98765 43210" : "Your answer"}
              className={INPUT}
            />
          )}
          <button disabled={!value.trim()} onClick={() => send(value.trim())} className={SEND}>
            Send
          </button>
        </div>
      )}
      {foot}
    </>
  );
}

function CaptchaAsk({
  app,
  pending,
  head,
  foot,
  send,
  onOpen,
}: {
  app: ApplicationSummary;
  pending: PendingDTO;
  head: HeadFn;
  foot: React.ReactNode;
  send: (v: string) => void;
  onOpen: () => void;
}) {
  const click = pending.captchaKind === "click" || pending.type === "clickCaptcha";
  const [code, setCode] = useState("");
  const title = useMemo(
    () => pending.contextMessage ?? "Quick security check",
    [pending.contextMessage],
  );
  return (
    <>
      {head(
        <ShieldCheck className="h-4 w-4" />,
        "Security check",
        title,
        "Only this check needs you — everything else is filled.",
      )}
      <div className="mb-3 overflow-hidden rounded-2xl bg-white p-2">
        <img
          src={pending.captchaUrl}
          alt={`Security check for ${app.title}`}
          draggable={false}
          className="mx-auto max-h-28 w-auto max-w-full object-contain"
        />
      </div>
      {click ? (
        // Tapping a picture needs room: do it on the full card.
        <button onClick={onOpen} className={`${SEND} w-full`}>
          Open to solve
        </button>
      ) : (
        <div className="flex gap-2">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && code.trim() && send(code.trim())}
            placeholder="Characters in the image"
            autoComplete="off"
            className={`${INPUT} font-mono tracking-widest`}
          />
          <button disabled={!code.trim()} onClick={() => send(code.trim())} className={SEND}>
            Submit
          </button>
        </div>
      )}
      {foot}
    </>
  );
}
