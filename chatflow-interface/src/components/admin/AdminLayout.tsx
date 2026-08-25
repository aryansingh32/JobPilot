import { useState, type ReactNode } from "react";
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
  Menu,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

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

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
        CF
      </div>
      {!collapsed && (
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground tracking-tight">ChatFlow</div>
          <div className="text-[10px] text-muted-foreground">Admin Panel</div>
        </div>
      )}
    </div>
  );
}

function NavList({
  activeTab,
  onTabChange,
  collapsed,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  collapsed?: boolean;
}) {
  return (
    <nav className="flex-1 overflow-y-auto py-2 scroll-thin">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onTabChange(item.id)}
          className={`group flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-all duration-150 ${
            activeTab === item.id
              ? "bg-primary/15 text-primary border-l-2 border-primary"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border-l-2 border-transparent"
          }`}
        >
          <span
            className={`shrink-0 ${activeTab === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}
          >
            {item.icon}
          </span>
          {!collapsed && <span className="truncate">{item.label}</span>}
        </button>
      ))}
    </nav>
  );
}

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const selectTab = (tab: string) => {
    onTabChange(tab);
    setMobileNavOpen(false);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* ── Sidebar (desktop) ──────────────────────── */}
      <aside
        className={`hidden flex-col border-r border-border/50 bg-background transition-all duration-300 md:flex ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <Brand collapsed={collapsed} />
        <NavList activeTab={activeTab} onTabChange={onTabChange} collapsed={collapsed} />
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center border-t border-border/40 py-3 text-muted-foreground hover:text-foreground transition"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </aside>

      {/* ── Sidebar (mobile, Sheet drawer) ─────────── */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-72 flex-col p-0">
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          <Brand />
          <NavList activeTab={activeTab} onTabChange={selectTab} />
        </SheetContent>
      </Sheet>

      {/* ── Main Content ────────────────────────────── */}
      <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-border/40 bg-background px-3 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
              aria-label="Open admin navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? "Admin"}
            </h1>
            <Link
              to="/"
              className="ml-1 hidden shrink-0 rounded-md border border-border/50 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent/50 sm:ml-2 sm:inline-block"
            >
              ← Back to Chat
            </Link>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                Updated {lastUpdated}
              </span>
            )}
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="flex items-center gap-1.5 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 transition"
              >
                <RefreshCw className="h-3 w-3" />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            )}
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 scroll-thin sm:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
