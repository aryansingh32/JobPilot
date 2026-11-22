import type { CSSProperties } from "react";

/**
 * Every job gets its own colour: a hue from a hand-picked set (no muddy
 * yellows or neon greens), chosen by hashing the company and title so the same
 * job is always the same colour but a list looks varied.
 */
const HUES = [8, 24, 38, 152, 172, 192, 208, 226, 250, 272, 292, 322, 342];

export function jobHue(job: { company: string; title?: string }): number {
  let h = 0;
  for (const c of `${job.company}|${job.title ?? ""}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/**
 * Neighbouring cards must never look alike: in a list the hue steps through this
 * order (warm → cool → warm …, far apart on the wheel), repeating every 8 cards.
 */
const ROTATION = [24, 208, 322, 152, 8, 250, 38, 192];

/** Spread on a card with className="job-tint" (see styles.css). Pass the card's position to alternate colours. */
export const jobTint = (job: { company: string; title?: string }, index?: number): CSSProperties =>
  ({
    "--h": index === undefined ? jobHue(job) : ROTATION[index % ROTATION.length],
  }) as CSSProperties;

/** "Closes in 6 days" / "Closes today" / null when no deadline or it's passed. */
export function closesIn(closesAt?: number): { label: string; urgent: boolean } | null {
  if (!closesAt) return null;
  const days = Math.ceil((closesAt - Date.now()) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return { label: "Closes today", urgent: true };
  return { label: `Closes in ${days} day${days === 1 ? "" : "s"}`, urgent: days <= 5 };
}
