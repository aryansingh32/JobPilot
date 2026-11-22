import { useState } from "react";
import { ArrowRight, Check, Inbox, KeyRound, ListChecks, Search, Sparkles, Wand2 } from "lucide-react";
import type {
  ActionsMessage,
  AppsStatusMessage,
  AskMessage,
  JobCardsMessage,
} from "@/lib/chat-types";
import { jp, type JobListingDTO } from "@/lib/api-client";
import { appStatus, appSummary, useApplications } from "@/lib/live";
import { TASK_STATUS_LABEL } from "@/lib/task-status";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { JobCard } from "./JobsHome";
import { ApplyBar } from "./ApplyTracker";

// Cards the assistant can put in the conversation. They never talk to the
// chat session directly: they raise window events the screen already handles.

export const OPEN_JOB_EVENT = "jp:open-job";
export const APPLY_JOB_EVENT = "jp:apply-job";
export const NAVIGATE_EVENT = "jp:navigate";
export const SEND_EVENT = "agent-send";

const fire = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

export function JobCardsView({ msg }: { msg: JobCardsMessage }) {
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const jobs = msg.jobs.filter((j) => !hidden.has(j.id));
  if (!jobs.length)
    return (
      <div className="rounded-[20px] border border-border bg-gradient-to-br from-card to-muted/40 px-4 py-5 shadow-sm sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground">
            <Search className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">No close matches yet</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {msg.empty ?? "I couldn't find roles that fit your saved profile yet."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fire(SEND_EVENT, "Search this role for all experience levels")}
                className="rounded-full border border-border bg-card px-3.5 py-2 text-[12.5px] font-medium text-foreground transition hover:border-primary hover:bg-primary-soft"
              >
                Try a broader search
              </button>
              <button
                type="button"
                onClick={() => fire(NAVIGATE_EVENT, "jobs")}
                className="rounded-full px-3.5 py-2 text-[12.5px] font-medium text-primary transition hover:bg-primary-soft"
              >
                Browse all jobs
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
        <Sparkles className="h-3.5 w-3.5" /> {msg.title}
      </div>
      <div className="no-scrollbar -mx-4 -mt-1.5 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-3 pt-1.5 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] sm:mx-0 sm:px-0">
        {jobs.map((job, i) => (
          <JobCard
            key={job.id}
            index={i}
            job={job}
            saved={saved.has(job.id)}
            onOpen={(j: JobListingDTO) => fire(OPEN_JOB_EVENT, j)}
            onApply={(j: JobListingDTO) => fire(APPLY_JOB_EVENT, j)}
            onToggleSave={(j: JobListingDTO) => {
              const on = saved.has(j.id);
              setSaved((p) => {
                const n = new Set(p);
                if (on) n.delete(j.id);
                else n.add(j.id);
                return n;
              });
              void (on ? jp.unsaveJob(j.id) : jp.saveJob(j.id));
            }}
            onPass={(j: JobListingDTO) => {
              setHidden((p) => new Set(p).add(j.id));
              void jp.passJob(j.id);
            }}
          />
        ))}
        {msg.hasMore && (
          <button
            type="button"
            onClick={() => fire(NAVIGATE_EVENT, { view: "jobs", search: msg.search })}
            className="group flex w-[min(82vw,300px)] shrink-0 snap-start flex-col justify-between rounded-[20px] border border-border bg-gradient-to-br from-card to-primary-soft/40 p-5 text-left transition hover:border-primary/40 hover:shadow-md active:scale-[0.99] sm:w-[300px]"
            aria-label="Search more similar jobs"
          >
            <span className="grid h-11 w-11 place-items-center rounded-full border border-border bg-card text-primary shadow-sm transition group-hover:bg-primary group-hover:text-primary-foreground">
              <ArrowRight className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-[16px] font-semibold text-foreground">Search more similar jobs</span>
              <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">Browse the full list with these filters</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

const SHELL = "rounded-[18px] border border-primary-border bg-primary-soft/50 p-4";
const FIELD =
  "h-11 w-full min-w-0 rounded-xl border border-border bg-card px-3.5 text-[15px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";
const GO =
  "inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40";

/** A question from the assistant: the answer goes back into the chat as your next message. */
export function AskView({ msg }: { msg: AskMessage }) {
  const [value, setValue] = useState("");
  const answer = (v: string) => {
    if (!v.trim()) return;
    window.dispatchEvent(
      new CustomEvent("agent-card-resolve", { detail: { id: msg.id, value: v } }),
    );
    fire(SEND_EVENT, msg.kind === "otp" ? v : v.trim());
  };

  if (msg.resolved)
    return (
      <div className="flex items-center gap-2 rounded-[14px] border border-border bg-card px-3.5 py-2.5 text-[13px] text-muted-foreground">
        <Check className="h-4 w-4 text-success" />
        <span className="min-w-0 truncate">{msg.prompt}</span>
        <span>·</span>
        <span className="text-foreground">
          {msg.kind === "otp" ? "•".repeat(msg.resolved.value.length) : msg.resolved.value}
        </span>
      </div>
    );

  const length = msg.length ?? 6;
  return (
    <div className={SHELL}>
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          {msg.kind === "otp" ? <KeyRound className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
        </span>
        <p className="pt-1 text-[14.5px] font-semibold leading-snug text-foreground">
          {msg.prompt}
        </p>
      </div>

      {msg.kind === "confirm" ? (
        <div className="flex gap-2">
          <button onClick={() => answer("Yes")} className={GO}>
            Yes
          </button>
          <button
            onClick={() => answer("No")}
            className="inline-flex h-11 items-center rounded-full border border-border bg-card px-5 text-[14px] font-medium text-ink-2 hover:border-faint"
          >
            No
          </button>
        </div>
      ) : msg.kind === "choice" ? (
        <div className="flex flex-wrap gap-2">
          {(msg.options ?? []).map((o) => (
            <button
              key={o}
              onClick={() => answer(o)}
              className="rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-medium text-foreground transition-all hover:border-primary hover:bg-primary hover:text-primary-foreground active:scale-95"
            >
              {o}
            </button>
          ))}
        </div>
      ) : msg.kind === "otp" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <InputOTP
            maxLength={length}
            value={value}
            onChange={(v) => setValue(v.replace(/\D/g, ""))}
            onComplete={answer}
            inputMode="numeric"
            autoComplete="one-time-code"
            containerClassName="justify-start"
          >
            <InputOTPGroup className="gap-1.5">
              {Array.from({ length }).map((_, i) => (
                <InputOTPSlot
                  key={i}
                  index={i}
                  className="h-12 w-10 rounded-xl border text-[20px] font-semibold first:rounded-xl last:rounded-xl sm:w-11"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <button disabled={value.length < length} onClick={() => answer(value)} className={GO}>
            Verify
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            autoFocus
            value={value}
            onChange={(e) =>
              setValue(
                msg.kind === "number" ? e.target.value.replace(/[^\d.,-]/g, "") : e.target.value,
              )
            }
            onKeyDown={(e) => e.key === "Enter" && answer(value)}
            inputMode={msg.kind === "number" ? "decimal" : undefined}
            placeholder={msg.kind === "number" ? "Enter a number" : "Your answer"}
            className={FIELD}
          />
          <button disabled={!value.trim()} onClick={() => answer(value)} className={GO}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}

const VIEW_ICON: Record<string, React.ReactNode> = {
  inbox: <Inbox className="h-4 w-4" />,
  tasks: <ListChecks className="h-4 w-4" />,
  jobs: <Search className="h-4 w-4" />,
  autoapply: <Wand2 className="h-4 w-4" />,
};

export function ActionsView({ msg }: { msg: ActionsMessage }) {
  return (
    <div className="flex flex-wrap gap-2">
      {msg.actions.map((a) => (
        <button
          key={a.view + a.label}
          onClick={() => fire(NAVIGATE_EVENT, a.view)}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-semibold text-foreground transition-all hover:border-primary hover:shadow-sm active:scale-95"
        >
          <span className="text-primary">{VIEW_ICON[a.view]}</span>
          {a.label}
        </button>
      ))}
    </div>
  );
}

/** Live: re-reads applications, so progress moves while you read. */
export function AppsStatusView({ msg }: { msg: AppsStatusMessage }) {
  const { data } = useApplications("all");
  const rows = (data?.applications ?? []).filter((a) => msg.ids.includes(a.id));
  if (!rows.length) return null;
  const pill = {
    needs: "bg-warning-soft text-warning-soft-foreground",
    working: "bg-primary-soft text-primary-soft-foreground",
    done: "bg-muted text-ink-2",
    failed: "bg-destructive/10 text-destructive",
    idle: "bg-muted text-muted-foreground",
  } as const;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-[18px] border border-border bg-card">
      {rows.map((a) => {
        const st = appStatus(a);
        return (
          <li key={a.id}>
            <button
              onClick={() => fire(NAVIGATE_EVENT, `tasks:${a.id}`)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-foreground">
                  {a.title}
                  {a.company && <span className="font-medium text-ink-2"> · {a.company}</span>}
                </div>
                <div className="truncate text-[12.5px] text-muted-foreground">{appSummary(a)}</div>
                {["queued", "running", "needs_input", "awaiting_review"].includes(a.status) && (
                  <ApplyBar app={a} />
                )}
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${pill[st]}`}
              >
                {TASK_STATUS_LABEL[st]}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
