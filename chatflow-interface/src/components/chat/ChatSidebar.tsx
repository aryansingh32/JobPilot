import { useEffect, useRef, useState } from "react";
import {
  History,
  ListChecks,
  Mail,
  Briefcase,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SquarePen,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { Thread } from "@/lib/chat-types";

interface Props {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Desktop: expanded panel vs. icon rail. Mobile: drawer open vs. hidden. */
  isOpen?: boolean;
  onOpen: () => void;
  onClose: () => void;
  userLabel?: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLogout: () => void;
  /** Tasks overview: whether it's showing, how to open it, and how many wait on the user */
  tasksActive?: boolean;
  onShowTasks: () => void;
  jobsActive?: boolean;
  onShowJobs: () => void;
  inboxActive?: boolean;
  onShowInbox: () => void;
  autoApplyActive?: boolean;
  onShowAutoApply: () => void;
  /** Opens the settings dialog (portal password…). */
  onOpenSettings?: () => void;
  /** Credit balance (null when credits are off) and the "Buy" action. */
  credits?: number | null;
  onBuyCredits?: () => void;
  /** Auto Apply switched on (shows "On" next to the entry). */
  autoApplyOn?: boolean;
  unreadCount?: number;
  needsCount?: number;
}

const DAY = 24 * 60 * 60 * 1000;

const isPhone = () => typeof window !== "undefined" && window.innerWidth < 768;

export function ChatSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
  isOpen = true,
  onOpen,
  onClose,
  userLabel,
  theme,
  onToggleTheme,
  onLogout,
  tasksActive = false,
  onShowTasks,
  jobsActive = false,
  onShowJobs,
  inboxActive = false,
  onShowInbox,
  autoApplyActive = false,
  onShowAutoApply,
  onOpenSettings,
  autoApplyOn = false,
  credits = null,
  onBuyCredits,
  unreadCount = 0,
  needsCount = 0,
}: Props) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searching && isOpen) searchRef.current?.focus();
  }, [searching, isOpen]);

  const q = query.trim().toLowerCase();
  // Blank chats aren't history.
  const written = threads.filter((t) => t.messages.length > 0);
  const visible = q ? written.filter((t) => (t.title || "").toLowerCase().includes(q)) : written;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: { label: string; items: Thread[] }[] = [
    { label: "Today", items: visible.filter((t) => t.updatedAt >= startOfToday) },
    {
      label: "Previous 7 days",
      items: visible.filter(
        (t) => t.updatedAt < startOfToday && t.updatedAt >= startOfToday - 7 * DAY,
      ),
    },
    { label: "Older", items: visible.filter((t) => t.updatedAt < startOfToday - 7 * DAY) },
  ].filter((g) => g.items.length);

  const afterPick = () => {
    if (isPhone()) onClose();
  };
  const initial = (userLabel || "?").slice(0, 1);

  return (
    <aside
      data-state={isOpen ? "open" : "closed"}
      className="group/sb absolute z-40 flex h-full w-[272px] -translate-x-full flex-col border-r border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-sidebar-foreground shadow-xl transition-[transform,width] duration-200 data-[state=open]:translate-x-0 md:relative md:translate-x-0 md:shadow-none md:data-[state=closed]:w-[60px]"
    >
      {/* ── Collapsed rail (desktop only) ── */}
      {!isOpen && (
        <div
          onClick={onOpen}
          title="Open sidebar"
          className="hidden h-full cursor-e-resize flex-col items-center gap-1 py-3 md:flex"
        >
          <button
            onClick={onOpen}
            className="group/logo relative grid h-10 w-10 cursor-pointer place-items-center rounded-xl hover:bg-sidebar-accent"
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <span className="relative transition-opacity group-hover/logo:opacity-0">
              <Brand compact />
              {needsCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-sidebar"
                  aria-label={`${needsCount} task${needsCount > 1 ? "s" : ""} need you`}
                />
              )}
            </span>
            <PanelLeftOpen className="absolute h-[18px] w-[18px] text-muted-foreground opacity-0 transition-opacity group-hover/logo:opacity-100" />
          </button>
          <RailButton label="New task" onClick={onNew}>
            <SquarePen className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton
            label="Search tasks"
            onClick={() => {
              setSearching(true);
              onOpen();
            }}
          >
            <Search className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="Browse jobs" onClick={onShowJobs}>
            <Briefcase className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="Applications" onClick={onShowTasks}>
            <ListChecks className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="Inbox" onClick={onShowInbox}>
            <Mail className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="Auto Apply" onClick={onShowAutoApply}>
            <Zap className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton label="History" onClick={onOpen}>
            <History className="h-[18px] w-[18px]" />
          </RailButton>
          <div className="mt-auto flex flex-col items-center gap-1">
            <RailButton
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? (
                <Sun className="h-[18px] w-[18px]" />
              ) : (
                <Moon className="h-[18px] w-[18px]" />
              )}
            </RailButton>
            <span
              title={userLabel ?? undefined}
              className="mt-1 grid h-8 w-8 place-items-center rounded-full bg-primary text-[12px] font-bold uppercase text-primary-foreground"
            >
              {initial}
            </span>
          </div>
        </div>
      )}

      {/* ── Expanded panel (desktop) / drawer (mobile) ── */}
      <div className={`h-full min-w-[272px] flex-col ${isOpen ? "flex" : "flex md:hidden"}`}>
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <div className="px-1">
            <Brand />
          </div>
          <div className="flex items-center">
            <button
              onClick={() => setSearching((v) => !v)}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Search tasks"
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Close sidebar"
            >
              <PanelLeftClose className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        <div className="space-y-0.5 px-2 pt-2">
          <button
            onClick={() => {
              onNew();
              afterPick();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-sidebar-accent/60"
          >
            <SquarePen className="h-[18px] w-[18px]" /> New task
          </button>
          <button
            onClick={() => {
              onShowJobs();
              afterPick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
              jobsActive
                ? "bg-sidebar-accent text-foreground"
                : "text-ink-2 hover:bg-sidebar-accent/60 hover:text-foreground"
            }`}
          >
            <Briefcase className="h-[18px] w-[18px]" /> Browse jobs
          </button>
          <button
            onClick={() => {
              onShowTasks();
              afterPick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
              tasksActive
                ? "bg-sidebar-accent text-foreground"
                : "text-ink-2 hover:bg-sidebar-accent/60 hover:text-foreground"
            }`}
          >
            <ListChecks className="h-[18px] w-[18px]" /> Applications
            {needsCount > 0 && (
              <span className="ml-auto rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-soft-foreground">
                {needsCount} need{needsCount > 1 ? "" : "s"} you
              </span>
            )}
          </button>
          <button
            onClick={() => {
              onShowInbox();
              afterPick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
              inboxActive
                ? "bg-sidebar-accent text-foreground"
                : "text-ink-2 hover:bg-sidebar-accent/60 hover:text-foreground"
            }`}
          >
            <Mail className="h-[18px] w-[18px]" /> Inbox
            {unreadCount > 0 && (
              <span className="ml-auto text-[12px] font-semibold text-foreground">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              onShowAutoApply();
              afterPick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
              autoApplyActive
                ? "bg-sidebar-accent text-foreground"
                : "text-ink-2 hover:bg-sidebar-accent/60 hover:text-foreground"
            }`}
          >
            <Zap className="h-[18px] w-[18px]" /> Auto Apply
            {autoApplyOn && (
              <span className="ml-auto rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-soft-foreground">
                On
              </span>
            )}
          </button>
          {searching && (
            <div className="flex items-center gap-2 rounded-xl border border-sidebar-border px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-faint" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tasks"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-faint focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search">
                  <X className="h-3.5 w-3.5 text-faint" />
                </button>
              )}
            </div>
          )}
        </div>

        <nav className="scroll-thin mt-4 flex-1 overflow-y-auto px-2 pb-3">
          {groups.length === 0 && (
            <p className="px-3 py-2 text-[13px] text-faint">
              {q ? "No tasks match that." : "Your tasks will show up here."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-4">
              <div className="px-3 pb-1.5 text-[12px] font-medium text-faint">{g.label}</div>
              {g.items.map((t) => {
                const active = t.id === activeId;
                return (
                  <div
                    key={t.id}
                    className={`group flex items-center rounded-xl transition-colors ${
                      active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                    }`}
                  >
                    <button
                      onClick={() => {
                        onSelect(t.id);
                        afterPick();
                      }}
                      className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[14px] ${
                        active ? "font-medium text-foreground" : "text-ink-2"
                      }`}
                    >
                      {t.title || "New task"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(t.id);
                      }}
                      className="mr-1 rounded-lg p-1.5 text-faint opacity-100 transition hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
                      aria-label="Delete task"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        {credits !== null && (
          <div className="flex items-center justify-between border-t border-sidebar-border px-4 py-2.5 text-[13px]">
            <span className="text-ink-2">
              <span className="font-semibold tabular-nums text-foreground">{credits}</span> credits
              left
            </span>
            {onBuyCredits && (
              <button
                onClick={() => {
                  onBuyCredits();
                  afterPick();
                }}
                className="rounded-full border border-border px-2.5 py-0.5 text-[12px] font-medium text-foreground hover:border-faint"
              >
                Buy
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-3">
          <button
            onClick={() => {
              onOpenSettings?.();
              afterPick();
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left hover:bg-sidebar-accent"
            aria-label="Open settings"
            title="Settings"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold uppercase text-primary-foreground">
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
              {userLabel || "Signed in"}
            </span>
          </button>
          <button
            onClick={onToggleTheme}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={onLogout}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function RailButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className="grid h-10 w-10 cursor-pointer place-items-center rounded-xl text-ink-2 transition-colors hover:bg-sidebar-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <img src="/logo.png" alt="" className="h-8 w-8 rounded-lg bg-black object-cover" />
      {!compact && (
        <span className="text-[17px] font-semibold tracking-tight text-foreground">jobpilot</span>
      )}
    </div>
  );
}
