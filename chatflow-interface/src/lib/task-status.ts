import type { ChatMessage, Thread } from "./chat-types";

export type TaskStatus = "needs" | "working" | "done" | "failed" | "idle";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  needs: "Needs you",
  working: "Working",
  done: "Done",
  failed: "Failed",
  idle: "Draft",
};

/**
 * Derive a task's state from its conversation: an unanswered ask or review
 * means it's waiting on the user; a receipt means it finished; a running
 * timeline means the agent is still going.
 */
export function taskStatus(thread: Thread): TaskStatus {
  const msgs = thread.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as ChatMessage;
    if ((m.type === "input-card" || m.type === "review") && !m.resolved) return "needs";
    if (m.type === "receipt") return m.status === "failed" ? "failed" : "done";
    if (m.type === "timeline") {
      if (!m.done) return m.steps.some((s) => s.status === "error") ? "failed" : "working";
      return "done";
    }
  }
  return "idle";
}

/** One-line summary shown under the task title. */
export function taskSummary(thread: Thread): string {
  const msgs = thread.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "review" && !m.resolved) return `Review before ${m.actionLabel.toLowerCase()}`;
    if (m.type === "input-card" && !m.resolved) return m.prompt;
    if (m.type === "receipt")
      return m.reference ? `${m.site ?? "Done"} · Ref ${m.reference}` : (m.site ?? "Done");
    if (m.type === "timeline") return m.steps.find((s) => s.status === "active")?.label ?? m.title;
    if (m.type === "text" && m.role === "user") return m.content;
  }
  return "No messages yet";
}
