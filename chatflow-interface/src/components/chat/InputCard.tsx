import { useState } from "react";
import { Check, X, ShieldCheck, KeyRound, Wallet, AlertCircle, Type, ZoomIn } from "lucide-react";
import type { InputCardMessage } from "@/lib/chat-types";
import { resolveCard } from "@/lib/backend-connector";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Props {
  msg: InputCardMessage;
}

export function InputCard({ msg }: Props) {
  if (msg.resolved) return <ResolvedCard msg={msg} />;
  switch (msg.kind) {
    case "otp":
      return <OtpCard msg={msg} />;
    case "captcha":
      return <CaptchaCard msg={msg} />;
    case "clickCaptcha":
      return <ClickCaptchaCard msg={msg} />;
    case "upi":
      return <UpiCard msg={msg} />;
    case "confirm":
      return <ConfirmCard msg={msg} />;
    case "text":
      return <TextCard msg={msg} />;
    case "credentialFill":
      return <CredentialFillCard msg={msg} />;
    case "gridCaptcha":
      return <GridCaptchaCard msg={msg} />;
    case "sliderCaptcha":
      return <SliderCaptchaCard msg={msg} />;
    case "paymentPending":
      return <PaymentPendingCard msg={msg} />;
  }
}

function CardShell({
  icon,
  label,
  title,
  children,
}: {
  icon: React.ReactNode;
  /** Small caps label naming what's needed, e.g. "One-time code" */
  label: string;
  /** The actual question, shown as the headline */
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-4 shadow-[0_1px_2px_rgba(13,24,40,0.04)] sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning-soft-foreground">
          {icon}
        </span>
        <div className="min-w-0 pt-0.5">
          <div className="eyebrow mb-1 !text-warning-soft-foreground">Needs you · {label}</div>
          <p className="text-[15px] font-semibold leading-snug text-foreground">{title}</p>
        </div>
      </div>
      {children}
      <p className="mt-3 text-[11px] text-faint">Only used for this task.</p>
    </div>
  );
}

const INPUT =
  "h-11 w-full min-w-0 shrink-0 rounded-xl sm:flex-1 sm:shrink border border-border bg-card px-3.5 text-[15px] text-foreground placeholder:text-faint transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15";
const PRIMARY =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-5 text-[14px] font-medium text-ink-2 transition-colors hover:border-faint hover:text-foreground";
/** Input + action: stacked full-width on phones, inline from sm up. */
const ROW = "flex flex-col gap-2 sm:flex-row";

/**
 * Every captcha type surfaces its image directly in the chat card — never
 * only in the (now auto-hidden) Live Screen panel, since that can be small,
 * scrolled away, or collapsed. This adds a tap-to-zoom affordance for the
 * read-only text/image captcha; click/grid/slider captchas stay at their own
 * generous inline size since the user interacts with them directly.
 */
