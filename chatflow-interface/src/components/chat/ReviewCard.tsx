import { useMemo, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Lock,
  PenLine,
  Send,
  Sparkles,
  UserRound,
  CircleAlert,
  Check,
  X,
} from "lucide-react";
import type { FieldSource, ReviewField, ReviewMessage } from "@/lib/chat-types";
import { resolveReview } from "@/lib/backend-connector";

const SOURCE_META: Record<FieldSource, { label: string; className: string; icon: typeof Lock }> = {
  profile: {
    label: "From profile",
    className: "bg-muted text-muted-foreground",
    icon: UserRound,
  },
  memory: {
    label: "Remembered",
    className: "bg-muted text-muted-foreground",
    icon: UserRound,
  },
  user: {
    label: "Your answer",
    className: "bg-muted text-muted-foreground",
    icon: UserRound,
  },
  edited: {
    label: "You edited",
    className: "bg-primary-soft text-primary-soft-foreground",
    icon: PenLine,
  },
  workflow: {
    label: "Site step",
    className: "bg-muted text-muted-foreground",
    icon: UserRound,
  },
  default: {
    label: "Prefer not to say",
    className: "bg-muted text-muted-foreground",
    icon: Lock,
  },
  ai: {
    label: "Check this",
    className: "bg-warning-soft text-warning-soft-foreground",
    icon: Sparkles,
  },
  missing: {
    label: "Needs you",
    className: "bg-destructive/10 text-destructive",
    icon: CircleAlert,
  },
};

/** "All 10 answers ready — 7 from your profile, 2 remembered, 1 from you." */
function summaryLine(counts: Partial<Record<FieldSource, number>>, total: number): string {
  const parts = [
    counts.profile && `${counts.profile} from your profile`,
    counts.memory && `${counts.memory} remembered`,
    (counts.user || counts.edited) && `${(counts.user ?? 0) + (counts.edited ?? 0)} from you`,
    counts.workflow && `${counts.workflow} by the site's steps`,
    counts.default && `${counts.default} prefer-not-to-say`,
  ].filter(Boolean);
  return `All ${total} answers ready${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
}

export function ReviewCard({ msg }: { msg: ReviewMessage }) {
  if (msg.resolved) return <ResolvedReview msg={msg} />;
  return <PendingReview msg={msg} />;
}

function PendingReview({ msg }: { msg: ReviewMessage }) {
  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const s of msg.sections) for (const f of s.fields) v[f.id] = f.value ?? "";
    return v;
  }, [msg.sections]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [submitting, setSubmitting] = useState(false);

  const allFields = msg.sections.flatMap((s) => s.fields);
  const sourceOf = (f: ReviewField): FieldSource => {
    if (values[f.id] !== initial[f.id]) return "edited";
    if (f.required && !values[f.id]?.trim()) return "missing";
    return f.source;
  };
  const counts = allFields.reduce(
    (acc, f) => {
      const s = sourceOf(f);
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<FieldSource, number>>,
  );
  const attention = (counts.ai ?? 0) + (counts.missing ?? 0);
  const blocking = allFields.filter((f) => f.required && !values[f.id]?.trim()).length;

  const finish = async (action: "approved" | "cancelled") => {
    setSubmitting(true);
    await resolveReview(msg, action, values);
  };

  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(13,24,40,0.04)]">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning-soft-foreground">
          <PenLine className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[14px] font-semibold text-foreground">Review before submit</h3>
            <span className="rounded-full bg-warning-soft px-2.5 py-0.5 text-[11px] font-semibold text-warning-soft-foreground">
              Waiting for your approval
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            Check what I filled in
            {msg.site ? (
              <>
                {" "}
                for <span className="font-semibold text-foreground">{msg.site}</span>
              </>
            ) : null}{" "}
            and fix anything. Nothing is sent until you tap{" "}
            <span className="font-semibold text-foreground">{msg.actionLabel}</span>.
          </p>
        </div>
        {msg.siteUrl && (
          <a
            href={msg.siteUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden shrink-0 items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground sm:flex"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View page
          </a>
        )}
      </div>

      {/* One-line summary: only what needs a look */}
      <div className="px-4 pt-3 sm:px-5">
        {attention > 0 ? (
          <div className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[13px] font-medium text-warning-soft-foreground">
            <Sparkles className="h-4 w-4 shrink-0" />
            {attention} answer{attention > 1 ? "s" : ""} need{attention > 1 ? "" : "s"} a quick look
            — the rest came from your profile.
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl bg-primary-soft px-3 py-2 text-[13px] font-medium text-primary-soft-foreground">
            <Check className="h-4 w-4 shrink-0" />
            {summaryLine(counts, allFields.length)}
          </div>
        )}
      </div>

      {/* Sections */}
      <div className="scroll-thin space-y-2 px-4 py-3 sm:max-h-[480px] sm:overflow-y-auto sm:px-5">
        {msg.sections.map((section, i) => (
          <Section
            key={section.id}
            title={section.title}
            count={section.fields.length}
            needsAttention={section.fields.some((f) => ["ai", "missing"].includes(sourceOf(f)))}
            defaultOpen={
              section.fields.some((f) => ["ai", "missing"].includes(f.source)) ||
              (i === 0 && attention === 0)
            }
          >
            {section.fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                value={values[f.id] ?? ""}
                source={sourceOf(f)}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.id]: v }))}
              />
            ))}
          </Section>
        ))}
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 sm:static sm:px-5">
        <span className="min-w-0 text-[12px] leading-snug text-muted-foreground">
          {blocking > 0 ? `${blocking} to fill` : "Ready"}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => finish("cancelled")}
            disabled={submitting}
            className="rounded-full px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => finish("approved")}
            disabled={submitting || blocking > 0}
            className="flex items-center gap-2 whitespace-nowrap rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            {msg.actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  needsAttention,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  needsAttention: boolean;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[14px] border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        {needsAttention && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
        <span className="ml-auto text-[12px] text-faint">{count} fields</span>
        <ChevronDown
          className={`h-4 w-4 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && <div className="space-y-4 border-t border-border px-3.5 py-3.5">{children}</div>}
    </div>
  );
}

