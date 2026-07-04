import { useEffect, useState } from "react";
import { X, Play, Square, Save, ArrowRight } from "lucide-react";
import { socketService } from "@/lib/socket-service";
import type { AdminWorkflow } from "@/lib/admin-api";

export function RecordWorkflowModal({ onClose, onPublish }: { onClose: () => void; onPublish: (wf: Partial<AdminWorkflow>) => void; }) {
  const [recording, setRecording] = useState(false);
  const [rawSteps, setRawSteps] = useState<any[]>([]);
  const [generalizedSteps, setGeneralizedSteps] = useState<any[]>([]);
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

  const handleGeneralize = () => {
    // mock generalization
    const generalized = rawSteps.map((s, i) => ({
      step: i + 1,
      action: s.action || "unknown",
      selector: s.selector ? s.selector.replace(/nth-child\(\d+\)/g, "nth-child(n)") : "",
      value: s.value || ""
    }));
    setGeneralizedSteps(generalized);
  };

  const handlePublish = () => {
    onPublish({
      ...form,
      instructions: JSON.stringify(generalizedSteps, null, 2)
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl border border-border/60 bg-[oklch(0.16_0.012_260)] p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-foreground">Record New Workflow</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent transition"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex gap-4 mb-4">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Workflow Name" className="rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground focus:outline-none flex-1" />
          <input value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} placeholder="Site ID" className="rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground focus:outline-none flex-1" />
          <input value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} placeholder="Trigger Phrase" className="rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground focus:outline-none flex-1" />
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
          <button onClick={handleGeneralize} disabled={rawSteps.length === 0} className="flex items-center gap-1.5 rounded-xl bg-violet-500/20 text-violet-300 px-4 py-2 text-xs font-medium hover:bg-violet-500/30 transition disabled:opacity-50">
            <ArrowRight className="h-3.5 w-3.5" /> Generalize
          </button>
        </div>
        <div className="flex-1 grid grid-cols-2 gap-4 min-h-[300px] overflow-hidden">
          <div className="flex flex-col border border-border/50 rounded-xl overflow-hidden bg-card/40">
            <div className="bg-muted/50 px-3 py-2 text-xs font-semibold border-b border-border/50">Raw Recorded Steps ({rawSteps.length})</div>
            <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-muted-foreground font-mono">
              {rawSteps.length > 0 ? JSON.stringify(rawSteps, null, 2) : "Listening to socket..."}
            </pre>
          </div>
          <div className="flex flex-col border border-border/50 rounded-xl overflow-hidden bg-card/40">
            <div className="bg-muted/50 px-3 py-2 text-xs font-semibold border-b border-border/50">Generalized Steps</div>
            <pre className="p-3 text-[10px] overflow-y-auto flex-1 text-foreground font-mono">
              {generalizedSteps.length > 0 ? JSON.stringify(generalizedSteps, null, 2) : "Click Generalize to process steps."}
            </pre>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border/50 px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition">Cancel</button>
          <button onClick={handlePublish} disabled={generalizedSteps.length === 0} className="flex items-center gap-1.5 rounded-xl bg-violet-500 px-4 py-2 text-xs font-medium text-white hover:bg-violet-600 transition disabled:opacity-50">
            <Save className="h-3.5 w-3.5" /> Publish
          </button>
        </div>
      </div>
    </div>
  );
}
