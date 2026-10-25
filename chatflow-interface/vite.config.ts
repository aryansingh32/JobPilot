// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// The Android app (Capacitor) ships the UI as static files: JP_NATIVE=1 builds the
// same app as a single-page shell (dist/client/index.html) with no Worker.
const native = process.env.JP_NATIVE === "1";

// Same-origin API through this server ("./dev-lan.sh share": one ngrok tunnel
// carries the app and its API). Defaults to the Docker Compose API on :3000.
const apiTarget = process.env.JP_API_TARGET || "http://localhost:3000";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  ...(native ? { cloudflare: false as const } : {}),
  tanstackStart: {
    server: { entry: "server" },
    ...(native ? { spa: { enabled: true, prerender: { outputPath: "/index.html" } } } : {}),
  },
  vite: {
    server: {
      watch: {
        ignored: ["**/backend/**", "**/mnt/**"],
      },
      // Any ngrok tunnel (a leading dot allows every subdomain).
      allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.app", ".ngrok.dev", "localhost"],
      proxy: {
        "/socket.io": {
          target: apiTarget,
          ws: true,
          changeOrigin: true,
        },
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  },
});
