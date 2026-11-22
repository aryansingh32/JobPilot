import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { controlApi, type AnswerDefaultsDTO, type CustomRuleDTO } from "@/lib/admin-control-api";
import { Btn, Field, Pill, Section, TextInput, act, useLoad } from "./kit";

// ── Default answers: what is answered without asking anyone ────────────
// Built-in rules can be switched off or reworded; custom rules add more. A custom rule can never answer a sensitive
// question (work authorisation, salary, diversity…) — those only ever come from the person.

const EMPTY: AnswerDefaultsDTO = { disabled: [], overrides: {}, custom: [] };

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-primary" : "bg-muted"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function AnswerDefaultsPanel() {
  const { data, reload } = useLoad(() => controlApi.answerDefaults());
  const [cfg, setCfg] = useState<AnswerDefaultsDTO>(EMPTY);
  const [saved, setSaved] = useState<string>("");
  useEffect(() => {
    if (!data) return;
    setCfg(data.config);
    setSaved(JSON.stringify(data.config));
  }, [data]);
  const dirty = JSON.stringify(cfg) !== saved;

  const setOn = (id: string, on: boolean) =>
    setCfg((c) => ({ ...c, disabled: on ? c.disabled.filter((x) => x !== id) : [...new Set([...c.disabled, id])] }));
  const setOver = (id: string, v: string) =>
    setCfg((c) => {
      const overrides = { ...c.overrides };
      if (v.trim()) overrides[id] = v;
      else delete overrides[id];
      return { ...c, overrides };
    });
  const setRule = (i: number, patch: Partial<CustomRuleDTO>) =>
    setCfg((c) => ({ ...c, custom: c.custom.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRule = () =>
    setCfg((c) => ({ ...c, custom: [...c.custom, { id: `custom-${Date.now().toString(36)}`, enabled: true, match: "", answer: "" }] }));

  const save = () =>
    act("Default answers saved — live on every worker", async () => {
      await controlApi.saveAnswerDefaults(cfg);
      await reload();
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        These are answered for every applicant without asking. Changes apply to all workers within seconds and are recorded in
        the settings history (<code>answers.defaults</code>). Anything a person's own profile, notes or earlier replies can
        answer is used first; sensitive questions are never answered from here.
      </p>

      <Section
        title="Built-in rules"
        actions={<Btn tone="primary" disabled={!dirty} onClick={save}><Save className="h-3 w-3" /> Save changes</Btn>}
      >
        <ul className="divide-y divide-border/20">
          {data?.builtin.map((r) => {
            const on = !cfg.disabled.includes(r.id);
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
                <Toggle on={on} onChange={(v) => setOn(r.id, v)} label={`Use ${r.title}`} />
                <div className="min-w-[240px] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{r.title}</span>
                    {!on && <Pill tone="amber">off — asked instead</Pill>}
                  </div>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                </div>
                <div className="w-64">
                  {r.overridable ? (
                    <TextInput
                      disabled={!on}
                      value={cfg.overrides[r.id] ?? ""}
                      placeholder={`Answer: ${r.answer}`}
                      onChange={(e) => setOver(r.id, e.target.value)}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">Answer: {r.answer}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title={`Your own rules (${cfg.custom.length})`}
        actions={<Btn onClick={addRule}><Plus className="h-3 w-3" /> Add rule</Btn>}
      >
        {!cfg.custom.length && (
          <p className="text-sm text-muted-foreground">
            None yet. A rule says: when a question matches this pattern, answer this. For a list, the nearest option is picked.
          </p>
        )}
        <ul className="space-y-3">
          {cfg.custom.map((r, i) => (
            <li key={r.id} className="grid gap-2 rounded-xl border border-border/40 p-3 md:grid-cols-[auto_1fr_1fr_1fr_auto] md:items-end">
              <Toggle on={r.enabled} onChange={(v) => setRule(i, { enabled: v })} label="Rule on" />
              <Field label="Question matches" hint="Pattern, lower-case, e.g. driving licen[cs]e">
                <TextInput value={r.match} onChange={(e) => setRule(i, { match: e.target.value })} />
              </Field>
              <Field label="Unless it matches" hint="Optional">
                <TextInput value={r.exclude ?? ""} onChange={(e) => setRule(i, { exclude: e.target.value })} />
              </Field>
              <Field label="Answer">
                <TextInput value={r.answer} onChange={(e) => setRule(i, { answer: e.target.value })} />
              </Field>
              <Btn tone="danger" title="Delete rule" onClick={() => setCfg((c) => ({ ...c, custom: c.custom.filter((_, j) => j !== i) }))}>
                <Trash2 className="h-3 w-3" />
              </Btn>
            </li>
          ))}
        </ul>
        {dirty && <p className="mt-3 text-xs text-amber-400">Unsaved changes — the test below uses what is saved.</p>}
      </Section>

      <TryQuestion />
    </div>
  );
}

/** Runs the real planner on one question with an empty profile: what would be answered, by which rule. */
function TryQuestion() {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState("");
  const [type, setType] = useState("auto");
  const [res, setRes] = useState<Awaited<ReturnType<typeof controlApi.testAnswer>>["result"]>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes((await controlApi.testAnswer(q, opts, type === "checkbox" ? "checkbox" : "auto")).result);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Try a question">
      <div className="grid gap-2 md:grid-cols-[2fr_2fr_auto_auto] md:items-end">
        <Field label="Question as the form shows it">
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="Before submitting, you must agree to our Privacy Notice" />
        </Field>
        <Field label="Options" hint="Separate with | — leave empty for a text box">
          <TextInput value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Yes | No" />
        </Field>
        <Field label="Shape">
          <select className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="auto">Text / choice</option>
            <option value="checkbox">Checkbox</option>
          </select>
        </Field>
        <Btn tone="primary" busy={busy} onClick={run}>Test</Btn>
      </div>
      {res && (
        <p className="mt-3 text-sm">
          {res.answered ? (
            <>
              Answers <b>{res.value}</b> <Pill tone="blue">{res.source}</Pill> {res.rule && <Pill tone="violet">{res.rule}</Pill>}
            </>
          ) : (
            <span className="text-muted-foreground">Not answered from defaults — {res.reason}. The person's profile, notes or earlier replies are tried first on a real application.</span>
          )}
        </p>
      )}
    </Section>
  );
}
