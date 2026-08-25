import { useEffect, useState, useCallback } from "react";
import { Search, XCircle, RotateCcw, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import { adminApi, type AdminJob } from "@/lib/admin-api";
import { StatusBadge } from "./StatusBadge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const STATUS_FILTERS = ["all", "running", "queued", "completed", "failed", "paused", "cancelled"];
const PAGE_SIZE = 50;

function ago(ts: string) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${Math.floor(d / 3600000)}h ago`;
}

function JobDetailModal({ job, onClose }: { job: AdminJob; onClose: () => void }) {
  const resultText = job.result ? JSON.stringify(job.result, null, 2) : "";
  const runtimeText = job.runtime ? JSON.stringify(job.runtime, null, 2) : "";
  const missingError = job.status === "failed" && !job.error;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto scroll-thin">
        <DialogTitle className="text-lg font-semibold text-foreground">Job Details</DialogTitle>
        <p className="text-xs text-muted-foreground font-mono -mt-3 mb-1">{job.job_id}</p>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          {[
            ["Status", <StatusBadge status={job.status} />],
            ["Type", job.type],
            ["User", job.user_id],
            ["Started", job.started_at ? new Date(job.started_at).toLocaleString() : "—"],
            ["Completed", job.completed_at ? new Date(job.completed_at).toLocaleString() : "—"],
          ].map(([label, val]) => (
            <div key={String(label)} className="rounded-xl border border-border/40 bg-card/60 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                {label as string}
              </p>
              <div className="text-foreground font-medium">{val as any}</div>
            </div>
          ))}
        </div>
        {job.task && (
          <div className="mt-3 rounded-xl border border-border/40 bg-card/60 p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Task / Prompt
            </p>
            <p className="text-sm text-foreground">{job.task}</p>
          </div>
        )}
        {job.error && (
          <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-[10px] text-red-400 uppercase tracking-wider mb-1">Error</p>
            <p className="text-sm text-red-300 font-mono">{job.error}</p>
          </div>
        )}
        {missingError && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-[10px] text-amber-400 uppercase tracking-wider mb-1">Error</p>
            <p className="text-sm text-amber-200">
              No error text was captured for this older failed job.
            </p>
          </div>
        )}
        {(resultText || runtimeText) && (
          <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-border/40 bg-black/20 p-3">
            {resultText && (
              <>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  Result
                </p>
                <pre className="mb-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {resultText}
                </pre>
              </>
            )}
            {runtimeText && (
              <>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  Runtime
                </p>
                <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {runtimeText}
                </pre>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function JobsPanel() {
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AdminJob | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.listJobs({
        status: statusFilter !== "all" ? statusFilter : undefined,
        userId: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setJobs(res.jobs);
      setTotal(res.total);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, page]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const handleCancel = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await adminApi.cancelJob(jobId).catch(() => {});
    load();
  };

  const handleRetry = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await adminApi.retryJob(jobId).catch(() => {});
    load();
  };

  const openJob = async (job: AdminJob) => {
    setSelected(job);
    try {
      const detail = await adminApi.getJob(job.job_id);
      setSelected({
        ...job,
        ...detail.job,
        runtime: detail.runtime,
      });
    } catch {}
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {selected && <JobDetailModal job={selected} onClose={() => setSelected(null)} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Filter by user ID…"
            className="w-full rounded-xl border border-border/50 bg-card/60 pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none"
          />
        </div>
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(0);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition capitalize ${
                statusFilter === s
                  ? "bg-primary/20 text-primary border border-primary/40"
                  : "bg-card/60 text-muted-foreground border border-border/40 hover:border-primary/30"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {total.toLocaleString()} total
        </span>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-border/40 bg-card/30 overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_auto] gap-px bg-border/20 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {["Job ID", "Type", "User", "Started", "Status", "Actions"].map((h) => (
              <div key={h} className="bg-background px-4 py-3">
                {h}
              </div>
            ))}
          </div>
          <div className="divide-y divide-border/20">
            {loading && !jobs.length ? (
              <div className="py-12 text-center text-sm text-muted-foreground">Loading jobs…</div>
            ) : !jobs.length ? (
              <div className="py-12 text-center text-sm text-muted-foreground">No jobs found</div>
            ) : (
              jobs.map((job) => (
                <div key={job.job_id}>
                  <div
                    onClick={() => openJob(job)}
                    className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_auto] gap-px bg-transparent hover:bg-accent/20 cursor-pointer transition-colors"
                  >
                    <div className="bg-transparent px-4 py-3 font-mono text-xs text-primary truncate">
                      {job.job_id.slice(0, 16)}…
                    </div>
                    <div className="px-4 py-3 text-xs text-foreground capitalize">{job.type}</div>
                    <div className="px-4 py-3 text-xs text-muted-foreground truncate">
                      {job.user_id}
                    </div>
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      {ago(job.started_at)}
                    </div>
                    <div className="px-4 py-3">
                      <StatusBadge status={job.status} />
                    </div>
                    <div
                      className="px-4 py-3 flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => openJob(job)}
                        className="rounded p-1 text-muted-foreground hover:text-primary transition"
                        title="View"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {(job.status === "running" || job.status === "queued") && (
                        <button
                          onClick={(e) => handleCancel(job.job_id, e)}
                          className="rounded p-1 text-muted-foreground hover:text-red-400 transition"
                          title="Cancel"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {job.status === "failed" && (
                        <button
                          onClick={(e) => handleRetry(job.job_id, e)}
                          className="rounded p-1 text-muted-foreground hover:text-emerald-400 transition"
                          title="Retry"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {job.status === "failed" && job.error && (
                    <div className="col-span-full px-4 py-2 bg-red-500/5 border-t border-red-500/20">
                      <p className="text-xs text-red-400 font-mono truncate" title={job.error}>
                        ⚠ {job.error}
                      </p>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
