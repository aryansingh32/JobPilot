import { Check, Loader2, X } from "lucide-react";
import type { ApplicationDetail } from "@/lib/api-client";
import { APPLY_STAGES, applyProgress } from "@/lib/apply-progress";

/**
 * Where an application is, as a trail of stages with the current one pulsing,
 * and one plain line saying what's happening right now.
 */
export function ApplyTracker({
  app,
  events,
}: {
  app: Pick<ApplicationDetail, "status" | "status_detail" | "error">;
  events?: ApplicationDetail["events"];
}) {
  const p = applyProgress(app, events);
  const live = p.state === "working";
  return (
    <div
      className="mb-4 rounded-2xl border border-border bg-card p-4"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {live && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {p.state === "done" && <Check className="h-4 w-4 text-success" />}
        {p.state === "failed" && <X className="h-4 w-4 text-destructive" />}
        <span className={p.state === "failed" ? "text-destructive" : undefined}>{p.now}</span>
      </div>

      <ol className="mt-3 flex items-start">
        {APPLY_STAGES.map((s, i) => {
          const done = p.state === "done" || i < p.current;
          const active = i === p.current && p.state !== "done";
          const failed = active && p.state === "failed";
          return (
            <li
              key={s.id}
              className="relative flex min-w-0 flex-1 flex-col items-center text-center"
            >
              {i > 0 && (
                <span
                  aria-hidden
                  className={`absolute right-1/2 top-[9px] h-0.5 w-full transition-colors duration-500 ${
                    done || active ? "bg-primary" : "bg-border"
                  }`}
                />
              )}
              <span
                className={`relative z-10 grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] transition-all duration-500 ${
                  failed
                    ? "bg-destructive text-white"
                    : done
                      ? "bg-primary text-primary-foreground"
                      : active
                        ? `border-2 border-primary bg-card ${live ? "animate-pulse" : ""}`
                        : "border border-border bg-card"
                }`}
              >
                {done ? (
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                ) : failed ? (
                  <X className="h-2.5 w-2.5" strokeWidth={3.5} />
                ) : null}
              </span>
              <span
                className={`mt-1.5 hidden px-0.5 text-[10.5px] leading-tight sm:block ${
                  active ? "font-semibold text-foreground" : done ? "text-ink-2" : "text-faint"
                }`}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Phones have no room for six labels: just the current one. */}
      <p className="mt-2 text-center text-[11px] font-medium text-muted-foreground sm:hidden">
        Step {Math.min(p.current + 1, APPLY_STAGES.length)} of {APPLY_STAGES.length} ·{" "}
        {APPLY_STAGES[p.current].label}
      </p>
    </div>
  );
}

/** A slim bar for list rows and cards: indeterminate shimmer while it works. */
export function ApplyBar({
  app,
}: {
  app: Pick<ApplicationDetail, "status" | "status_detail" | "error">;
}) {
  const p = applyProgress(app);
  if (p.state === "done" || p.state === "cancelled") return null;
  return (
    <div className="mt-2" aria-hidden>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${p.state === "failed" ? "bg-destructive" : p.state === "needs" ? "bg-warning" : "bg-primary"} ${
            p.state === "working" ? "animate-pulse" : ""
          } transition-[width] duration-700`}
          style={{ width: `${Math.max(8, Math.round(p.fraction * 100))}%` }}
        />
      </div>
    </div>
  );
}
