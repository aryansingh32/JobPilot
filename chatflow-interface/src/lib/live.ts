import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jp, type ApplicationSummary } from "./api-client";
import type { TaskStatus } from "./task-status";

// Live data from the user API. Polling keeps status/badges fresh without a
// page reload; mutations invalidate exactly what they change.

export const keys = {
  me: ["me"] as const,
  recs: ["recommendations"] as const,
  apps: (filter: string) => ["applications", filter] as const,
  app: (id: string) => ["application", id] as const,
  inbox: (category: string) => ["inbox", category] as const,
  profile: ["profile"] as const,
  autoApply: ["auto-apply"] as const,
  autoApplyPreview: ["auto-apply", "preview"] as const,
  autoApplyRuns: ["auto-apply", "runs"] as const,
  pulse: ["jobs-pulse"] as const,
  integrations: ["integrations"] as const,
};

/** "162 new roles fit you since yesterday" — refreshed every minute while the screen is open. */
export function useJobPulse(enabled = true) {
  return useQuery({
    queryKey: keys.pulse,
    queryFn: jp.pulse,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useIntegrations(enabled = true) {
  return useQuery({
    queryKey: keys.integrations,
    queryFn: jp.integrations,
    enabled,
    staleTime: 15_000,
  });
}

export function useAutoApply(enabled = true) {
  return useQuery({ queryKey: keys.autoApply, queryFn: jp.autoApply, enabled, staleTime: 10_000 });
}

export function useAutoApplyPreview(enabled = true) {
  return useQuery({
    queryKey: keys.autoApplyPreview,
    queryFn: jp.autoApplyPreview,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAutoApplyRuns(enabled = true) {
  return useQuery({
    queryKey: keys.autoApplyRuns,
    queryFn: jp.autoApplyRuns,
    enabled,
    refetchInterval: 30_000,
  });
}

/** Save settings / run now; refreshes everything Auto Apply touches. */
export function useAutoApplyActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["auto-apply"] });
    void qc.invalidateQueries({ queryKey: ["applications"] });
    void qc.invalidateQueries({ queryKey: keys.me });
  };
  return {
    save: useMutation({ mutationFn: jp.saveAutoApply, onSuccess: refresh }),
    run: useMutation({ mutationFn: jp.runAutoApply, onSettled: refresh }),
  };
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: keys.me,
    queryFn: jp.me,
    enabled,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useRecommendations(enabled = true) {
  return useQuery({
    queryKey: keys.recs,
    queryFn: () => jp.recommendations(24),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useApplications(filter = "all", enabled = true) {
  return useQuery({
    queryKey: keys.apps(filter),
    queryFn: () => jp.applications(filter, 100),
    enabled,
    refetchInterval: (q) =>
      (q.state.data?.applications ?? []).some(
        (a) => a.status === "queued" || a.status === "running",
      )
        ? 4_000
        : 15_000,
    staleTime: 3_000,
  });
}

export function useApplication(id: string | null) {
  return useQuery({
    queryKey: keys.app(id ?? ""),
    queryFn: () => jp.application(id!),
    enabled: !!id,
    // A captcha being solved click-by-click needs the fresh crop quickly.
    // While it's running the stage tracker should move on its own: poll fast, then relax once it's finished.
    refetchInterval: (q) =>
      q.state.data?.pending?.captchaUrl
        ? 1_500
        : ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 2_500
          : 10_000,
  });
}

export function useInbox(category = "all", enabled = true) {
  return useQuery({
    queryKey: keys.inbox(category),
    queryFn: () => jp.inbox(category),
    enabled,
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
}

export function useJobActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.recs });
  return {
    save: useMutation({ mutationFn: jp.saveJob }),
    unsave: useMutation({ mutationFn: jp.unsaveJob }),
    pass: useMutation({ mutationFn: jp.passJob, onSuccess: refresh }),
  };
}

export function useApplicationActions() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["applications"] });
    qc.invalidateQueries({ queryKey: ["application"] });
    qc.invalidateQueries({ queryKey: keys.me });
  };
  return {
    cancel: useMutation({ mutationFn: jp.cancelApplication, onSuccess: refresh }),
    resolve: useMutation({
      mutationFn: ({ id, action }: { id: string; action: "applied" | "skip" }) => jp.resolveApplication(id, action),
      onSuccess: refresh,
    }),
    start: useMutation({ mutationFn: jp.startApplication, onSuccess: refresh }),
    respond: useMutation({
      mutationFn: ({ id, value }: { id: string; value: string }) =>
        jp.respondToApplication(id, value),
      onSuccess: refresh,
    }),
  };
}

export function useInboxActions() {
  const qc = useQueryClient();
  return {
    markRead: useMutation({
      mutationFn: ({ id, read }: { id: string; read: boolean }) => jp.markEmailRead(id, read),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["inbox"] });
        qc.invalidateQueries({ queryKey: keys.me });
      },
    }),
  };
}

// ─── Application status → the UI's task status vocabulary ───────────────────

export function appStatus(a: Pick<ApplicationSummary, "status">): TaskStatus {
  switch (a.status) {
    case "needs_input":
    case "awaiting_review":
      return "needs";
    case "queued":
    case "running":
      return "working";
    case "submitted":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

/** One line under the title: what's happening, or what came out of it. */
export function appSummary(a: ApplicationSummary): string {
  if (a.status === "awaiting_review")
    return a.status_detail || "Ready for your review before submitting";
  if (a.status === "needs_input") return a.status_detail || "Waiting on something from you";
  if (a.status === "failed") return a.error || a.status_detail || "Couldn't finish this one";
  if (a.status === "cancelled") return "Cancelled";
  if (a.reference) return `Submitted · ref ${a.reference}`;
  return a.status_detail || (a.status === "queued" ? "Queued — starting shortly" : a.company || "");
}

export const ts = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Date.now());
