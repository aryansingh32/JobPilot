import { useEffect, useState, useCallback } from "react";
import { Database, BarChart3 } from "lucide-react";
import { adminApi } from "@/lib/admin-api";

export function MetricsPanel() {
  const [raw, setRaw] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { const r = await adminApi.metrics(); setRaw(r); } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  // Parse Prometheus text into structured rows
  const parsed = raw
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([^\s{]+)(\{[^}]*\})?\s+([\d.e+\-NaInf]+)(.*)$/);
      if (!match) return null;
      return { name: match[1], labels: match[2] ?? "", value: match[3] };
    })
    .filter(Boolean) as { name: string; labels: string; value: string }[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Prometheus Metrics</span>
          <span className="text-xs text-muted-foreground">({parsed.length} metrics)</span>
        </div>
        <button onClick={load}
          className="rounded-lg border border-border/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition">
          Refresh
        </button>
      </div>

      {loading && !raw ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading metrics…</div>
      ) : (
        <>
          {/* Key metrics highlight */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {parsed.slice(0, 8).map((m, i) => (
              <div key={i} className="rounded-2xl border border-border/40 bg-card/40 p-4 hover:border-primary/30 transition">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">{m!.name.replace(/_/g, " ")}</p>
                <p className="mt-1 text-xl font-bold text-foreground tabular-nums">
                  {isNaN(Number(m!.value)) ? m!.value : Number(m!.value).toLocaleString()}
                </p>
                {m!.labels && <p className="text-[10px] text-muted-foreground mt-1 truncate">{m!.labels}</p>}
              </div>
            ))}
          </div>

          {/* Raw Prometheus output */}
          <div className="rounded-2xl border border-border/40 bg-background overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border/30 px-4 py-2.5">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-mono">Raw /metrics output</span>
            </div>
            <pre className="overflow-auto p-4 text-[11px] font-mono text-zinc-400 max-h-96 scroll-thin">{raw}</pre>
          </div>
        </>
      )}
    </div>
  );
}
