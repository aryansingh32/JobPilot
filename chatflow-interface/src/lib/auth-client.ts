// ============================================================
// AUTH CLIENT
// Talks to the backend's /auth/* endpoints. Every call carries
// credentials so the httpOnly session cookie is set/sent — no
// token ever touches JS-readable storage.
// ============================================================

import { config } from "./config";

export interface AuthUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  mobileNumber: string | null;
  mobileVerified: boolean;
  googleId: string | null;
  displayName: string | null;
}

async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    // Only declare a JSON content type when there's actually a body — the
    // backend's strict JSON body parser 400s on an empty body sent with
    // Content-Type: application/json, which broke logout/adminLogout (the
    // only two callers with no body) until this was traced to a real 400.
    headers: body
      ? { "Content-Type": "application/json", "x-api-key": config.apiKey }
      : { "x-api-key": config.apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const authClient = {
  async me(): Promise<AuthUser | null> {
    try {
      const res = await fetch(`${config.apiBaseUrl}/auth/me`, {
        credentials: "include",
        headers: { "x-api-key": config.apiKey },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user ?? null;
    } catch {
      return null;
    }
  },

  signInWithGoogle: (idToken: string) =>
    authRequest<{ user: AuthUser }>("/auth/google", { idToken }),

  requestEmailOtp: (email: string) =>
    authRequest<{ sent: boolean }>("/auth/email/request-otp", { email }),
  verifyEmailOtp: (email: string, code: string) =>
    authRequest<{ user: AuthUser }>("/auth/email/verify", { email, code }),

  requestMobileOtp: (mobileNumber: string) =>
    authRequest<{ sent: boolean }>("/auth/mobile/request-otp", { mobileNumber }),
  verifyMobileOtp: (mobileNumber: string, code: string) =>
    authRequest<{ user: AuthUser }>("/auth/mobile/verify", { mobileNumber, code }),

  logout: () => authRequest<{ loggedOut: boolean }>("/auth/logout"),

  async adminSession(): Promise<{ role: string } | null> {
    // /admin/health is cheap and already gated by adminAuth — a 200 means
    // the admin session cookie is valid.
    try {
      const res = await fetch(`${config.apiBaseUrl}/admin/health`, { credentials: "include" });
      if (!res.ok) return null;
      return { role: "unknown" };
    } catch {
      return null;
    }
  },

  adminLogin: (username: string, password: string) =>
    authRequest<{ role: string }>("/auth/admin/login", { username, password }),

  adminLogout: () => authRequest<{ loggedOut: boolean }>("/auth/admin/logout"),
};
