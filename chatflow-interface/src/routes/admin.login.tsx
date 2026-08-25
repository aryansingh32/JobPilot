import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("admin-login-route");

export const Route = createFileRoute("/admin/login")({
  head: () => ({ meta: [{ title: "Admin sign in — Agent" }] }),
  component: AdminLoginPage,
});

function AdminLoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await authClient.adminLogin(username.trim(), password);
      navigate({ to: "/admin" });
    } catch (err) {
      logger.warn("admin-login:failed", { username: username.trim() });
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
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Admin sign in</h1>
          <p className="text-sm text-muted-foreground">Restricted to authorized administrators.</p>
        </div>

        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <Button
            className="w-full"
            disabled={busy || !username.trim() || !password}
            onClick={submit}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </div>

        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
