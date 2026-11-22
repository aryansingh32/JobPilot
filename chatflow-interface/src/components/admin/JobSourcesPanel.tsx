import { cn } from "@/lib/utils";
import { Fragment, useState } from "react";
import { EyeOff, Eye, FlaskConical, Plus, RefreshCw, Trash2 } from "lucide-react";
import { controlApi, type SourceTestResult } from "@/lib/admin-control-api";
import { Btn, Empty, Field, JsonEditor, Pill, Section, Stat, Tabs, TextInput, act, ago, inputCls, statusTone, useLoad } from "./kit";

// Where jobs come from. Each "board" is one company on one applicant system,
// polled on a schedule. New systems = a code adapter; anything else with a
// JSON API can be added here as a Custom source with a field map — no deploy.

const CUSTOM_TEMPLATE = {
  url: "https://example.com/api/jobs?company={token}",
  itemsPath: "data.items",
  fields: {
    id: "id",
    title: "title",
    url: "applyUrl",
    location: "location.name",
    department: "team",
    postedAt: "createdAt",
    description: "descriptionHtml",
  },
};

export function JobSourcesPanel() {
  const [tab, setTab] = useState<"registry" | "boards" | "add" | "jobs">("registry");
  const stats = useLoad(() => controlApi.feedStats());
  const s = stats.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
        <Stat label="Boards" value={s?.boards.total ?? "—"} />
        <Stat label="Erroring" value={s?.boards.erroring ?? "—"} tone="text-red-400" />
        <Stat label="Feed stopped" value={s?.boards.stale ?? "—"} tone="text-amber-400" />
        <Stat label="Active jobs" value={s?.jobs.active?.toLocaleString() ?? "—"} tone="text-emerald-400" />
        <Stat label="New · 24h" value={s?.jobs.new_24h ?? "—"} />
        <Stat label="India / US" value={s ? `${s.jobs.active_india} / ${s.jobs.active_us}` : "—"} />
        <Stat label="Remote" value={s?.jobs.active_remote ?? "—"} />
      </div>
      {s?.bySystem.length ? (
        <div className="flex flex-wrap gap-2">
          {s.bySystem.map((b) => (
            <Pill key={b.ats_type} tone="violet">{b.ats_type}: {b.boards} boards · {b.jobs ?? 0} jobs</Pill>
          ))}
        </div>
      ) : null}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[{ id: "registry", label: "Registry" }, { id: "boards", label: "Boards" }, { id: "add", label: "Add source" }, { id: "jobs", label: "Jobs" }]}
      />
      {tab === "registry" && <RegistryTab />}
      {tab === "boards" && <BoardsTab onChanged={stats.reload} />}
      {tab === "add" && <AddSourceTab onAdded={() => { setTab("boards"); void stats.reload(); }} />}
      {tab === "jobs" && <JobsTab />}
    </div>
  );
}

/**
 * The registry at scale: every company board we know per system, whether it
 * has jobs (and how many in the focus countries), and the discovery runs
 * that find new ones. Discovery adds candidates; polling checks each once.
 */
