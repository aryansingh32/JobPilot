import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Float, Icosahedron, MeshDistortMaterial, Stars } from "@react-three/drei";
import { motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { Activity, Radio, Trash2 } from "lucide-react";
import { adminApi } from "@/lib/admin-api";
import { config } from "@/lib/config";
import { useAdminObservabilityStore, type ObsFeedItem } from "@/stores/adminObservabilityStore";

const ADMIN_KEY =
  (typeof import.meta !== "undefined" ? (import.meta as any).env?.VITE_ADMIN_KEY : undefined) ??
  config.apiKey;

/** R3F Canvas requires WebGL — never render during SSR. */
function useIsClient(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(true);
  }, []);
  return ok;
}

function apiOriginForSockets(): string {
  const base = String(config.apiBaseUrl ?? "").trim();
  try {
    if (base.startsWith("http://") || base.startsWith("https://")) {
      return new URL(base).origin;
    }
  } catch {
    /* fall through */
  }
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function CoreMesh() {
  return (
    <Float speed={2} rotationIntensity={0.4} floatIntensity={0.6}>
      <Icosahedron args={[1.1, 0]} castShadow>
        <MeshDistortMaterial color="#7c3aed" emissive="#4c1d95" emissiveIntensity={0.35} distort={0.35} speed={1.6} />
      </Icosahedron>
    </Float>
  );
}

function MiniGalaxy() {
  return (
    <Canvas camera={{ position: [0, 0, 4], fov: 45 }} className="h-[200px] w-full rounded-2xl bg-black/40">
      <color attach="background" args={["#070712"]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[4, 2, 6]} intensity={1.2} color="#a78bfa" />
      <Stars radius={40} depth={40} count={1800} factor={3} saturation={0} fade speed={0.4} />
      <Suspense fallback={null}>
        <CoreMesh />
      </Suspense>
    </Canvas>
  );
}

function TopologyPulse() {
  const client = useIsClient();
  if (!client) {
    return (
      <div className="flex h-[200px] w-full items-center justify-center rounded-2xl bg-black/40 text-xs text-muted-foreground">
        Preparing visualization…
      </div>
    );
  }
  return <MiniGalaxy />;
}

export function ObservabilityCommandCenter() {
  const feed = useAdminObservabilityStore((s) => s.feed);
  const push = useAdminObservabilityStore((s) => s.push);
  const clear = useAdminObservabilityStore((s) => s.clear);
  const [summary, setSummary] = useState<{ events24h: number; errors24h: number; sessions24h: number } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    adminApi
      .observabilitySummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    const origin = apiOriginForSockets();
    const socket: Socket = io(`${origin}/admin`, {
      path: config.socketPath,
      auth: { adminKey: ADMIN_KEY },
      transports: ["websocket", "polling"],
    });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("feed", (data: ObsFeedItem) => push(data));
    return () => {
      socket.disconnect();
    };
  }, [push]);

  const cards = useMemo(
    () => [
      { label: "Events 24h", value: summary?.events24h ?? "—", tone: "from-cyan-500/20 to-blue-500/10" },
      { label: "Sessions 24h", value: summary?.sessions24h ?? "—", tone: "from-primary/20 to-fuchsia-500/10" },
      { label: "Errors 24h", value: summary?.errors24h ?? "—", tone: "from-rose-500/20 to-orange-500/10" },
    ],
    [summary]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Radio className={`h-4 w-4 ${connected ? "text-emerald-400 animate-pulse" : "text-zinc-500"}`} />
          <span>{connected ? "Live observability stream" : "Connecting…"}</span>
        </div>
        <button
          type="button"
          onClick={() => clear()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear feed
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {cards.map((c, i) => (
          <motion.div
            key={c.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br ${c.tone} p-4 backdrop-blur-xl`}
          >
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{c.label}</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{c.value}</div>
            <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/5 blur-2xl" />
          </motion.div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-primary/20 bg-background/80 p-4 backdrop-blur-md">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-200">
            <Activity className="h-4 w-4" />
            Topology pulse
          </div>
          <TopologyPulse />
          <p className="mt-2 text-[11px] text-muted-foreground">
            OTLP → Tempo · Prometheus scrape · Extend with service mesh graphs in Grafana.
          </p>
        </div>
        <div className="flex max-h-[320px] flex-col rounded-2xl border border-border/40 bg-black/30">
          <div className="border-b border-border/30 px-4 py-2 text-xs font-medium text-muted-foreground">Live feed</div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] scroll-thin">
            {!feed.length ? (
              <p className="text-muted-foreground">Waiting for events…</p>
            ) : (
              feed.map((row, idx) => (
                <pre key={idx} className="mb-2 whitespace-pre-wrap break-all text-cyan-100/90">
                  {JSON.stringify(row, null, 2)}
                </pre>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
