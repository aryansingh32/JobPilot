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
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 text-primary">
          {icon}
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

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
        className={`group relative block w-full overflow-hidden rounded-lg border border-border bg-background p-2 ${className}`}
      >
        <img src={src} alt="captcha" className="mx-auto h-auto max-h-56 w-full object-contain" />
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
        : msg.resolved!.value;
  return (
    <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
      <Check className="h-4 w-4 text-primary" />
      <span className="capitalize">{msg.kind}</span>
      <span>·</span>
      <span className="text-foreground">{label}</span>
    </div>
  );
}

function OtpCard({ msg }: { msg: InputCardMessage }) {
  const [value, setValue] = useState("");

  const submit = (v: string) => {
    if (v.length === 6) resolveCard(msg.id, v, msg.jobId);
  };

  return (
    <CardShell icon={<KeyRound className="h-4 w-4" />} title="Enter OTP">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      <div className="mb-3">
        <InputOTP
          maxLength={6}
          value={value}
          onChange={setValue}
          onComplete={submit}
          autoFocus
          containerClassName="justify-start"
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }).map((_, i) => (
              <InputOTPSlot key={i} index={i} className="h-12 w-10 text-lg" />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      <button
        onClick={() => submit(value)}
        disabled={value.length < 6}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center min-w-[80px]"
      >
        Verify
      </button>
    </CardShell>
  );
}

function CaptchaCard({ msg }: { msg: InputCardMessage }) {
  const [v, setV] = useState("");
  return (
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} title="Solve CAPTCHA">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.captchaUrl && <ZoomableCaptchaImage src={msg.data.captchaUrl} className="mb-3" />}
      <div className="flex gap-2">
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Type the characters"
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-[16px] focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          onKeyDown={(e) => {
            if (e.key === "Enter" && v) resolveCard(msg.id, v, msg.jobId);
          }}
        />
        <button
          onClick={() => v && resolveCard(msg.id, v, msg.jobId)}
          disabled={!v}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
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
    <CardShell icon={<Wallet className="h-4 w-4" />} title="UPI ID">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      <div className="flex gap-2">
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="yourname@bank"
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-[16px] focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          onClick={() => valid && resolveCard(msg.id, v, msg.jobId)}
          disabled={!valid}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
        >
          Continue
        </button>
      </div>
      {!valid && v && (
        <div className="mt-2 flex items-center gap-1 text-xs text-warning">
          <AlertCircle className="h-3 w-3" /> Looks like an invalid UPI ID
        </div>
      )}
    </CardShell>
  );
}

function ConfirmCard({ msg }: { msg: InputCardMessage }) {
  return (
    <CardShell icon={<Check className="h-4 w-4" />} title="Confirmation">
      <p className="mb-1 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.amount && (
        <div className="my-3 text-2xl font-semibold tracking-tight">{msg.data.amount}</div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => resolveCard(msg.id, msg.data?.confirmLabel ?? "Confirm", msg.jobId)}
          className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
        >
          <Check className="mr-1 inline h-4 w-4" />
          {msg.data?.confirmLabel ?? "Confirm"}
        </button>
        <button
          onClick={() => resolveCard(msg.id, msg.data?.cancelLabel ?? "Cancel", msg.jobId)}
          className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition-all hover:bg-muted active:scale-95 cursor-pointer"
        >
          <X className="mr-1 inline h-4 w-4" />
          {msg.data?.cancelLabel ?? "Cancel"}
        </button>
      </div>
    </CardShell>
  );
}

function TextCard({ msg }: { msg: InputCardMessage }) {
  const [v, setV] = useState("");
  const inputType = msg.data?.inputType || "text";
  return (
    <CardShell icon={<Type className="h-4 w-4" />} title="Enter Information">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      <div className="flex gap-2">
        <input
          autoFocus
          type={inputType}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Type here..."
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-[16px] focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          onKeyDown={(e) => {
            if (e.key === "Enter" && v) resolveCard(msg.id, v, msg.jobId);
          }}
        />
        <button
          onClick={() => v && resolveCard(msg.id, v, msg.jobId)}
          disabled={!v}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center min-w-[80px]"
        >
          Submit
        </button>
      </div>
    </CardShell>
  );
}

function ClickCaptchaCard({ msg }: { msg: InputCardMessage }) {
  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    resolveCard(msg.id, `${x},${y}`, msg.jobId);
  };

  return (
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} title="Solve CAPTCHA">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.captchaUrl ? (
        <div className="relative mb-3 w-full overflow-hidden rounded-lg border border-border bg-background cursor-crosshair">
          <img
            src={msg.data.captchaUrl}
            alt="captcha"
            onClick={handleImageClick}
            className="block max-h-64 w-full object-contain"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the CAPTCHA image…</p>
      )}
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
      <CardShell icon={<KeyRound className="h-4 w-4" />} title="Saved Credentials">
        <p className="mb-1 text-sm text-muted-foreground">{msg.prompt}</p>
        <div className="my-3 text-lg font-semibold tracking-tight">
          Use saved login for {msg.data?.domain ?? "this site"}?
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => resolveCard(msg.id, "Confirm", msg.jobId)}
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
          >
            <Check className="mr-1 inline h-4 w-4" />
            Yes, use saved
          </button>
          <button
            onClick={() => setMode("type")}
            className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition-all hover:bg-muted active:scale-95 cursor-pointer"
          >
            <Type className="mr-1 inline h-4 w-4" />
            No, let me type
          </button>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell icon={<KeyRound className="h-4 w-4" />} title="Enter Value Securely">
      <p className="mb-3 text-sm text-muted-foreground">
        Your input is sent directly to the site and is not seen by the AI.
      </p>
      <div className="flex gap-2">
        <input
          autoFocus
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Enter securely..."
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-[16px] focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40 text-[16px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && val) resolveCard(msg.id, val, msg.jobId);
          }}
        />
        <button
          onClick={() => val && resolveCard(msg.id, val, msg.jobId)}
          disabled={!val}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer disabled:opacity-50 flex items-center justify-center min-w-[80px]"
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
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} title="Select Images">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.captchaUrl ? (
        <div className="mb-3 relative w-full overflow-hidden rounded-lg border border-border bg-background">
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
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
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
    <CardShell icon={<ShieldCheck className="h-4 w-4" />} title="Slide to verify">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.captchaUrl && (
        <div className="mb-3 relative overflow-hidden rounded-lg border border-border bg-background">
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
        <button
          onClick={() => resolveCard(msg.id, val.toString(), msg.jobId)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
        >
          Submit
        </button>
      </div>
    </CardShell>
  );
}

function PaymentPendingCard({ msg }: { msg: InputCardMessage }) {
  return (
    <CardShell icon={<Wallet className="h-4 w-4 text-warning" />} title="Complete Payment">
      <p className="mb-1 text-sm text-muted-foreground">{msg.prompt}</p>
      {msg.data?.amount && (
        <div className="my-3 text-2xl font-semibold tracking-tight">{msg.data.amount}</div>
      )}
      <div className="rounded-lg bg-warning/10 p-3 mb-3 border border-warning/20">
        <p className="text-sm text-warning">
          Don't refresh or close this window until it's confirmed.
        </p>
      </div>
      <button
        onClick={() => resolveCard(msg.id, "Paid", msg.jobId)}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95 cursor-pointer"
      >
        I have paid
      </button>
    </CardShell>
  );
}
