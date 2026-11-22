import type { ApplicationOutcome, ApplicationSummary } from "@/lib/api-client";

// Where a sent application stands with the employer (read from their emails),
// and whether Auto Apply started it.

const OUTCOME: Record<ApplicationOutcome, { label: string; cls: string }> = {
  confirmed: { label: "Confirmed", cls: "bg-muted text-ink-2" },
  assessment: { label: "Assessment", cls: "bg-warning-soft text-warning-soft-foreground" },
  interview: { label: "Interview", cls: "bg-primary-soft text-primary-soft-foreground" },
  offer: { label: "Offer", cls: "bg-success text-success-foreground" },
  rejected: { label: "Not selected", cls: "bg-destructive/10 text-destructive" },
};

export function OutcomeBadge({ app }: { app: Pick<ApplicationSummary, "outcome" | "source"> }) {
  const o = app.outcome ? OUTCOME[app.outcome] : null;
  if (!o && app.source !== "auto") return null;
  return (
    <span className="inline-flex items-center gap-1">
      {o && <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${o.cls}`}>{o.label}</span>}
      {app.source === "auto" && (
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-faint" title="Started by Auto Apply">
          Auto
        </span>
      )}
    </span>
  );
}
