import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { jp, type ProfileGapDTO } from "@/lib/api-client";

/**
 * "This job needs the details below." — the facts almost every form refuses to submit without, asked once
 * before the run starts instead of one at a time while a browser waits. Saved to the profile, so the next
 * application doesn't ask again.
 */
export function ProfileGapsDialog({
  gaps,
  title,
  onClose,
  onDone,
}: {
  gaps: ProfileGapDTO[] | null;
  title?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues({});
    setError(null);
  }, [gaps]);

  const open = !!gaps?.length;
  const ready = !!gaps?.every((g) => !g.blocking || values[g.key]?.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await jp.saveProfileGaps(values);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogTitle>This job needs a few details</DialogTitle>
        <DialogDescription>
          {title ? `${title} — ` : ""}almost every form asks for these. Add them once and I'll remember them for every application.
        </DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void save();
          }}
        >
          {gaps?.map((g) => (
            <div key={g.key}>
              <label className="mb-1 block text-[13px] font-medium text-foreground">{g.label}</label>
              {g.input === "choice" && g.options ? (
                <div className="flex flex-wrap gap-1.5">
                  {g.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setValues((v) => ({ ...v, [g.key]: o }))}
                      className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${
                        values[g.key] === o ? "border-primary bg-primary text-primary-foreground" : "border-border text-ink-2 hover:border-faint"
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  value={values[g.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [g.key]: e.target.value }))}
                  placeholder={g.hint}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:border-primary"
                />
              )}
              {g.input === "choice" && g.hint && <p className="mt-1 text-[12px] text-muted-foreground">{g.hint}</p>}
            </div>
          ))}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={!ready || busy}
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-[14px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save and apply
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
