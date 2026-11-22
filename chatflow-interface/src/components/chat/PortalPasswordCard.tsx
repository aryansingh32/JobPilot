import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { jp } from "@/lib/api-client";

/**
 * One password the person chooses for employer portals (Workday, iCIMS…). When the bot has to create an
 * account on a portal it uses this one, so the person can always sign in to that portal by hand too.
 * Write-only: the server says whether one is set, never what it is.
 */
export function PortalPasswordCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["portal-password"], queryFn: () => jp.portalPassword() });
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data?.set) setEditing(false);
  }, [data?.set]);

  const set = !!data?.set;
  const refresh = () => qc.invalidateQueries({ queryKey: ["portal-password"] });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await jp.setPortalPassword(value);
      setValue("");
      setEditing(false);
      toast.success("Portal password saved");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    await jp.clearPortalPassword().catch(() => {});
    setBusy(false);
    await refresh();
  };

  return (
    <div className="rounded-[18px] border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
          <KeyRound className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
            Portal password {set && <Check className="h-4 w-4 text-success" />}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Many big employers (Workday, iCIMS, Oracle) make you create an account first. Pick one password here and I'll use
            it for every new account — so you can always sign in to those portals yourself. It's stored encrypted and I
            never show it back.
          </p>
        </div>
      </div>
      {editing || !set ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="10+ characters, upper & lower case, a number and a symbol"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:border-primary"
          />
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || value.length < 10}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save password
            </button>
            {set && (
              <button type="button" onClick={() => setEditing(false)} className="h-9 rounded-full px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          <button onClick={() => setEditing(true)} className="h-9 rounded-full border border-border px-3.5 text-[13px] font-medium text-ink-2 hover:border-faint">
            Change
          </button>
          <button onClick={clear} disabled={busy} className="h-9 rounded-full px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
