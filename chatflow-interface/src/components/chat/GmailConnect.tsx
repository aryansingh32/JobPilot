import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { jp } from "@/lib/api-client";
import { keys, useIntegrations } from "@/lib/live";

/**
 * "Connect Gmail" for people who apply with their own address: sign-in codes,
 * verification links and employer replies then reach jobpilot on their own.
 * Read-only; only mail about the user's applications is ever kept.
 */
export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const { data } = useIntegrations();
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Back from Google: ?gmail=connected | failed | access_denied
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("gmail");
    if (!r) return;
    setNote(r === "connected" ? "Gmail is connected. I'll pick up codes and replies from now on." : "Gmail wasn't connected — you can try again any time.");
    q.delete("gmail");
    window.history.replaceState(null, "", `${window.location.pathname}${q.toString() ? `?${q}` : ""}`);
    void qc.invalidateQueries({ queryKey: keys.integrations });
  }, [qc]);

  const gmail = data?.gmail;
  if (!gmail?.available && !gmail?.connection) return null;
  const c = gmail.connection;

  const connect = async () => {
    setBusy("connect");
    try {
      const { url } = await jp.connectGmail();
      window.location.assign(url);
    } catch {
      setBusy(null);
      setNote("Couldn't reach Google just now — try again in a moment.");
    }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    await jp.disconnectGmail().catch(() => {});
    setBusy(null);
    setNote("Gmail is disconnected and its access removed.");
    void qc.invalidateQueries({ queryKey: keys.integrations });
  };
  const sync = async () => {
    setBusy("sync");
    const r = await jp.syncGmail().catch(() => ({ kept: 0 }));
    setBusy(null);
    setNote(r.kept ? `Found ${r.kept} new email${r.kept > 1 ? "s" : ""} about your applications.` : "Nothing new about your applications.");
    void qc.invalidateQueries({ queryKey: ["inbox"] });
  };

  return (
    <div className={`rounded-[16px] border border-border bg-card ${compact ? "p-3" : "p-4"}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-[15px] font-bold text-ink-2" aria-hidden>
          G
        </span>
        <div className="min-w-0 flex-1">
          {c?.status === "active" ? (
            <>
              <div className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
                <Check className="h-4 w-4 text-success" /> Gmail connected
              </div>
              <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                {c.address} · codes and replies about your applications come in by themselves
              </p>
            </>
          ) : (
            <>
              <div className="text-[14px] font-semibold text-foreground">
                {c ? "Gmail needs reconnecting" : "Applying with your Gmail?"}
              </div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                Connect it and I'll read sign-in codes and employer replies for your applications — read-only, nothing else is kept, and I never send mail.
              </p>
            </>
          )}
          {note && <p className="mt-2 text-[12.5px] text-ink-2">{note}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {c?.status === "active" ? (
          <>
            <button onClick={sync} disabled={!!busy} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3.5 text-[13px] font-medium text-ink-2 hover:border-faint disabled:opacity-50">
              {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check now
            </button>
            <button onClick={disconnect} disabled={!!busy} className="inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <button onClick={connect} disabled={!!busy} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy === "connect" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {c ? "Reconnect Gmail" : "Connect Gmail"}
          </button>
        )}
      </div>
    </div>
  );
}