function ZoomableCaptchaImage({ src, className = "" }: { src: string; className?: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        className={`group relative block w-full overflow-hidden rounded-[14px] border border-border bg-background p-2 ${className}`}
      >
        {/* Captchas are small (≈120×40): ~2× keeps them sharp instead of stretching to the card. */}
        <img src={src} alt="captcha" className="mx-auto h-20 w-auto max-w-full object-contain sm:h-24" />
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white opacity-90 transition group-hover:opacity-100">
          <ZoomIn className="h-3 w-3" /> Tap to zoom
        </span>
      </button>
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent className="max-w-2xl bg-background p-4">
          <DialogTitle className="sr-only">CAPTCHA image</DialogTitle>
          <img src={src} alt="captcha, zoomed" className="h-auto w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResolvedCard({ msg }: { msg: InputCardMessage }) {
  const label =
    msg.kind === "confirm"
      ? msg.resolved!.value
      : msg.kind === "otp" || msg.kind === "credentialFill" || msg.data?.inputType === "password"
        ? "•".repeat(Math.max(8, msg.resolved!.value.length))
        : msg.kind === "clickCaptcha"
          ? msg.resolved!.value.includes('"done"') ? "Done" : "Tapped"
          : msg.resolved!.value;
  return (
    <div className="flex items-center gap-2 rounded-[14px] border border-border bg-card px-3.5 py-2.5 text-[13px] text-muted-foreground">
      <Check className="h-4 w-4 text-success" />
      <span className="capitalize">{msg.kind === "clickCaptcha" ? "Security check" : msg.kind}</span>
      <span>·</span>
      <span className="text-foreground">{label}</span>
    </div>
  );
}

/** OTP length: explicit from the backend, else read from the prompt ("4-digit code"), else unknown. */
function otpLength(msg: InputCardMessage): number | null {
  const explicit = Number(msg.data?.length);
  if (explicit >= 4 && explicit <= 8) return explicit;
  const m = msg.prompt.match(/\b([4-8])\s*-?\s*digit/i);
  return m ? Number(m[1]) : null;
}

function OtpCard({ msg }: { msg: InputCardMessage }) {
  const length = otpLength(msg);
  const [value, setValue] = useState("");
  const [pasteFailed, setPasteFailed] = useState(false);
  const min = length ?? 4;
  const max = length ?? 8;
  const ready = value.length >= min && value.length <= max;

  const submit = (v: string) => {
    if (v.length >= min && v.length <= max) resolveCard(msg.id, v, msg.jobId);
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      // Pull the code out of a pasted SMS/email ("Your OTP is 4821. Do not share…")
      const code = (text.match(new RegExp(`\\b\\d{${min},${max}}\\b`)) ?? [
        text.replace(/\D/g, ""),
      ])[0].slice(0, max);
      setValue(code);
      if (length && code.length === length) submit(code);
    } catch {
      setPasteFailed(true);
    }
  };

  return (
    <CardShell icon={<KeyRound className="h-4 w-4" />} label="One-time code" title={msg.prompt}>
      {msg.data?.destination && (
        <p className="-mt-2 mb-3 text-[13px] text-muted-foreground">
          Sent to <span className="font-medium text-foreground">{msg.data.destination}</span>
        </p>
      )}

      {length ? (
        <InputOTP
          maxLength={length}
          value={value}
          onChange={(v) => setValue(v.replace(/\D/g, ""))}
          onComplete={submit}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="^[0-9]+$"
          containerClassName="justify-start"
        >
          <InputOTPGroup className="gap-1.5 sm:gap-2">
            {Array.from({ length }).map((_, i) => (
              <InputOTPSlot
                key={i}
                index={i}
                className="h-12 w-10 rounded-xl border text-[20px] font-semibold first:rounded-xl last:rounded-xl sm:h-14 sm:w-12"
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
      ) : (
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 8))}
          onKeyDown={(e) => e.key === "Enter" && submit(value)}
          placeholder="4–8 digit code"
          aria-label="One-time code"
          className={`${INPUT} h-12 text-center text-[20px] font-semibold tracking-[0.4em] placeholder:tracking-normal sm:max-w-[16rem] sm:flex-none`}
        />
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          onClick={() => submit(value)}
          disabled={!ready}
          className={`${PRIMARY} w-full sm:w-auto`}
        >
          Verify
        </button>
        <button onClick={paste} className={`${SECONDARY} w-full sm:w-auto`}>
          Paste code
        </button>
        <span className="text-[12px] text-faint sm:ml-1">
          {pasteFailed
            ? "Couldn't read the clipboard — type the code instead."
            : length
              ? `${length} digits · fills itself from SMS on your phone`
              : "Usually 4 or 6 digits"}
        </span>
      </div>
    </CardShell>
  );
}

function CaptchaCard({ msg }: { msg: InputCardMessage }) {
  const [v, setV] = useState("");
  return (
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} label="Security check" title={msg.prompt}>
      {msg.data?.captchaUrl && <ZoomableCaptchaImage src={msg.data.captchaUrl} className="mb-3" />}
      <div className={ROW}>
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Type the characters"
          className={INPUT}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v) resolveCard(msg.id, v, msg.jobId);
          }}
        />
        <button
          onClick={() => v && resolveCard(msg.id, v, msg.jobId)}
          disabled={!v}
          className={PRIMARY}
        >
          Submit
        </button>
      </div>
    </CardShell>
  );
}

function UpiCard({ msg }: { msg: InputCardMessage }) {
  const [v, setV] = useState("");
  const valid = /^[\w.-]{2,}@[a-z]{2,}$/i.test(v);
  return (
    <CardShell icon={<Wallet className="h-4 w-4" />} label="UPI ID" title={msg.prompt}>
      <div className={ROW}>
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="yourname@bank"
          className={INPUT}
        />
        <button
          onClick={() => valid && resolveCard(msg.id, v, msg.jobId)}
          disabled={!valid}
          className={PRIMARY}
        >
          Continue
        </button>
      </div>
      {!valid && v && (
        <div className="mt-2 flex items-center gap-1 text-[12px] text-destructive">
          <AlertCircle className="h-3 w-3" /> Looks like an invalid UPI ID
        </div>
      )}
    </CardShell>
  );
}

