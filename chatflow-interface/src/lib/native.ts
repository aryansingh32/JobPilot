// ============================================================
// NATIVE APP BRIDGE (Android via Capacitor)
// The app runs this same UI from bundled files. Cross-site cookies don't work
// reliably inside the Android WebView, so the app keeps its session token in
// device storage and sends it as `Authorization: Bearer` (plus
// `x-jp-client: android`, which makes the backend return the token at sign-in).
// On the web every function here is a no-op and the httpOnly cookie is used.
// ============================================================

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const TOKEN_KEY = "jp_session";
const ISSUED_KEY = "jp_session_issued_at";
/** Refresh the 30-day token once it is a week old. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativePlatform(): "android" | "ios" | "web" {
  return Capacitor.getPlatform() as "android" | "ios" | "web";
}

let token: string | null | undefined;

export async function getSessionToken(): Promise<string | null> {
  if (!isNative()) return null;
  if (token === undefined) {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    token = value;
  }
  return token;
}

export async function setSessionToken(next: string | null): Promise<void> {
  if (!isNative()) return;
  token = next;
  if (next) {
    await Preferences.set({ key: TOKEN_KEY, value: next });
    await Preferences.set({ key: ISSUED_KEY, value: String(Date.now()) });
  } else {
    await Preferences.remove({ key: TOKEN_KEY });
    await Preferences.remove({ key: ISSUED_KEY });
  }
}

/** Headers every API call from the app carries (empty on the web). */
export async function nativeHeaders(): Promise<Record<string, string>> {
  if (!isNative()) return {};
  const t = await getSessionToken();
  return { "x-jp-client": nativePlatform(), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

/** Sign-in responses carry the token for the app; keep it. */
export async function rememberSessionFrom(body: unknown): Promise<void> {
  const t = (body as { token?: unknown } | null)?.token;
  if (typeof t === "string" && t) await setSessionToken(t);
}

/** Token old enough to swap for a fresh one (sliding 30-day session)? */
export async function sessionNeedsRefresh(): Promise<boolean> {
  if (!(await getSessionToken())) return false;
  const { value } = await Preferences.get({ key: ISSUED_KEY });
  return !value || Date.now() - Number(value) > REFRESH_AFTER_MS;
}
