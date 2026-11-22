import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Circle, Keyboard, Save, Square, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { controlApi, type PlanStep } from "@/lib/admin-control-api";
import {
  Btn,
  Empty,
  Field,
  JsonEditor,
  Pill,
  Section,
  TextInput,
  act,
  inputCls,
  useLoad,
} from "./kit";
import { adminSocket } from "./LiveRun";

// Record a workflow on any site — including ones with no API. The browser
// runs headless on a worker; you drive it from here (click the screen, type
// with the keyboard). Every action is captured, then compiled into steps
// without AI: values that match the test profile become {{profile:*}}.

interface RawStep {
  action: string;
  value?: string;
  url?: string;
  target?: { label?: string; text?: string; selectors?: string[] };
  snapshot?: {
    title: string;
    headings: string[];
    fields: {
      label: string;
      type: string;
      required: boolean;
      options?: string[];
      secret?: string;
      hint?: string;
    }[];
    buttons: string[];
    gates: string[];
  };
}

export function RecorderPanel() {
  const status = useLoad(() => controlApi.recorderStatus());
  const [url, setUrl] = useState("");
  const [jobApply, setJobApply] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState("");
  const [raw, setRaw] = useState<RawStep[]>([]);
  const [compiled, setCompiled] = useState<PlanStep[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [typeBox, setTypeBox] = useState("");
  const [fileIndex, setFileIndex] = useState(1);
  const [save, setSave] = useState({ name: "", key: "", patterns: "" });
  const screenRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!sessionId) return;
    const s = adminSocket();
    const onFrame = (f: { sessionId: string; data?: string; url?: string }) => {
      if (f.sessionId !== sessionId) return;
      if (f.data) setFrame(f.data);
      if (f.url) setPageUrl(f.url);
    };
    const onStep = (p: { sessionId: string; step: RawStep }) => {
      if (p.sessionId === sessionId) setRaw((r) => [...r, p.step]);
    };
    s.on("workflow:record-frame", onFrame);
    s.on("workflow:record-step", onStep);
    return () => {
      s.off("workflow:record-frame", onFrame);
      s.off("workflow:record-step", onStep);
    };
  }, [sessionId]);

  // Inputs go one at a time, in order.
  const send = (input: Record<string, unknown>) => {
    if (!sessionId) return;
    queue.current = queue.current
      .then(() => controlApi.recordInput(sessionId, input))
      .then((r) => r?.url && setPageUrl(r.url))
      .catch((e) => toast.error((e as Error).message));
  };

  // The browser is remote, so the file's bytes go with the command; it attaches to the Nth file field on the page.
  const uploadFile = (file: File) => {
    if (file.size > 10 * 1024 * 1024) return toast.error("File is larger than 10 MB");
    const reader = new FileReader();
    reader.onload = () => {
      const dataBase64 = String(reader.result).split(",")[1] ?? "";
      send({ type: "upload", fileName: file.name, dataBase64, index: fileIndex - 1 });
      toast.success(`Uploading ${file.name} to file field #${fileIndex}`);
    };
    reader.readAsDataURL(file);
  };

  const start = async () => {
    setBusy(true);
    const id = crypto.randomUUID();
    adminSocket(); // connect before frames start
    const ok = await act("Recording — drive the browser below", async () => {
      setSessionId(id);
      setRaw([]);
      setCompiled(null);
      setWarnings([]);
      setFrame(null);
      await controlApi.recordStart(url.trim(), id);
    });
    if (!ok) setSessionId(null);
    setBusy(false);
    setTimeout(() => screenRef.current?.focus(), 300);
  };

  const stop = async () => {
    if (!sessionId) return;
    setBusy(true);
    let stopped = false;
    const ok = await act("Recording stopped", async () => {
      await queue.current;
      const r = await controlApi.recordStop(sessionId);
      stopped = true;
      const steps = (r.steps as RawStep[]) ?? raw;
      setRaw(steps);
      const c = await controlApi.recordCompile(steps, jobApply);
      setCompiled(c.steps);
      setWarnings([
        ...(c.warnings ?? []),
        ...(c.confirmation
          ? [
              `Learned this site's confirmation: ${[c.confirmation.urlPath, c.confirmation.text && `"${c.confirmation.text}"`].filter(Boolean).join(" · ")}`,
            ]
          : []),
      ]);
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return "site";
        }
      })();
      setSave({
        name: `${host} — ${jobApply ? "Apply" : "Workflow"}`,
        key: `${jobApply ? "job-apply" : "wf"}-${host.replace(/[^a-z0-9]+/gi, "-")}`,
        patterns: host.replace(/\./g, "\\."),
      });
    });
    // Keep the live session and controls if the stop command failed so the
    // operator can retry instead of orphaning a worker browser for 20 minutes.
    if (stopped || ok) setSessionId(null);
    setBusy(false);
  };

  const onScreenClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    send({ type: "click", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    screenRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!sessionId) return;
    if (e.metaKey || e.ctrlKey) return;
    const named = [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageDown",
      "PageUp",
    ];
    if (named.includes(e.key)) {
      e.preventDefault();
      send({ type: "key", key: e.shiftKey && e.key === "Tab" ? "Shift+Tab" : e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      send({ type: "type", text: e.key });
    }
  };

  const saveWorkflow = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await act("Saved as a draft workflow — test it in Workflows", async () => {
        const first = compiled?.find((s) => s.action === "navigate");
        const res = await controlApi.importWorkflow({
          id: save.key,
          name: save.name,
          category: jobApply ? "jobs" : "general",
          portalType: jobApply ? "jobs" : "general-web",
          entryUrl: String(first?.metadata?.recordedUrl ?? url),
          pageUrlPatterns: save.patterns
            .split(/\n|,/)
            .map((s) => s.trim())
            .filter(Boolean),
          requiredFiles: JSON.stringify(compiled).includes("{{userFile:")
            ? [jobApply ? "resume" : "document"]
            : [],
          starterActionPlan: compiled ?? [],
          isActive: false,
          metadata: {
            ...(jobApply ? { kind: "job-apply", atsType: "recorded" } : {}),
            source: "recorder",
          },
        });
        const bad = res.results.find((r) => !r.ok);
        if (bad) throw new Error(bad.error);
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Record a workflow"
        actions={
          <Pill tone={status.data?.workerOnline ? "green" : "red"}>
            {status.data?.workerOnline ? "worker online" : "no worker online"}
          </Pill>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 w-full sm:w-auto sm:min-w-[280px] flex-1">
            <Field label="Start URL">
              <TextInput
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/start"
                disabled={!!sessionId}
              />
            </Field>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={jobApply}
              onChange={(e) => setJobApply(e.target.checked)}
              disabled={!!sessionId}
            />
            Job application (first page becomes the job's apply URL)
          </label>
          {sessionId ? (
            <Btn tone="danger" busy={busy} onClick={stop}>
              <Square className="h-3 w-3" /> Stop & compile
            </Btn>
          ) : (
            <Btn
              tone="primary"
              busy={busy}
              disabled={!/^https?:\/\//.test(url) || !status.data?.workerOnline}
              onClick={start}
            >
              <Circle className="h-3 w-3 fill-current" /> Start recording
            </Btn>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Tip: fill the form with the <b>test profile's</b> values so they're saved as profile
          fields, not fixed text. Recognized secret fields become "ask the user" steps. Review the
          recording for personal data before saving.
        </p>
      </Section>

      {sessionId && (
        <div className="grid gap-4 xl:grid-cols-[3fr_1fr]">
          <Section
            title={
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Live
                <span className="truncate font-mono text-[11px] font-normal text-muted-foreground">
                  {pageUrl}
                </span>
              </span>
            }
            actions={
              <>
                <Btn tone="ghost" onClick={() => send({ type: "back" })}>
                  <ArrowLeft className="h-3 w-3" /> Back
                </Btn>
                <Btn tone="ghost" onClick={() => send({ type: "scroll", dy: 500 })}>
                  Scroll ↓
                </Btn>
                <Btn tone="ghost" onClick={() => send({ type: "scroll", dy: -500 })}>
                  Scroll ↑
                </Btn>
              </>
            }
          >
            <div
              ref={screenRef}
              tabIndex={0}
              aria-label="Remote browser controls. Click the preview, then type; Tab moves focus inside the remote page."
              onKeyDown={onKey}
              className="overflow-hidden rounded-lg border border-border/40 bg-black/80 outline-none focus:ring-2 focus:ring-primary/50"
            >
              {frame ? (
                <img
                  src={`data:image/jpeg;base64,${frame}`}
                  alt="Remote browser"
                  onClick={onScreenClick}
                  className="w-full cursor-crosshair select-none"
                  draggable={false}
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-muted-foreground">
                  Opening the page…
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                Click the screen, then type. Or paste text:
              </span>
              <TextInput
                className="max-w-sm"
                value={typeBox}
                onChange={(e) => setTypeBox(e.target.value)}
                placeholder="Text to type into the focused field"
              />
              <Btn
                onClick={() => {
                  send({ type: "type", text: typeBox });
                  setTypeBox("");
                  screenRef.current?.focus();
                }}
                disabled={!typeBox}
              >
                Type
              </Btn>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Upload className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                Upload a file to file field #
              </span>
              <input
                type="number"
                min={1}
                aria-label="Target file field number"
                value={fileIndex}
                onChange={(e) => setFileIndex(Math.max(1, Number(e.target.value) || 1))}
                className={cn(inputCls, "w-14")}
              />
              <input
                type="file"
                aria-label="Upload a file to the remote page"
                className="text-xs"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </Section>
          <Section
            title={`Captured (${raw.length})`}
            actions={
              <Btn
                onClick={() => {
                  // Secrets are already redacted at capture; this is the full flow map (pages, fields, gates, clicks).
                  const blob = new Blob([JSON.stringify(raw, null, 2)], {
                    type: "application/json",
                  });
                  const a = document.createElement("a");
                  const objectUrl = URL.createObjectURL(blob);
                  a.href = objectUrl;
                  a.download = `recording-${new Date().toISOString().slice(0, 10)}.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                }}
                disabled={!raw.length}
              >
                Download JSON
              </Btn>
            }
          >
            <ol className="max-h-[60vh] space-y-1 overflow-y-auto text-xs">
              {raw.map((s, i) =>
                s.action === "page" && s.snapshot ? (
                  <li key={i} className="rounded-md border border-border/40 bg-muted/30 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="gray">page</Pill>
                      <span className="font-medium text-foreground">
                        {s.snapshot.headings[0] || s.snapshot.title || s.url}
                      </span>
                      {s.snapshot.gates.map((g) => (
                        <Pill key={g} tone="violet">
                          {g} gate
                        </Pill>
                      ))}
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground">
                        {s.snapshot.fields.length} fields · {s.snapshot.buttons.length} buttons
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {s.snapshot.fields.map((f, k) => (
                          <li key={k} className="text-muted-foreground">
                            <span className="text-foreground">{f.label || "(unlabelled)"}</span> ·{" "}
                            {f.type}
                            {f.required ? " · required" : ""}
                            {f.secret ? ` · secret:${f.secret}` : ""}
                            {f.options?.length
                              ? ` · ${f.options.slice(0, 5).join(" / ")}${f.options.length > 5 ? "…" : ""}`
                              : ""}
                            {f.hint ? ` — ${f.hint}` : ""}
                          </li>
                        ))}
                        {s.snapshot.buttons.length > 0 && (
                          <li>Buttons: {s.snapshot.buttons.join(" · ")}</li>
                        )}
                      </ul>
                    </details>
                  </li>
                ) : (
                  <li key={i} className="flex gap-2">
                    <Pill
                      tone={
                        s.action === "click" ? "blue" : s.action === "navigate" ? "gray" : "violet"
                      }
                    >
                      {s.action}
                    </Pill>
                    <span className="truncate text-foreground">
                      {s.target?.label || s.target?.text || s.url || ""}
                    </span>
                    {s.value && s.action !== "navigate" && (
                      <span className="truncate font-mono text-muted-foreground">{s.value}</span>
                    )}
                  </li>
                ),
              )}
              {!raw.length && <Empty>Interact with the page…</Empty>}
            </ol>
          </Section>
        </div>
      )}

      {compiled && (
        <Section
          title={
            <span className="flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" /> Compiled workflow ({compiled.length} steps)
            </span>
          }
          actions={
            <Btn
              tone="primary"
              onClick={saveWorkflow}
              busy={saving}
              disabled={!save.key || !compiled.length}
            >
              <Save className="h-3 w-3" /> Save as draft
            </Btn>
          }
        >
          <div className="mb-3 grid gap-3 md:grid-cols-3">
            <Field label="Name">
              <TextInput
                value={save.name}
                onChange={(e) => setSave({ ...save, name: e.target.value })}
              />
            </Field>
            <Field label="Key (unique)">
              <TextInput
                value={save.key}
                onChange={(e) => setSave({ ...save, key: e.target.value })}
              />
            </Field>
            <Field label="URL patterns" hint="Regex; jobs on matching URLs use this workflow.">
              <input
                className={cn(inputCls, "font-mono text-xs")}
                value={save.patterns}
                onChange={(e) => setSave({ ...save, patterns: e.target.value })}
              />
            </Field>
          </div>
          {warnings.length > 0 && (
            <ul className="mb-3 list-disc space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 pl-7 text-xs">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <JsonEditor
            value={compiled}
            onChange={(v) => Array.isArray(v) && setCompiled(v as PlanStep[])}
            rows={20}
          />
        </Section>
      )}
    </div>
  );
}
