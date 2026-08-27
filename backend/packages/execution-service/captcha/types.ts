import type { HumanInterventionEventType, InterventionResolvedBy } from '../../shared/types/index.js';

// ============================================================
// CAPTCHA / HUMAN-VERIFICATION SUBSYSTEM — shared types
// ============================================================

/**
 * Challenge classification. Distinct from the workflow-authored
 * `expectedInput` (otp/mfa/captcha/...) — this is what the DETECTOR
 * actually observes on the page, which can disagree with what the
 * workflow author expected (e.g. a step marked `captcha` that today
 * renders a Cloudflare interstitial instead).
 *
 * 'waf-block' / 'rate-limit' / 'js-interstitial' are detected and
 * reported ONLY — this subsystem never attempts to defeat them.
 */
export type ChallengeType =
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'hcaptcha'
  | 'cloudflare-turnstile'
  | 'image-text'
  | 'slider'
  | 'puzzle'
  | 'otp'
  | 'mfa'
  | 'login-verification'
  | 'waf-block'
  | 'rate-limit'
  | 'js-interstitial'
  | 'unknown';

/** Challenge types a legitimate solver API can be asked to solve. Everything else is human-only by design. */
export const SOLVABLE_CHALLENGE_TYPES: ReadonlySet<ChallengeType> = new Set([
  'recaptcha-v2',
  'recaptcha-v3',
  'hcaptcha',
  'cloudflare-turnstile',
  'image-text',
  'slider',
  'puzzle',
]);

/** Challenge types that represent an anti-bot control, not a CAPTCHA — never bypassed, always routed to human/report. */
export const SECURITY_BLOCK_TYPES: ReadonlySet<ChallengeType> = new Set([
  'waf-block',
  'rate-limit',
  'js-interstitial',
]);

export interface ChallengeDetection {
  detected: boolean;
  type: ChallengeType;
  eventType: HumanInterventionEventType;
  selector?: string;
  sitekey?: string;
  /** Human-readable signal that triggered detection, for logs/metadata (e.g. "title contains 'Just a moment...'"). */
  signal?: string;
}

export interface ProviderSolveRequest {
  challengeType: ChallengeType;
  sitekey?: string;
  pageUrl: string;
  /** Data URL or remote URL of a rendered image challenge (image-text). */
  imageUrl?: string;
}

export interface ProviderSolveResult {
  solved: boolean;
  token?: string;
  error?: string;
  costUsd: number;
  providerTaskId?: string;
}

export interface CaptchaProvider {
  readonly id: string;
  /** Whether this provider is configured (API key present) and usable right now. */
  isConfigured(): boolean;
  /** Challenge types this provider can be asked to solve. */
  readonly supports: ReadonlySet<ChallengeType>;
  solve(request: ProviderSolveRequest): Promise<ProviderSolveResult>;
}

export interface ResolveChallengeInput {
  jobId: string;
  userId: string;
  siteId: string;
  workflowKey?: string;
  stepId: string;
  pageUrl: string;
  /** What the workflow step itself declared it expects (may be undefined for opportunistically-detected blocks). */
  expectedEventType?: HumanInterventionEventType;
  detection: ChallengeDetection;
}

export interface ResolveChallengeOutcome {
  resolved: boolean;
  resolvedBy: InterventionResolvedBy;
  token?: string;
  /** For human-loop paths: the value the human/admin submitted (captcha text, OTP code, MFA code, etc.). */
  humanValue?: string;
  provider?: string;
  attempts: number;
  costUsd: number;
  error?: string;
}