function ConfirmCard({ msg }: { msg: InputCardMessage }) {
  return (
    <CardShell icon={<Check className="h-4 w-4" />} label="Confirm" title={msg.prompt}>
      {msg.data?.amount && (
        <div className="mb-3 text-[26px] font-bold tracking-tight text-foreground">
          {msg.data.amount}
        </div>
      )}
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => resolveCard(msg.id, msg.data?.confirmLabel ?? "Confirm", msg.jobId)}
          className={`${PRIMARY} flex-1`}
        >
          <Check className="h-4 w-4" />
          {msg.data?.confirmLabel ?? "Confirm"}
        </button>
        <button
          onClick={() => resolveCard(msg.id, msg.data?.cancelLabel ?? "Cancel", msg.jobId)}
          className={`${SECONDARY} flex-1`}
        >
          <X className="h-4 w-4" />
          {msg.data?.cancelLabel ?? "Cancel"}
        </button>
      </div>
    </CardShell>
  );
}

/** Per-type keyboard, autofill hint, placeholder and validation for plain text asks. */
const TEXT_KINDS: Record<
  string,
  {
    label: string;
    type: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
    autoComplete: string;
    placeholder: string;
    valid?: (v: string) => boolean;
    error?: string;
  }
> = {
  text: { label: "Details", type: "text", autoComplete: "off", placeholder: "Type your answer" },
  email: {
    label: "Email",
    type: "email",
    inputMode: "email",
    autoComplete: "email",
    placeholder: "you@example.com",
    valid: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),
    error: "That doesn't look like an email address",
  },
  mobile: {
    label: "Mobile number",
    type: "tel",
    inputMode: "tel",
    autoComplete: "tel",
    placeholder: "10-digit mobile number",
    valid: (v) => v.replace(/\D/g, "").length >= 10,
    error: "Enter at least 10 digits",
  },
  password: {
    label: "Password",
    type: "password",
    autoComplete: "current-password",
    placeholder: "Password",
  },
};

/** A question with fixed answers on the site: tap one (or pick from a list when long). */
function ChoiceCard({ msg, options }: { msg: InputCardMessage; options: string[] }) {
  const question = typeof msg.data?.question === "string" ? `The application asks: “${msg.data.question}”` : msg.prompt;
  return (
    <CardShell icon={<Type className="h-4 w-4" />} label="Needs your answer" title={question}>
      {options.length <= 12 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o}
              onClick={() => resolveCard(msg.id, o, msg.jobId)}
              className="rounded-full border border-border bg-card px-3.5 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:border-primary hover:bg-primary-soft"
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <select
          className={INPUT}
          defaultValue=""
          onChange={(e) => e.target.value && resolveCard(msg.id, e.target.value, msg.jobId)}
        >
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
      <p className="mt-2 text-[12px] text-muted-foreground">I'll remember this for similar applications.</p>
    </CardShell>
  );
}

function TextCard({ msg }: { msg: InputCardMessage }) {
  const options = Array.isArray(msg.data?.options) ? (msg.data.options as string[]) : [];
  if (options.length) return <ChoiceCard msg={msg} options={options} />;
  return <FreeTextCard msg={msg} />;
}

function FreeTextCard({ msg }: { msg: InputCardMessage }) {
  const [v, setV] = useState("");
  const [touched, setTouched] = useState(false);
  const kind = TEXT_KINDS[msg.data?.inputType ?? "text"] ?? TEXT_KINDS.text;
  const ok = v.trim().length > 0 && (kind.valid ? kind.valid(v.trim()) : true);
  const submit = () => {
    setTouched(true);
    if (ok) resolveCard(msg.id, v.trim(), msg.jobId);
  };
  return (
    <CardShell icon={<Type className="h-4 w-4" />} label={kind.label} title={msg.prompt}>
      <div className={ROW}>
        <input
          autoFocus
          type={kind.type}
          inputMode={kind.inputMode}
          autoComplete={kind.autoComplete}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => v && setTouched(true)}
          placeholder={kind.placeholder}
          aria-invalid={touched && !ok}
          className={`${INPUT} ${touched && !ok ? "border-destructive/50" : ""}`}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button onClick={submit} disabled={!v.trim()} className={PRIMARY}>
          Continue
        </button>
      </div>
      {touched && !ok && kind.error && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5" /> {kind.error}
        </p>
      )}
    </CardShell>
  );
}

function ClickCaptchaCard({ msg }: { msg: InputCardMessage }) {
  // Sent as fractions of the image so the click lands right whatever its display size.
  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    resolveCard(
      msg.id,
      JSON.stringify({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }),
      msg.jobId,
    );
  };

  return (
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} label="Security check" title={msg.prompt}>
      {msg.data?.captchaUrl ? (
        <div className="relative mb-3 w-full overflow-hidden rounded-[14px] border border-border bg-background cursor-crosshair">
          <img
            src={msg.data.captchaUrl}
            alt="captcha"
            onClick={handleImageClick}
            draggable={false}
            className="block h-auto max-w-full"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the CAPTCHA image…</p>
      )}
      <button onClick={() => resolveCard(msg.id, JSON.stringify({ done: true }), msg.jobId)} className={PRIMARY}>
        Done
      </button>
    </CardShell>
  );
}

