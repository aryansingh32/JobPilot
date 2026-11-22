// ============================================================
// ANDROID SHELL — what the app needs around the shared UI:
// status bar that follows the theme, the hardware back button, a sliding
// session, and push notifications (register the phone, open the right
// application when one is tapped). Nothing here renders UI.
// ============================================================

import { App } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { authClient } from "./auth-client";
import { config } from "./config";
import { isNative, nativeHeaders, nativePlatform, sessionNeedsRefresh } from "./native";
import { createLogger } from "./logger";

const logger = createLogger("native-app");

/** The index screen listens for these to open a view (no routes for views). */
export const OPEN_APPLICATION_EVENT = "jp:open-application";
export const OPEN_INBOX_EVENT = "jp:open-inbox";
/** Cancelable: a screen that handles Back (close a drawer, leave a view) calls preventDefault(). */
export const BACK_EVENT = "jp:back";

/** Push needs google-services.json in the Android project; without it registering crashes the app. */
const PUSH_ENABLED = String((import.meta as any).env?.VITE_PUSH_ENABLED ?? "") === "true";

let started = false;
let pushToken: string | null = null;

function syncStatusBar(): void {
  const dark = document.documentElement.classList.contains("dark");
  // Same colours as --background in styles.css.
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
  StatusBar.setBackgroundColor({ color: dark ? "#0a0a0a" : "#f9fafb" }).catch(() => {});
}

export function initNativeApp(): void {
  if (started || !isNative()) return;
  started = true;

  syncStatusBar();
  new MutationObserver(syncStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  SplashScreen.hide().catch(() => {});

  App.addListener("backButton", ({ canGoBack }) => {
    const event = new CustomEvent(BACK_EVENT, { cancelable: true });
    window.dispatchEvent(event);
    if (event.defaultPrevented) return;
    if (canGoBack) window.history.back();
    else App.exitApp();
  });

  // Coming back to the app: keep a week-old session fresh.
  App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) void refreshSessionIfOld();
  });
  void refreshSessionIfOld();
}

async function refreshSessionIfOld(): Promise<void> {
  if (!(await sessionNeedsRefresh())) return;
  await authClient.refresh().catch((err) => logger.warn("session:refresh-failed", { error: String(err) }));
}

/** After sign-in: ask for permission, register with FCM and tell the backend this phone's token. */
export async function registerPush(): Promise<void> {
  if (!isNative() || !PUSH_ENABLED) return;
  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return;

    await PushNotifications.createChannel({
      id: "applications",
      name: "Applications",
      description: "Questions, reviews and results of your applications",
      importance: 4,
    }).catch(() => {});

    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener("registration", async ({ value }) => {
      pushToken = value;
      await fetch(`${config.apiBaseUrl}/me/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, ...(await nativeHeaders()) },
        body: JSON.stringify({ token: value, platform: nativePlatform(), appVersion: (await App.getInfo()).version }),
      }).catch((err) => logger.warn("push:device-register-failed", { error: String(err) }));
    });
    await PushNotifications.addListener("registrationError", (err) => logger.warn("push:registration-error", { error: err.error }));
    await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const data = (notification.data ?? {}) as Record<string, string>;
      if (data.applicationId) {
        window.dispatchEvent(new CustomEvent(OPEN_APPLICATION_EVENT, { detail: { id: data.applicationId } }));
      } else if (data.emailId) {
        window.dispatchEvent(new CustomEvent(OPEN_INBOX_EVENT));
      }
    });
    await PushNotifications.register();
  } catch (err) {
    logger.warn("push:setup-failed", { error: String(err) });
  }
}

/** Before sign-out: stop pushing to this phone. */
export async function unregisterPush(): Promise<void> {
  if (!isNative() || !pushToken) return;
  await fetch(`${config.apiBaseUrl}/me/devices/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, ...(await nativeHeaders()) },
    body: JSON.stringify({ token: pushToken }),
  }).catch(() => {});
  pushToken = null;
}
