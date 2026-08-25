// ============================================================
// APPLICATION CONFIG
// Central configuration for connecting to the backend API
// ============================================================

const env = typeof import.meta !== "undefined" ? (import.meta as any).env : {};

export const config = {
  /** Backend API base URL (no trailing slash) */
  apiBaseUrl:
    env?.VITE_API_BASE_URL !== undefined && env?.VITE_API_BASE_URL !== null
      ? env.VITE_API_BASE_URL
      : "http://localhost:3000",

  /** API key for x-api-key header — identifies this as a legitimate client, not a per-user secret */
  apiKey: env?.VITE_API_KEY || "",

  /** Google OAuth Web Client ID, used by the Google Identity Services sign-in button */
  googleClientId: env?.VITE_GOOGLE_CLIENT_ID || "",

  /** Socket.IO path (defaults to /socket.io) */
  socketPath: env?.VITE_SOCKET_PATH || "/socket.io",
} as const;

// There is no VITE_ADMIN_KEY and no VITE_USER_ID anymore: the admin panel
// authenticates via an httpOnly session cookie issued by POST /auth/admin/login,
// and end-user identity comes from the session cookie issued by /auth/google,
// /auth/email/verify, or /auth/mobile/verify — neither is ever readable by
// client-side JS, unlike the old VITE_-prefixed values which were baked into
// the public bundle.
