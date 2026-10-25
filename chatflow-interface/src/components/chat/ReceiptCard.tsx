import { useState } from "react";
import { Check, Copy, Download, ExternalLink, FileText, Timer, XCircle } from "lucide-react";
import type { ReceiptMessage } from "@/lib/chat-types";

type Tab = "details" | "files" | "steps";

export function ReceiptCard({ msg }: { msg: ReceiptMessage }) {
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "details", label: "Details" },
    ...(msg.files?.length ? [{ id: "files" as Tab, label: "Files", count: msg.files.length }] : []),
    ...(msg.steps?.length ? [{ id: "steps" as Tab, label: "Steps", count: msg.steps.length }] : []),
  ];
  const [tab, setTab] = useState<Tab>("details");
  const [copied, setCopied] = useState(false);
  const failed = msg.status === "failed";
  const fieldCount = msg.sections.reduce((n, s) => n + s.items.length, 0);

  const copyRef = () => {
    if (!msg.reference) return;
    navigator.clipboard?.writeText(msg.reference).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(13,24,40,0.04)]">
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pb-3 pt-4 sm:px-5">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
            failed ? "bg-destructive/10 text-destructive" : "bg-primary text-primary-foreground"
          }`}
        >
          {failed ? (
            <XCircle className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" strokeWidth={2.5} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-bold leading-tight text-foreground">{msg.title}</h3>
          {msg.site && <p className="mt-0.5 text-[13px] text-muted-foreground">{msg.site}</p>}
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold ${
            failed
              ? "bg-destructive/10 text-destructive"
              : "bg-primary-soft text-primary-soft-foreground"
          }`}
        >
          {failed ? "Failed" : msg.status === "submitted" ? "Submitted" : "Completed"}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pb-3 text-[12px] text-muted-foreground sm:px-5">
        {msg.reference && (
          <button onClick={copyRef} className="flex items-center gap-1.5 hover:text-foreground">
            <span className="eyebrow !tracking-[0.08em]">Ref</span>
            <span className="font-semibold text-foreground">{msg.reference}</span>
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </button>
        )}
        {msg.durationMs !== undefined && (
          <span className="flex items-center gap-1">
            <Timer className="h-3.5 w-3.5" /> Done in {formatDuration(msg.durationMs)}
          </span>
        )}
        <span>
          {new Date(msg.completedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
        {!failed && fieldCount > 0 && <span>{fieldCount} fields sent</span>}
        {msg.siteUrl && (
          <a
            href={msg.siteUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 font-medium hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View original
          </a>
        )}
      </div>

      {/* Tabs */}
      {tabs.length > 1 && (
        <div className="flex gap-1 border-y border-border bg-background px-3 py-1.5 sm:px-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                tab === t.id
                  ? "bg-card text-foreground shadow-[0_1px_2px_rgba(13,24,40,0.08)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.count !== undefined && <span className="ml-1 text-faint">{t.count}</span>}
            </button>
          ))}
        </div>
      )}

      <div className={`px-4 py-3.5 sm:px-5 ${tabs.length > 1 ? "" : "border-t border-border"}`}>
        {tab === "details" && (
          <div className="space-y-4">
            {msg.sections.map((s) => (
              <div key={s.title}>
                <div className="eyebrow mb-2">{s.title}</div>
                <dl className="divide-y divide-border rounded-[14px] border border-border">
                  {s.items.map((it) => (
                    <div
                      key={it.label}
                      className="flex flex-col gap-0.5 px-3.5 py-2.5 text-[13px] sm:flex-row sm:gap-3"
                    >
                      <dt className="shrink-0 text-[12px] text-muted-foreground sm:w-[38%] sm:text-[13px]">
                        {it.label}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words font-medium text-foreground">
                        <Check className="mr-1.5 inline h-3 w-3 text-success" />
                        {it.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}

        {tab === "files" && (
          <div className="space-y-2">
            {msg.files!.map((f) => (
              <div
                key={f.name}
                className="flex items-center gap-3 rounded-[14px] border border-border px-3 py-2.5"
              >
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-foreground">{f.name}</div>
                  {f.sizeLabel && <div className="text-[12px] text-faint">{f.sizeLabel}</div>}
                </div>
                {f.downloadUrl && (
                  <a
                    href={f.downloadUrl}
                    className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:border-faint"
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "steps" && (
          <ol className="relative ml-1.5 space-y-3 border-l border-border pl-4">
            {msg.steps!.map((s, i) => (
              <li key={i} className="relative text-[13px]">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                <span className="text-foreground">{s.label}</span>
                <span className="ml-2 text-[12px] text-faint">{formatDuration(s.atMs)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {msg.nextSteps?.length ? (
        <div className="border-t border-border bg-background px-4 py-3 sm:px-5">
          <div className="eyebrow mb-2">What next</div>
          <div className="flex flex-wrap gap-2">
            {msg.nextSteps.map((s) => (
              <button
                key={s}
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("agent-suggest", { detail: s }))
                }
                className="rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
