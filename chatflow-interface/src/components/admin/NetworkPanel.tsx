import { useEffect, useState, useCallback } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Clock, XCircle, Globe } from "lucide-react";
import { adminApi } from "@/lib/admin-api";
import { StatCard } from "./StatCard";

export function NetworkPanel() {
  const [stats, setStats] = useState<{
    requestsTotal: number;
    requestsFailed: number;
    avgLatencyMs: number;
    timestamp: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<
    { total: number; failed: number; latency: number; ts: number }[]
  >([]);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.networkStats();
      setStats(r);
      setHistory((h) => [
        ...h.slice(-29),
        {
          total: r.requestsTotal,
          failed: r.requestsFailed,
          latency: r.avgLatencyMs,
          ts: Date.now(),
        },
      ]);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const errRate =
    stats && stats.requestsTotal > 0
      ? ((stats.requestsFailed / stats.requestsTotal) * 100).toFixed(2)
      : "0";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Total Requests"
          value={stats?.requestsTotal ?? 0}
          icon={<Globe className="h-5 w-5" />}
          color="blue"
        />
        <StatCard
          title="Failed Requests"
          value={stats?.requestsFailed ?? 0}
          icon={<XCircle className="h-5 w-5" />}
          color="red"
        />
        <StatCard
          title="Avg Latency"
          value={`${stats?.avgLatencyMs ?? 0}ms`}
          icon={<Clock className="h-5 w-5" />}
          color="amber"
        />
        <StatCard
          title="Error Rate"
          value={`${errRate}%`}
          icon={<Activity className="h-5 w-5" />}
          color={Number(errRate) > 5 ? "red" : "green"}
        />
      </div>

      {/* Sparkline-like history */}
      <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Request History (last 30 samples)
        </p>
        <div className="flex items-end gap-1 h-24">
          {history.map((h, i) => {
            const maxReq = Math.max(...history.map((x) => x.total), 1);
            const pct = (h.total / maxReq) * 100;
            return (
              <div
                key={i}
                className="flex-1 flex flex-col items-center justify-end"
                title={`${h.total} reqs, ${h.failed} failed, ${h.latency}ms`}
              >
                <div
                  className={`w-full rounded-t-sm transition-all ${h.failed > 0 ? "bg-red-400/60" : "bg-primary/60"}`}
                  style={{ height: `${Math.max(pct, 2)}%` }}
                />
              </div>
            );
          })}
          {history.length === 0 && (
            <p className="text-xs text-muted-foreground mx-auto">Collecting data…</p>
          )}
        </div>
      </div>

      {/* Latency chart */}
      <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Latency Trend
        </p>
        <div className="flex items-end gap-1 h-20">
          {history.map((h, i) => {
            const maxLat = Math.max(...history.map((x) => x.latency), 1);
            const pct = (h.latency / maxLat) * 100;
            const color =
              h.latency > 500
                ? "bg-red-400/60"
                : h.latency > 200
                  ? "bg-amber-400/60"
                  : "bg-emerald-400/60";
            return (
              <div
                key={i}
                className="flex-1 flex flex-col items-center justify-end"
                title={`${h.latency}ms`}
              >
                <div
                  className={`w-full rounded-t-sm transition-all ${color}`}
                  style={{ height: `${Math.max(pct, 2)}%` }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
