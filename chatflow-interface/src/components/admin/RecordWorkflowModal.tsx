import { useEffect, useRef, useState } from "react";
import { Play, Square, Save, ArrowRight, ShieldAlert, FlaskConical, MousePointerClick } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { config, apiOriginForSockets } from "@/lib/config";
import type { AdminWorkflow } from "@/lib/admin-api";
import { toast } from "sonner";

const QUICK_KEYS = ["Enter", "Tab", "Backspace", "Escape"];
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export function RecordWorkflowModal({
  onClose,
  onPublish,
}: {
  onClose: () => void;
  onPublish: (wf: Partial<AdminWorkflow>) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [rawSteps, setRawSteps] = useState<any[]>([]);
  const [generalizedSteps, setGeneralizedSteps] = useState<any[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [typeText, setTypeText] = useState("");
  const [isGeneralizing, setIsGeneralizing] = useState(false);
  const [starterActionPlan, setStarterActionPlan] = useState("");
  const [form, setForm] = useState<Partial<AdminWorkflow>>({
    name: "Recorded Workflow",
    trigger: "trigger_name",
    site_id: "site_id",
  });

  const sessionIdRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const handleStartRecording = async () => {
    if (!form.entry_url) {
      toast.error("Enter an Entry URL to start recording");
      return;
    }
    setIsStarting(true);
    try {
      const sessionId = crypto.randomUUID();
      const res = await fetch(`${config.apiBaseUrl}/admin/record/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.entry_url, sessionId }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error || "Failed to start recording");
      }

      sessionIdRef.current = sessionId;
      setRawSteps([]);

      const socket = io(`${apiOriginForSockets()}/admin`, {
        path: config.socketPath,
        withCredentials: true,
        transports: ["websocket", "polling"],
      });
      socket.on(
        "workflow:record-step",
        (payload: { sessionId: string; step: Record<string, unknown> }) => {
          if (payload.sessionId === sessionId) {
            setRawSteps((prev) => [...prev, payload.step]);
          }
        },
      );
      socket.on(
        "workflow:record-frame",
        (payload: { sessionId: string; frame: string }) => {
          if (payload.sessionId === sessionId) {
            setFrame(`data:image/jpeg;base64,${payload.frame}`);
          }
        },
      );
      socketRef.current = socket;

      setRecording(true);
      toast.success("Recording started — interact with the site in its own browser context.");
    } catch (e: any) {
      toast.error(e.message || "Failed to start recording");
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopRecording = async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      setRecording(false);
      return;
    }
    try {
      const res = await fetch(`${config.apiBaseUrl}/admin/record/stop`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.steps)) setRawSteps(data.steps);
      }
    } catch (e) {
      console.error("Stop recording error:", e);
    } finally {
      socketRef.current?.disconnect();
      socketRef.current = null;
      sessionIdRef.current = null;
      setRecording(false);
      setFrame(null);
    }
  };

  // Interactive recording: clicking/typing on the streamed screenshot
  // replays as a real Playwright mouse/keyboard action on the recorder's
  // page (see recorderService.click/type/pressKey on the backend), which
  // triggers the same real DOM events the injected step-capture script
  // listens for — so it shows up in Raw Recorded Steps like any other click.
  const handleLiveClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const socket = socketRef.current;
    const sessionId = sessionIdRef.current;
    if (!socket || !sessionId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = (e.clientX - rect.left) / rect.width;
    const yPct = (e.clientY - rect.top) / rect.height;
    socket.emit("workflow:record-click", { sessionId, xPct, yPct });
  };

  const sendType = () => {
    const socket = socketRef.current;
    const sessionId = sessionIdRef.current;
    if (!socket || !sessionId || !typeText) return;
    socket.emit("workflow:record-type", { sessionId, text: typeText });
    setTypeText("");
  };

  const sendKey = (key: string) => {
    const socket = socketRef.current;
    const sessionId = sessionIdRef.current;
    if (!socket || !sessionId) return;
    socket.emit("workflow:record-key", { sessionId, key });
  };

  const handleGeneralize = async () => {
    setIsGeneralizing(true);
    try {
      const res = await fetch(`${config.apiBaseUrl}/admin/record/generalize`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          steps: rawSteps,
          starterActionPlan: starterActionPlan || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to generalize");
      const data = await res.json();
      setGeneralizedSteps(data.generalized || data.steps || []);
    } catch (e) {
      console.error("Generalize error:", e);
      // Fallback
      setGeneralizedSteps(
        rawSteps.map((s, i) => ({
          step: i + 1,
          action: s.action || "unknown",
          selector: s.selector ? s.selector.replace(/nth-child\(\d+\)/g, "nth-child(n)") : "",
          value: s.value || "",
        })),
      );
    } finally {
      setIsGeneralizing(false);
    }
  };

  const addCaptchaStep = () => {
    setRawSteps((prev) => [
      ...prev,
      {
        action: "solveCaptcha",
        selector: "body",
        value: "Wait for user to solve captcha",
      },
    ]);
  };

  const [isDryRunning, setIsDryRunning] = useState(false);

  const handleDryRun = async () => {
    if (!form.entry_url && !form.page_url) {
      toast.error("Please provide an Entry URL or Page URL to dry-run");
      return;
    }
    setIsDryRunning(true);
    try {
      const res = await fetch(`${config.apiBaseUrl}/admin/record/dry-run`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: form.entry_url || form.page_url,
          steps: generalizedSteps,
        }),
      });
      if (!res.ok) throw new Error("Dry-run failed");
      const data = await res.json();
      if (data.success) {
        toast.success(`Dry-run passed! (${data.durationMs}ms)`);
      } else {
        toast.error(`Dry-run failed at step ${data.failedStepId}: ${data.error}`);
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to run dry-run");
    } finally {
      setIsDryRunning(false);
    }
  };

  const handlePublish = () => {
    onPublish({
      ...form,
      instructions: JSON.stringify(generalizedSteps, null, 2),
      starterActionPlan: generalizedSteps,
    });
  };

  const handleClose = () => {
    if (recording) handleStopRecording();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Record New Workflow</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 mb-3 sm:flex-row sm:gap-4 sm:mb-0">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Workflow Name"
            className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]"
          />
          <input
            value={form.site_id}
            onChange={(e) => setForm({ ...form, site_id: e.target.value })}
            placeholder="Site ID"
            className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]"
          />
          <input
            value={form.trigger}
            onChange={(e) => setForm({ ...form, trigger: e.target.value })}
            placeholder="Trigger Phrase"
            className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]"
          />
        </div>
        <div className="flex gap-4 mb-3">
          <input
            value={form.entry_url || ""}
            onChange={(e) => setForm({ ...form, entry_url: e.target.value })}
            placeholder="Entry URL (recording start page + dry-run target)"
            className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]"
          />
        </div>

        <div className="mb-4">
          <textarea
            value={starterActionPlan}
            onChange={(e) => setStarterActionPlan(e.target.value)}
            placeholder="Starter Action Plan (optional context for generalization)"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none min-h-[16px] h-16 resize-none"
          />
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {!recording ? (
            <button
              onClick={handleStartRecording}
              disabled={isStarting}
              className="flex items-center gap-1.5 rounded-xl bg-red-500/20 text-red-400 px-4 py-2 text-xs font-medium hover:bg-red-500/30 transition disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> {isStarting ? "Starting…" : "Start Recording"}
            </button>
          ) : (
            <button
              onClick={handleStopRecording}
              className="flex items-center gap-1.5 rounded-xl bg-zinc-500/20 text-zinc-400 px-4 py-2 text-xs font-medium hover:bg-zinc-500/30 transition"
            >
              <Square className="h-3.5 w-3.5" /> Stop Recording
            </button>
          )}

          <button
            onClick={addCaptchaStep}
            className="flex items-center gap-1.5 rounded-xl bg-orange-500/20 text-orange-400 px-4 py-2 text-xs font-medium hover:bg-orange-500/30 transition"
          >
            <ShieldAlert className="h-3.5 w-3.5" /> Mark as Captcha
          </button>

          <div className="flex gap-2 sm:ml-auto">
            <button
              onClick={handleDryRun}
              disabled={generalizedSteps.length === 0 || isDryRunning}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500/20 text-amber-500 px-4 py-2 text-xs font-medium hover:bg-amber-500/30 transition disabled:opacity-50"
            >
              <FlaskConical className="h-3.5 w-3.5" /> {isDryRunning ? "Testing..." : "Dry Run"}
            </button>
            <button
              onClick={handleGeneralize}
              disabled={rawSteps.length === 0 || isGeneralizing}
              className="flex items-center gap-1.5 rounded-xl bg-primary/20 text-primary px-4 py-2 text-xs font-medium hover:bg-primary/30 transition disabled:opacity-50"
            >
              <ArrowRight className="h-3.5 w-3.5" />{" "}
              {isGeneralizing ? "Generalizing..." : "Generalize"}
            </button>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 gap-4 min-h-[250px] overflow-y-auto sm:grid-cols-2 sm:overflow-hidden">
          {recording ? (
            <div className="flex flex-col border border-border rounded-xl overflow-hidden bg-card/40">
              <div className="flex items-center justify-between bg-muted px-3 py-2 text-xs font-semibold border-b border-border">
                <span className="flex items-center gap-1.5">
                  <MousePointerClick className="h-3.5 w-3.5" /> Live — click/type to interact ({rawSteps.length} steps)
                </span>
              </div>
              <div className="flex-1 overflow-hidden bg-black/40 flex items-center justify-center min-h-[160px]">
                {frame ? (
                  <img
                    src={frame}
                    alt="Live recording view"
                    onClick={handleLiveClick}
                    className="max-h-full max-w-full cursor-crosshair"
                  />
                ) : (
                  <span className="text-[11px] text-muted-foreground">Connecting…</span>
                )}
              </div>
              <div className="border-t border-border p-2 space-y-1.5 shrink-0">
                <div className="flex gap-1.5">
                  <input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendType()}
                    placeholder="Click a field above, then type here…"
                    className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:outline-none"
                  />
                  <button
                    onClick={sendType}
                    disabled={!typeText}
                    className="rounded-lg bg-primary/20 text-primary px-3 text-xs font-medium hover:bg-primary/30 transition disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {QUICK_KEYS.map((key) => (
                    <button
                      key={key}
                      onClick={() => sendKey(key)}
                      className="rounded-lg border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition"
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col border border-border rounded-xl overflow-hidden bg-card/40">
              <div className="bg-muted px-3 py-2 text-xs font-semibold border-b border-border">
                Raw Recorded Steps ({rawSteps.length})
              </div>
              <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-muted-foreground font-mono">
                {rawSteps.length > 0 ? JSON.stringify(rawSteps, null, 2) : "Click Start Recording to begin."}
              </pre>
            </div>
          )}
          <div className="flex flex-col border border-border rounded-xl overflow-hidden bg-card/40">
            <div className="bg-muted px-3 py-2 text-xs font-semibold border-b border-border">
              Generalized Steps
            </div>
            <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-foreground font-mono">
              {generalizedSteps.length > 0
                ? JSON.stringify(generalizedSteps, null, 2)
                : "Click Generalize to process steps."}
            </pre>
          </div>
        </div>

        <DialogFooter className="mt-5">
          <button
            onClick={handleClose}
            className="rounded-xl border border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition"
          >
            Cancel
          </button>
          <button
            onClick={handlePublish}
            disabled={generalizedSteps.length === 0}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> Publish
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
