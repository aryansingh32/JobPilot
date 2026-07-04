import { useEffect, useRef, useState } from "react";
import { Check, X, ShieldCheck, KeyRound, Wallet, AlertCircle, Type } from "lucide-react";
import type { InputCardMessage } from "@/lib/chat-types";
import { resolveCard } from "@/lib/backend-connector";

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

function ResolvedCard({ msg }: { msg: InputCardMessage }) {
  const label =
    msg.kind === "confirm"
      ? msg.resolved!.value
      : msg.kind === "otp"
        ? "•".repeat(msg.resolved!.value.length)
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
  const [vals, setVals] = useState<string[]>(Array(6).fill(""));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const setAt = (i: number, v: string) => {
    const c = v.replace(/\D/g, "").slice(-1);
    const next = [...vals];
    next[i] = c;
    setVals(next);
    if (c && i < 5) refs.current[i + 1]?.focus();
  };
  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !vals[i] && i > 0) refs.current[i - 1]?.focus();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const txt = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!txt) return;
    e.preventDefault();
    const arr = Array(6)
      .fill("")
      .map((_, i) => txt[i] ?? "");
    setVals(arr);
    refs.current[Math.min(txt.length, 5)]?.focus();
  };
  const submit = () => {
    const v = vals.join("");
    if (v.length === 6) resolveCard(msg.id, v, msg.jobId);
  };
  return (
    <CardShell icon={<KeyRound className="h-4 w-4" />} title="Enter OTP">
      <p className="mb-3 text-sm text-muted-foreground">{msg.prompt}</p>
      <div className="mb-3 flex gap-2" onPaste={onPaste}>
        {vals.map((v, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={v}
            onChange={(e) => setAt(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            inputMode="numeric"
            maxLength={1}
            className="h-12 w-10 rounded-lg border border-input bg-background text-center text-lg font-semibold focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        ))}
      </div>
      <button
        onClick={() => {
          const v = vals.join("");
          if (v.length === 6) {
            resolveCard(msg.id, v, msg.jobId);
          }
        }}
        disabled={vals.join("").length < 6}
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
      {msg.data?.captchaUrl && (
        <div className="mb-3 overflow-hidden rounded-lg border border-border bg-background p-2">
          <img
            src={msg.data.captchaUrl}
            alt="captcha"
            className="block h-20 w-full object-contain"
          />
        </div>
      )}
      <p className="mb-2 text-xs text-muted-foreground">
        💡 Look at the <strong>Live Screen</strong> panel to see the CAPTCHA image
      </p>
      <div className="flex gap-2">
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Type the characters"
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
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
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
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
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
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
        <div className="relative mb-3 inline-block overflow-hidden rounded-lg border border-border bg-background cursor-crosshair">
          <img
            src={msg.data.captchaUrl}
            alt="captcha"
            onClick={handleImageClick}
            className="block max-h-64 max-w-full object-contain"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Click the CAPTCHA image on the live screen to solve.
        </p>
      )}
    </CardShell>
  );
}

function CredentialFillCard({ msg }: { msg: InputCardMessage }) {
  // CRITICAL REQUIREMENT: This PII/Aadhaar auto-save opt-in feature is disabled by default
  const FEATURE_ENABLED = false;

  if (!FEATURE_ENABLED) return null;

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
          onClick={() => resolveCard(msg.id, "Cancel", msg.jobId)}
          className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition-all hover:bg-muted active:scale-95 cursor-pointer"
        >
          <X className="mr-1 inline h-4 w-4" />
          No, let me type
        </button>
      </div>
    </CardShell>
  );
}
