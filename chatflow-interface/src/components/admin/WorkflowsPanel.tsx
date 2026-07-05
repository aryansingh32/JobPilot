import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, X, Save, Search, ToggleLeft, ToggleRight, Video } from "lucide-react";
import { adminApi, type AdminWorkflow } from "@/lib/admin-api";
import { toast } from "sonner";
import { StatusBadge } from "./StatusBadge";
import { RecordWorkflowModal } from "./RecordWorkflowModal";

const EMPTY: Partial<AdminWorkflow> = {
  name: "", site_id: "", trigger: "", instructions: "", portal_type: "general",
  entry_url: "", page_url: "", category: "", is_active: true, version: 1,
};

function WorkflowModal({ wf, onSave, onClose }: {
  wf: Partial<AdminWorkflow> | null; onSave: (d: Partial<AdminWorkflow>) => void; onClose: () => void;
}) {
  const [form, setForm] = useState<Partial<AdminWorkflow>>(wf ?? { ...EMPTY });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const isNew = !wf?.id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border/60 bg-background p-6 shadow-2xl scroll-thin">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-foreground">{isNew ? "Create Workflow" : "Edit Workflow"}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent transition"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {([
            ["name", "Name", "text"], ["site_id", "Site ID", "text"], ["trigger", "Trigger", "text"],
            ["portal_type", "Portal Type", "text"], ["category", "Category", "text"], ["entry_url", "Entry URL", "text"],
            ["page_url", "Page URL", "text"], ["version", "Version", "number"],
          ] as const).map(([key, label, type]) => (
            <div key={key}>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
              <input value={String(form[key as keyof Partial<AdminWorkflow>] ?? "")} onChange={(e) => set(key, type === "number" ? Number(e.target.value) : e.target.value)}
                className="mt-1 w-full rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none" />
            </div>
          ))}
        </div>
        <div className="mt-3">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Instructions</label>
          <textarea value={form.instructions ?? ""} onChange={(e) => set("instructions", e.target.value)} rows={5}
            className="mt-1 w-full rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none resize-y" />
        </div>
        <div className="mt-3">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Captcha Policy</label>
          <select 
            value={form.captcha_policy ?? "default"} 
            onChange={(e) => set("captcha_policy", e.target.value)}
            className="mt-1 w-full rounded-xl border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground focus:border-primary/60 focus:outline-none"
          >
            <option value="default">Default</option>
            <option value="grid">Grid</option>
            <option value="slider">Slider</option>
            <option value="click">Click</option>
          </select>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => set("is_active", !form.is_active)} className="flex items-center gap-2 text-sm text-foreground">
            {form.is_active ? <ToggleRight className="h-5 w-5 text-emerald-400" /> : <ToggleLeft className="h-5 w-5 text-zinc-500" />}
            {form.is_active ? "Active" : "Inactive"}
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border/50 px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition">Cancel</button>
          <button onClick={() => onSave(form)} className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-primary/90 transition">
            <Save className="h-3.5 w-3.5" /> {isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkflowsPanel() {
  const [workflows, setWorkflows] = useState<AdminWorkflow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<AdminWorkflow> | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await adminApi.listWorkflows({ limit: 100 }); setWorkflows(r.workflows); setTotal(r.total); }
    catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data: Partial<AdminWorkflow>) => {
    try {
      if (data.id) { await adminApi.updateWorkflow(data.id, data); }
      else {
        await adminApi.createWorkflow({
          ...data, siteId: data.site_id, isActive: data.is_active ?? true,
          portalType: data.portal_type, entryUrl: data.entry_url, pageUrl: data.page_url,
        } as any);
      }
      setEditing(null); setShowCreate(false); setShowRecord(false); load();
    } catch (e: any) {
      toast.error(e.message || "Failed to save workflow");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this workflow?")) return;
    await adminApi.deleteWorkflow(id).catch(() => {}); load();
  };

  const filtered = search ? workflows.filter((w) => w.name.toLowerCase().includes(search.toLowerCase()) || w.site_id?.toLowerCase().includes(search.toLowerCase())) : workflows;

  return (
    <div className="space-y-4">
      {(showCreate || editing) && <WorkflowModal wf={editing ?? { ...EMPTY }} onSave={handleSave} onClose={() => { setEditing(null); setShowCreate(false); }} />}
      {showRecord && <RecordWorkflowModal onPublish={handleSave} onClose={() => setShowRecord(false)} />}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search workflows…"
              className="rounded-xl border border-border/50 bg-card/60 pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none w-56" />
          </div>
          <span className="text-xs text-muted-foreground">{total} workflows</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowRecord(true)}
            className="flex items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600 transition">
            <Video className="h-3.5 w-3.5" /> Record New Workflow
          </button>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-primary/90 transition">
            <Plus className="h-3.5 w-3.5" /> New Workflow
          </button>
        </div>
      </div>

      <div className="grid gap-3">
        {loading && !workflows.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !filtered.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No workflows found</div>
        ) : filtered.map((wf) => (
          <div key={wf.id} className="group rounded-2xl border border-border/40 bg-card/40 p-5 hover:border-primary/30 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-foreground truncate">{wf.name}</h3>
                  <StatusBadge status={wf.is_active ? "active" : "inactive"} />
                  {wf.portal_type && <span className="text-[10px] rounded-full bg-primary/15 text-primary px-2 py-0.5 capitalize">{wf.portal_type}</span>}
                </div>
                <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{wf.instructions?.slice(0, 150)}</p>
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span>Site: <span className="text-foreground font-mono">{wf.site_id}</span></span>
                  <span>Trigger: <span className="text-amber-300">{wf.trigger}</span></span>
                  {wf.version && <span>v{wf.version}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
                <button onClick={() => setEditing(wf)} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-primary transition"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => handleDelete(wf.id)} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-red-400 transition"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