function FieldRow({
  field,
  value,
  source,
  onChange,
}: {
  field: ReviewField;
  value: string;
  source: FieldSource;
  onChange: (v: string) => void;
}) {
  const inputClass = `w-full rounded-xl border px-3 py-2 text-[14px] text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring/20 ${
    field.locked
      ? "cursor-not-allowed border-border bg-muted text-ink-2"
      : source === "ai"
        ? "border-warning/40 bg-card focus:border-primary"
        : source === "missing"
          ? "border-destructive/40 bg-card focus:border-primary"
          : "border-border bg-card focus:border-primary"
  }`;

  return (
    <div>
      <div className="mb-1.5 flex items-start gap-2">
        <label htmlFor={field.id} className="eyebrow flex min-w-0 items-center gap-1 leading-snug">
          {field.locked && <Lock className="h-3 w-3" />}
          {field.label}
          {field.required && <span className="text-destructive">*</span>}
        </label>
        {(source === "ai" || source === "missing" || source === "user") && (
          <span className="ml-auto shrink-0">
            <SourceBadge source={source} />
          </span>
        )}
      </div>

      {field.kind === "file" ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2 text-[13px] text-ink-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          {value || "No file attached"}
        </div>
      ) : field.kind === "textarea" ? (
        <textarea
          id={field.id}
          value={value}
          disabled={field.locked}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={`${inputClass} resize-y leading-relaxed`}
        />
      ) : field.kind === "boolean" ? (
        <div className="flex gap-2">
          {["Yes", "No"].map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={field.locked}
              onClick={() => onChange(opt)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                value === opt
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-ink-2 hover:border-faint"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : field.kind === "select" && field.options?.length ? (
        <div className="flex flex-wrap gap-2">
          {field.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={field.locked}
              onClick={() => onChange(opt.value)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                value === opt.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-ink-2 hover:border-faint"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <input
          id={field.id}
          type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
          value={value}
          disabled={field.locked}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}

      {field.locked && <p className="mt-1 text-[11px] text-faint">Edit in your profile.</p>}
      {!field.locked && field.hint && source === "ai" && (
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{field.hint}</p>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: FieldSource }) {
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function ResolvedReview({ msg }: { msg: ReviewMessage }) {
  const approved = msg.resolved!.action === "approved";
  const total = msg.sections.reduce((n, s) => n + s.fields.length, 0);
  return (
    <div className="flex items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-3">
      <span
        className={`grid h-7 w-7 place-items-center rounded-full ${
          approved
            ? "bg-primary-soft text-primary-soft-foreground"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {approved ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">
          {approved ? "Approved" : "Cancelled"}
          {msg.site ? ` · ${msg.site}` : ""}
        </div>
        <div className="text-[12px] text-muted-foreground">
          {approved
            ? `${total} fields locked in — exactly these values will be sent.`
            : "Nothing was sent."}
        </div>
      </div>
    </div>
  );
}
