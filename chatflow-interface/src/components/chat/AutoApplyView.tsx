import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CircleAlert, Loader2, Play, X, Zap } from "lucide-react";
import { useAutoApply, useAutoApplyActions, useAutoApplyPreview, useAutoApplyRuns } from "@/lib/live";
import type { AutoApplyRunDTO } from "@/lib/api-client";
import { PortalPasswordCard } from "./PortalPasswordCard";

const CAPS = [5, 10, 15, 25];
const SCORES = [60, 70, 75, 80, 90];

function ago(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function runLine(r: AutoApplyRunDTO): string {
  if (r.status === "running") return "Running…";
  if (r.status === "failed") return "Didn't finish — it will try again next time";
  if (r.started) return `Started ${r.started} application${r.started === 1 ? "" : "s"}`;
  return r.note ?? "Nothing new to apply to";
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "border-foreground bg-foreground text-background" : "border-border bg-card text-ink-2 hover:border-faint"
      }`}
    >
      {children}
    </button>
  );
}

export function AutoApplyView({
  credits,
  onOpenApplications,
  onBuyCredits,
}: {
  credits?: number | null;
  onOpenApplications: () => void;
  onBuyCredits?: () => void;
}) {
  const settingsQ = useAutoApply();
  const previewQ = useAutoApplyPreview();
  const runsQ = useAutoApplyRuns();
  const { save, run } = useAutoApplyActions();
  const s = settingsQ.data?.settings;
  const [company, setCompany] = useState("");
  const [optimisticOn, setOptimisticOn] = useState<boolean | null>(null);
  useEffect(() => setOptimisticOn(null), [s?.enabled]);
  const on = optimisticOn ?? s?.enabled ?? false;

  const update = (patch: Parameters<typeof save.mutate>[0]) =>
    save.mutate(patch, { onError: (e) => toast.error((e as Error).message) });

  const preview = previewQ.data;
  const runs = runsQ.data?.runs ?? [];

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-8 pt-2 sm:px-4">
      <div className="mx-auto w-full max-w-(--chat-w) space-y-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Auto Apply</h1>
          <p className="text-[13px] text-muted-foreground">
            I apply to your best new matches on my own, up to your daily limit. Your review setting still applies — if you
            review before submitting, they wait for you in Applications.
          </p>
        </div>

        {/* On / off */}
        <div className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-4">
          <span
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${on ? "bg-primary text-primary-foreground" : "bg-muted text-ink-2"}`}
          >
            <Zap className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-foreground">{on ? "Auto Apply is on" : "Auto Apply is off"}</p>
            <p className="truncate text-[12px] text-muted-foreground">
              {settingsQ.data?.lastRun
                ? `${runLine(settingsQ.data.lastRun)} · ${ago(settingsQ.data.lastRun.started_at)}`
                : on
                  ? "First run within the hour"
                  : "Turn it on and I'll start with your top matches"}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={on}
            aria-label="Auto Apply"
            disabled={!s || save.isPending}
            onClick={() => {
              setOptimisticOn(!on);
              update({ enabled: !on });
            }}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-primary" : "bg-muted ring-1 ring-inset ring-border"}`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-background shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        {/* Limits */}
        <div className="space-y-4 rounded-[18px] border border-border bg-card p-4">
          <div>
            <p className="mb-2 text-[13px] font-semibold text-foreground">Applications per day</p>
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
              {CAPS.map((c) => (
                <Chip key={c} active={s?.dailyCap === c} onClick={() => update({ dailyCap: c })}>
                  {c}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold text-foreground">Only jobs that match at least</p>
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
              {SCORES.map((v) => (
                <Chip key={v} active={s?.minScore === v} onClick={() => update({ minScore: v })}>
                  {v}%
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold text-foreground">Never apply to</p>
            <div className="flex flex-wrap gap-1.5">
              {s?.excludeCompanies.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-[12px] text-foreground">
                  {c}
                  <button
                    aria-label={`Allow ${c} again`}
                    onClick={() => update({ excludeCompanies: s.excludeCompanies.filter((x) => x !== c) })}
                  >
                    <X className="h-3 w-3 text-faint" />
                  </button>
                </span>
              ))}
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && company.trim() && s) {
                    update({ excludeCompanies: [...s.excludeCompanies, company.trim()] });
                    setCompany("");
                  }
                }}
                placeholder="Company name, then Enter"
                className="min-w-[180px] flex-1 rounded-full border border-border bg-background px-3 py-1 text-[12px] text-foreground outline-none focus:border-primary"
              />
            </div>
          </div>
          {credits !== undefined && credits !== null && (
            <p className="text-[12px] text-muted-foreground">
              {credits} credits left · one per application, given back if nothing is sent
              {onBuyCredits && (
                <>
                  {" · "}
                  <button onClick={onBuyCredits} className="font-medium text-foreground underline underline-offset-2">
                    Buy more
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        <PortalPasswordCard />

        {/* What it would do now */}
        <div className="rounded-[18px] border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-foreground">
                {preview ? `${preview.total} matching job${preview.total === 1 ? "" : "s"} right now` : "Checking your matches…"}
              </p>
              {preview && !preview.blockers.length && (
                <p className="text-[12px] text-muted-foreground">
                  The next run would start {preview.capacity.now} — {preview.capacity.leftToday} left today
                </p>
              )}
            </div>
            <button
              disabled={!preview || preview.blockers.length > 0 || run.isPending}
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (r) => {
                    toast.success(r.started ? runLine(r) : r.note ?? "Nothing new to apply to");
                    if (r.started) onOpenApplications();
                  },
                  onError: (e) => toast.error((e as Error).message),
                })
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run now
            </button>
          </div>
          {preview?.blockers.map((b) => (
            <p key={b} className="mb-2 flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[12px] text-warning-soft-foreground">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}
            </p>
          ))}
          {preview?.guards && (preview.guards.companyCooldown > 0 || preview.guards.repeatedFailures > 0 || preview.guards.unhealthySystem.length > 0) && (
            <p className="mb-2 text-[12px] text-muted-foreground">
              Held back to protect you:
              {preview.guards.companyCooldown > 0 && ` ${preview.guards.companyCooldown} at companies you applied to recently;`}
              {preview.guards.repeatedFailures > 0 && ` ${preview.guards.repeatedFailures} that failed twice;`}
              {preview.guards.unhealthySystem.length > 0 && ` ${preview.guards.unhealthySystem.join(", ")} portals are failing for everyone right now (paused).`}
            </p>
          )}
          <div className="divide-y divide-border">
            {preview?.candidates.slice(0, 6).map((c) => (
              <div key={c.jobId} className="flex items-center gap-3 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-[12px] font-semibold text-ink-2">
                  {c.company.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{c.title}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{c.company}</p>
                </div>
                <span className="shrink-0 text-[12px] font-semibold tabular-nums text-success">{c.score}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* History */}
        {runs.length > 0 && (
          <div className="rounded-[18px] border border-border bg-card p-4">
            <p className="mb-2 text-[13px] font-semibold text-foreground">Recent runs</p>
            <div className="divide-y divide-border">
              {runs.slice(0, 8).map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-[12px]">
                  <span className="truncate text-foreground">{runLine(r)}</span>
                  <span className="shrink-0 text-faint">
                    {r.trigger === "schedule" ? "Scheduled" : r.trigger === "manual" ? "You" : "Support"} · {ago(r.started_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
