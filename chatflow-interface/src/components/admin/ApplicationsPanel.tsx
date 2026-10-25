import { cn } from "@/lib/utils";
import { useState } from "react";
import { ExternalLink, MonitorPlay } from "lucide-react";
import { controlApi, type AppStatus } from "@/lib/admin-control-api";
import { Btn, Empty, Pill, Section, Stat, TextInput, act, ago, inputCls, statusTone, useLoad } from "./kit";
import { LiveRun } from "./LiveRun";

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "needs_input,awaiting_review", label: "Needs user" },
  { id: "queued,running", label: "In flight" },
  { id: "submitted,completed", label: "Done" },
  { id: "failed,cancelled", label: "Failed" },
];
const STATUSES: AppStatus[] = ["queued", "running", "needs_input", "awaiting_review", "submitted", "completed", "failed", "cancelled"];

/** Every user's applications: see the pipeline trace, watch a run live, help or correct it. */
export function ApplicationsPanel() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const list = useLoad(() => controlApi.applications({ status, q, limit: 100 }), [status, q]);
  const [open, setOpen] = useState<string | null>(null);
  const s = list.data?.last7Days ?? {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Submitted · 7d" value={(s.submitted ?? 0) + (s.completed ?? 0)} tone="text-emerald-400" />
        <Stat label="Needs user" value={(s.needs_input ?? 0) + (s.awaiting_review ?? 0)} tone="text-amber-400" />
        <Stat label="In flight" value={(s.queued ?? 0) + (s.running ?? 0)} tone="text-blue-400" />
        <Stat label="Failed" value={s.failed ?? 0} tone="text-red-400" />
        <Stat label="Cancelled" value={s.cancelled ?? 0} />
      </div>
      <SiteSuccess />
      <Section
        title="Applications"
        actions={
          <>
            <TextInput className="w-56" placeholder="Search title, company, URL" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className={cn(inputCls, "w-40")} value={status} onChange={(e) => setStatus(e.target.value)}>
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </>
        }
      >
        {list.loading && !list.data ? (
          <Empty>Loading…</Empty>
        ) : !list.data?.applications.length ? (
          <Empty>No applications match</Empty>
        ) : (
          <ul className="divide-y divide-border/20">
            {list.data.applications.map((a) => (
              <li key={a.id}>
                <button onClick={() => setOpen(open === a.id ? null : a.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-accent/20">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {a.title} {a.company && <span className="text-muted-foreground">· {a.company}</span>}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {a.user_email ?? a.user_id} · {a.status_detail ?? a.error ?? ""}
                    </div>
                  </div>
                  {a.reference && <span className="font-mono text-[11px] text-muted-foreground">{a.reference}</span>}
                  <Pill tone={statusTone(a.status)}>{a.status}</Pill>
                  <span className="w-16 text-right text-[11px] text-muted-foreground">{ago(a.updated_at)}</span>
                </button>
                {open === a.id && <ApplicationDetail id={a.id} onChanged={list.reload} />}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ApplicationDetail({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const { data, reload } = useLoad(() => controlApi.application(id), [id]);
  const [watch, setWatch] = useState(false);
  const [mark, setMark] = useState<AppStatus>("submitted");
  if (!data) return <div className="pb-3 text-xs text-muted-foreground">Loading…</div>;
  const active = ["queued", "running", "needs_input", "awaiting_review"].includes(data.status);
  return (
    <div className="mb-3 space-y-3 rounded-xl border border-border/40 bg-background/50 p-3">
      <ol className="space-y-1.5 border-l border-border/50 pl-3">
        {data.events.map((e, i) => (
          <li key={i} className="text-xs">
            <span className="font-medium text-foreground">{e.phase}</span>
            <span className="ml-2 text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span>
            {Object.keys(e.detail ?? {}).length > 0 && (
              <EventDetail detail={e.detail} />
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {data.url && (
          <a href={data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary">
            <ExternalLink className="h-3 w-3" /> Job posting
          </a>
        )}
        {data.exec_job_id && active && (
          <Btn onClick={() => setWatch((w) => !w)}>
            <MonitorPlay className="h-3 w-3" /> {watch ? "Hide live view" : "Watch live / help"}
          </Btn>
        )}
        {active && (
          <Btn tone="danger" onClick={() => act("Cancelled", async () => { await controlApi.cancelApplication(id); await reload(); await onChanged(); })}>
            Cancel
          </Btn>
        )}
        <span className="ml-auto flex items-center gap-1">
          <select className={cn(inputCls, "h-8 w-40 py-1 text-xs")} value={mark} onChange={(e) => setMark(e.target.value as AppStatus)}>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <Btn onClick={() => act("Status corrected", async () => { await controlApi.markApplication(id, mark, "Corrected by support"); await reload(); await onChanged(); })}>
            Set status
          </Btn>
        </span>
      </div>
      {watch && data.exec_job_id && <LiveRun jobId={data.exec_job_id} onDone={() => void reload()} />}
    </div>
  );
}

function EventDetail({ detail }: { detail: Record<string, unknown> }) {
  // "answers" is the per-field list on the answers stage, but a plain count elsewhere.
  const answers = Array.isArray(detail.answers) ? (detail.answers as Array<{ label: string; source: string; required: boolean }>) : undefined;
  const rest = Object.fromEntries(Object.entries(detail).filter(([k]) => !(k === "answers" && answers)));
  return (
    <div className="mt-0.5 text-[11px] text-muted-foreground">
      {Object.entries(rest).map(([k, v]) => (
        <span key={k} className="mr-3">
          {k}: <span className="text-foreground">{Array.isArray(v) ? v.join(", ") || "—" : String(v)}</span>
        </span>
      ))}
      {answers && (
        <div className="mt-1 flex flex-wrap gap-1">
          {answers.map((a, i) => (
            <span key={i} className="rounded bg-muted px-1.5 py-0.5">
              {a.label} <span className={a.source === "profile" ? "text-emerald-400" : a.source === "user" ? "text-blue-400" : "text-primary"}>{a.source}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per applicant-system success rate: where applications go through and why they don't. */
function SiteSuccess() {
  const [days, setDays] = useState(7);
  const { data, loading } = useLoad(() => controlApi.applicationsBySite(days), [days]);
  return (
    <Section
      title="Success by site"
      actions={
        <select className={cn(inputCls, "w-28")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>{d === 1 ? "24 hours" : `${d} days`}</option>
          ))}
        </select>
      }
    >
      {loading && !data ? (
        <Empty>Loading…</Empty>
      ) : !data?.sites.length ? (
        <Empty>No finished applications in this period</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Site</th>
                <th className="pr-3 font-medium">Success</th>
                <th className="pr-3 font-medium">Sent / tried</th>
                <th className="pr-3 font-medium">Typical time</th>
                <th className="font-medium">Most common problems</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {data.sites.map((s) => {
                const pct = Math.round((s.successRate ?? 0) * 100);
                return (
                  <tr key={s.site} className="align-top">
                    <td className="py-1.5 pr-3 font-medium text-foreground">{s.site}</td>
                    <td className="pr-3">
                      <Pill tone={s.attempts < 3 ? "gray" : pct >= 70 ? "green" : pct >= 40 ? "amber" : "red"}>{pct}%</Pill>
                    </td>
                    <td className="pr-3 tabular-nums text-muted-foreground">
                      {s.submitted} / {s.attempts}
                      {s.by_user > 0 && <span title="Finished by the user after the bot stopped"> · {s.by_user} by user</span>}
                    </td>
                    <td className="pr-3 tabular-nums text-muted-foreground">{s.median_seconds != null ? `${s.median_seconds}s` : "—"}</td>
                    <td className="text-muted-foreground">
                      {s.topErrors.length ? s.topErrors.map((e) => (
                        <div key={e.error} className="max-w-[420px] truncate" title={e.error}>{e.n}× {e.error}</div>
                      )) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
