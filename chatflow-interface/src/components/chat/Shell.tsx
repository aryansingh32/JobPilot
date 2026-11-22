import {
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Eye,
  FileDown,
  Bell,
  Loader2,
  PanelLeft,
  SearchCheck,
  XCircle,
} from "lucide-react";
import type { ReceiptMessage, Thread } from "@/lib/chat-types";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/task-status";

export function WorkingStrip({
  label,
  frame,
  onWatch,
}: {
  label: string;
  frame: string | null;
  onWatch: () => void;
}) {
  return (
    <div className="px-3 sm:px-4">
      <button
        onClick={onWatch}
        className="mx-auto flex w-full max-w-(--chat-w) items-center gap-3 rounded-2xl border border-border bg-card px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(13,24,40,0.04)] transition-colors hover:border-faint"
      >
        <span className="relative h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
          {frame ? (
            <img src={frame} alt="" className="h-full w-full object-cover object-top" />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-faint" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">
            <span className="live-dot h-1.5 w-1.5" /> Working
          </span>
          <span className="block truncate text-[13px] text-ink-2">{label}</span>
        </span>
        {frame && (
          <span className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold text-ink-2">
            <Eye className="h-3.5 w-3.5" /> Watch
          </span>
        )}
      </button>
    </div>
  );
}

export function HowItWorks() {
  const steps = [
    { n: "1", t: "Tell it the task", d: "Plain words. Attach files if needed." },
    { n: "2", t: "Watch it work", d: "Live view of every step." },
    { n: "3", t: "Approve & get proof", d: "Nothing sent without you. Receipt saved." },
  ];
  return (
    <div className="mx-auto mt-10 hidden max-w-2xl grid-cols-3 gap-3 sm:grid">
      {steps.map((s) => (
        <div key={s.n} className="rounded-[18px] border border-border bg-card px-4 py-3.5">
          <div className="eyebrow mb-1">Step {s.n}</div>
          <div className="text-[13px] font-semibold text-foreground">{s.t}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{s.d}</div>
        </div>
      ))}
    </div>
  );
}

export type MainView = "chat" | "tasks" | "inbox" | "autoapply" | "jobs";

const PILL: Record<Exclude<TaskStatus, "idle">, string> = {
  working: "bg-primary-soft text-primary-soft-foreground",
  needs: "bg-warning-soft text-warning-soft-foreground",
  done: "bg-muted text-ink-2",
  failed: "bg-destructive/10 text-destructive",
};

/**
 * Top bar: task title on the left, and on the right a live status pill for
 * the current task — the "proof it's working" at a glance. Tapping it goes to
 * what matters for that state (live view, the card waiting on you, the receipt).
 */
export function ChatHeader({
  onOpenSidebar,
  title,
  status,
  detail,
  onStatusClick,
  unreadCount,
  onOpenInbox,
}: {
  onOpenSidebar: () => void;
  title: string;
  status: TaskStatus | null;
  /** e.g. the step being worked on, shown next to "Working" on wider screens */
  detail?: string;
  onStatusClick: () => void;
  unreadCount: number;
  onOpenInbox: () => void;
}) {
  const shown = status && status !== "idle" ? status : null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-2 md:px-4">
      <button
        onClick={onOpenSidebar}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
        aria-label="Open sidebar"
      >
        <PanelLeft className="h-[18px] w-[18px]" />
      </button>
      <div className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">
        {title}
      </div>

      {shown && (
        <button
          onClick={onStatusClick}
          className={`flex h-8 max-w-[60vw] shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-opacity hover:opacity-85 md:max-w-[22rem] ${PILL[shown]}`}
        >
          {shown === "working" ? (
            <span className="live-dot h-1.5 w-1.5 shrink-0" />
          ) : shown === "needs" ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0" />
          ) : shown === "done" ? (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="shrink-0">{TASK_STATUS_LABEL[shown]}</span>
          {detail && (
            <span className="hidden min-w-0 truncate font-medium opacity-80 sm:inline">
              · {detail}
            </span>
          )}
        </button>
      )}

      <button
        onClick={onOpenInbox}
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={unreadCount ? `Inbox, ${unreadCount} unread` : "Inbox"}
        title="Inbox"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unreadCount > 0 && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
        )}
      </button>
    </header>
  );
}

const CAPABILITIES = [
  {
    icon: ClipboardList,
    title: "Fill a form",
    example: "Fill out the internship application on this page for me",
  },
  {
    icon: FileDown,
    title: "Get a document",
    example: "Download my latest bank statement as a PDF",
  },
  {
    icon: CalendarCheck,
    title: "Book a slot",
    example: "Book the earliest passport appointment near me",
  },
  {
    icon: SearchCheck,
    title: "Check a status",
    example: "Check the status of my visa application",
  },
];

/** Home: what jobpilot can do — each tile pre-fills a concrete example. */
export function CapabilityTiles() {
  return (
    <div className="no-scrollbar -mx-4 mt-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0">
      {CAPABILITIES.map(({ icon: Icon, title, example }) => (
        <button
          key={title}
          onClick={() =>
            window.dispatchEvent(new CustomEvent("agent-suggest", { detail: example }))
          }
          className="group w-[44%] shrink-0 snap-start rounded-[16px] border border-border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary-border hover:shadow-[0_4px_14px_rgba(13,24,40,0.06)] sm:w-auto"
        >
          <span className="mb-2 grid h-8 w-8 place-items-center rounded-lg bg-primary-soft text-primary-soft-foreground">
            <Icon className="h-4 w-4" />
          </span>
          <span className="block text-[13px] font-semibold text-foreground">{title}</span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-muted-foreground">
            {example}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Home: the last finished tasks as mini receipts — proof of work at a glance. */
export function RecentProofs({
  threads,
  onOpen,
}: {
  threads: Thread[];
  onOpen: (id: string) => void;
}) {
  const proofs = threads
    .map((t) => {
      const r = [...t.messages].reverse().find((m) => m.type === "receipt") as
        | ReceiptMessage
        | undefined;
      return r && r.status !== "failed" ? { t, r } : null;
    })
    .filter((x): x is { t: Thread; r: ReceiptMessage } => !!x)
    .sort((a, b) => b.r.completedAt - a.r.completedAt)
    .slice(0, 3);
  if (!proofs.length) return <HowItWorks />;
  return (
    <div className="mx-auto mt-8 max-w-(--chat-w)">
      <div className="eyebrow mb-2 px-1">Recent proof</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {proofs.map(({ t, r }) => (
          <button
            key={t.id}
            onClick={() => onOpen(t.id)}
            className="flex items-start gap-2.5 rounded-[16px] border border-border bg-card p-3 text-left transition-colors hover:border-faint"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
              <CircleCheck className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-foreground">
                {r.title || t.title}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {r.reference ? `Ref ${r.reference}` : (r.site ?? "Done")}
              </span>
              <span className="block text-[11px] text-faint">
                {new Date(r.completedAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
