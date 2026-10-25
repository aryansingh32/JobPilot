import type { CapacitorConfig } from "@capacitor/cli";

// Android app = the same web UI, bundled (npm run build:android → dist/client).
// JP_ANDROID_DEV=1 allows a plain-http backend (local testing, e.g. the emulator's
// http://10.0.2.2:3000); release builds must point VITE_API_BASE_URL at https.
const devHttp = process.env.JP_ANDROID_DEV === "1";

const config: CapacitorConfig = {
  appId: "com.jobpilot.app",
  appName: "jobpilot",
  webDir: "dist/client",
  server: {
    androidScheme: "https",
    ...(devHttp ? { cleartext: true } : {}),
  },
  android: {
    allowMixedContent: devHttp,
    // Keep the web view out from under the status and navigation bars (Android 15 is edge-to-edge).
    adjustMarginsForEdgeToEdge: "force",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#15362b",
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
