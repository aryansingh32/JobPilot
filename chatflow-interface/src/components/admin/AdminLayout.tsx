import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  Workflow,
  ShieldCheck,
  ScrollText,
  Activity,
  Globe,
  Puzzle,
  Server,
  AlertTriangle,
  Database,
  ChevronLeft,
  ChevronRight,
  Zap,
  RefreshCw,
  Orbit,
  Fingerprint,
  Sparkles,
} from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: "observability", label: "Observability", icon: <Orbit className="h-4 w-4" /> },
  { id: "sessions", label: "Session Intel", icon: <Fingerprint className="h-4 w-4" /> },
  { id: "copilot", label: "AI Copilot", icon: <Sparkles className="h-4 w-4" /> },
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: "jobs", label: "Jobs & Tasks", icon: <Zap className="h-4 w-4" /> },
  { id: "users", label: "Users", icon: <Users className="h-4 w-4" /> },
  { id: "workflows", label: "Workflows", icon: <Workflow className="h-4 w-4" /> },
  { id: "sites", label: "Sites", icon: <Globe className="h-4 w-4" /> },
  { id: "captcha", label: "Captcha Solver", icon: <Puzzle className="h-4 w-4" /> },
  { id: "browsers", label: "Browser Pool", icon: <Server className="h-4 w-4" /> },
  { id: "logs", label: "Logs", icon: <ScrollText className="h-4 w-4" /> },
  { id: "errors", label: "Errors", icon: <AlertTriangle className="h-4 w-4" /> },
  { id: "network", label: "Network", icon: <Activity className="h-4 w-4" /> },
  { id: "metrics", label: "Metrics", icon: <Database className="h-4 w-4" /> },
  { id: "security", label: "Security", icon: <ShieldCheck className="h-4 w-4" /> },
];

export function AdminLayout({
  activeTab,
  onTabChange,
  children,
  onRefresh,
  lastUpdated,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: ReactNode;
  onRefresh?: () => void;
  lastUpdated?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside
        className={`flex flex-col border-r border-border/50 bg-background transition-all duration-300 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-fuchsia-500 text-white text-xs font-bold shadow-lg shadow-primary/25">
            CF
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground tracking-tight">ChatFlow</div>
              <div className="text-[10px] text-muted-foreground">Admin Panel</div>
            </div>
          )}
        </div>

        {/* Nav Items */}
        <nav className="flex-1 overflow-y-auto py-2 scroll-thin">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`group flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-all duration-150 ${
                activeTab === item.id
                  ? "bg-gradient-to-r from-primary/15 to-fuchsia-500/10 text-primary border-l-2 border-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border-l-2 border-transparent"
              }`}
            >
              <span className={`shrink-0 ${activeTab === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
                {item.icon}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center border-t border-border/40 py-3 text-muted-foreground hover:text-foreground transition"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </aside>

      {/* ── Main Content ────────────────────────────── */}
      <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-border/40 bg-background px-6 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? "Admin"}
            </h1>
            <Link
              to="/"
              className="ml-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground border border-border/50 hover:bg-accent/50 transition"
            >
              ← Back to Chat
            </Link>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-[10px] text-muted-foreground">
                Updated {lastUpdated}
              </span>
            )}
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="flex items-center gap-1.5 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 transition"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            )}
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-thin">{children}</div>
      </main>
    </div>
  );
}
