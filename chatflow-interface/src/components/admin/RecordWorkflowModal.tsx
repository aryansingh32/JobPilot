import { useEffect, useState } from "react";
import { X, Play, Square, Save, ArrowRight, ShieldAlert } from "lucide-react";
import { socketService } from "@/lib/socket-service";
import { config } from "@/lib/config";
import type { AdminWorkflow } from "@/lib/admin-api";

export function RecordWorkflowModal({ onClose, onPublish }: { onClose: () => void; onPublish: (wf: Partial<AdminWorkflow>) => void; }) {
  const [recording, setRecording] = useState(false);
  const [rawSteps, setRawSteps] = useState<any[]>([]);
  const [generalizedSteps, setGeneralizedSteps] = useState<any[]>([]);
  const [isGeneralizing, setIsGeneralizing] = useState(false);
  const [starterActionPlan, setStarterActionPlan] = useState("");
  const [form, setForm] = useState<Partial<AdminWorkflow>>({ name: "Recorded Workflow", trigger: "trigger_name", site_id: "site_id" });

  useEffect(() => {
    if (recording) {
      socketService.updateCallbacks({
        onRecordStep: (step) => {
          setRawSteps((prev) => [...prev, step]);
        }
      });
    }
    return () => {
      socketService.updateCallbacks({ onRecordStep: undefined });
    };
  }, [recording]);

  const handleGeneralize = async () => {
    setIsGeneralizing(true);
    try {
      const ADMIN_KEY = (import.meta as any).env?.VITE_ADMIN_KEY ?? config.apiKey;
      const res = await fetch(`${config.apiBaseUrl}/admin/record/generalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": ADMIN_KEY
        },
        body: JSON.stringify({
          steps: rawSteps,
          starterActionPlan: starterActionPlan || undefined
        })
      });
      if (!res.ok) throw new Error("Failed to generalize");
      const data = await res.json();
      setGeneralizedSteps(data.generalized || data.steps || []);
    } catch (e) {
      console.error("Generalize error:", e);
      // Fallback
      setGeneralizedSteps(rawSteps.map((s, i) => ({
        step: i + 1,
        action: s.action || "unknown",
        selector: s.selector ? s.selector.replace(/nth-child\(\d+\)/g, "nth-child(n)") : "",
        value: s.value || ""
      })));
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
        value: "Wait for user to solve captcha"
      }
    ]);
  };

  const handlePublish = () => {
    onPublish({
      ...form,
      instructions: JSON.stringify(generalizedSteps, null, 2)
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-border bg-background p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Record New Workflow</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent transition"><X className="h-4 w-4" /></button>
        </div>
        
        <div className="flex gap-4 mb-3">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Workflow Name" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]" />
          <input value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} placeholder="Site ID" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]" />
          <input value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} placeholder="Trigger Phrase" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none flex-1 min-h-[16px]" />
        </div>
        
        <div className="mb-4">
          <textarea 
            value={starterActionPlan} 
            onChange={(e) => setStarterActionPlan(e.target.value)} 
            placeholder="Starter Action Plan (optional context for generalization)" 
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none min-h-[16px] h-16 resize-none"
          />
        </div>

        <div className="flex gap-2 mb-4">
          {!recording ? (
            <button onClick={() => setRecording(true)} className="flex items-center gap-1.5 rounded-xl bg-red-500/20 text-red-400 px-4 py-2 text-xs font-medium hover:bg-red-500/30 transition">
              <Play className="h-3.5 w-3.5" /> Start Recording
            </button>
          ) : (
            <button onClick={() => setRecording(false)} className="flex items-center gap-1.5 rounded-xl bg-zinc-500/20 text-zinc-400 px-4 py-2 text-xs font-medium hover:bg-zinc-500/30 transition">
              <Square className="h-3.5 w-3.5" /> Stop Recording
            </button>
          )}
          
          <button onClick={addCaptchaStep} className="flex items-center gap-1.5 rounded-xl bg-orange-500/20 text-orange-400 px-4 py-2 text-xs font-medium hover:bg-orange-500/30 transition">
            <ShieldAlert className="h-3.5 w-3.5" /> Mark as Captcha
          </button>

          <button onClick={handleGeneralize} disabled={rawSteps.length === 0 || isGeneralizing} className="flex items-center gap-1.5 rounded-xl bg-primary/20 text-primary px-4 py-2 text-xs font-medium hover:bg-primary/30 transition disabled:opacity-50 ml-auto">
            <ArrowRight className="h-3.5 w-3.5" /> {isGeneralizing ? "Generalizing..." : "Generalize"}
          </button>
        </div>
        
        <div className="flex-1 grid grid-cols-2 gap-4 min-h-[250px] overflow-hidden">
          <div className="flex flex-col border border-border rounded-xl overflow-hidden bg-card/40">
            <div className="bg-muted px-3 py-2 text-xs font-semibold border-b border-border">Raw Recorded Steps ({rawSteps.length})</div>
            <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-muted-foreground font-mono">
              {rawSteps.length > 0 ? JSON.stringify(rawSteps, null, 2) : "Listening to socket..."}
            </pre>
          </div>
          <div className="flex flex-col border border-border rounded-xl overflow-hidden bg-card/40">
            <div className="bg-muted px-3 py-2 text-xs font-semibold border-b border-border">Generalized Steps</div>
            <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-foreground font-mono">
              {generalizedSteps.length > 0 ? JSON.stringify(generalizedSteps, null, 2) : "Click Generalize to process steps."}
            </pre>
          </div>
        </div>
        
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition">Cancel</button>
          <button onClick={handlePublish} disabled={generalizedSteps.length === 0} className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50">
            <Save className="h-3.5 w-3.5" /> Publish
          </button>
        </div>
      </div>
    </div>
  );
}
