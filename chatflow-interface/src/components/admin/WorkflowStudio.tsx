import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Download, FileUp, Play, Plus, Save, Trash2, Undo2 } from "lucide-react";
import {
  controlApi,
  type PlanStep,
  type WorkflowDefinition,
  type WorkflowRow,
} from "@/lib/admin-control-api";
import { Btn, Empty, Field, JsonEditor, Pill, Section, Tabs, TextInput, act, ago, inputCls, statusTone, useLoad } from "./kit";
import { LiveRun } from "./LiveRun";

// Workflows are the background bots: each is an ordered action plan the
// executor runs in a real browser. Job-apply workflows (metadata.kind) are
// picked by the apply engine by URL pattern → applicant system → generic.

const ACTIONS = [
  "navigate", "click", "fill", "select", "check", "upload", "pressKey", "waitForSelector", "waitForTimeout",
  "scroll", "extractData", "assertText", "assertURL", "pauseForUserInput", "autofillForm", "reviewForm", "submitForm",
  "conditional", "customJS", "screenshot",
];

const JOB_TEMPLATE: WorkflowDefinition = {
  id: "job-apply-new-site",
  name: "New site — Apply",
  category: "jobs",
  portalType: "jobs",
  entryUrl: "https://careers.example.com/",
  pageUrlPatterns: ["careers\\.example\\.com"],
  requiredFiles: ["resume"],
  isActive: false,
  metadata: { kind: "job-apply", atsType: "custom-site" },
  starterActionPlan: [
    { id: "open", action: "navigate", value: "{{job:applyUrl}}", description: "Open the application form", timeout: 45000 },
    { id: "fill", action: "autofillForm", description: "Fill the form from the profile", retries: 0, metadata: { openApplyButton: true } },
    { id: "review", action: "reviewForm", description: "Wait for approval", retries: 0 },
    { id: "submit", action: "submitForm", description: "Submit", retries: 0, timeout: 45000 },
  ],
};

