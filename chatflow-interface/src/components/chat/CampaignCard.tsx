import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Target } from "lucide-react";
import { useCampaign, useCampaignActions } from "@/lib/live";

const TARGETS = [10, 25, 50, 100];

/** "Apply to N jobs": start it, watch the honest count, stop it. Only confirmed submissions count. */
export function CampaignCard({ minScore }: { minScore?: number }) {
  const q = useCampaign();
  const { start, stop } = useCampaignActions();
  const [target, setTarget] = useState(25);
  const active = q.data?.active ?? null;
  const last = !active ? q.data?.recent?.[0] ?? null : null;
  const shown = active ?? last;

  return (
    <div className="space-y-3 rounded-[18px] border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
          <Target className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-foreground">Apply to a set number of jobs</p>
          <p className="text-[12px] text-muted-foreground">
            I keep going until that many are confirmed by the company, or I run out of good matches and tell you how far I got.
          </p>
        </div>
      </div>

      {shown && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
            <span className="font-semibold tabular-nums text-foreground">
              {shown.progress.confirmed} of {shown.target} confirmed
            </span>
            <span className="text-faint">{active ? "Running" : shown.status === "completed" ? "Done" : shown.status === "exhausted" ? "Target not reached" : "Stopped"}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, Math.round((shown.progress.confirmed / shown.target) * 100))}%` }}
            />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">{shown.summary}</p>
        </div>
      )}

      {active ? (
        <button
          disabled={stop.isPending}
          onClick={() => stop.mutate(active.id, { onError: (e) => toast.error((e as Error).message) })}
          className="rounded-full border border-border px-4 py-2 text-[13px] font-semibold text-foreground disabled:opacity-50"
        >
          Stop campaign
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {TARGETS.map((n) => (
            <button
              key={n}
              onClick={() => setTarget(n)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
                target === n ? "border-foreground bg-foreground text-background" : "border-border bg-card text-ink-2"
              }`}
            >
              {n}
            </button>
          ))}
          <button
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { target, minScore },
                { onSuccess: () => toast.success(`Campaign started: ${target} applications`), onError: (e) => toast.error((e as Error).message) },
              )
            }
            className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Start
          </button>
        </div>
      )}
    </div>
  );
}
