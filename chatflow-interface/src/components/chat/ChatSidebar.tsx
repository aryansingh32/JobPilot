import { useEffect, useState } from "react";
import {
  Plus,
  MessageSquare,
  Trash2,
  PanelLeftClose,
  User,
  Workflow,
  Clock,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { Profile, Thread } from "@/lib/chat-types";
import { api, type UserProfile, type SiteWorkflow } from "@/lib/api-client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("frontend-chat-sidebar");

interface Props {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  profile: Profile;
  profiles: Profile[];
  onProfileChange: (id: string) => void;
  isOpen?: boolean;
}

export function ChatSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onClose,
  profile,
  profiles,
  onProfileChange,
  isOpen = true,
}: Props) {
  const [backendProfiles, setBackendProfiles] = useState<UserProfile[]>([]);
  const [workflows, setWorkflows] = useState<SiteWorkflow[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);

  // Load backend profiles
  useEffect(() => {
    loadProfiles();
    loadWorkflows();
  }, []);

  const loadProfiles = async () => {
    setLoadingProfiles(true);
    try {
      const { profiles: p } = await api.getProfiles();
      setBackendProfiles(p);
    } catch (err) {
      logger.error("profiles:load-failed", err);
    } finally {
      setLoadingProfiles(false);
    }
  };

  const loadWorkflows = async () => {
    setLoadingWorkflows(true);
    try {
      const { workflows: w } = await api.listWorkflows();
      setWorkflows(w);
    } catch (err) {
      logger.error("workflows:load-failed", err);
    } finally {
      setLoadingWorkflows(false);
    }
  };

  // Merge local profiles with backend profiles
  const allProfiles: Profile[] = [
    ...profiles,
    ...backendProfiles
      .filter((bp) => !profiles.some((lp) => lp.id === bp.profileName))
      .map((bp) => ({
        id: bp.profileName,
        name: bp.profileName.charAt(0).toUpperCase() + bp.profileName.slice(1),
        description: `${Object.keys(bp.data).length} fields saved`,
      })),
  ];

  return (
    <aside
      data-state={isOpen ? "open" : "closed"}
      className="absolute z-40 flex h-full w-72 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:relative md:translate-x-0 transition-transform -translate-x-full data-[state=open]:translate-x-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
    >
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground">
            A
          </span>
          Agent
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          aria-label="Hide sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2 text-sm font-medium hover:bg-sidebar-accent"
        >
          <Plus className="h-4 w-4" /> New chat
        </button>
      </div>

      <div className="px-3 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <Clock className="h-3 w-3" /> History
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-2">
        {threads.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group mb-0.5 flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
              }`}
            >
              <button
                onClick={() => onSelect(t.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.title || "New chat"}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(t.id);
                }}
                className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive"
                aria-label="Delete chat"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-sidebar-border p-3 space-y-3">
        {/* Profile Selector */}
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <User className="h-3 w-3" /> Profile
            {loadingProfiles && <Loader2 className="h-3 w-3 animate-spin" />}
            <button
              onClick={loadProfiles}
              className="ml-auto rounded p-0.5 hover:bg-sidebar-accent"
              aria-label="Refresh profiles"
            >
              <RefreshCw className="h-2.5 w-2.5" />
            </button>
          </label>
          <select
            value={profile.id}
            onChange={(e) => onProfileChange(e.target.value)}
            className="w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {allProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Workflows */}
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Workflow className="h-3 w-3" /> Workflows
            {loadingWorkflows && <Loader2 className="h-3 w-3 animate-spin" />}
            <button
              onClick={loadWorkflows}
              className="ml-auto rounded p-0.5 hover:bg-sidebar-accent"
              aria-label="Refresh workflows"
            >
              <RefreshCw className="h-2.5 w-2.5" />
            </button>
          </label>
          {workflows.length > 0 ? (
            <div className="space-y-1 max-h-28 overflow-y-auto scroll-thin">
              {workflows.slice(0, 10).map((w) => (
                <div
                  key={w.id}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent/50"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-primary/60 shrink-0" />
                  <span className="truncate">{w.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground opacity-70 px-1">
              {loadingWorkflows ? "Loading…" : "No workflows available"}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
