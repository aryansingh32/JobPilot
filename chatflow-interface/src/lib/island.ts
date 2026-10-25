// Events the rest of the app (and the AI) can put on the dynamic island.

export type IslandTone = "info" | "success" | "warn" | "error";
export type IslandTarget = "tasks" | "inbox" | "jobs" | "autoapply";

export interface IslandEvent {
  id: string;
  tone: IslandTone;
  title: string;
  body?: string;
  /** Tapping the island (or its button) goes here. */
  action?: { label: string; view?: IslandTarget; appId?: string };
  /** ms on screen; default 6000. */
  ttl?: number;
}

export const ISLAND_EVENT = "island:show";

/** Put a notice on the island from anywhere: `showIsland({ tone: "success", title: "…" })`. */
export function showIsland(ev: Omit<IslandEvent, "id"> & { id?: string }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(ISLAND_EVENT, { detail: { id: `ev-${Date.now()}-${Math.random()}`, ...ev } }),
  );
}
