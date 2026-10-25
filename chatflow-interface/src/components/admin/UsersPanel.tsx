import { useEffect, useState, useCallback } from "react";
import { Eye, MessageSquare, ChevronLeft, ChevronRight, User, Megaphone } from "lucide-react";
import { adminApi, type AdminUser, type CreditLedgerRow, type UserNotificationRow } from "@/lib/admin-api";
import { StatusBadge } from "./StatusBadge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Btn, Field, Pill, TextInput, act, ago as agoOrDash } from "./kit";

const PAGE_SIZE = 50;

function ago(ts: string) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

/** Credits, sign-in state, export/delete and notifications for one account. */
function AccountTab({ userId, suspended, onChanged, onDeleted }: { userId: string; suspended: boolean; onChanged: () => void; onDeleted: () => void }) {
  const [credits, setCredits] = useState<{ balance: number; ledger: CreditLedgerRow[] } | null>(null);
  const [notes, setNotes] = useState<{ notifications: UserNotificationRow[]; devices: { platform: string; app_version: string | null; last_seen_at: string }[] } | null>(null);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.userCredits(userId).then(setCredits).catch(() => {});
    adminApi.userNotifications(userId).then(setNotes).catch(() => {});
  }, [userId]);
  useEffect(load, [load]);

  const run = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    const ok = await act(label, fn);
    setBusy(null);
    if (ok) {
      load();
      onChanged();
    }
    return ok;
  };

  const exportJson = async () => {
    setBusy("export");
    await act("Export downloaded", async () => {
      const data = await adminApi.exportUser(userId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `user-${userId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    setBusy(null);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Credits</p>
          <p className="text-xl font-semibold tabular-nums text-foreground">{credits?.balance ?? "…"}</p>
        </div>
        <div className="grid grid-cols-[100px_1fr_auto] items-end gap-2">
          <Field label="Change">
            <TextInput value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+10 or -5" inputMode="numeric" />
          </Field>
          <Field label="Reason">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (shown in the ledger)" />
          </Field>
          <Btn
            tone="primary"
            busy={busy === "credits"}
            disabled={!Number.isInteger(Number(delta)) || Number(delta) === 0 || !note.trim()}
            onClick={async () => {
              if (await run("credits", "Credits updated", () => adminApi.adjustCredits(userId, Number(delta), note.trim()))) {
                setDelta("");
                setNote("");
              }
            }}
          >
            Apply
          </Btn>
        </div>
        <div className="max-h-48 space-y-1 overflow-y-auto scroll-thin">
          {credits?.ledger.map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-lg border border-border/30 px-3 py-1.5 text-[11px]">
              <span className="text-muted-foreground">
                {l.reason}
                {l.application_title ? ` · ${l.application_title}` : ""}
                {l.note ? ` · ${l.note}` : ""}
              </span>
              <span className="flex items-center gap-3 tabular-nums">
                <span className={l.delta > 0 ? "text-emerald-400" : l.delta < 0 ? "text-red-400" : "text-muted-foreground"}>
                  {l.delta > 0 ? `+${l.delta}` : l.delta}
                </span>
                <span className="text-muted-foreground">= {l.balance_after}</span>
                <span className="text-muted-foreground">{agoOrDash(l.created_at)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Access</p>
        <div className="flex flex-wrap gap-2">
          <Btn busy={busy === "logout"} onClick={() => run("logout", "Signed out on every device", () => adminApi.logoutUser(userId))}>
            Sign out everywhere
          </Btn>
          <Btn
            tone={suspended ? "default" : "danger"}
            busy={busy === "suspend"}
            onClick={() => run("suspend", suspended ? "Account restored" : "Account suspended", () => adminApi.suspendUser(userId, !suspended))}
          >
            {suspended ? "Unsuspend" : "Suspend"}
          </Btn>
          <Btn busy={busy === "export"} onClick={exportJson}>
            Export data
          </Btn>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Notifications · {notes?.devices.length ?? 0} {notes?.devices.length === 1 ? "phone" : "phones"}
        </p>
        <div className="max-h-40 space-y-1 overflow-y-auto scroll-thin">
          {notes?.notifications.map((n) => (
            <div key={n.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/30 px-3 py-1.5 text-[11px]">
              <span className="truncate text-foreground">
                {n.title}
                <span className="text-muted-foreground"> · {n.body}</span>
              </span>
              <span className="shrink-0 text-muted-foreground">{n.read ? "read" : "unread"} · {agoOrDash(n.created_at)}</span>
            </div>
          ))}
          {notes && !notes.notifications.length && <p className="text-[11px] text-muted-foreground">None yet</p>}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-red-500/30 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-red-400">Delete account</p>
        <p className="text-[11px] text-muted-foreground">
          Cancels running applications, then permanently deletes the account, profile, applications, inbox, files and credits.
          Type the user id to confirm.
        </p>
        <div className="flex gap-2">
          <TextInput value={confirmId} onChange={(e) => setConfirmId(e.target.value)} placeholder={userId} className="font-mono text-xs" />
          <Btn
            tone="danger"
            busy={busy === "delete"}
            disabled={confirmId.trim() !== userId}
            onClick={async () => {
              if (await run("delete", "Account deleted", () => adminApi.deleteUser(userId))) onDeleted();
            }}
          >
            Delete
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** Announcement to every user (in-app bell + push to their phones). */
function Announcement() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<{ devices: number; sent_24h: number; pushed_24h: number; pushConfigured: boolean } | null>(null);
  useEffect(() => {
    adminApi.notificationStats().then(setStats).catch(() => {});
  }, [open]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stats && (
        <span className="text-[11px] text-muted-foreground">
          {stats.devices} phones · {stats.sent_24h} notifications today · push {stats.pushConfigured ? "on" : "not configured"}
        </span>
      )}
      <Btn onClick={() => setOpen((o) => !o)}>
        <Megaphone className="h-3.5 w-3.5" /> Send announcement
      </Btn>
      {open && (
        <div className="flex w-full flex-wrap items-end gap-2 rounded-xl border border-border/40 bg-card/30 p-3">
          <div className="min-w-[180px] flex-1">
            <Field label="Title">
              <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
          </div>
          <div className="min-w-[240px] flex-[2]">
            <Field label="Message">
              <TextInput value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <Btn
            tone="primary"
            busy={busy}
            disabled={!title.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await act("Announcement sent", () => adminApi.broadcast(title.trim(), body.trim()));
              setBusy(false);
              if (ok) {
                setTitle("");
                setBody("");
                setOpen(false);
              }
            }}
          >
            Send to everyone
          </Btn>
        </div>
      )}
    </div>
  );
}

function UserDetailModal({ user, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void }) {
  const userId = user.user_id;
  const [data, setData] = useState<any>(null);
  const [prompts, setPrompts] = useState<any[]>([]);
  const [tab, setTab] = useState<"account" | "jobs" | "prompts" | "files">("account");

  useEffect(() => {
    adminApi
      .getUser(userId)
      .then(setData)
      .catch(() => {});
    adminApi
      .getUserPrompts(userId, 30)
      .then((r) => setPrompts(r.prompts))
      .catch(() => {});
  }, [userId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden p-0">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
              {user.display_name || user.email || user.mobile_number || "User Profile"}
              {user.suspended && <Pill tone="red">Suspended</Pill>}
            </DialogTitle>
            <p className="truncate text-[11px] font-mono text-muted-foreground">{userId}</p>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-border/40 px-6 pt-3 scroll-thin">
          {(["account", "jobs", "prompts", "files"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`shrink-0 whitespace-nowrap pb-2 px-3 text-xs font-medium capitalize transition border-b-2 ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t} {t === "jobs" && data ? `(${data.jobs?.length ?? 0})` : ""}{" "}
              {t === "files" && data ? `(${data.files?.length ?? 0})` : ""}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-thin">
          {tab === "account" ? (
            <AccountTab
              userId={userId}
              suspended={!!user.suspended}
              onChanged={onChanged}
              onDeleted={() => {
                onChanged();
                onClose();
              }}
            />
          ) : !data ? (
            <div className="flex justify-center py-8">
              <div className="h-8 w-8 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
            </div>
          ) : tab === "jobs" ? (
            <div className="space-y-2">
              {data.jobs?.map((j: any) => (
                <div
                  key={j.job_id}
                  className="flex items-center justify-between rounded-xl border border-border/40 bg-card/60 px-4 py-2.5"
                >
                  <div>
                    <p className="text-xs font-mono text-primary">{j.job_id?.slice(0, 20)}…</p>
                    <p className="text-[11px] text-muted-foreground">
                      {j.type} · {ago(j.started_at)}
                    </p>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
              ))}
            </div>
          ) : tab === "prompts" ? (
            <div className="space-y-2">
              {prompts.map((p) => (
                <div
                  key={p.job_id}
                  className="rounded-xl border border-border/40 bg-card/60 px-4 py-3"
                >
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
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded-xl border border-border/40 bg-card/60 px-4 py-2.5"
                >
                  <div>
                    <p className="text-xs text-foreground">{f.original_name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {f.category} · {ago(f.created_at)}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {Math.round((f.file_size_bytes ?? 0) / 1024)} KB
                  </span>
                </div>
              ))}
              {!data.files?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">No files found</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Connected Gmail accounts: health at a glance, force a check, or cut access. */
function MailConnections() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof adminApi.mailConnections>> | null>(null);
  const load = useCallback(() => adminApi.mailConnections().then(setData).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [load, open]);
  if (!data) return null;
  const active = data.connections.filter((c) => c.status === "active").length;
  const failing = data.connections.filter((c) => c.status !== "active" || c.last_error).length;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">
        Gmail: {data.configured ? `${active} connected${failing ? ` · ${failing} need attention` : ""}` : "not configured (GOOGLE_CLIENT_ID / SECRET)"}
        {data.configured && !data.available ? " · switched off in Settings (features.gmail)" : ""}
      </span>
      {data.connections.length > 0 && <Btn onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Gmail connections"}</Btn>}
      {open && (
        <div className="w-full overflow-x-auto rounded-xl border border-border/40 bg-card/30">
          <table className="w-full text-[12px]">
            <thead className="text-left text-muted-foreground">
              <tr><th className="p-2">User</th><th className="p-2">Gmail</th><th className="p-2">Status</th><th className="p-2">Last check</th><th className="p-2">Kept</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {data.connections.map((c) => (
                <tr key={c.id} className="border-t border-border/30">
                  <td className="p-2">{c.user_email ?? c.user_id.slice(0, 8)}</td>
                  <td className="p-2">{c.address}</td>
                  <td className="p-2">
                    <Pill tone={c.status === "active" && !c.last_error ? "green" : "amber"}>{c.last_error ? "error" : c.status}</Pill>
                    {c.last_error && <div className="mt-1 max-w-[220px] truncate text-muted-foreground" title={c.last_error}>{c.last_error}</div>}
                  </td>
                  <td className="p-2">{agoOrDash(c.last_sync_at)}</td>
                  <td className="p-2">{c.messages_kept}</td>
                  <td className="p-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Btn onClick={async () => { await act("Checked", () => adminApi.gmailSync(c.user_id)); void load(); }}>Check now</Btn>
                      <Btn tone="danger" onClick={async () => { await act("Gmail disconnected", () => adminApi.gmailDisconnect(c.user_id)); void load(); }}>Disconnect</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selectedUser = users.find((u) => u.user_id === selectedUserId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.listUsers({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, q: query.trim() || undefined });
      setUsers(res.users);
      setTotal(res.total);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {selectedUser && (
        <UserDetailModal user={selectedUser} onClose={() => setSelectedUserId(null)} onChanged={load} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">{total.toLocaleString()} accounts</p>
          <TextInput
            value={query}
            onChange={(e) => {
              setPage(0);
              setQuery(e.target.value);
            }}
            placeholder="Search email, phone, name or id"
            className="w-64 py-1.5 text-xs"
          />
        </div>
        <Announcement />
        <MailConnections />
      </div>

      <div className="rounded-2xl border border-border/40 bg-card/30 overflow-x-auto">
        <div className="min-w-[680px]">
          <div className="grid grid-cols-[2.4fr_0.8fr_1fr_1fr_1fr_1.2fr_auto] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/30">
            {["User", "Credits", "Applications", "Sent", "Failed", "Last Active", ""].map((h) => (
              <div key={h} className="bg-background px-4 py-3">
                {h}
              </div>
            ))}
          </div>
          <div className="divide-y divide-border/20">
            {loading && !users.length ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading users…</div>
            ) : !users.length ? (
              <div className="py-10 text-center text-sm text-muted-foreground">No users found</div>
            ) : (
              users.map((u) => (
                <div
                  key={u.user_id}
                  className="grid grid-cols-[2.4fr_0.8fr_1fr_1fr_1fr_1.2fr_auto] hover:bg-accent/20 cursor-pointer transition-colors"
                  onClick={() => setSelectedUserId(u.user_id)}
                >
                  <div className="min-w-0 px-4 py-3">
                    <div className="flex items-center gap-2 truncate text-xs text-foreground">
                      {u.display_name || u.email || u.mobile_number || "—"}
                      {u.suspended && <Pill tone="red">Suspended</Pill>}
                      {!!u.devices && <Pill tone="blue">app</Pill>}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{u.user_id}</div>
                  </div>
                  <div className="px-4 py-3 text-xs text-foreground tabular-nums">{u.credits ?? "—"}</div>
                  <div className="px-4 py-3 text-xs text-foreground tabular-nums">
                    {Number(u.total_jobs).toLocaleString()}
                  </div>
                  <div className="px-4 py-3 text-xs text-emerald-400 tabular-nums">
                    {Number(u.completed_jobs).toLocaleString()}
                  </div>
                  <div className="px-4 py-3 text-xs text-red-400 tabular-nums">
                    {Number(u.failed_jobs).toLocaleString()}
                  </div>
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    {ago(u.last_active)}
                  </div>
                  <div className="px-4 py-3 flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedUserId(u.user_id);
                      }}
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
              ))
            )}
          </div>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
