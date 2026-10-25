import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

// Small building blocks shared by the control panels, in the same visual
// language as the existing admin panels.

export function Section({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border/40 bg-card/30 ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type BtnTone = "primary" | "default" | "danger" | "ghost";
const TONE: Record<BtnTone, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  default: "border border-border/60 bg-background text-foreground hover:bg-accent/50",
  danger: "border border-red-500/30 text-red-400 hover:bg-red-500/10",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-accent/40",
};

export function Btn({
  tone = "default",
  busy,
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${TONE[tone]} ${className}`}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputCls, props.className)} />;
}

const PILL: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-400",
  amber: "bg-amber-500/15 text-amber-400",
  red: "bg-red-500/15 text-red-400",
  blue: "bg-blue-500/15 text-blue-400",
  violet: "bg-primary/15 text-primary",
  gray: "bg-muted text-muted-foreground",
};
export function Pill({ tone = "gray", children }: { tone?: keyof typeof PILL; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${PILL[tone]}`}>{children}</span>;
}

export const statusTone = (s: string): keyof typeof PILL =>
  ["submitted", "completed", "ok", "published", "healthy", "resolved"].includes(s)
    ? "green"
    : ["needs_input", "awaiting_review", "paused", "draft", "pending", "stale"].includes(s)
      ? "amber"
      : ["failed", "error", "cancelled"].includes(s)
        ? "red"
        : ["running", "queued"].includes(s)
          ? "blue"
          : "gray";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-card/30 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

export function ago(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** Load-on-mount with refresh, errors as toasts. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, reload, setData };
}

/** Run an action with a toast; returns true on success. */
export async function act(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    toast.success(label);
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

/** JSON textarea that only reports valid values upward. */
export function JsonEditor({
  value,
  onChange,
  rows = 14,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  rows?: number;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
    // Only resync when the value identity changes from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="space-y-1">
      <textarea
        value={text}
        rows={rows}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setError(null);
            onChange(v);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        className={`${inputCls} font-mono text-[12px] leading-relaxed ${error ? "border-red-500/60" : ""}`}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-border/40 bg-card/30 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            value === t.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
