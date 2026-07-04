import { useEffect, useState, useCallback } from "react";
import { Search, Eye, MessageSquare, ChevronLeft, ChevronRight, User } from "lucide-react";
import { adminApi, type AdminUser } from "@/lib/admin-api";
import { StatusBadge } from "./StatusBadge";

const PAGE_SIZE = 50;

function ago(ts: string) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function UserDetailModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [prompts, setPrompts] = useState<any[]>([]);
  const [tab, setTab] = useState<"jobs" | "prompts" | "files">("jobs");

  useEffect(() => {
    adminApi.getUser(userId).then(setData).catch(() => {});
    adminApi.getUserPrompts(userId, 30).then((r) => setPrompts(r.prompts)).catch(() => {});
  }, [userId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl border border-border/60 bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/20 text-primary">
              <User className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">User Profile</h3>
              <p className="text-[11px] font-mono text-muted-foreground">{userId}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition border border-border/40">
            Close
          </button>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 border-b border-border/40 px-6 pt-3">
          {(["jobs", "prompts", "files"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2 px-3 text-xs font-medium capitalize transition border-b-2 ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t} {t === "jobs" && data ? `(${data.jobs?.length ?? 0})` : ""} {t === "files" && data ? `(${data.files?.length ?? 0})` : ""}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-thin">
          {!data ? (
            <div className="flex justify-center py-8">
              <div className="h-8 w-8 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
            </div>
          ) : tab === "jobs" ? (
            <div className="space-y-2">
              {data.jobs?.map((j: any) => (
                <div key={j.job_id} className="flex items-center justify-between rounded-xl border border-border/40 bg-card/60 px-4 py-2.5">
                  <div>
                    <p className="text-xs font-mono text-primary">{j.job_id?.slice(0, 20)}…</p>
                    <p className="text-[11px] text-muted-foreground">{j.type} · {ago(j.started_at)}</p>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
              ))}
            </div>
          ) : tab === "prompts" ? (
            <div className="space-y-2">
              {prompts.map((p) => (
                <div key={p.job_id} className="rounded-xl border border-border/40 bg-card/60 px-4 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <StatusBadge status={p.status} />
                    <span className="text-[10px] text-muted-foreground">{ago(p.started_at)}</span>
                  </div>
                  <p className="text-sm text-foreground line-clamp-2">{p.prompt}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {data.files?.map((f: any) => (
                <div key={f.id} className="flex items-center justify-between rounded-xl border border-border/40 bg-card/60 px-4 py-2.5">
                  <div>
                    <p className="text-xs text-foreground">{f.original_name}</p>
                    <p className="text-[11px] text-muted-foreground">{f.category} · {ago(f.created_at)}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{Math.round((f.file_size_bytes ?? 0) / 1024)} KB</span>
                </div>
              ))}
              {!data.files?.length && <p className="text-sm text-muted-foreground text-center py-4">No files found</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.listUsers({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setUsers(res.users);
      setTotal(res.total);
    } catch {}
    finally { setLoading(false); }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {selectedUserId && <UserDetailModal userId={selectedUserId} onClose={() => setSelectedUserId(null)} />}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{total.toLocaleString()} unique users tracked</p>
      </div>

      <div className="rounded-2xl border border-border/40 bg-card/30 overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.2fr_auto] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/30">
          {["User ID", "Total Jobs", "Completed", "Failed", "Last Active", ""].map((h) => (
            <div key={h} className="bg-background px-4 py-3">{h}</div>
          ))}
        </div>
        <div className="divide-y divide-border/20">
          {loading && !users.length ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading users…</div>
          ) : !users.length ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No users found</div>
          ) : users.map((u) => (
            <div
              key={u.user_id}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_1.2fr_auto] hover:bg-accent/20 cursor-pointer transition-colors"
              onClick={() => setSelectedUserId(u.user_id)}
            >
              <div className="px-4 py-3 font-mono text-xs text-primary truncate">{u.user_id}</div>
              <div className="px-4 py-3 text-xs text-foreground tabular-nums">{Number(u.total_jobs).toLocaleString()}</div>
              <div className="px-4 py-3 text-xs text-emerald-400 tabular-nums">{Number(u.completed_jobs).toLocaleString()}</div>
              <div className="px-4 py-3 text-xs text-red-400 tabular-nums">{Number(u.failed_jobs).toLocaleString()}</div>
              <div className="px-4 py-3 text-xs text-muted-foreground">{ago(u.last_active)}</div>
              <div className="px-4 py-3 flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedUserId(u.user_id); }}
                  className="rounded p-1 text-muted-foreground hover:text-primary transition"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="rounded p-1 text-muted-foreground hover:text-amber-300 transition"
                  title="View prompts"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
