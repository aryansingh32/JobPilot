import { useEffect, useState, useCallback } from "react";
import {
  Activity,
  Users,
  Zap,
  CheckCircle2,
  XCircle,
  Server,
  Globe,
  Database,
  Cpu,
  MemoryStick,
  Clock,
  AlertTriangle,
  BrainCircuit,
} from "lucide-react";
import { adminApi, type OverviewData, type SystemHealth, type LLMUsageData } from "@/lib/admin-api";
import { StatCard } from "./StatCard";
import { StatusBadge } from "./StatusBadge";

function bytes(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}

function uptime(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function HealthBar({ label, status, latency }: { label: string; status: string; latency: number }) {
  const ok = status === "ok" || status === "healthy";
  return (
    <div className="flex items-center justify-between rounded-xl border border-border/40 bg-card/60 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"} shadow-lg ${ok ? "shadow-emerald-400/50" : "shadow-red-400/50"}`}
        />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={status} />
        {latency >= 0 && <span className="text-[11px] text-muted-foreground">{latency}ms</span>}
      </div>
    </div>
  );
}

function BrowserDonut({ stats }: { stats: Record<string, unknown> }) {
  const total = (stats?.browsers as number) ?? 0;
  const active = (stats?.activeContexts as number) ?? 0;
  const idle = total - active;
  return (
    <div className="rounded-2xl border border-border/40 bg-card/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Browser Pool
      </p>
      <div className="flex items-end gap-6">
        <div className="text-4xl font-bold text-foreground tabular-nums">{total}</div>
        <div className="flex flex-col gap-1 pb-1">
          <span className="text-xs text-emerald-400">● {active} active leases</span>
          <span className="text-xs text-zinc-400">● {idle} idle</span>
        </div>
      </div>
    </div>
  );
}

function QueueTable({ queues }: { queues: Record<string, unknown> }) {
  const entries = Object.entries(queues || {});
  if (!entries.length) return null;
  return (
    <div className="rounded-2xl border border-border/40 bg-card/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Queue Stats
      </p>
      <div className="space-y-2">
        {entries.map(([name, stats]: [string, any]) => (
          <div key={name} className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground capitalize">{name}</span>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span className="text-amber-400">⏳ {stats?.waiting ?? 0}</span>
              <span className="text-blue-400">▶ {stats?.active ?? 0}</span>
              <span className="text-emerald-400">✓ {stats?.completed ?? 0}</span>
              <span className="text-red-400">✗ {stats?.failed ?? 0}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LLMUsageCard({ usage }: { usage: LLMUsageData | null }) {
  if (!usage) return null;
  return (
    <div className="rounded-2xl border border-border/40 bg-card/60 p-5">
      <div className="flex items-center gap-2 mb-3">
        <BrainCircuit className="h-4 w-4 text-primary" />
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          LLM Call Volume — last {usage.days}d
        </p>
      </div>
      <div className="flex items-end gap-6 mb-3">
        <div className="text-3xl font-bold text-foreground tabular-nums">{usage.totalAiCalls}</div>
        <div className="flex flex-col gap-0.5 pb-1 text-xs text-muted-foreground">
          <span>{usage.totalJobs} jobs</span>
          <span>{usage.avgAiCallsPerJob} calls/job avg</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {Object.entries(usage.models).map(([key, model]) => (
          <div
            key={key}
            className="rounded-lg border border-border/30 bg-card/40 px-2.5 py-1.5 truncate"
          >
            <span className="text-muted-foreground capitalize">{key.replace("Model", "")}: </span>
            <span className="text-foreground font-mono">{model ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [llmUsage, setLlmUsage] = useState<LLMUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const d = await adminApi.overview();
      setData(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    try {
      const u = await adminApi.llmUsage(30);
      setLlmUsage(u);
    } catch {
      /* usage card just stays hidden on transient fetch failure */
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading system overview…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-red-400" />
        <p className="text-sm font-medium text-red-300">{error}</p>
        <button
          onClick={load}
          className="mt-3 rounded-lg bg-red-500/20 px-4 py-2 text-xs text-red-300 hover:bg-red-500/30 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  const h = data?.health;
  const js = data?.jobStats;
  const mem = h?.memory;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className={`h-2.5 w-2.5 rounded-full ${h?.status === "healthy" ? "bg-emerald-400 shadow-emerald-400/60" : "bg-amber-400 shadow-amber-400/60"} shadow-lg`}
        />
        <span
          className={`text-sm font-semibold ${h?.status === "healthy" ? "text-emerald-300" : "text-amber-300"}`}
        >
          System {h?.status === "healthy" ? "Healthy" : "Degraded"}
        </span>
        <span className="text-xs text-muted-foreground ml-2">
          • Node {h?.nodeVersion} on {h?.platform}
        </span>
      </div>

      {/* Stat Cards Row 1 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Active Users"
          value={data?.userCount ?? 0}
          icon={<Users className="h-5 w-5" />}
          color="violet"
          pulse
          subtitle="WebSocket sessions"
        />
        <StatCard
          title="Jobs Today"
          value={js?.total ?? 0}
          subtitle={`${js?.running ?? 0} running now`}
          icon={<Zap className="h-5 w-5" />}
          color="blue"
        />
        <StatCard
          title="Completed"
          value={js?.completed ?? 0}
          subtitle="Last 24 hours"
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="green"
        />
        <StatCard
          title="Failed"
          value={js?.failed ?? 0}
          subtitle="Last 24 hours"
          icon={<XCircle className="h-5 w-5" />}
          color="red"
        />
      </div>

      {/* Stat Cards Row 2 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Uptime"
          value={uptime(h?.uptime ?? 0)}
          icon={<Clock className="h-5 w-5" />}
          color="cyan"
        />
        <StatCard
          title="Heap Used"
          value={bytes(mem?.heapUsed ?? 0)}
          subtitle={`of ${bytes(mem?.heapTotal ?? 0)} heap`}
          icon={<MemoryStick className="h-5 w-5" />}
          color="amber"
        />
        <StatCard
          title="RSS Memory"
          value={bytes(mem?.rss ?? 0)}
          subtitle={`${bytes(mem?.systemFree ?? 0)} sys free`}
          icon={<Cpu className="h-5 w-5" />}
          color="violet"
        />
        <StatCard
          title="CPU Load"
          value={(h?.cpu?.[0] ?? 0).toFixed(2)}
          subtitle={`5m: ${(h?.cpu?.[1] ?? 0).toFixed(2)} · 15m: ${(h?.cpu?.[2] ?? 0).toFixed(2)}`}
          icon={<Activity className="h-5 w-5" />}
          color="blue"
        />
      </div>

      {/* Infrastructure health + queues */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Infrastructure
          </p>
          <HealthBar
            label="PostgreSQL"
            status={h?.db?.status ?? "unknown"}
            latency={h?.db?.latencyMs ?? -1}
          />
          <HealthBar
            label="Redis"
            status={h?.redis?.status ?? "unknown"}
            latency={h?.redis?.latencyMs ?? -1}
          />
          <BrowserDonut stats={(h?.browsers as Record<string, unknown>) ?? {}} />
        </div>
        <QueueTable queues={(data?.queues as Record<string, unknown>) ?? {}} />
      </div>

      <LLMUsageCard usage={llmUsage} />
    </div>
  );
}
