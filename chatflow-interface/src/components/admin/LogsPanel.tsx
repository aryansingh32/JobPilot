import { useEffect, useState, useCallback, useRef } from "react";
import { Download, AlertCircle, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { adminApi, type LogEntry, type ErrorReportRow } from "@/lib/admin-api";

const SERVICES = ["api", "worker", "execution", "auth", "system"];
const LOG_LEVELS: Record<string, string> = {
  info: "text-blue-300",
  warn: "text-amber-300",
  error: "text-red-400",
  debug: "text-zinc-400",
};

export function LogsPanel() {
  const [service, setService] = useState("api");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getLogs(service, 300);
      setEntries(res.entries);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load();
    if (!autoRefresh) return;
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load, autoRefresh]);

  useEffect(() => {
    if (autoRefresh) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, autoRefresh]);

  const filtered = filter
    ? entries.filter((e) => JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()))
    : entries;

  return (
    <div className="flex flex-col gap-4" style={{ height: "calc(100vh - 160px)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5">
          {SERVICES.map((s) => (
            <button
              key={s}
              onClick={() => setService(s)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition capitalize ${
                service === s
                  ? "bg-primary/20 text-primary border border-primary/40"
                  : "bg-card/60 text-muted-foreground border border-border/40"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="rounded-xl border border-border/50 bg-card/60 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none w-40"
        />
        <label
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => setAutoRefresh((v) => !v)}
        >
          <div
            className={`relative h-5 w-9 rounded-full transition-colors ${autoRefresh ? "bg-primary" : "bg-zinc-700"}`}
          >
            <div
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${autoRefresh ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </div>
          <span className="text-xs text-muted-foreground">Live</span>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} entries</span>
      </div>

      <div className="flex-1 overflow-y-auto rounded-2xl border border-border/40 bg-background p-4 font-mono text-xs scroll-thin">
        {loading && !entries.length ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !filtered.length ? (
          <p className="text-muted-foreground">No entries</p>
        ) : (
          filtered.map((entry, i) => {
            const level = String(entry.level ?? "").toLowerCase();
            const cls =
              Object.entries(LOG_LEVELS).find(([k]) => level.includes(k))?.[1] ?? "text-zinc-300";
            const ts = entry.timestamp
              ? new Date(entry.timestamp as string).toLocaleTimeString()
              : "";
            const msg = String(entry.message ?? entry.msg ?? JSON.stringify(entry));
            return (
              <div key={i} className="flex gap-2 py-0.5 hover:bg-white/5 rounded">
                <span className="shrink-0 text-zinc-600 w-20">{ts}</span>
                <span className={`shrink-0 w-12 uppercase ${cls}`}>
                  {level.slice(0, 5) || "LOG"}
                </span>
                <span className="text-zinc-300 break-all">{msg.slice(0, 300)}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export function ErrorsPanel() {
  const [redisErrors, setRedisErrors] = useState<LogEntry[]>([]);
  const [dbErrors, setDbErrors] = useState<ErrorReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([adminApi.getErrors(120), adminApi.listObsErrors(80)]);
      setRedisErrors(r.errors);
      setDbErrors(d.errors);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-medium text-foreground">Error intelligence (Postgres)</span>
        </div>
        {loading && !dbErrors.length ? (
          <div className="py-6 text-sm text-muted-foreground">Loading enriched errors…</div>
        ) : !dbErrors.length ? (
          <div className="rounded-2xl border border-border/40 bg-card/30 py-8 text-center text-sm text-muted-foreground">
            No persisted errors yet. 5xx API failures are captured automatically.
          </div>
        ) : (
          <div className="space-y-2">
            {dbErrors.map((e) => {
              const open = openId === e.id;
              return (
                <div
                  key={e.id}
                  className="rounded-xl border border-rose-500/25 bg-gradient-to-r from-rose-950/30 to-transparent px-4 py-3"
                >
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-2 text-left"
                    onClick={() => setOpenId(open ? null : e.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {open ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-sm text-rose-100">{e.message.slice(0, 220)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono">id {e.id.slice(0, 8)}…</span>
                        {e.http_status != null ? <span>HTTP {e.http_status}</span> : null}
                        {e.route ? <span className="truncate">{e.route}</span> : null}
                        {e.trace_id ? (
                          <span className="font-mono">
                            trace {String(e.trace_id).slice(0, 12)}…
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[10px] text-muted-foreground">
                        {e.ts ? new Date(e.ts).toLocaleString() : ""}
                      </span>
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void copyId(e.id);
                        }}
                        className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="h-3 w-3" />
                        Copy id
                      </button>
                    </div>
                  </button>
                  {open ? (
                    <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-white/10 bg-black/50 p-3 text-[11px] leading-relaxed text-zinc-200">
                      {JSON.stringify(
                        {
                          id: e.id,
                          message: e.message,
                          stack: e.stack,
                          context: e.context,
                          fingerprint: e.fingerprint,
                          request_id: e.request_id,
                          trace_id: e.trace_id,
                          user_id: e.user_id,
                          session_id: e.session_id,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Download className="h-4 w-4" />
          Redis error stream (legacy tail)
        </div>
        {!redisErrors.length ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 py-6 text-center text-sm text-emerald-400">
            ✓ No tail entries
          </div>
        ) : (
          redisErrors.map((err, i) => (
            <div
              key={i}
              className="mb-2 rounded-lg border border-border/30 bg-card/20 px-3 py-2 font-mono text-[11px] text-zinc-300"
            >
              {String(err.message ?? err.msg ?? JSON.stringify(err))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
