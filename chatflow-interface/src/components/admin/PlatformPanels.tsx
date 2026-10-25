import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { History, RotateCcw, Save, Trash2, Upload, UserPlus } from "lucide-react";
import { controlApi, type SettingRow } from "@/lib/admin-control-api";
import { Btn, Empty, JsonEditor, Pill, Section, Stat, TextInput, act, ago, inputCls, statusTone, useLoad } from "./kit";

// ── Settings: every runtime knob, applied live to all services ──────────
export function SettingsPanel() {
  const { data, reload } = useLoad(() => controlApi.settings());
  const groups = useMemo(() => {
    const g = new Map<string, SettingRow[]>();
    for (const s of data?.settings ?? []) g.set(s.group, [...(g.get(s.group) ?? []), s]);
    return [...g.entries()];
  }, [data]);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Changes apply to every API, worker and scheduler within seconds — no redeploy. Every change is recorded.
      </p>
      {groups.map(([group, rows]) => (
        <Section key={group} title={group}>
          <ul className="divide-y divide-border/20">
            {rows.map((s) => <SettingRowEditor key={s.key} s={s} onSaved={reload} />)}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function SettingRowEditor({ s, onSaved }: { s: SettingRow; onSaved: () => Promise<void> }) {
  const [v, setV] = useState<unknown>(s.value);
  const [hist, setHist] = useState<Array<{ old_value: unknown; new_value: unknown; changed_at: string; changed_by: string | null }> | null>(null);
  const dirty = JSON.stringify(v) !== JSON.stringify(s.value);
  const save = (value: unknown) => act(`${s.key} saved`, async () => { await controlApi.setSetting(s.key, value); await onSaved(); });
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1">
          <div className="flex items-center gap-2">
            <code className="text-xs font-semibold text-foreground">{s.key}</code>
            {s.overridden && <Pill tone="violet">changed</Pill>}
          </div>
          <p className="text-xs text-muted-foreground">{s.description}</p>
          {s.updatedAt && <p className="text-[11px] text-muted-foreground">Last changed {ago(s.updatedAt)}</p>}
        </div>
        <div className="flex items-center gap-2">
          {s.kind === "boolean" ? (
            <button
              onClick={() => save(!s.value)}
              className={`relative h-5 w-9 rounded-full transition ${s.value ? "bg-primary" : "bg-muted"}`}
              aria-label={`Toggle ${s.key}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition ${s.value ? "left-[18px]" : "left-0.5"}`} />
            </button>
          ) : s.kind === "number" ? (
            <TextInput type="number" className="w-36" value={String(v ?? "")} min={s.min} max={s.max} onChange={(e) => setV(e.target.value === "" ? "" : Number(e.target.value))} />
          ) : s.kind === "string" ? (
            s.options ? (
              <select className={cn(inputCls, "w-64")} value={String(v)} onChange={(e) => setV(e.target.value)}>
                {s.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <TextInput className="w-72" value={String(v ?? "")} onChange={(e) => setV(e.target.value)} />
            )
          ) : null}
          {s.kind !== "boolean" && s.kind !== "json" && (
            <Btn tone="primary" disabled={!dirty} onClick={() => save(v)}><Save className="h-3 w-3" /></Btn>
          )}
          {s.overridden && (
            <Btn tone="ghost" title="Back to default" onClick={() => act("Reset to default", async () => { await controlApi.resetSetting(s.key); await onSaved(); })}>
              <RotateCcw className="h-3 w-3" />
            </Btn>
          )}
          <Btn tone="ghost" title="History" onClick={async () => setHist(hist ? null : (await controlApi.settingHistory(s.key)).history)}>
            <History className="h-3 w-3" />
          </Btn>
        </div>
      </div>
      {s.kind === "json" && (
        <div className="mt-2 space-y-2">
          <JsonEditor value={s.value} onChange={setV} rows={6} />
          <Btn tone="primary" disabled={!dirty} onClick={() => save(v)}><Save className="h-3 w-3" /> Save</Btn>
        </div>
      )}
      {hist && (
        <ul className="mt-2 space-y-1 rounded-lg bg-muted/40 p-2 text-[11px]">
          {!hist.length && <li className="text-muted-foreground">No changes yet</li>}
          {hist.map((h, i) => (
            <li key={i} className="font-mono">
              {new Date(h.changed_at).toLocaleString()} · {h.changed_by ?? "?"}: {JSON.stringify(h.old_value)} → {JSON.stringify(h.new_value)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ── Team + audit ─────────────────────────────────────────────
const ROLES = ["viewer", "support", "editor", "super-admin"];
const ROLE_HINT: Record<string, string> = {
  viewer: "read everything",
  support: "+ cancel/retry/correct a user's applications",
  editor: "+ workflows, sources, recorder",
  "super-admin": "+ settings, admins, workers, deletes",
};

export function TeamPanel() {
  const admins = useLoad(() => controlApi.admins());
  const [path, setPath] = useState("");
  const audit = useLoad(() => controlApi.audit({ path }), [path]);
  const [form, setForm] = useState({ username: "", password: "", role: "support" });
  return (
    <div className="space-y-4">
      <Section title="Admins">
        <ul className="divide-y divide-border/20">
          {admins.data?.admins.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-medium text-foreground">{a.username}</span>
              <span className="text-[11px] text-muted-foreground">since {new Date(a.created_at).toLocaleDateString()}</span>
              <select
                className={cn(inputCls, "ml-auto w-40 py-1 text-xs")}
                value={a.role}
                onChange={(e) => act("Role updated", async () => { await controlApi.updateAdmin(a.id, { role: e.target.value }); await admins.reload(); })}
              >
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
              <Btn tone="ghost" onClick={() => act("Admin removed", async () => { await controlApi.deleteAdmin(a.id); await admins.reload(); })}>
                <Trash2 className="h-3 w-3" />
              </Btn>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid gap-2 border-t border-border/30 pt-4 md:grid-cols-[1fr_1fr_1fr_auto]">
          <TextInput placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <TextInput placeholder="Password (10+ chars)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{r} — {ROLE_HINT[r]}</option>)}
          </select>
          <Btn tone="primary" onClick={() => act("Admin added", async () => { await controlApi.createAdmin(form); setForm({ username: "", password: "", role: "support" }); await admins.reload(); })}>
            <UserPlus className="h-3 w-3" /> Add
          </Btn>
        </div>
      </Section>
      <Section title="Audit log — every admin write" actions={<TextInput className="w-56" placeholder="Filter by path" value={path} onChange={(e) => setPath(e.target.value)} />}>
        {!audit.data?.entries.length ? (
          <Empty>{audit.loading ? "Loading…" : "Nothing yet"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1">When</th><th>Who</th><th>Action</th><th>Result</th><th>IP</th></tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {audit.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="py-1.5">{new Date(e.at).toLocaleString()}</td>
                    <td>{e.username ?? "key"} <span className="text-muted-foreground">({e.role})</span></td>
                    <td className="font-mono"><span className="text-primary">{e.method}</span> {e.path}</td>
                    <td><Pill tone={e.status < 400 ? "green" : "red"}>{e.status}</Pill></td>
                    <td className="text-muted-foreground">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── AI usage ─────────────────────────────────────────────────
export function AiUsagePanel() {
  const [days, setDays] = useState(7);
  const usage = useLoad(() => controlApi.aiUsage(days), [days]);
  const status = useLoad(() => controlApi.aiStatus());
  const t = usage.data?.totals;
  const st = status.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {st && (
          <>
            <Pill tone={st.killswitch ? "red" : "green"}>{st.killswitch ? "AI killswitch ON" : "AI enabled"}</Pill>
            <Pill tone="gray">today ${st.todaySpendUsd.toFixed(3)} of ${st.globalDailyBudgetUsd}</Pill>
            <Pill tone="gray">per user {st.userDailyTokenBudget.toLocaleString()} tokens/day</Pill>
          </>
        )}
        <select className={cn(inputCls, "ml-auto w-32")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d}d</option>)}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">Models, budgets and the killswitch are under Settings → AI. Job applications use no AI at all.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Calls" value={t?.calls ?? "—"} />
        <Stat label="Tokens" value={t ? (Number(t.prompt_tokens) + Number(t.completion_tokens)).toLocaleString() : "—"} />
        <Stat label="Cost" value={t ? `$${t.cost_usd.toFixed(3)}` : "—"} />
        <Stat label="Errors" value={t?.errors ?? "—"} tone="text-red-400" />
        <Stat label="Avg latency" value={t ? `${t.avg_latency_ms} ms` : "—"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="By purpose">
          <SimpleTable rows={usage.data?.byPurpose ?? []} cols={["purpose", "calls", "tokens", "cost_usd", "errors"]} />
        </Section>
        <Section title="By model">
          <SimpleTable rows={usage.data?.byModel ?? []} cols={["model", "calls", "tokens", "cost_usd"]} />
        </Section>
        <Section title="Top users">
          <SimpleTable rows={usage.data?.topUsers ?? []} cols={["user_id", "calls", "tokens", "cost_usd"]} />
        </Section>
        <Section title="By day">
          <SimpleTable rows={(usage.data?.byDay ?? []).map((d) => ({ ...d, day: new Date(d.day).toLocaleDateString() }))} cols={["day", "calls", "tokens", "cost_usd"]} />
        </Section>
      </div>
    </div>
  );
}

function SimpleTable({ rows, cols }: { rows: Array<Record<string, unknown>>; cols: string[] }) {
  if (!rows.length) return <Empty>No data</Empty>;
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground"><tr>{cols.map((c) => <th key={c} className="py-1">{c.replace(/_/g, " ")}</th>)}</tr></thead>
      <tbody className="divide-y divide-border/20">
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => (
              <td key={c} className="max-w-[220px] truncate py-1.5 tabular-nums">
                {typeof r[c] === "number" && c === "cost_usd" ? `$${(r[c] as number).toFixed(4)}` : String(r[c] ?? "—")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Inbox + resume parsing ────────────────────────────────────
export function InboxPanel() {
  const [unmatched, setUnmatched] = useState(false);
  const emails = useLoad(() => controlApi.emails({ unmatched }), [unmatched]);
  const parses = useLoad(() => controlApi.resumeParses());
  const [matchId, setMatchId] = useState<Record<string, string>>({});
  return (
    <div className="space-y-4">
      <Section
        title="Inbound application email"
        actions={
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} /> Unmatched only
          </label>
        }
      >
        {!emails.data?.emails.length ? (
          <Empty>{emails.loading ? "Loading…" : "No email yet"}</Empty>
        ) : (
          <ul className="divide-y divide-border/20">
            {emails.data.emails.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <Pill tone={e.category === "code" ? "amber" : e.category === "confirmation" ? "green" : e.category === "reply" ? "blue" : "gray"}>{e.category}</Pill>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{e.subject || "(no subject)"}</div>
                  <div className="truncate text-muted-foreground">{e.from_name ?? e.from_address} → {e.to_address} · {ago(e.received_at)}</div>
                </div>
                {e.application_id ? (
                  <Pill tone="green">matched · {e.match_method}</Pill>
                ) : (
                  <span className="flex items-center gap-1">
                    <TextInput className="h-7 w-56 py-1 text-xs" placeholder="Application id" value={matchId[e.id] ?? ""} onChange={(ev) => setMatchId({ ...matchId, [e.id]: ev.target.value })} />
                    <Btn onClick={() => act("Matched", async () => { await controlApi.matchEmail(e.id, matchId[e.id]); await emails.reload(); })} disabled={!matchId[e.id]}>Match</Btn>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Résumé parsing">
        {!parses.data?.parses.length ? (
          <Empty>{parses.loading ? "Loading…" : "No résumés parsed yet"}</Empty>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">When</th><th>User</th><th>Status</th><th>Chars</th><th>Model</th><th>Error</th></tr></thead>
            <tbody className="divide-y divide-border/20">
              {parses.data.parses.map((p) => (
                <tr key={p.id}>
                  <td className="py-1.5">{ago(p.created_at)}</td>
                  <td className="font-mono">{p.user_id.slice(0, 12)}</td>
                  <td><Pill tone={statusTone(p.status === "done" ? "ok" : p.status)}>{p.status}</Pill></td>
                  <td>{p.text_chars ?? "—"}</td>
                  <td className="max-w-[180px] truncate">{p.model ?? "rules only"}</td>
                  <td className="max-w-[240px] truncate text-red-400">{p.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

// ── Test profile (used by test runs + recordings) ─────────────
export function TestProfilePanel() {
  const { data, reload } = useLoad(() => controlApi.testProfile());
  const [profile, setProfile] = useState<unknown>(null);
  return (
    <Section
      title="Test profile"
      actions={
        <>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-foreground hover:bg-accent/50">
            <Upload className="h-3 w-3" /> {data?.resume ? `Résumé: ${data.resume.name}` : "Upload résumé"}
            <input
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = () =>
                  void act("Résumé uploaded", async () => {
                    await controlApi.saveTestProfile({ resume: { name: f.name, base64: String(r.result).split(",")[1] } });
                    await reload();
                  });
                r.readAsDataURL(f);
              }}
            />
          </label>
          <Btn tone="primary" disabled={!profile} onClick={() => act("Test profile saved", async () => { await controlApi.saveTestProfile({ profile }); setProfile(null); await reload(); })}>
            <Save className="h-3 w-3" /> Save
          </Btn>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        The applicant every test run and recording uses (user <code>{data?.userId}</code>) — never a real user's data.
        Fill forms with these values while recording and they're saved as <code>{"{{profile:…}}"}</code> fields.
      </p>
      {data ? <JsonEditor value={data.profile} onChange={setProfile} rows={24} /> : <Empty>Loading…</Empty>}
    </Section>
  );
}
