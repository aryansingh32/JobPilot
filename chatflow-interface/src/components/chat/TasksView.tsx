import { useEffect, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Loader2,
  MessageSquare,
  PenLine,
  XCircle,
} from "lucide-react";
import type { ApplicationSummary, PendingDTO } from "@/lib/api-client";
import { appStatus, appSummary, ts, useApplication, useApplicationActions } from "@/lib/live";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/task-status";
import { OutcomeBadge } from "./OutcomeBadge";
import { ApplyBar, ApplyTracker } from "./ApplyTracker";
import { NeedsYouHint } from "./NeedsYouHint";

type Filter = "all" | "needs" | "working" | "done";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

const STATUS_STYLE: Record<TaskStatus, { pill: string; icon: React.ReactNode }> = {
  needs: {
    pill: "bg-warning-soft text-warning-soft-foreground",
    icon: <CircleAlert className="h-3.5 w-3.5" />,
  },
  working: {
    pill: "bg-primary-soft text-primary-soft-foreground",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  done: {
    pill: "bg-muted text-ink-2",
    icon: <CircleCheck className="h-3.5 w-3.5 text-success" />,
  },
  failed: {
    pill: "bg-destructive/10 text-destructive",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  idle: {
    pill: "bg-muted text-muted-foreground",
    icon: <PenLine className="h-3.5 w-3.5" />,
  },
};

const matches = (f: Filter, s: TaskStatus) =>
  f === "all" ? true : f === "done" ? s === "done" || s === "failed" || s === "idle" : s === f;

/** Every application from the server, filterable by what needs attention. */
export function TasksView({
  applications,
  loading,
  focusId,
  onOpenChat,
  onNew,
  onWatching,
}: {
  applications: ApplicationSummary[];
  loading: boolean;
  /** Application to expand on arrival (e.g. tapped on the home screen) */
  focusId?: string | null;
  /** Opens the chat for this application when one exists on this device */
  onOpenChat?: (app: ApplicationSummary) => (() => void) | null;
  onNew: () => void;
  /** The application whose card is open on screen (the island stays quiet for it). */
  onWatching?: (id: string | null) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const rows = applications
    .map((a) => ({ a, status: appStatus(a) }))
    .sort((x, y) => ts(y.a.updated_at) - ts(x.a.updated_at));
  const visible = rows.filter((r) => matches(filter, r.status));
  useEffect(() => {
    onWatching?.(openId);
    return () => onWatching?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);
  const openNeeds = applications.some((a) => a.id === openId && a.status === "needs_input");
  const openReview = applications.some((a) => a.id === openId && a.status === "awaiting_review");

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-8 pt-2 sm:px-4">
      <div className="mx-auto w-full max-w-(--chat-w)">
        <div className="mb-4">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Applications</h1>
          <p className="text-[13px] text-muted-foreground">
            Everything I've applied to for you, and what's waiting on you.
          </p>
        </div>

        <div className="no-scrollbar -mx-3 mb-4 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0">
          {FILTERS.map((f) => {
            const n = rows.filter((r) => matches(f.id, r.status)).length;
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-ink-2 hover:border-faint"
                }`}
              >
                {f.label}
                <span className={active ? "opacity-70" : "text-faint"}>{n}</span>
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="overflow-hidden rounded-[18px] border border-border bg-card">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-3 border-b border-border px-4 py-4 last:border-0"
              >
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                </div>
                <div className="h-5 w-20 rounded-full bg-muted" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-[18px] border border-dashed border-border px-6 py-12 text-center">
            <p className="text-[14px] font-semibold text-foreground">
              {filter === "needs" ? "Nothing needs you right now" : "No applications here yet"}
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {filter === "needs"
                ? "When I need a code, a file or your approval, it shows up here."
                : "Open a job and tap Apply for me — it will appear in this list."}
            </p>
            {filter !== "needs" && (
              <button
                onClick={onNew}
                className="mt-4 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground"
              >
                Find jobs
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-[18px] border border-border bg-card">
            {visible.map(({ a, status }) => {
              const open = openId === a.id;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => setOpenId(open ? null : a.id)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold text-foreground">
                        {a.title || "Application"}
                        {a.company && (
                          <span className="font-medium text-ink-2"> · {a.company}</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
                        {appSummary(a)}
                      </div>
                      {["queued", "running", "needs_input", "awaiting_review"].includes(
                        a.status,
                      ) && <ApplyBar app={a} />}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${STATUS_STYLE[status].pill}`}
                      >
                        {STATUS_STYLE[status].icon}
                        {a.status === "cancelled" ? "Cancelled" : TASK_STATUS_LABEL[status]}
                      </span>
                      <OutcomeBadge app={a} />
                      <span className="text-[11px] text-faint">{timeAgo(ts(a.updated_at))}</span>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                  {open && <ApplicationDetailPanel app={a} openChat={onOpenChat?.(a) ?? null} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <NeedsYouHint
        targetId={openNeeds || openReview ? `pending-${openId}` : null}
        label={openReview ? "Review waiting" : "Your answer needed"}
      />
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Working on it",
  parse: "Read the application form",
  answers: "Filled in your answers",
  needs_input: "Asked you for something",
  awaiting_review: "Ready for your review",
  verified: "Checked every answer before sending",
  submit_skipped: "Stopped before submitting (test run)",
  code_autofilled: "Code read from your inbox",
  submitted: "Submitted",
  completed: "Finished",
  failed: "Stopped with an error",
  cancelled: "Cancelled",
  manual_applied: "You applied on the company site",
  manual_skipped: "Skipped",
};

/** One readable line of detail per pipeline stage. */
function eventNote(phase: string, d: Record<string, unknown> = {}): string | null {
  if (phase === "parse" && typeof d.fields === "number")
    return `${d.fields} fields, ${d.required ?? 0} required`;
  if (phase === "answers" && Array.isArray(d.answers)) {
    const a = d.answers as { source: string }[];
    const from = (src: string) => a.filter((x) => x.source === src).length;
    const parts = [
      `${from("profile")} from your profile`,
      from("memory") && `${from("memory")} remembered`,
      from("user") && `${from("user")} from you`,
    ]
      .filter(Boolean)
      .join(", ");
    return `${a.length} answers — ${parts}`;
  }
  if (phase === "submitted" && d.reference) return `Reference ${String(d.reference)}`;
  const text = d.detail ?? d.error;
  return typeof text === "string" ? text : null;
}

function ApplicationDetailPanel({
  app,
  openChat,
}: {
  app: ApplicationSummary;
  openChat: (() => void) | null;
}) {
  const { data, isLoading } = useApplication(app.id);
  const { cancel, resolve } = useApplicationActions();
  const active = ["queued", "running", "needs_input", "awaiting_review"].includes(app.status);
  const events = data?.events ?? [];

  return (
    <div className="border-t border-border bg-background/60 px-4 pb-4 pt-3">
      {(active || app.status === "failed" || app.status === "submitted") && (
        <ApplyTracker app={data ?? app} events={events} />
      )}
      {(app.status === "failed" || app.status === "needs_input" || app.status === "awaiting_review") && app.url && (
        <div className="mb-4 rounded-2xl border border-border bg-muted/40 p-3.5">
          <p className="text-[13px] font-semibold text-foreground">
            {app.status === "failed" ? "Want to finish it yourself?" : "Rather do this step yourself?"}
          </p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Open the company's page and apply there, then tell me so it's counted and not retried.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <a
              href={app.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open the application page
            </a>
            <button
              onClick={() => resolve.mutate({ id: app.id, action: "applied" })}
              disabled={resolve.isPending}
              className="rounded-full border border-border px-3.5 py-1.5 text-[12px] font-medium text-ink-2 hover:border-faint hover:text-foreground disabled:opacity-50"
            >
              I've applied
            </button>
            <button
              onClick={() => resolve.mutate({ id: app.id, action: "skip" })}
              disabled={resolve.isPending}
              className="rounded-full border border-border px-3.5 py-1.5 text-[12px] font-medium text-ink-2 hover:border-faint hover:text-foreground disabled:opacity-50"
            >
              Skip this job
            </button>
          </div>
        </div>
      )}
      {data?.pending && (
        <PendingCard
          key={`${data.pending.contextMessage}-${data.pending.captchaUrl?.length ?? 0}`}
          appId={app.id}
          pending={data.pending}
        />
      )}

      {isLoading ? (
        <p className="text-[12px] text-muted-foreground">Loading history…</p>
      ) : events.length ? (
        <ol className="relative ml-1 space-y-2.5 border-l border-border pl-4">
          {events.map((e, i) => {
            const note = eventNote(e.phase, e.detail);
            return (
              <li key={i} className="relative text-[13px]">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-faint ring-2 ring-background" />
                <span className="text-foreground">
                  {PHASE_LABEL[e.phase] ??
                    (e.phase.startsWith("admin:") ? "Updated by support" : e.phase)}
                </span>
                {note && <span className="text-muted-foreground"> — {note}</span>}
                <span className="ml-2 text-[11px] text-faint">{timeAgo(ts(e.at))}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[12px] text-muted-foreground">No history yet.</p>
      )}

      {app.reference && (
        <p className="mt-3 text-[13px] text-ink-2">
          Reference <span className="font-mono font-semibold text-foreground">{app.reference}</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {openChat && (
          <button
            onClick={openChat}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" /> Open chat
          </button>
        )}
        {app.url && (
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12px] font-medium text-ink-2 hover:border-faint hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Job posting
          </a>
        )}
        {active && (
          <button
            onClick={() => cancel.mutate(app.id)}
            disabled={cancel.isPending}
            className="rounded-full border border-border px-3.5 py-1.5 text-[12px] font-medium text-destructive hover:border-destructive/40 disabled:opacity-50"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel application"}
          </button>
        )}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  profile: "From your profile",
  memory: "Remembered",
  user: "Your answer",
  workflow: "Filled by the site's steps",
  default: "Prefer not to say",
};

/** The question it's paused on, or the full review before anything is sent. */
function PendingCard({ appId, pending }: { appId: string; pending: PendingDTO }) {
  const { respond, cancel } = useApplicationActions();
  const fields = pending.sections?.flatMap((s) => s.fields) ?? [];
  const [answer, setAnswer] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.id, f.value])),
  );
  const field =
    "w-full rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary";

  if (pending.captchaUrl) return <CaptchaCard appId={appId} pending={pending} />;

  if (pending.type !== "review") {
    return (
      <div
        id={`pending-${appId}`}
        className="mb-4 scroll-mt-24 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5"
      >
        <p className="text-[13px] font-semibold text-foreground">
          {pending.type === "credentialFill"
            ? pending.contextMessage
            : pending.question
              ? `The application asks: “${pending.question}”`
              : pending.contextMessage}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {pending.type === "credentialFill"
            ? "Stored encrypted, only used to sign in to this site."
            : "I'll remember your answer for next time."}
        </p>
        <div className="mt-2.5 flex gap-2">
          {pending.options?.length ? (
            <select className={field} value={answer} onChange={(e) => setAnswer(e.target.value)}>
              <option value="">Choose…</option>
              {pending.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              className={field}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              type={pending.type === "credentialFill" ? "password" : "text"}
              inputMode={pending.type === "otp" ? "numeric" : undefined}
              autoComplete={
                pending.type === "credentialFill"
                  ? "current-password"
                  : pending.type === "otp"
                    ? "one-time-code"
                    : undefined
              }
              placeholder={pending.type === "credentialFill" ? "Password" : "Your answer"}
            />
          )}
          <button
            disabled={!answer.trim() || respond.isPending}
            onClick={() => respond.mutate({ id: appId, value: answer.trim() })}
            className="shrink-0 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      id={`pending-${appId}`}
      className="mb-4 scroll-mt-24 rounded-2xl border border-primary/30 bg-primary-soft/40 p-3.5"
    >
      <p className="text-[14px] font-semibold text-foreground">Check before I submit</p>
      <p className="text-[12px] text-muted-foreground">
        Exactly these answers will be sent. Edit anything that's off.
      </p>
      {pending.missing?.length ? (
        <p className="mt-1.5 text-[12px] text-warning-soft-foreground">
          Left blank: {pending.missing.join(", ")}
        </p>
      ) : null}
      <div className="mt-3 max-h-96 space-y-2.5 overflow-y-auto pr-1">
        {(pending.sections ?? []).length > 1 && fields.some((f) => f.locked) && (
          <p className="text-[12px] text-muted-foreground">
            This site's form has several pages — earlier answers can't be changed from here. Fix
            them in your profile and apply again.
          </p>
        )}
        {(pending.sections ?? []).flatMap((sec) => [
          (pending.sections ?? []).length > 1 ? (
            <p
              key={`h-${sec.id}`}
              className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-faint"
            >
              {sec.title}
            </p>
          ) : null,
          ...sec.fields.map((f) => (
            <label key={f.id} className="block">
              <span className="flex items-center gap-2 text-[12px] text-ink-2">
                {f.label}
                <span className="text-[11px] text-faint">{SOURCE_LABEL[f.source] ?? ""}</span>
              </span>
              {f.kind === "file" || f.locked ? (
                <div className="mt-1 text-[13px] text-foreground">{f.value}</div>
              ) : f.options?.length ? (
                <select
                  className={`${field} mt-1`}
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                >
                  {f.options.map((o) => (
                    <option key={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={`${field} mt-1`}
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                />
              )}
            </label>
          )),
        ])}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          disabled={respond.isPending}
          onClick={() =>
            respond.mutate({ id: appId, value: JSON.stringify({ action: "approve", values }) })
          }
          className="rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
        >
          {respond.isPending ? "Submitting…" : "Submit application"}
        </button>
        <button
          onClick={() => cancel.mutate(appId)}
          className="rounded-full border border-border px-4 py-2 text-[13px] font-medium text-ink-2"
        >
          Don't submit
        </button>
      </div>
    </div>
  );
}

function timeAgo(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(t).toLocaleDateString();
}

/**
 * A captcha, shown as just its own cropped image. Text: type what it says.
 * Click: tap the picture as asked — each tap is done on the site and a fresh
 * image comes back — then "Done".
 */
function CaptchaCard({ appId, pending }: { appId: string; pending: PendingDTO }) {
  const { respond } = useApplicationActions();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const click = pending.captchaKind === "click" || pending.type === "clickCaptcha";
  const send = (value: string) => {
    setSent(true);
    respond.mutate({ id: appId, value });
  };
  return (
    <div
      id={`pending-${appId}`}
      className="mb-4 scroll-mt-24 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5"
    >
      <p className="text-[13px] font-semibold text-foreground">
        {pending.contextMessage ?? "Security check"}
      </p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        {click
          ? "Tap the picture just like on the site. I'll show you the result after each tap."
          : "Only this check needs you — everything else is filled."}
      </p>
      <div className="mt-2.5 inline-block max-w-full overflow-hidden rounded-xl border border-border bg-background">
        <img
          src={pending.captchaUrl}
          alt="Security check from the application form"
          draggable={false}
          onClick={(e) => {
            if (!click || sent) return;
            const r = e.currentTarget.getBoundingClientRect();
            send(
              JSON.stringify({
                x: (e.clientX - r.left) / r.width,
                y: (e.clientY - r.top) / r.height,
              }),
            );
          }}
          className={`block h-auto max-w-full ${click ? (sent ? "cursor-wait opacity-60" : "cursor-crosshair") : ""}`}
        />
      </div>
      {click ? (
        <div className="mt-2.5">
          <button
            disabled={sent}
            onClick={() => send(JSON.stringify({ done: true }))}
            className="rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink-2 disabled:opacity-50"
          >
            {sent ? "Updating…" : "Done"}
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && code.trim() && send(code.trim())}
            placeholder="Characters in the image"
            autoComplete="off"
            className="w-full max-w-xs rounded-xl border border-border bg-card px-3 py-2 font-mono text-[14px] tracking-widest text-foreground outline-none focus:border-primary"
          />
          <button
            disabled={!code.trim() || sent}
            onClick={() => send(code.trim())}
            className="shrink-0 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {sent ? "Submitting…" : "Submit"}
          </button>
        </div>
      )}
    </div>
  );
}
