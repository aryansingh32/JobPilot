import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Mail, Phone, Loader2 } from "lucide-react";
import { Brand } from "@/components/chat/ChatSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { config } from "@/lib/config";
import { authClient } from "@/lib/auth-client";
import { jp } from "@/lib/api-client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("login-route");

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — jobpilot" }] }),
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

  // New accounts go straight into setup — no stop on the home screen first.
  const goNext = async () => {
    const me = await jp.me().catch(() => null);
    navigate({
      to: me?.profile.onboardingStatus === "pending" ? "/onboarding" : "/",
      replace: true,
    });
  };

  const handleGoogleCredential = async (idToken: string) => {
    setBusy(true);
    setError(null);
    try {
      await authClient.signInWithGoogle(idToken);
      await goNext();
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
      await goNext();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm animate-in space-y-6 fade-in-0 duration-300">
        <div className="flex flex-col items-center gap-3 text-center">
          <Brand />
          <h1 className="mt-3 text-[26px] font-bold tracking-tight text-foreground">
            Sign in to jobpilot
          </h1>
          <p className="text-[14px] leading-relaxed text-muted-foreground">
            Find roles that fit you, apply in one tap, and track every reply. New here? The same
            code creates your account.
          </p>
        </div>

        <div className="space-y-5 rounded-[18px] border border-border bg-card p-5 shadow-[0_1px_2px_rgba(13,24,40,0.04)]">
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
            <TabsList className="grid h-10 w-full grid-cols-2 rounded-full bg-muted p-1">
              <TabsTrigger value="email" className="gap-1.5 rounded-full text-[13px] font-semibold">
                <Mail className="h-3.5 w-3.5" /> Email
              </TabsTrigger>
              <TabsTrigger
                value="mobile"
                className="gap-1.5 rounded-full text-[13px] font-semibold"
              >
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
                    className="h-11 rounded-xl text-[15px]"
                  />
                  <Button
                    className="h-11 w-full rounded-full text-[14px] font-semibold"
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
                    className="h-12 rounded-xl text-center text-lg tracking-[0.4em]"
                  />
                  <Button
                    className="h-11 w-full rounded-full text-[14px] font-semibold"
                    disabled={busy || code.length < 6}
                    onClick={verifyOtp}
                  >
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
        </div>

        {error && (
          <p className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-center text-[13px] text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
