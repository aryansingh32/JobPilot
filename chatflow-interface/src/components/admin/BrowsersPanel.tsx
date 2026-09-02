import { useEffect, useState, useCallback } from "react";
import { Server, RefreshCw, Trash2, Monitor } from "lucide-react";
import { adminApi } from "@/lib/admin-api";
import { StatCard } from "./StatCard";

export function BrowsersPanel() {
  const [stats, setStats] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [recycling, setRecycling] = useState(false);
  const [flushing, setFlushing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.browsers();
      setStats(r.browsers);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, [load]);

  const handleRecycle = async () => {
    setRecycling(true);
    await adminApi.recycleBrowsers().catch(() => {});
    setTimeout(() => {
      setRecycling(false);
      load();
    }, 2000);
  };

  const handleFlushCache = async () => {
    setFlushing(true);
    await adminApi.flushCache("session:*").catch(() => {});
    setTimeout(() => setFlushing(false), 1500);
  };

  const total = stats?.totalBrowsers ?? 0;
  const active = stats?.activeLeasesCount ?? 0;
  const contexts = stats?.totalContexts ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Total Browsers"
          value={total}
          icon={<Server className="h-5 w-5" />}
          color="violet"
        />
        <StatCard
          title="Active Leases"
          value={active}
          icon={<Monitor className="h-5 w-5" />}
          color="blue"
          pulse={active > 0}
        />
        <StatCard
          title="Contexts"
          value={contexts}
          icon={<Server className="h-5 w-5" />}
          color="cyan"
        />
        <StatCard
          title="Idle"
          value={Math.max(0, total - active)}
          icon={<Server className="h-5 w-5" />}
          color="green"
        />
      </div>

      {/* Pool config */}
      <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Pool Configuration
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Object.entries(stats)
            .filter(([k]) => !["totalBrowsers", "activeLeasesCount", "totalContexts"].includes(k))
            .map(([key, val]) => (
              <div key={key} className="rounded-xl border border-border/30 bg-card/60 px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {key.replace(/([A-Z])/g, " $1")}
                </p>
                <p className="text-sm font-medium text-foreground mt-0.5">{String(val)}</p>
              </div>
            ))}
        </div>
      </div>

      {/* Actions */}
      <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Admin Actions
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleRecycle}
            disabled={recycling}
            className="flex items-center gap-2 rounded-xl bg-amber-500/15 border border-amber-500/30 px-4 py-2.5 text-xs font-medium text-amber-300 hover:bg-amber-500/25 transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${recycling ? "animate-spin" : ""}`} />
            {recycling ? "Recycling…" : "Recycle Idle Browsers"}
          </button>
          <button
            onClick={handleFlushCache}
            disabled={flushing}
            className="flex items-center gap-2 rounded-xl bg-red-500/15 border border-red-500/30 px-4 py-2.5 text-xs font-medium text-red-300 hover:bg-red-500/25 transition disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {flushing ? "Flushing…" : "Flush Session Cache"}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-xl border border-border/40 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground transition"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh Stats
          </button>
        </div>
      </div>
    </div>
  );
}
