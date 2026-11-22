import type { Locator } from 'playwright';
/** Resolve only an unambiguous target; recheck all candidates as SPA content arrives. */
export async function resolveCandidates(build: (candidate: string) => Locator, candidates: string[], options: { timeout: number; visible: boolean }): Promise<Locator> {
  const deadline = Date.now() + options.timeout;
  do {
    for (const candidate of candidates) {
      try {
        const locator = build(candidate);
        const count = await locator.count();
        if (count > 50) continue;
        if (!options.visible) { if (count === 1) return locator; continue; }
        let match: Locator | undefined;
        let ambiguous = false;
        for (let i = 0; i < count; i++) {
          const item = locator.nth(i);
          if (await item.isVisible()) {
            if (match) { ambiguous = true; break; }
            match = item;
          }
        }
        if (match && !ambiguous) return match;
      } catch { /* A malformed or stale candidate must not block valid fallbacks. */ }
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  throw new Error('Selector resolution failed: no unique eligible target before timeout');
}
