import type { CaptchaProvider, ChallengeType } from './types.js';
import { TwoCaptchaProvider } from './providers/twocaptcha.js';
import { AntiCaptchaProvider } from './providers/anticaptcha.js';
import { CapSolverProvider } from './providers/capsolver.js';

// ============================================================
// PROVIDER REGISTRY
// Auto-selects a configured provider for a given challenge type.
// Selection is pure config lookup — no LLM call, no network probe.
// ============================================================

const ALL_PROVIDERS: CaptchaProvider[] = [
  new TwoCaptchaProvider(),
  new AntiCaptchaProvider(),
  new CapSolverProvider(),
];

function priorityOrder(): string[] {
  const configured = process.env.CAPTCHA_PROVIDER_PRIORITY;
  if (configured) return configured.split(',').map((s) => s.trim()).filter(Boolean);
  return ['2captcha', 'anti-captcha', 'capsolver'];
}

/** Every provider that has an API key configured, regardless of challenge support — used for admin status display. */
export function listConfiguredProviders(): CaptchaProvider[] {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

export function listAllProviders(): CaptchaProvider[] {
  return ALL_PROVIDERS;
}

/**
 * Pick the best configured provider for a challenge type, honoring
 * CAPTCHA_PROVIDER_PRIORITY order. Returns null if nothing configured
 * supports this challenge type — the caller falls back to human-in-the-loop.
 */
export function selectProvider(challengeType: ChallengeType): CaptchaProvider | null {
  const order = priorityOrder();
  const configured = listConfiguredProviders().filter((p) => p.supports.has(challengeType));
  if (!configured.length) return null;

  configured.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });
  return configured[0];
}
