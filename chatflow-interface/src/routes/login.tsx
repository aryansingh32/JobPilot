import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Mail, Phone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { config } from "@/lib/config";
import { authClient } from "@/lib/auth-client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("login-route");

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Agent" }] }),
  component: LoginPage,
});

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (opts: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

function useGoogleSignIn(onCredential: (idToken: string) => void) {
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config.googleClientId) return;

    const renderButton = () => {
      if (!window.google || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: (resp: { credential: string }) => onCredential(resp.credential),
      });
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        width: 320,
      });
    };

    if (window.google) {
      renderButton();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = renderButton;
    document.head.appendChild(script);

    return () => {
      script.onload = null;
    };
  }, [onCredential]);

  return buttonRef;
}

type Mode = "email" | "mobile";
type Step = "enter" | "otp";

function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<Mode>("email");
  const [step, setStep] = useState<Step>("enter");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");

  const handleGoogleCredential = async (idToken: string) => {
    setBusy(true);
    setError(null);
    try {
      await authClient.signInWithGoogle(idToken);
      navigate({ to: "/" });
    } catch (err) {
      logger.error("login:google-failed", err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const googleButtonRef = useGoogleSignIn(handleGoogleCredential);

  const requestOtp = async () => {
    if (!identifier.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "email") await authClient.requestEmailOtp(identifier.trim());
      else await authClient.requestMobileOtp(identifier.trim());
      setStep("otp");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "email") await authClient.verifyEmailOtp(identifier.trim(), code.trim());
      else await authClient.verifyMobileOtp(identifier.trim(), code.trim());
      navigate({ to: "/" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Sign in to Agent</h1>
          <p className="text-sm text-muted-foreground">
            Your saved profiles, files, and job history stay private to your account.
          </p>
        </div>

        {config.googleClientId && (
          <div className="flex flex-col items-center gap-3">
            <div ref={googleButtonRef} />
            <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              or
              <div className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        <Tabs
          value={mode}
          onValueChange={(v) => {
            setMode(v as Mode);
            setStep("enter");
            setIdentifier("");
            setCode("");
            setError(null);
          }}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="email" className="gap-1.5">
              <Mail className="h-3.5 w-3.5" /> Email
            </TabsTrigger>
            <TabsTrigger value="mobile" className="gap-1.5">
              <Phone className="h-3.5 w-3.5" /> Mobile
            </TabsTrigger>
          </TabsList>

          <TabsContent value={mode} className="mt-4 space-y-3">
            {step === "enter" ? (
              <>
                <Input
                  autoFocus
                  type={mode === "email" ? "email" : "tel"}
                  inputMode={mode === "email" ? "email" : "tel"}
                  placeholder={mode === "email" ? "you@example.com" : "+91 98765 43210"}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && requestOtp()}
                />
                <Button
                  className="w-full"
                  disabled={busy || !identifier.trim()}
                  onClick={requestOtp}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Send code
                </Button>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Enter the 6-digit code sent to{" "}
                  <span className="text-foreground">{identifier}</span>
                </p>
                <Input
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
                  className="text-center text-lg tracking-[0.4em]"
                />
                <Button className="w-full" disabled={busy || code.length < 6} onClick={verifyOtp}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Verify &amp; sign in
                </Button>
                <button
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setStep("enter")}
                >
                  Use a different {mode === "email" ? "email" : "number"}
                </button>
              </>
            )}
          </TabsContent>
        </Tabs>

        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