function RegistryTab() {
  const reg = useLoad(() => controlApi.registry());
  const [busy, setBusy] = useState<string | null>(null);
  const r = reg.data;
  const systems = [...new Set((r?.bySystem ?? []).map((x) => x.ats_type))];
  const cell = (ats: string, status: string) => r?.bySystem.find((x) => x.ats_type === ats && x.status === status);
  const total = (status: string) => (r?.bySystem ?? []).filter((x) => x.status === status).reduce((n, x) => n + x.boards, 0);
  const focusJobs = (r?.bySystem ?? []).reduce((n, x) => n + (x.focus_jobs ?? 0), 0);
  const focusBoards = (r?.bySystem ?? []).reduce((n, x) => n + (x.focus_boards ?? 0), 0);
  const run = async (key: string, body: Parameters<typeof controlApi.discover>[0]) => {
    setBusy(key);
    await act("Discovery queued — it runs on a worker", () => controlApi.discover(body));
    setBusy(null);
    setTimeout(() => void reg.reload(), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Known boards" value={(r?.bySystem ?? []).reduce((n, x) => n + x.boards, 0).toLocaleString() || "—"} />
        <Stat label="Active" value={total("active").toLocaleString()} tone="text-emerald-400" />
        <Stat label="Waiting for first check" value={total("candidate").toLocaleString()} />
        <Stat label="Hiring in focus countries" value={focusBoards.toLocaleString()} tone="text-primary" />
        <Stat label="Focus-country jobs" value={focusJobs.toLocaleString()} tone="text-primary" />
        <Stat label="Polled · 24h" value={r ? r.polled_24h.toLocaleString() : "—"} />
      </div>

      <Section
        title="Find more companies"
        actions={<Btn onClick={() => void reg.reload()} busy={reg.loading}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Btn>}
      >
        <div className="flex flex-wrap gap-2">
          <Btn busy={busy === "cc-in"} onClick={() => run("cc-in", { source: "commoncrawl", systems: ["keka", "zoho", "freshteam", "oracle"] })}>
            Common Crawl · Indian systems
          </Btn>
          <Btn busy={busy === "cc-all"} onClick={() => run("cc-all", { source: "commoncrawl" })}>Common Crawl · all systems</Btn>
          <Btn busy={busy === "dataset"} onClick={() => run("dataset", { source: "dataset" })}>Open dataset (MIT)</Btn>
          <Btn busy={busy === "seed"} onClick={() => run("seed", { source: "seed" })}>Verified seeds</Btn>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          New boards are added as candidates and checked by polling (a share every minute, Indian systems first). Runs weekly on its own.
        </p>
      </Section>

      <Section title="Boards by system">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                {["System", "Active", "Candidates", "Empty", "Dead", "Jobs", "Focus jobs"].map((h) => (
                  <th key={h} className="px-2 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {systems.map((ats) => {
                const rows = (r?.bySystem ?? []).filter((x) => x.ats_type === ats);
                return (
                  <tr key={ats}>
                    <td className="px-2 py-2 font-medium text-foreground">{ats}</td>
                    {(["active", "candidate", "empty", "dead"] as const).map((st) => (
                      <td key={st} className="px-2 py-2 tabular-nums text-ink-2">{(cell(ats, st)?.boards ?? 0).toLocaleString()}</td>
                    ))}
                    <td className="px-2 py-2 tabular-nums">{rows.reduce((n, x) => n + (x.jobs ?? 0), 0).toLocaleString()}</td>
                    <td className="px-2 py-2 tabular-nums text-primary">{rows.reduce((n, x) => n + (x.focus_jobs ?? 0), 0).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Discovery runs">
        {!r?.runs.length ? (
          <Empty>No discovery runs yet</Empty>
        ) : (
          <div className="space-y-1">
            {r.runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/30 px-3 py-1.5 text-[11px]">
                <span className="flex items-center gap-2">
                  <Pill tone={statusTone(run.status === "done" ? "completed" : run.status)}>{run.status}</Pill>
                  <span className="text-foreground">{run.source}</span>
                  {run.error && <span className="truncate text-red-400">{run.error}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {run.found.toLocaleString()} seen · {run.added.toLocaleString()} new · {ago(run.started_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function BoardsTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const list = useLoad(() => controlApi.boards({ status: filter, q }), [filter, q]);
  const [editing, setEditing] = useState<string | null>(null);
  const [cfg, setCfg] = useState<unknown>(null);
  return (
    <Section
      title={`Boards (${list.data?.boards.length ?? 0})`}
      actions={
        <>
          <TextInput className="w-48" placeholder="Company or token" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={cn(inputCls, "w-32")} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="error">Erroring</option>
            <option value="stale">Feed stopped</option>
            <option value="disabled">Disabled</option>
          </select>
          <Btn onClick={() => act("Seeded starter boards", async () => { await controlApi.seedBoards(); await list.reload(); })}>Seed starter list</Btn>
        </>
      }
    >
      {!list.data?.boards.length ? (
        <Empty>{list.loading ? "Loading…" : "No boards"}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-1.5">Company</th><th>System</th><th>Token</th><th>Jobs</th><th>Last poll</th><th>Every</th><th>On</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {list.data.boards.map((b) => (
                <Fragment key={b.id}>
                  <tr>
                    <td className="py-2 font-medium text-foreground">{b.company ?? "—"} {b.country && <span className="text-muted-foreground">({b.country})</span>}</td>
                    <td><Pill tone="violet">{b.ats_type}</Pill></td>
                    <td className="font-mono">{b.board_token}</td>
                    <td className="tabular-nums">{b.job_count}</td>
                    <td>
                      <Pill tone={statusTone(b.last_status ?? "pending")}>{b.last_status ?? "never"}</Pill>{" "}
                      <span className="text-muted-foreground">{ago(b.last_polled_at)}</span>
                      {b.last_error && <div className="max-w-[240px] truncate text-red-400" title={b.last_error}>{b.last_error}</div>}
                    </td>
                    <td>
                      <select
                        className="rounded border border-border/50 bg-background px-1 py-0.5"
                        value={b.poll_interval_minutes}
                        onChange={(e) => act("Interval saved", async () => { await controlApi.updateBoard(b.id, { pollIntervalMinutes: Number(e.target.value) }); await list.reload(); })}
                      >
                        {[15, 30, 60, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m}m` : `${m / 60}h`}</option>)}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" checked={b.enabled} onChange={(e) => act(e.target.checked ? "Enabled" : "Disabled", async () => { await controlApi.updateBoard(b.id, { enabled: e.target.checked }); await list.reload(); })} />
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Btn tone="ghost" title="Poll now" onClick={() => act("Poll queued", async () => { await controlApi.pollBoard(b.id); setTimeout(() => { void list.reload(); void onChanged(); }, 4000); })}>
                        <RefreshCw className="h-3 w-3" />
                      </Btn>
                      {b.ats_type === "custom" && (
                        <Btn tone="ghost" onClick={() => { setEditing(editing === b.id ? null : b.id); setCfg(b.config); }}>Config</Btn>
                      )}
                      <Btn tone="ghost" title="Delete board and its jobs" onClick={() => act("Board deleted", async () => { await controlApi.deleteBoard(b.id); await list.reload(); await onChanged(); })}>
                        <Trash2 className="h-3 w-3" />
                      </Btn>
                    </td>
                  </tr>
                  {editing === b.id && (
                    <tr>
                      <td colSpan={8} className="pb-3">
                        <JsonEditor value={b.config} onChange={setCfg} rows={12} />
                        <Btn tone="primary" className="mt-2" onClick={() => act("Config saved", async () => { await controlApi.updateBoard(b.id, { config: cfg }); setEditing(null); await list.reload(); })}>Save config</Btn>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AddSourceTab({ onAdded }: { onAdded: () => void }) {
  const types = useLoad(() => controlApi.sourceTypes());
  const [atsType, setAtsType] = useState("greenhouse");
  const [token, setToken] = useState("");
  const [company, setCompany] = useState("");
  const [country, setCountry] = useState("");
  const [config, setConfig] = useState<unknown>(CUSTOM_TEMPLATE);
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const info = types.data?.types[atsType];
  const body = () => ({ atsType, token: token.trim(), ...(atsType === "custom" ? { config } : {}) });

  return (
    <Section title="Add a job source">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="System">
          <select className={inputCls} value={atsType} onChange={(e) => { setAtsType(e.target.value); setTest(null); }}>
            {Object.entries(types.data?.types ?? {}).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Board token" hint={info ? `${info.tokenHint} — e.g. ${info.example}` : undefined}>
          <TextInput value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Company name">
          <TextInput value={company} onChange={(e) => setCompany(e.target.value)} placeholder={test?.company ?? ""} />
        </Field>
        <Field label="Country (optional)" hint="Default for jobs with no location country">
          <TextInput value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="IN / US" />
        </Field>
      </div>
      {atsType === "custom" && (
        <div className="mt-3">
          <Field label="Endpoint + field map" hint="Dot paths into each item. {token} in the URL is replaced by the board token.">
            <JsonEditor value={config} onChange={setConfig} rows={14} />
          </Field>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Btn busy={busy} disabled={!token} onClick={async () => {
          setBusy(true);
          try { setTest(await controlApi.testSource(body())); } catch (e) { setTest({ ok: false, error: (e as Error).message, ms: 0 }); }
          setBusy(false);
        }}>
          <FlaskConical className="h-3 w-3" /> Test
        </Btn>
        <Btn tone="primary" disabled={!token || !(company || test?.company)} onClick={() =>
          act("Source added — first poll queued", async () => {
            await controlApi.addBoard({ ...body(), company: company || test?.company || token, country: country || undefined });
            onAdded();
          })
        }>
          <Plus className="h-3 w-3" /> Add & poll
        </Btn>
      </div>
      {test && (
        <div className={`mt-3 rounded-xl border p-3 text-xs ${test.ok ? "border-emerald-500/30" : "border-red-500/30"}`}>
          {test.ok ? (
            <>
              <p className="mb-2 text-foreground">
                <b>{test.count}</b> jobs{test.company ? ` from ${test.company}` : ""} in {test.ms} ms
              </p>
              <ul className="space-y-1">
                {test.sample?.map((j) => (
                  <li key={j.url} className="truncate">
                    <a href={j.url} target="_blank" rel="noreferrer" className="text-primary">{j.title}</a>
                    <span className="text-muted-foreground"> · {j.location ?? "—"} · {j.country ?? "?"} · {j.workplace ?? "?"}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-red-400">{test.error}</p>
          )}
        </div>
      )}
    </Section>
  );
}

function JobsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const list = useLoad(() => controlApi.feedJobs({ q, status, limit: 100 }), [q, status]);
  return (
    <Section
      title="Jobs in the feed"
      actions={
        <>
          <TextInput className="w-56" placeholder="Title or company" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={cn(inputCls, "w-28")} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option><option value="hidden">Hidden</option><option value="closed">Closed</option>
          </select>
        </>
      }
    >
      {!list.data?.jobs.length ? (
        <Empty>{list.loading ? "Loading…" : "No jobs"}</Empty>
      ) : (
        <ul className="divide-y divide-border/20">
          {list.data.jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <a href={j.url} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-foreground hover:text-primary">{j.title}</a>
                <div className="truncate text-muted-foreground">{j.company} · {j.location ?? "—"} · {j.country ?? "?"} · {j.workplace ?? "?"} · {ago(j.posted_at)}</div>
              </div>
              <Pill tone="violet">{j.ats_type}</Pill>
              {j.status === "hidden" ? (
                <Btn tone="ghost" onClick={() => act("Unhidden", async () => { await controlApi.unhideJob(j.id); await list.reload(); })}><Eye className="h-3 w-3" /></Btn>
              ) : (
                <Btn tone="ghost" title="Hide from every user's feed" onClick={() => act("Hidden", async () => { await controlApi.hideJob(j.id); await list.reload(); })}><EyeOff className="h-3 w-3" /></Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
