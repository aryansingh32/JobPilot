import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { MonitorPlay, Square } from "lucide-react";
import { config, adminOriginForSockets } from "@/lib/config";
import { controlApi, type PendingInput } from "@/lib/admin-control-api";
import { Btn, Pill, TextInput, act, inputCls, statusTone } from "./kit";

/** One admin socket shared by live views and the recorder. */
let shared: Socket | null = null;
export function adminSocket(): Socket {
  if (!shared) {
    shared = io(`${adminOriginForSockets()}/admin`, {
      path: config.socketPath,
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
  }
  return shared;
}

/**
 * Live screen of a running job, plus whatever it's waiting for: a question
 * to answer or a review to approve (with editable values).
 */
export function LiveRun({ jobId, onDone }: { jobId: string; onDone?: (status: string) => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState("queued");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ type: string; payload: PendingInput } | null>(null);
  const [answer, setAnswer] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const doneRef = useRef(false);

  useEffect(() => {
    const s = adminSocket();
    const onFrame = (f: { jobId: string; data: string }) => {
      if (f.jobId === jobId) setFrame(f.data);
    };
    const watch = () => s.emit("watch-job", { jobId });
    s.on("job:frame", onFrame);
    s.on("connect", watch);
    watch();
    return () => {
      s.off("job:frame", onFrame);
      s.off("connect", watch);
      s.emit("unwatch-job");
    };
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await controlApi.jobPending(jobId);
        if (!alive) return;
        const st = r.runtime?.status ?? "queued";
        setStatus(st);
        setError(r.runtime?.error ?? null);
        setPending((prev) => {
          if (r.pending && (!prev || prev.payload.contextMessage !== r.pending.payload.contextMessage)) {
            const fields = r.pending.payload.sections?.flatMap((sec) => sec.fields) ?? [];
            setValues(Object.fromEntries(fields.map((f) => [f.id, f.value])));
            setAnswer("");
          }
          return r.pending;
        });
        if ((st === "completed" || st === "failed") && !doneRef.current) {
          doneRef.current = true;
          onDone?.(st);
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobId, onDone]);

  const review = pending?.type === "review" ? pending.payload : null;
  const fields = review?.sections?.flatMap((s) => s.fields) ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <div className="overflow-hidden rounded-xl border border-border/40 bg-black/80">
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame}`} alt="Live view of the run" className="w-full" />
        ) : (
          <div className="flex aspect-video items-center justify-center gap-2 text-xs text-muted-foreground">
            <MonitorPlay className="h-4 w-4" /> Waiting for the browser…
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Pill tone={statusTone(status)}>{status}</Pill>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{jobId}</span>
          {["running", "paused", "queued"].includes(status) && (
            <Btn tone="danger" className="ml-auto" onClick={() => act("Cancelled", () => controlApi.cancelJob(jobId))}>
              <Square className="h-3 w-3" /> Stop
            </Btn>
          )}
        </div>
        {error && <p className="rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}

        {pending?.payload.captchaUrl && (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-sm text-foreground">{pending.payload.contextMessage}</p>
            <img
              src={pending.payload.captchaUrl}
              alt="Captcha"
              className={`max-w-full rounded border border-border/40 ${pending.type === "clickCaptcha" ? "cursor-crosshair" : ""}`}
              onClick={(e) => {
                if (pending.type !== "clickCaptcha") return;
                const r = e.currentTarget.getBoundingClientRect();
                void act("Click sent", () =>
                  controlApi.respondToJob(jobId, JSON.stringify({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })),
                );
              }}
            />
            {pending.type === "clickCaptcha" && (
              <Btn onClick={() => act("Done", () => controlApi.respondToJob(jobId, JSON.stringify({ done: true })))}>Done</Btn>
            )}
          </div>
        )}

        {pending && !review && !(pending.type === "clickCaptcha") && (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-sm text-foreground">{pending.payload.contextMessage ?? "The run needs input"}</p>
            {pending.payload.options?.length ? (
              <select className={inputCls} value={answer} onChange={(e) => setAnswer(e.target.value)}>
                <option value="">Choose…</option>
                {pending.payload.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <TextInput value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" />
            )}
            <Btn tone="primary" disabled={!answer} onClick={() => act("Sent", () => controlApi.respondToJob(jobId, answer))}>
              Send answer
            </Btn>
          </div>
        )}

        {review && (
          <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm font-semibold text-foreground">{review.title ?? "Review before submit"}</p>
            {review.missing?.length ? (
              <p className="text-xs text-amber-400">Still unanswered: {review.missing.join(", ")}</p>
            ) : null}
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {fields.map((f) => (
                <label key={f.id} className="block">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {f.label}
                    <Pill tone={f.source === "profile" ? "green" : f.source === "user" ? "blue" : "violet"}>{f.source}</Pill>
                  </span>
                  {f.kind === "file" ? (
                    <div className="text-xs text-foreground">{f.value}</div>
                  ) : f.options?.length ? (
                    <select className={inputCls} value={values[f.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}>
                      {f.options.map((o) => (
                        <option key={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <TextInput value={values[f.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))} />
                  )}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Btn
                tone="primary"
                onClick={() => act("Approved", () => controlApi.respondToJob(jobId, JSON.stringify({ action: "approve", values })))}
              >
                Approve
              </Btn>
              <Btn tone="danger" onClick={() => act("Cancelled", () => controlApi.cancelJob(jobId))}>
                Cancel run
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
