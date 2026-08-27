import { useEffect, useState, useCallback } from "react";
import {
  Puzzle,
  MousePointerClick,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  Send,
  DollarSign,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import {
  adminApi,
  type CaptchaItem,
  type CaptchaSpend,
  type CaptchaMetrics,
  type CaptchaProviderStatus,
} from "@/lib/admin-api";
import { StatCard } from "./StatCard";

export function CaptchaPanel() {
  const [captchas, setCaptchas] = useState<CaptchaItem[]>([]);
  const [spend, setSpend] = useState<CaptchaSpend | null>(null);
  const [metrics, setMetrics] = useState<CaptchaMetrics | null>(null);
  const [providers, setProviders] = useState<CaptchaProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [solvingId, setSolvingId] = useState<string | null>(null);
  const [solution, setSolution] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await adminApi.pendingCaptchas();
      setCaptchas(r.captchas);
    } catch {
    } finally {
      setLoading(false);
    }
    try {
      const s = await adminApi.captchaSpend();
      setSpend(s);
    } catch {
      /* spend card just stays hidden on transient fetch failure */
    }
    try {
      const m = await adminApi.captchaMetrics(30);
      setMetrics(m);
    } catch {
      /* metrics card just stays hidden on transient fetch failure */
    }
    try {
      const p = await adminApi.captchaProviders();
      setProviders(p.providers);
    } catch {
      /* provider row just stays hidden on transient fetch failure */
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const handleSolve = async (captchaId: string) => {
    if (!solution.trim()) return;
    await adminApi.solveCaptcha(captchaId, solution).catch(() => {});
    setSolvingId(null);
    setSolution("");
    load();
  };

  const pending = captchas.filter((c) => c.status === "pending");
  const solved = captchas.filter((c) => c.status === "solved");
  const failed = captchas.filter((c) => c.status === "failed");

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Pending"
          value={pending.length}
          icon={<Clock className="h-5 w-5" />}
          color="amber"
          pulse={pending.length > 0}
        />
        <StatCard
          title="Solved"
          value={solved.length}
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="green"
        />
        <StatCard
          title="Failed"
          value={failed.length}
          icon={<XCircle className="h-5 w-5" />}
          color="red"
        />
        <StatCard
          title="Total"
          value={captchas.length}
          icon={<Puzzle className="h-5 w-5" />}
          color="violet"
        />
      </div>

      {/* How it works info */}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <MousePointerClick className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-primary">Universal Captcha Solver</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          A CAPTCHA/verification checkpoint is first tried against a free in-browser solve
          (checkbox/audio/slider), then — <strong className="text-foreground">only for premium
          users within their plan's monthly limit</strong> — a paid provider API. Anything left
          unsolved, plus OTP/MFA/login-verification checkpoints and security blocks (WAF /
          rate-limit / JS interstitial, never bypassed), falls to
          <strong className="text-foreground"> human-in-the-loop</strong>: the live browser view
          in the user's chat, or this queue, whichever answers first.
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-[11px]">
          <span className="flex items-center gap-1 text-emerald-400">
            <Zap className="h-3 w-3" /> Bounded auto-attempts, never an endless retry loop
          </span>
          <span className="flex items-center gap-1 text-amber-400">
            <Clock className="h-3 w-3" /> Idle timeout per checkpoint (default 3 min)
          </span>
        </div>
      </div>

      {/* Solver providers */}
      {providers.length > 0 && (
        <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Solver Providers
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {providers.map((p) => (
              <div
                key={p.id}
                className={`flex items-center justify-between rounded-xl border px-3 py-2 text-xs ${
                  p.configured
                    ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                    : "border-border/40 bg-card/40 text-muted-foreground"
                }`}
              >
                <span className="font-medium">{p.id}</span>
                {p.configured ? (
                  <ShieldCheck className="h-3.5 w-3.5" />
                ) : (
                  <ShieldOff className="h-3.5 w-3.5" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Intervention metrics (last 30 days) */}
      {metrics && metrics.totals.events > 0 && (
        <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Checkpoints — last {metrics.days} days
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <MetricTile label="Total" value={metrics.totals.events} />
            <MetricTile label="Resolved" value={metrics.totals.resolved} tone="green" />
            <MetricTile label="Failed" value={metrics.totals.failed} tone="red" />
            <MetricTile label="Timed out" value={metrics.totals.timeout} tone="amber" />
            <MetricTile
              label="Avg time"
              value={
                metrics.totals.avgDurationMs != null
                  ? `${Math.round(metrics.totals.avgDurationMs / 1000)}s`
                  : "—"
              }
            />
          </div>
          {metrics.byEventType.length > 0 && (
            <div className="mt-4 space-y-1.5">
              {metrics.byEventType.map((row) => (
                <div
                  key={row.eventType}
                  className="flex items-center justify-between rounded-lg bg-card/60 px-3 py-1.5 text-xs"
                >
                  <span className="text-foreground">{row.eventType.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">
                    {row.resolvedCount}/{row.count} resolved
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Premium solver spend */}
      {spend && (
        <div className="rounded-2xl border border-border/40 bg-card/40 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Premium Solver Spend — {spend.currentMonth}
              </span>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${
                spend.premiumConfigured
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {spend.premiumConfigured ? "Provider configured" : "No provider key set"}
            </span>
          </div>
          <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${
                spend.currentSpend / Math.max(spend.maxMonthlySpend, 0.0001) > 0.9
                  ? "bg-red-500"
                  : "bg-primary"
              }`}
              style={{
                width: `${Math.min(100, (spend.currentSpend / Math.max(spend.maxMonthlySpend, 0.0001)) * 100)}%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            ${spend.currentSpend.toFixed(3)} spent of ${spend.maxMonthlySpend.toFixed(2)} monthly
            cap — ${spend.remaining.toFixed(3)} remaining. Past the cap, solves fall back to
            human-in-the-loop.
          </p>
        </div>
      )}

      {/* Pending captchas */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Pending Captchas
        </p>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !pending.length ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 py-8 text-center text-sm text-emerald-400">
            ✓ No pending captchas — all clear
          </div>
        ) : (
          <div className="grid gap-3">
            {pending.map((c) => (
              <div key={c.id} className="rounded-2xl border border-amber-500/20 bg-card/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {c.type} captcha
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        {c.id.slice(0, 12)}…
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Site: {c.siteId}</p>
                  </div>
                  {solvingId === c.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={solution}
                        onChange={(e) => setSolution(e.target.value)}
                        placeholder="Solution…"
                        className="rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none w-40"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSolve(c.id);
                        }}
                        autoFocus
                      />
                      <button
                        onClick={() => handleSolve(c.id)}
                        className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setSolvingId(null)}
                        className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setSolvingId(c.id);
                        setSolution("");
                      }}
                      className="rounded-xl bg-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/30 transition"
                    >
                      Solve Manually
                    </button>
                  )}
                </div>
                {/* If payload has an image */}
                {((c.payload as any)?.captchaUrl || (c.payload as any)?.imageUrl) && (
                  <div className="mt-3 rounded-xl border border-border/40 overflow-hidden bg-black">
                    <img
                      src={(c.payload as any).captchaUrl ?? (c.payload as any).imageUrl}
                      alt="captcha"
                      className="max-h-48 w-auto mx-auto"
                    />
                  </div>
                )}
                {(c.payload as any)?.contextMessage && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {(c.payload as any).contextMessage}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "green" | "red" | "amber";
}) {
  const toneClass =
    tone === "green"
      ? "text-emerald-400"
      : tone === "red"
        ? "text-red-400"
        : tone === "amber"
          ? "text-amber-400"
          : "text-foreground";
  return (
    <div className="rounded-xl bg-card/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
