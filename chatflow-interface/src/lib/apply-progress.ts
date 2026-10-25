import type { ApplicationDetail } from "./api-client";

/** The journey of one application, in the words a person would use. */
export const APPLY_STAGES = [
  { id: "start", label: "Starting", phases: ["queued", "running"] },
  { id: "account", label: "Signing in", phases: ["account", "link_opened", "code_autofilled"] },
  { id: "form", label: "Reading the form", phases: ["parse"] },
  { id: "answers", label: "Filling answers", phases: ["answers"] },
  { id: "review", label: "Your review", phases: ["needs_input", "awaiting_review", "verified"] },
  { id: "submit", label: "Submitting", phases: ["submitted", "completed"] },
] as const;

export interface ApplyProgress {
  /** Index of the stage in progress (or the last one reached). */
  current: number;
  /** Fraction 0–1 for a bar. */
  fraction: number;
  state: "working" | "needs" | "done" | "failed" | "cancelled";
  /** What's happening right now, in one line. */
  now: string;
}

const NOW_BY_STAGE = [
  "Opening the job page…",
  "Setting up your account on the site…",
  "Reading the application form…",
  "Filling in your answers…",
  "Waiting for you",
  "Sending your application…",
];

export function applyProgress(
  app: Pick<ApplicationDetail, "status" | "status_detail" | "error">,
  events: ApplicationDetail["events"] = [],
): ApplyProgress {
  let current = 0;
  for (const e of events) {
    const i = APPLY_STAGES.findIndex((s) => (s.phases as readonly string[]).includes(e.phase));
    if (i > current) current = i;
  }
  if (app.status === "awaiting_review" || app.status === "needs_input")
    current = Math.max(current, 4);
  if (app.status === "submitted" || app.status === "completed") current = APPLY_STAGES.length - 1;

  const state: ApplyProgress["state"] =
    app.status === "failed"
      ? "failed"
      : app.status === "cancelled"
        ? "cancelled"
        : app.status === "submitted" || app.status === "completed"
          ? "done"
          : app.status === "awaiting_review" || app.status === "needs_input"
            ? "needs"
            : "working";

  const fraction =
    state === "done" ? 1 : (current + (state === "working" ? 0.5 : 0.85)) / APPLY_STAGES.length;
  const lastNote = [...events].reverse().find((e) => typeof e.detail?.detail === "string")?.detail
    .detail as string | undefined;
  const now =
    state === "done"
      ? "Submitted"
      : state === "failed"
        ? app.error || "Stopped with an error"
        : state === "cancelled"
          ? "Cancelled"
          : state === "needs"
            ? app.status === "awaiting_review"
              ? "Ready for your review"
              : "I need something from you"
            : app.status_detail && !/^started$/i.test(app.status_detail)
              ? app.status_detail
              : (lastNote ?? NOW_BY_STAGE[current]);
  return { current, fraction: Math.min(fraction, 1), state, now };
}
