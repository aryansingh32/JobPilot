import type { Page } from 'playwright';
import type { InputCardKind, HumanInterventionEventType } from '../../shared/types/index.js';
import type { ChallengeDetection, ChallengeType } from './types.js';

// ============================================================
// CHALLENGE DETECTOR
// Pure DOM/response inspection — no LLM calls, no network calls.
// Classifies what's actually on the page right now:
//   • a solvable CAPTCHA widget (recaptcha/hcaptcha/turnstile/slider/puzzle/image)
//   • a workflow-authored human checkpoint (otp/mfa/login-verification)
//   • an anti-bot SECURITY BLOCK (WAF interstitial / rate limit) — this
//     subsystem detects these and routes to a human/report; it never
//     attempts to defeat them (no fingerprint spoofing, no rate-limit
//     evasion, no WAF bypass logic lives here).
// ============================================================

/** expectedInput values that are known human-checkpoints by workflow authoring, not DOM-detected. */
export function classifyExpectedInput(
  expectedInput: InputCardKind | undefined
): { type: ChallengeType; eventType: HumanInterventionEventType } | null {
  switch (expectedInput) {
    case 'otp':
      return { type: 'otp', eventType: 'otp' };
    case 'mfa':
      return { type: 'mfa', eventType: 'mfa' };
    case 'loginVerification':
      return { type: 'login-verification', eventType: 'login_verification' };
    default:
      return null;
  }
}

interface DomSignal {
  detected: boolean;
  type: ChallengeType;
  selector?: string;
  sitekey?: string;
  signal?: string;
}

async function detectCaptchaWidget(page: Page): Promise<DomSignal> {
  return page.evaluate(() => {
    const rc2 = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
    if (rc2) {
      return {
        detected: true,
        type: 'recaptcha-v2' as const,
        selector: '.g-recaptcha',
        sitekey: rc2.getAttribute('data-sitekey') ?? undefined,
        signal: 'g-recaptcha element/iframe present',
      };
    }
    if (document.querySelector('script[src*="recaptcha/api.js"]')) {
      return { detected: true, type: 'recaptcha-v3' as const, signal: 'recaptcha/api.js script present' };
    }
    const hcap = document.querySelector('.h-captcha, iframe[src*="hcaptcha"]');
    if (hcap) {
      return {
        detected: true,
        type: 'hcaptcha' as const,
        selector: '.h-captcha',
        sitekey: hcap.getAttribute('data-sitekey') ?? undefined,
        signal: 'h-captcha element/iframe present',
      };
    }
    if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare"]')) {
      return { detected: true, type: 'cloudflare-turnstile' as const, signal: 'cf-turnstile element/iframe present' };
    }
    if (document.querySelector('[class*="slider"][class*="captcha"], [id*="slider-captcha"]')) {
      return { detected: true, type: 'slider' as const, signal: 'slider-captcha class/id present' };
    }
    if (document.querySelector('[class*="puzzle-captcha"], [class*="jigsaw"]')) {
      return { detected: true, type: 'puzzle' as const, signal: 'puzzle/jigsaw class present' };
    }
    if (document.querySelector('img[src*="captcha"], img[alt*="captcha" i], canvas[id*="captcha"]')) {
      return { detected: true, type: 'image-text' as const, signal: 'captcha image/canvas present' };
    }
    return { detected: false, type: 'unknown' as const };
  });
}

const WAF_TITLE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /attention required/i,
  /access denied/i,
  /are you a human/i,
  /please verify you are a human/i,
  /security check/i,
];

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /slow down/i];

async function detectSecurityBlock(page: Page, lastResponseStatus?: number): Promise<DomSignal> {
  if (lastResponseStatus === 429) {
    return { detected: true, type: 'rate-limit', signal: `HTTP 429 response` };
  }

  const pageSignals = await page.evaluate(() => ({
    title: document.title || '',
    bodyText: (document.body?.innerText || '').slice(0, 500),
    hasCfWrapper: Boolean(document.querySelector('#cf-wrapper, .cf-error-details, [class*="cf-browser-verification"]')),
  })).catch(() => null);

  if (!pageSignals) return { detected: false, type: 'unknown' };

  if (RATE_LIMIT_PATTERNS.some((p) => p.test(pageSignals.title) || p.test(pageSignals.bodyText))) {
    return { detected: true, type: 'rate-limit', signal: 'rate-limit copy detected in page text' };
  }

  if (pageSignals.hasCfWrapper || WAF_TITLE_PATTERNS.some((p) => p.test(pageSignals.title))) {
    // Distinguish a genuine solvable Turnstile widget (already handled above)
    // from a bare JS interstitial / hard WAF block with no widget to solve.
    if (lastResponseStatus === 403 || lastResponseStatus === 503 || pageSignals.hasCfWrapper) {
      return { detected: true, type: 'waf-block', signal: `WAF interstitial markers (status=${lastResponseStatus ?? 'n/a'})` };
    }
    return { detected: true, type: 'js-interstitial', signal: 'browser-check interstitial title' };
  }

  return { detected: false, type: 'unknown' };
}

function toEventType(type: ChallengeType): HumanInterventionEventType {
  switch (type) {
    case 'otp': return 'otp';
    case 'mfa': return 'mfa';
    case 'login-verification': return 'login_verification';
    case 'waf-block':
    case 'rate-limit':
    case 'js-interstitial':
      return 'security_block';
    case 'unknown':
      return 'generic';
    default:
      return 'captcha';
  }
}

/**
 * Classify the current page/step state. Order of precedence:
 *   1. Workflow-authored checkpoint (otp/mfa/login-verification) — cheapest,
 *      no DOM work needed, and authoritative for what the step means.
 *   2. A solvable CAPTCHA widget actually present in the DOM.
 *   3. An anti-bot security block (WAF/rate-limit/JS interstitial).
 *   4. Nothing detected.
 */
export async function detectChallenge(
  page: Page,
  opts: { expectedInput?: InputCardKind; lastResponseStatus?: number } = {}
): Promise<ChallengeDetection> {
  const authored = classifyExpectedInput(opts.expectedInput);
  if (authored) {
    return { detected: true, type: authored.type, eventType: authored.eventType, signal: 'workflow-authored expectedInput' };
  }

  const widget = await detectCaptchaWidget(page).catch((): DomSignal => ({ detected: false, type: 'unknown' }));
  if (widget.detected) {
    return {
      detected: true,
      type: widget.type,
      eventType: 'captcha',
      selector: widget.selector,
      sitekey: widget.sitekey,
      signal: widget.signal,
    };
  }

  const block = await detectSecurityBlock(page, opts.lastResponseStatus);
  if (block.detected) {
    return { detected: true, type: block.type, eventType: 'security_block', signal: block.signal };
  }

  return { detected: false, type: 'unknown', eventType: 'generic' };
}

export { toEventType };
