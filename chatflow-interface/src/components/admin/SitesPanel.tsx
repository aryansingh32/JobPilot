import { useEffect, useState, useCallback } from "react";
import { Globe, ChevronLeft, ChevronRight } from "lucide-react";
import { adminApi, type AdminSite } from "@/lib/admin-api";
import { StatusBadge } from "./StatusBadge";

export function SitesPanel() {
  const [sites, setSites] = useState<AdminSite[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.listSites({ limit: PAGE, offset: page * PAGE });
      setSites(r.sites);
      setTotal(r.total);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE);

  function ago(ts: string) {
    const d = Date.now() - new Date(ts).getTime();
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
    return `${Math.floor(d / 86400000)}d ago`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            {total.toLocaleString()} sites registered
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-border/40 bg-card/30 overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/30">
            {["Domain", "Pages", "Status", "Added", ""].map((h) => (
              <div key={h} className="bg-background px-4 py-3">
                {h}
              </div>
            ))}
          </div>
          <div className="divide-y divide-border/20">
            {loading && !sites.length ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading sites…</div>
            ) : !sites.length ? (
              <div className="py-10 text-center text-sm text-muted-foreground">No sites found</div>
            ) : (
              sites.map((s) => (
                <div
                  key={s.id}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] hover:bg-accent/20 transition-colors"
                >
                  <div className="px-4 py-3 flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm text-foreground font-medium truncate">{s.domain}</span>
                  </div>
                  <div className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
                    {(s.page_count ?? 0).toLocaleString()}
                  </div>
                  <div className="px-4 py-3">
                    <StatusBadge status={s.status ?? "active"} />
                  </div>
                  <div className="px-4 py-3 text-xs text-muted-foreground">{ago(s.created_at)}</div>
                  <div className="px-4 py-3" />
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
