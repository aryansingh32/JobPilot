import { ShieldCheck, Key, Lock, Eye, EyeOff, Copy, Check } from "lucide-react";
import { useState } from "react";
import { config } from "@/lib/config";

function MaskedKey({ label, value }: { label: string; value: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const masked = value ? "•".repeat(Math.min(value.length, 24)) : "not set";

  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-2xl border border-border/40 bg-card/40 p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono text-foreground truncate">
          {visible ? value || "not set" : masked}
        </code>
        <button
          onClick={() => setVisible((v) => !v)}
          className="rounded p-1 text-muted-foreground hover:text-foreground transition"
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        {value && (
          <button
            onClick={copy}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export function SecurityPanel() {
  return (
    <div className="space-y-6">
      {/* Security status */}
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          <span className="text-sm font-semibold text-emerald-300">Security Overview</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3 lg:grid-cols-4">
          {[
            ["API Auth", "Active — x-api-key"],
            ["User Auth", "Session cookie (Google / email / mobile)"],
            ["Admin Auth", "Session cookie — login required"],
            ["CORS", "Configured"],
            ["Rate Limiting", "100 req/min"],
          ].map(([label, val]) => (
            <div
              key={label}
              className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2"
            >
              <p className="text-[10px] text-emerald-400/70 uppercase tracking-wider">{label}</p>
              <p className="text-xs text-emerald-300 font-medium mt-0.5">{val}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Auth keys (masked) */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
          <Key className="h-3.5 w-3.5" /> Authentication Keys
        </p>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MaskedKey label="API Key (x-api-key)" value={config.apiKey} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          There is no admin key in the browser anymore — the admin panel authenticates via an
          httpOnly session cookie issued at login, which client-side JS can never read.
        </p>
      </div>

      {/* Security checklist */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
          <Lock className="h-3.5 w-3.5" /> Security Checklist
        </p>
        <div className="space-y-2">
          {[
            { ok: true, msg: "API key authentication on all protected routes" },
            { ok: true, msg: "Admin key required for /admin/* endpoints" },
            { ok: true, msg: "CORS origin whitelist configured" },
            { ok: true, msg: "Rate limiting: 100 requests/minute" },
            { ok: true, msg: "WebSocket auth via session join event" },
            { ok: false, msg: "JWT / SSO not yet enabled (planned)" },
            { ok: false, msg: "RBAC (role-based access) not yet enabled (planned)" },
            { ok: true, msg: "Sensitive data masked in memory profiles" },
            { ok: true, msg: "File uploads scanned for MIME type" },
            { ok: true, msg: "SQL injection protected via parameterized queries" },
          ].map(({ ok, msg }, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 ${ok ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}`}
            >
              <span className={`text-sm ${ok ? "text-emerald-400" : "text-amber-400"}`}>
                {ok ? "✓" : "⚠"}
              </span>
              <span className="text-xs text-foreground">{msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
