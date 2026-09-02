export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    healthy: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    ok: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    completed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    solved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    running: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    queued: "bg-primary/20 text-primary border-primary/30",
    paused: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    pending: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    degraded: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    failed: "bg-red-500/20 text-red-300 border-red-500/30",
    error: "bg-red-500/20 text-red-300 border-red-500/30",
    cancelled: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
    inactive: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  };
  const cls = map[status?.toLowerCase()] ?? "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}
