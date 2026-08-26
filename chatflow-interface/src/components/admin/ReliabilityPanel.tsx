import { useEffect, useState, useCallback } from "react";
import { ShieldAlert, ShieldCheck, HeartPulse, Search } from "lucide-react";
import { adminApi, type CircuitBreakerRow, type SelectorHealthRow } from "@/lib/admin-api";
import { StatCard } from "./StatCard";

export function ReliabilityPanel() {
  const [breakers, setBreakers] = useState<CircuitBreakerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState("");
  const [health, setHealth] = useState<SelectorHealthRow[] | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.circuitBreakers();
      setBreakers(r.breakers);
    } catch {
      /* keep last known breakers on transient fetch failure */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const lookupHealth = async () => {
    if (!siteId.trim()) return;
    setHealthLoading(true);
    setHealthError(null);
    try {
      const r = await adminApi.selectorHealth(siteId.trim());
      setHealth(r.report);
    } catch (e) {
      setHealth(null);
      setHealthError(e instanceof Error ? e.message : "Failed to load selector health");
    } finally {
      setHealthLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard
          title="Open Circuit Breakers"
          value={breakers.length}
          icon={<ShieldAlert className="h-5 w-5" />}
          color={breakers.length > 0 ? "red" : "green"}
          pulse={breakers.length > 0}
        />
        <StatCard
          title="Healthy Sites"
          value={breakers.length === 0 ? "All clear" : "—"}
          icon={<ShieldCheck className="h-5 w-5" />}
          color="green"
        />
        <StatCard
          title="Selector Types Checked"
          value={health?.length ?? 0}
          icon={<HeartPulse className="h-5 w-5" />}
          color="cyan"
        />
      </div>

      {/* Circuit breakers */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Circuit Breakers (per-site auto-pause after repeated failures)
        </p>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !breakers.length ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 py-8 text-center text-sm text-emerald-400">
            ✓ No open breakers — all sites executing normally
          </div>
        ) : (
          <div className="grid gap-3">
            {breakers.map((b) => (
              <div
                key={b.siteId}
                className="flex items-center justify-between rounded-2xl border border-red-500/20 bg-card/60 p-4"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{b.siteId}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Jobs against this site are paused after 5 consecutive failures
                  </p>
                </div>
                <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-medium text-red-300">
                  Resets in {Math.max(0, b.resetInSeconds)}s
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Selector health lookup */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Selector Health Report
        </p>
        <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
          <div className="flex gap-2 mb-4">
            <input
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") lookupHealth();
              }}
              placeholder="Site ID…"
              className="flex-1 rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-sm text-foreground focus:border-primary/60 focus:outline-none"
            />
            <button
              onClick={lookupHealth}
              disabled={healthLoading || !siteId.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-primary/20 px-4 py-2 text-xs font-medium text-primary hover:bg-primary/30 transition disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {healthLoading ? "Loading…" : "Check"}
            </button>
          </div>

          {healthError && <p className="text-xs text-red-400">{healthError}</p>}

          {health &&
            (health.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No selectors recorded for this site yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[520px]">
                  <div className="grid grid-cols-5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/30 pb-2">
                    <div>Element Type</div>
                    <div>Total Selectors</div>
                    <div>Avg Confidence</div>
                    <div>Total Failures</div>
                    <div>Broken (≥5 fails)</div>
                  </div>
                  <div className="divide-y divide-border/20">
                    {health.map((row) => (
                      <div key={row.type} className="grid grid-cols-5 py-2.5 text-sm">
                        <div className="text-foreground font-medium">{row.type}</div>
                        <div className="text-muted-foreground tabular-nums">
                          {row.total_selectors}
                        </div>
                        <div className="text-muted-foreground tabular-nums">
                          {row.avg_confidence ? Number(row.avg_confidence).toFixed(2) : "—"}
                        </div>
                        <div className="text-muted-foreground tabular-nums">
                          {row.total_failures}
                        </div>
                        <div
                          className={
                            Number(row.broken_selectors) > 0
                              ? "text-red-400 tabular-nums"
                              : "text-muted-foreground tabular-nums"
                          }
                        >
                          {row.broken_selectors}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
