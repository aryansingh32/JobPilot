import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Clock, ChevronRight } from "lucide-react";
import { adminApi, type ObsSessionRow, type ObsTimelineEvent } from "@/lib/admin-api";

export function SessionIntelPanel() {
  const [sessions, setSessions] = useState<ObsSessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ObsTimelineEvent[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await adminApi.listObsSessions(80);
      setSessions(r.sessions);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    const t = setInterval(loadSessions, 12000);
    return () => clearInterval(t);
  }, [loadSessions]);

  useEffect(() => {
    if (!selected) {
      setTimeline([]);
      return;
    }
    void adminApi
      .sessionTimeline(selected, 400)
      .then((r) => setTimeline(r.events))
      .catch(() => setTimeline([]));
  }, [selected]);

  return (
    <div className="grid gap-4 lg:grid-cols-2" style={{ minHeight: "calc(100vh - 180px)" }}>
      <div className="flex flex-col rounded-2xl border border-border/40 bg-card/30">
        <div className="border-b border-border/30 px-4 py-3 text-sm font-medium">Sessions (client + server events)</div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {!sessions.length ? (
            <p className="p-4 text-sm text-muted-foreground">No session telemetry yet — browse the app to ingest events.</p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                onClick={() => setSelected(s.session_id)}
                className={`flex w-full items-center gap-2 border-b border-border/20 px-4 py-2.5 text-left text-sm transition hover:bg-white/5 ${
                  selected === s.session_id ? "bg-primary/10" : ""
                }`}
              >
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-foreground">{s.session_id}</div>
                  <div className="text-[10px] text-muted-foreground">
                    user {s.user_id ?? "—"} · {s.event_count} events
                  </div>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {s.last_ts ? new Date(s.last_ts).toLocaleString() : ""}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-col rounded-2xl border border-border/40 bg-background">
        <div className="flex items-center gap-2 border-b border-border/30 px-4 py-3 text-sm font-medium">
          <Clock className="h-4 w-4 text-cyan-400" />
          Timeline {selected ? `· ${selected.slice(0, 8)}…` : ""}
        </div>
        <div className="flex-1 overflow-y-auto p-3 scroll-thin">
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select a session to replay its timeline.</p>
          ) : !timeline.length ? (
            <p className="text-sm text-muted-foreground">No events for this session.</p>
          ) : (
            <div className="space-y-2">
              {timeline.map((ev) => {
                const id = String(ev.id);
                const open = expanded === id;
                return (
                  <motion.div
                    key={id}
                    layout
                    className="rounded-xl border border-white/5 bg-black/25 px-3 py-2 text-xs"
                  >
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
                      onClick={() => setExpanded(open ? null : id)}
                    >
                      <span className="font-mono text-cyan-300/90">{ev.event_type}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {ev.ts ? new Date(ev.ts as string).toLocaleTimeString() : ""}
                      </span>
                    </button>
                    {ev.route ? <div className="mt-1 text-[10px] text-primary/80">{String(ev.route)}</div> : null}
                    {open ? (
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] text-zinc-200">
                        {JSON.stringify(ev.payload ?? {}, null, 2)}
                      </pre>
                    ) : null}
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
