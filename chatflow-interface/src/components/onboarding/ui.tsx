import { useEffect, useId, useRef, useState } from "react";
import { Check, Eraser, Plus, UploadCloud, X, Sparkles } from "lucide-react";

export const INPUT =
  "h-11 w-full rounded-xl border border-border bg-card px-3.5 text-[15px] text-foreground placeholder:text-faint transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15";

export function StepHeader({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
}) {
  return (
    <div className="mb-6">
      <div className="eyebrow mb-2">{eyebrow}</div>
      <h1 className="text-[24px] font-bold leading-tight tracking-tight text-foreground sm:text-[28px]">
        {title}
      </h1>
      {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function Field({
  label,
  hint,
  optional,
  group = false,
  auto = false,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  /** Filled in from the résumé — shown as a quiet chip so the user knows to glance at it. */
  auto?: boolean;
  /**
   * Set for anything with more than one control (chips, tag input, input +
   * button rows, uploads). A <label> around several buttons would forward
   * clicks to its first control — e.g. a tag's remove button.
   */
  group?: boolean;
  children: React.ReactNode;
}) {
  const labelId = useId();
  const heading = (
    <span
      id={labelId}
      className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-foreground"
    >
      {label}
      {optional && <span className="text-[12px] font-normal text-faint">Optional</span>}
      {auto && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-soft-foreground">
          <Sparkles className="h-3 w-3" /> From your resume
        </span>
      )}
    </span>
  );
  const help = hint && <span className="mt-1 block text-[12px] text-muted-foreground">{hint}</span>;
  return group ? (
    <div role="group" aria-labelledby={labelId}>
      {heading}
      {children}
      {help}
    </div>
  ) : (
    <label className="block">
      {heading}
      {children}
      {help}
    </label>
  );
}

/** Single- or multi-select pill group. */
export function Chips({
  options,
  value,
  onChange,
  multi = false,
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  multi?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() =>
              onChange(multi ? (on ? value.filter((x) => x !== o) : [...value, o]) : [o])
            }
            className={`flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors ${
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-ink-2 hover:border-faint"
            }`}
          >
            {on && multi && <Check className="h-3.5 w-3.5" />}
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Free-form tags: suggestions + typed entries. */
export function TagInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (t: string) => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
        {value.map((t) => (
          <span
            key={t}
            className="flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-[13px] font-medium text-primary-soft-foreground"
          >
            {t}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== t))}
              aria-label={`Remove ${t}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={value.length ? "Add more…" : placeholder}
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-[15px] text-foreground placeholder:text-faint focus:outline-none"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* Chips stay where they are when picked (toggle), so the next tap lands
            on what the user aimed at — removing them reflowed the row mid-click. */}
        {suggestions.slice(0, 8).map((s) => {
          const on = value.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => (on ? onChange(value.filter((x) => x !== s)) : add(s))}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                on
                  ? "border-primary/40 bg-primary-soft text-primary-soft-foreground"
                  : "border-dashed border-border text-muted-foreground hover:border-faint hover:text-foreground"
              }`}
            >
              {on ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />} {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Large selectable card for mutually-exclusive choices. */
export function OptionCard({
  selected,
  onClick,
  icon,
  title,
  description,
  badge,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-start gap-3 rounded-[16px] border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
        selected
          ? "border-primary bg-primary-soft/60 ring-1 ring-primary"
          : "border-border bg-card hover:border-faint"
      }`}
    >
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
          selected ? "bg-primary text-primary-foreground" : "bg-muted text-ink-2"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold text-foreground">{title}</span>
          {badge && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border"
        }`}
      >
        {selected && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Drag-and-drop / click-to-pick file area. */
export function DropZone({
  accept,
  capture,
  title,
  hint,
  fileName,
  busy,
  onFile,
}: {
  accept: string;
  capture?: "user" | "environment";
  title: string;
  hint: string;
  fileName?: string;
  busy?: boolean;
  onFile: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && ref.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-[18px] border-2 border-dashed px-5 py-8 text-center transition-colors ${
        drag ? "border-primary bg-primary-soft/50" : "border-border bg-card hover:border-faint"
      }`}
    >
      <span className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground">
        {fileName ? <Check className="h-5 w-5" /> : <UploadCloud className="h-5 w-5" />}
      </span>
      <span className="text-[14px] font-semibold text-foreground">
        {busy ? "Uploading…" : fileName ? fileName : title}
      </span>
      <span className="mt-1 text-[12px] text-muted-foreground">
        {fileName ? "Tap to replace" : hint}
      </span>
      <input
        ref={ref}
        type="file"
        accept={accept}
        capture={capture}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Draw a signature with finger/mouse; exports a transparent PNG. */
export function SignaturePad({ onChange }: { onChange: (png: Blob | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(c).color;
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    canvas.current!.toBlob((b) => onChange(b), "image/png");
  };
  const clear = () => {
    const c = canvas.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="relative">
      <canvas
        ref={canvas}
        className="h-40 w-full touch-none rounded-[16px] border border-border bg-card text-foreground"
        onPointerDown={(e) => {
          drawing.current = true;
          setEmpty(false);
          const ctx = canvas.current!.getContext("2d")!;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          canvas.current!.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvas.current!.getContext("2d")!;
          const p = point(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      {empty && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-faint">
          Sign here with your finger or mouse
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-border" />
      {!empty && (
        <button
          type="button"
          onClick={clear}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-ink-2"
        >
          <Eraser className="h-3.5 w-3.5" /> Clear
        </button>
      )}
    </div>
  );
}
