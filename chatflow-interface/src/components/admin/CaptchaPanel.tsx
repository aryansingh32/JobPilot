import { useEffect, useState, useCallback } from "react";
import { Puzzle, MousePointerClick, Zap, Clock, CheckCircle2, XCircle, Send } from "lucide-react";
import { adminApi, type CaptchaItem } from "@/lib/admin-api";
import { StatCard } from "./StatCard";

export function CaptchaPanel() {
  const [captchas, setCaptchas] = useState<CaptchaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [solvingId, setSolvingId] = useState<string | null>(null);
  const [solution, setSolution] = useState("");

  const load = useCallback(async () => {
    try { const r = await adminApi.pendingCaptchas(); setCaptchas(r.captchas); }
    catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, [load]);

  const handleSolve = async (captchaId: string) => {
    if (!solution.trim()) return;
    await adminApi.solveCaptcha(captchaId, solution).catch(() => {});
    setSolvingId(null); setSolution(""); load();
  };

  const pending = captchas.filter((c) => c.status === "pending");
  const solved = captchas.filter((c) => c.status === "solved");
  const failed = captchas.filter((c) => c.status === "failed");

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="Pending" value={pending.length} icon={<Clock className="h-5 w-5" />} color="amber" pulse={pending.length > 0} />
        <StatCard title="Solved" value={solved.length} icon={<CheckCircle2 className="h-5 w-5" />} color="green" />
        <StatCard title="Failed" value={failed.length} icon={<XCircle className="h-5 w-5" />} color="red" />
        <StatCard title="Total" value={captchas.length} icon={<Puzzle className="h-5 w-5" />} color="violet" />
      </div>

      {/* How it works info */}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <MousePointerClick className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-primary">Universal Captcha Solver</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          When the bot encounters a captcha, it captures a screenshot and pushes it here.
          <strong className="text-foreground"> For standard users:</strong> the captcha image is forwarded to the user's chat — they click/type the solution and it's relayed back to the bot.
          <strong className="text-foreground"> For premium users:</strong> an external API (2Captcha, hCaptcha Solver) is used automatically.
          For Google image-selection captchas, the user clicks on the images in the chat interface and those click coordinates are sent to the bot to replay.
        </p>
        <div className="mt-3 flex gap-4 text-[11px]">
          <span className="flex items-center gap-1 text-emerald-400"><Zap className="h-3 w-3" /> Auto-retry on failure (3 attempts)</span>
          <span className="flex items-center gap-1 text-amber-400"><Clock className="h-3 w-3" /> 90s timeout per captcha</span>
        </div>
      </div>

      {/* Pending captchas */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Pending Captchas</p>
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
                      <span className="ml-2 text-xs text-muted-foreground font-mono">{c.id.slice(0, 12)}…</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Site: {c.siteId}</p>
                  </div>
                  {solvingId === c.id ? (
                    <div className="flex items-center gap-2">
                      <input value={solution} onChange={(e) => setSolution(e.target.value)} placeholder="Solution…"
                        className="rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs text-foreground focus:border-primary/60 focus:outline-none w-40"
                        onKeyDown={(e) => { if (e.key === "Enter") handleSolve(c.id); }} autoFocus />
                      <button onClick={() => handleSolve(c.id)}
                        className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition">
                        <Send className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setSolvingId(null)}
                        className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => { setSolvingId(c.id); setSolution(""); }}
                      className="rounded-xl bg-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/30 transition">
                      Solve Manually
                    </button>
                  )}
                </div>
                {/* If payload has an image */}
                {(c.payload as any)?.imageUrl && (
                  <div className="mt-3 rounded-xl border border-border/40 overflow-hidden bg-black">
                    <img src={(c.payload as any).imageUrl} alt="captcha" className="max-h-48 w-auto mx-auto" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
