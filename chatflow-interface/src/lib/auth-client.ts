// ============================================================
// AUTH CLIENT
// Talks to the backend's /auth/* endpoints. Every call carries
// credentials so the httpOnly session cookie is set/sent — no
// token ever touches JS-readable storage.
// ============================================================

import { config } from "./config";
import { nativeHeaders, rememberSessionFrom, setSessionToken } from "./native";

export interface AuthUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  mobileNumber: string | null;
  mobileVerified: boolean;
  googleId: string | null;
  displayName: string | null;
}

async function authRequest<T>(
  path: string,
  body?: unknown,
  baseUrl: string = config.apiBaseUrl,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    // Only declare a JSON content type when there's actually a body — the
    // backend's strict JSON body parser 400s on an empty body sent with
    // Content-Type: application/json, which broke logout/adminLogout (the
    // only two callers with no body) until this was traced to a real 400.
    // The user API's key is never sent to the admin service (its CORS
    // allowlist doesn't accept it, which blocked admin sign-in entirely).
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(baseUrl === config.apiBaseUrl ? { "x-api-key": config.apiKey, ...(await nativeHeaders()) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  // The Android app gets its session token in the body (no cross-site cookies there).
  if (baseUrl === config.apiBaseUrl) await rememberSessionFrom(data);
  return data as T;
}

export const authClient = {
  async me(): Promise<AuthUser | null> {
    try {
      const res = await fetch(`${config.apiBaseUrl}/auth/me`, {
        credentials: "include",
        headers: { "x-api-key": config.apiKey, ...(await nativeHeaders()) },
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
  /** Attach a verified number to the signed-in account (doesn't switch accounts). */
  linkMobile: (mobileNumber: string, code: string) =>
    authRequest<{ user: AuthUser }>("/auth/mobile/link", { mobileNumber, code }),

  async logout() {
    const out = await authRequest<{ loggedOut: boolean }>("/auth/logout");
    await setSessionToken(null);
    return out;
  },

  /** Swap the app's token for a fresh 30-day one (no-op response on the web). */
  refresh: () => authRequest<{ user: AuthUser }>("/auth/refresh"),

  async adminSession(): Promise<{ role: string } | null> {
    // /admin/health is cheap and already gated by adminAuth — a 200 means
    // the admin session cookie is valid.
    try {
      const res = await fetch(`${config.adminApiBaseUrl}/admin/health`, { credentials: "include" });
      if (!res.ok) return null;
      return { role: "unknown" };
    } catch {
      return null;
    }
  },

  // Admin auth lives on the separate admin service.
  adminLogin: (username: string, password: string) =>
    authRequest<{ role: string }>(
      "/auth/admin/login",
      { username, password },
      config.adminApiBaseUrl,
    ),

  adminLogout: () =>
    authRequest<{ loggedOut: boolean }>("/auth/admin/logout", undefined, config.adminApiBaseUrl),
};