function CredentialFillCard({ msg }: { msg: InputCardMessage }) {
  const FEATURE_ENABLED = true; // Deliberately gated until crypto envs are fully hardened
  const [val, setVal] = useState("");
  const [mode, setMode] = useState<"ask" | "type">("ask");

  if (!FEATURE_ENABLED) return null;

  if (mode === "ask") {
    return (
      <CardShell icon={<KeyRound className="h-4 w-4" />} label="Login" title={msg.prompt}>
        <p className="mb-3 text-[14px] text-ink-2">
          Use your saved login for{" "}
          <span className="font-semibold text-foreground">{msg.data?.domain ?? "this site"}</span>?
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <button
            onClick={() => resolveCard(msg.id, "Confirm", msg.jobId)}
            className={`${PRIMARY} flex-1`}
          >
            <Check className="h-4 w-4" />
            Yes, use saved
          </button>
          <button onClick={() => setMode("type")} className={`${SECONDARY} flex-1`}>
            <Type className="h-4 w-4" />
            No, let me type
          </button>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      icon={<KeyRound className="h-4 w-4" />}
      label="Login"
      title="Type it here — it goes straight to the site, the AI never sees it."
    >
      <div className={ROW}>
        <input
          autoFocus
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Enter securely..."
          className={INPUT}
          onKeyDown={(e) => {
            if (e.key === "Enter" && val) resolveCard(msg.id, val, msg.jobId);
          }}
        />
        <button
          onClick={() => val && resolveCard(msg.id, val, msg.jobId)}
          disabled={!val}
          className={PRIMARY}
        >
          Submit
        </button>
      </div>
    </CardShell>
  );
}

function GridCaptchaCard({ msg }: { msg: InputCardMessage }) {
  const [selected, setSelected] = useState<number[]>([]);

  const toggle = (i: number) => {
    setSelected((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  };

  return (
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} label="Security check" title={msg.prompt}>
      {msg.data?.captchaUrl ? (
        <div className="mb-3 relative w-full overflow-hidden rounded-[14px] border border-border bg-background">
          <img
            src={msg.data.captchaUrl}
            className="block max-h-64 w-full object-contain pointer-events-none"
            alt="Grid Captcha"
          />
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                onClick={() => toggle(i)}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  toggle(i);
                }}
                className={`border border-white/20 cursor-pointer transition-all ${selected.includes(i) ? "bg-primary/40" : "hover:bg-primary/10"}`}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the CAPTCHA image…</p>
      )}
      <div className="flex justify-end">
        <button
          onClick={() => resolveCard(msg.id, selected.join(","), msg.jobId)}
          className={PRIMARY}
        >
          Verify
        </button>
      </div>
    </CardShell>
  );
}

function SliderCaptchaCard({ msg }: { msg: InputCardMessage }) {
  const [val, setVal] = useState(0);

  return (
    <CardShell
      icon={<ShieldCheck className="h-4 w-4" />}
      label="Slide to verify"
      title={msg.prompt}
    >
      {msg.data?.captchaUrl && (
        <div className="mb-3 relative overflow-hidden rounded-[14px] border border-border bg-background">
          <img
            src={msg.data.captchaUrl}
            className="block max-h-64 w-full object-contain pointer-events-none"
            alt="Slider Captcha"
          />
          <div
            className="absolute top-0 bottom-0 border-l-2 border-primary bg-primary/20 pointer-events-none"
            style={{ left: `${val}%`, width: "40px" }}
          />
        </div>
      )}
      <input
        type="range"
        min="0"
        max="100"
        value={val}
        onChange={(e) => setVal(parseInt(e.target.value))}
        onTouchMove={(e) => e.stopPropagation()}
        className="w-full mb-3 accent-primary"
      />
      <div className="flex justify-end">
        <button onClick={() => resolveCard(msg.id, val.toString(), msg.jobId)} className={PRIMARY}>
          Submit
        </button>
      </div>
    </CardShell>
  );
}

function PaymentPendingCard({ msg }: { msg: InputCardMessage }) {
  return (
    <CardShell
      icon={<Wallet className="h-4 w-4 text-warning" />}
      label="Complete Payment"
      title={msg.prompt}
    >
      {msg.data?.amount && (
        <div className="mb-3 text-[26px] font-bold tracking-tight text-foreground">
          {msg.data.amount}
        </div>
      )}
      <div className="rounded-lg bg-warning/10 p-3 mb-3 border border-warning/20">
        <p className="text-sm text-warning">
          Don't refresh or close this window until it's confirmed.
        </p>
      </div>
      <button
        onClick={() => resolveCard(msg.id, "Paid", msg.jobId)}
        className="w-full rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
      >
        I have paid
      </button>
    </CardShell>
  );
}