type Filter = "all" | "jobs" | "published" | "draft";
type Tab = "steps" | "settings" | "test" | "runs" | "history";

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function WorkflowStudio() {
  const list = useLoad(() => controlApi.workflows());
  const [filter, setFilter] = useState<Filter>("jobs");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState<unknown | null>(null);

  const rows = useMemo(() => {
    const all = list.data?.workflows ?? [];
    return all
      .filter((w) =>
        filter === "jobs" ? w.metadata?.kind === "job-apply" : filter === "all" ? true : w.status === filter,
      )
      .filter((w) => !q || `${w.name} ${w.workflow_key} ${w.entry_url}`.toLowerCase().includes(q.toLowerCase()));
  }, [list.data, filter, q]);
  const current = list.data?.workflows.find((w) => w.id === selected) ?? null;

  const runImport = async () => {
    const res = await controlApi.importWorkflow(importing as WorkflowDefinition);
    const bad = res.results.filter((r) => !r.ok);
    if (bad.length) throw new Error(bad.map((b) => `${b.id ?? "?"}: ${b.error}`).join("; "));
    setImporting(null);
    await list.reload();
    if (res.results[0]?.dbId) setSelected(res.results[0].dbId);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
      <Section
        title={`Workflows (${list.data?.total ?? 0})`}
        actions={
          <>
            <Btn onClick={() => setImporting(JOB_TEMPLATE)}>
              <Plus className="h-3 w-3" /> New
            </Btn>
            <Btn onClick={() => setImporting([])}>
              <FileUp className="h-3 w-3" /> Import
            </Btn>
          </>
        }
      >
        <div className="space-y-2">
          <TextInput placeholder="Search name, key, URL" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {(["jobs", "all", "published", "draft"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${filter === f ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                {f === "jobs" ? "Job apply" : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <ul className="max-h-[65vh] divide-y divide-border/20 overflow-y-auto">
            {list.loading && !rows.length ? (
              <Empty>Loading…</Empty>
            ) : !rows.length ? (
              <Empty>No workflows</Empty>
            ) : (
              rows.map((w) => (
                <li key={w.id}>
                  <button
                    onClick={() => {
                      setSelected(w.id);
                      setImporting(null);
                    }}
                    className={`w-full px-2 py-2.5 text-left transition hover:bg-accent/30 ${selected === w.id ? "bg-primary/10" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
                      <Pill tone={statusTone(w.status)}>{w.status}</Pill>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {w.workflow_key} · {w.starter_action_plan?.length ?? 0} steps · v{w.version}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </Section>

      {importing !== null ? (
        <Section
          title={Array.isArray(importing) && !importing.length ? "Import workflow JSON" : "New workflow"}
          actions={
            <>
              <Btn onClick={() => setImporting(null)}>Cancel</Btn>
              <Btn tone="primary" onClick={() => act("Workflow saved", runImport)}>
                <Save className="h-3 w-3" /> Save
              </Btn>
            </>
          }
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Same format as the files in <code>backend/workflows/</code>. Paste one definition or an array. Tokens:{" "}
            <code>{"{{job:applyUrl}}"}</code>, <code>{"{{profile:firstName}}"}</code>, <code>{"{{userFile:resume}}"}</code>,{" "}
            <code>{"{{userInput:stepId}}"}</code>.
          </p>
          <JsonEditor value={importing} onChange={setImporting} rows={24} />
        </Section>
      ) : current ? (
        <WorkflowEditor key={current.id + current.updated_at} wf={current} onChanged={list.reload} onDeleted={() => { setSelected(null); void list.reload(); }} onSelect={setSelected} />
      ) : (
        <Section>
          <Empty>Pick a workflow to edit, test or record a new one in the Recorder.</Empty>
        </Section>
      )}
    </div>
  );
}

function WorkflowEditor({
  wf,
  onChanged,
  onDeleted,
  onSelect,
}: {
  wf: WorkflowRow;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("steps");
  const [steps, setSteps] = useState<PlanStep[]>(wf.starter_action_plan ?? []);
  const [raw, setRaw] = useState(false);
  const [meta, setMeta] = useState({
    name: wf.name,
    trigger: wf.trigger,
    entryUrl: wf.entry_url ?? "",
    patterns: (wf.page_url_patterns ?? []).join("\n"),
    instructions: wf.instructions ?? "",
    kind: String(wf.metadata?.kind ?? ""),
    atsType: String(wf.metadata?.atsType ?? ""),
  });
  const [openStep, setOpenStep] = useState<number | null>(null);
  const dirty =
    JSON.stringify(steps) !== JSON.stringify(wf.starter_action_plan ?? []) ||
    meta.name !== wf.name ||
    meta.entryUrl !== (wf.entry_url ?? "") ||
    meta.patterns !== (wf.page_url_patterns ?? []).join("\n") ||
    meta.instructions !== (wf.instructions ?? "") ||
    meta.trigger !== wf.trigger ||
    meta.kind !== String(wf.metadata?.kind ?? "") ||
    meta.atsType !== String(wf.metadata?.atsType ?? "");

  const save = (extra: Record<string, unknown> = {}) =>
    act("Saved", async () => {
      await controlApi.updateWorkflow(wf.id, {
        name: meta.name,
        trigger: meta.trigger,
        entryUrl: meta.entryUrl || undefined,
        instructions: meta.instructions,
        pageUrlPatterns: meta.patterns.split(/\n|,/).map((s) => s.trim()).filter(Boolean),
        starterActionPlan: steps.map((s, i) => ({ ...s, order: i + 1 })),
        metadata: { kind: meta.kind || undefined, atsType: meta.atsType || undefined },
        ...extra,
      });
      await onChanged();
    });

  const move = (i: number, d: number) =>
    setSteps((s) => {
      const n = [...s];
      const j = i + d;
      if (j < 0 || j >= n.length) return s;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const published = wf.status === "published" && wf.is_active;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {wf.name} <Pill tone={statusTone(wf.status)}>{wf.status}</Pill>
          <span className="text-[11px] font-normal text-muted-foreground">v{wf.version} · updated {ago(wf.updated_at)}</span>
        </span>
      }
      actions={
        <>
          <Btn tone="primary" disabled={!dirty} onClick={() => save()}>
            <Save className="h-3 w-3" /> Save
          </Btn>
          <Btn onClick={() => save(published ? { status: "draft", isActive: false } : { status: "published", isActive: true })}>
            {published ? "Unpublish" : "Publish"}
          </Btn>
          <Btn
            onClick={() =>
              act("Duplicated", async () => {
                const r = await controlApi.duplicateWorkflow(wf.id);
                await onChanged();
                onSelect(r.id);
              })
            }
          >
            <Copy className="h-3 w-3" /> Duplicate
          </Btn>
          <Btn onClick={() => act("Exported", async () => download(`${wf.workflow_key ?? wf.id}.json`, await controlApi.exportWorkflow(wf.id)))}>
            <Download className="h-3 w-3" /> Export
          </Btn>
          <Btn
            tone="danger"
            onClick={async () => {
              if (await act("Deleted", () => controlApi.deleteWorkflow(wf.id))) onDeleted();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Btn>
        </>
      }
    >
      <div className="mb-4">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "steps", label: `Steps (${steps.length})` },
            { id: "settings", label: "Settings" },
            { id: "test", label: "Test run" },
            { id: "runs", label: "Runs" },
            { id: "history", label: "History" },
          ]}
        />
      </div>

      {tab === "steps" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Runs top to bottom. Click a step to edit it.</p>
            <Btn tone="ghost" onClick={() => setRaw((r) => !r)}>
              {raw ? "Step list" : "Raw JSON"}
            </Btn>
          </div>
          {raw ? (
            <JsonEditor value={steps} onChange={(v) => Array.isArray(v) && setSteps(v as PlanStep[])} rows={26} />
          ) : (
            <>
              <ol className="divide-y divide-border/20 rounded-xl border border-border/40">
                {steps.map((s, i) => (
                  <li key={`${s.id}-${i}`} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-5 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                      <Pill tone={["autofillForm", "reviewForm", "submitForm"].includes(s.action) ? "violet" : s.action === "pauseForUserInput" ? "amber" : "gray"}>
                        {s.action}
                      </Pill>
                      <button onClick={() => setOpenStep(openStep === i ? null : i)} className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
                        {s.description || s.target?.value || s.value || s.id}
                        {s.value && s.action !== "navigate" ? <span className="ml-2 font-mono text-[11px] text-muted-foreground">{s.value}</span> : null}
                      </button>
                      <Btn tone="ghost" onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-3 w-3" /></Btn>
                      <Btn tone="ghost" onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-3 w-3" /></Btn>
                      <Btn tone="ghost" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-3 w-3" /></Btn>
                    </div>
                    {openStep === i && (
                      <div className="mt-2 pl-7">
                        <JsonEditor value={s} onChange={(v) => setSteps((x) => x.map((y, j) => (j === i ? (v as PlanStep) : y)))} rows={10} />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              <div className="flex items-center gap-2">
                <select
                  className={cn(inputCls, "max-w-xs")}
                  defaultValue=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setSteps((x) => [...x, { id: `s${Date.now().toString(36)}`, action: e.target.value, description: "" }]);
                    setOpenStep(steps.length);
                    e.target.value = "";
                  }}
                >
                  <option value="">+ Add step…</option>
                  {ACTIONS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <TextInput value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          </Field>
          <Field label="Chat trigger" hint="Phrase that routes a chat request here (gov/other workflows).">
            <TextInput value={meta.trigger} onChange={(e) => setMeta({ ...meta, trigger: e.target.value })} />
          </Field>
          <Field label="Entry URL">
            <TextInput value={meta.entryUrl} onChange={(e) => setMeta({ ...meta, entryUrl: e.target.value })} />
          </Field>
          <Field label="Kind" hint='"job-apply" makes the apply engine consider it.'>
            <select className={inputCls} value={meta.kind} onChange={(e) => setMeta({ ...meta, kind: e.target.value })}>
              <option value="">general</option>
              <option value="job-apply">job-apply</option>
            </select>
          </Field>
          <Field label="URL patterns (regex, one per line)" hint="Jobs whose apply URL matches use this workflow first.">
            <textarea className={cn(inputCls, "font-mono text-xs")} rows={4} value={meta.patterns} onChange={(e) => setMeta({ ...meta, patterns: e.target.value })} />
          </Field>
          <Field label="Applicant system" hint="greenhouse, lever, ashby, workday, generic… (job-apply only)">
            <TextInput value={meta.atsType} onChange={(e) => setMeta({ ...meta, atsType: e.target.value })} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Instructions">
              <textarea className={inputCls} rows={3} value={meta.instructions} onChange={(e) => setMeta({ ...meta, instructions: e.target.value })} />
            </Field>
          </div>
        </div>
      )}

      {tab === "test" && <TestRunTab wf={wf} />}
      {tab === "runs" && <RunsTab id={wf.id} />}
      {tab === "history" && <HistoryTab id={wf.id} onRestored={onChanged} />}
    </Section>
  );
}

function TestRunTab({ wf }: { wf: WorkflowRow }) {
  const isJob = wf.metadata?.kind === "job-apply";
  const [url, setUrl] = useState(isJob ? "" : wf.entry_url ?? "");
  const [submit, setSubmit] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Runs this workflow in a worker browser as the <b>test profile</b> (Settings → Test profile), and shows it live.
        {isJob ? " It stops before the final submit unless you tick the box." : ""}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[260px] flex-1">
          <Field label={isJob ? "Job URL or job id" : "URL"}>
            <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://job-boards.greenhouse.io/…" />
          </Field>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-foreground">
          <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
          Really submit
        </label>
        <Btn
          tone="primary"
          busy={busy}
          disabled={!url}
          onClick={async () => {
            setBusy(true);
            const isId = /^[0-9a-f-]{36}$/i.test(url.trim());
            await act("Test run started", async () => {
              const r = await controlApi.testRun(wf.id, isId ? { jobId: url.trim(), submit } : { url: url.trim(), submit });
              setJobId(r.execJobId);
            });
            setBusy(false);
          }}
        >
          <Play className="h-3 w-3" /> Run
        </Btn>
      </div>
      {submit && <p className="text-xs text-amber-400">This will send a real application to that site.</p>}
      {jobId && <LiveRun jobId={jobId} />}
    </div>
  );
}

function RunsTab({ id }: { id: string }) {
  const { data, loading } = useLoad(() => controlApi.workflowRuns(id), [id]);
  if (loading && !data) return <Empty>Loading…</Empty>;
  const s = data?.stats;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Last 30 days: {s?.runs ?? 0} runs · {s?.runs ? Math.round(((s.ok ?? 0) / s.runs) * 100) : 0}% success · avg{" "}
        {s?.avg_ms ? `${(s.avg_ms / 1000).toFixed(1)}s` : "—"}
      </p>
      {!data?.runs.length ? (
        <Empty>No runs yet</Empty>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">When</th><th>User</th><th>Result</th><th>Time</th><th>Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {data.runs.map((r) => (
              <tr key={r.job_id}>
                <td className="py-1.5">{ago(r.created_at)}</td>
                <td className="font-mono">{r.user_id.slice(0, 10)}</td>
                <td><Pill tone={r.success ? "green" : "red"}>{r.success ? (r.verified === false ? "ran, unverified" : "ok") : "failed"}</Pill></td>
                <td>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                <td className="max-w-[280px] truncate text-red-400">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HistoryTab({ id, onRestored }: { id: string; onRestored: () => Promise<void> }) {
  const { data, loading, reload } = useLoad(() => controlApi.workflowHistory(id), [id]);
  if (loading && !data) return <Empty>Loading…</Empty>;
  if (!data?.history.length) return <Empty>No changes recorded yet</Empty>;
  return (
    <ul className="divide-y divide-border/20">
      {data.history.map((h) => (
        <li key={h.id} className="flex items-center gap-2 py-2 text-xs">
          <Pill tone="gray">{h.action}</Pill>
          <span className="text-foreground">{h.username ?? "system"}</span>
          <span className="text-muted-foreground">{ago(h.timestamp)}</span>
          {(h.action === "UPDATE" || h.action === "DELETE") && (
            <Btn
              tone="ghost"
              className="ml-auto"
              onClick={() =>
                act("Restored the version before this change", async () => {
                  await controlApi.restoreWorkflow(id, h.id);
                  await onRestored();
                  await reload();
                })
              }
            >
              <Undo2 className="h-3 w-3" /> Restore before
            </Btn>
          )}
        </li>
      ))}
    </ul>
  );
}
