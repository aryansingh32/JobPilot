import { getPgPool, getRedisClient } from '../db/index.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// RUNTIME SETTINGS — editable from the admin panel, applied live.
// Each key has a default + validation here; overrides live in app_settings.
// Every process keeps an in-memory copy and reloads when an admin change is
// broadcast on SETTINGS_CHANNEL, so no redeploy is needed.
// ============================================================

const logger = createLogger('settings');
const SETTINGS_CHANNEL = 'settings:changed';

type Kind = 'string' | 'number' | 'boolean' | 'json';

interface SettingDef {
  kind: Kind;
  default: unknown;
  description: string;
  group: string;
  min?: number;
  max?: number;
  options?: string[];
  /** Never echoed back to the admin panel (provider keys etc.). */
  secret?: boolean;
}

// Haiku is a strong fit for résumé/job tasks and has the lowest observed
// inference cost among Coarena's evaluated models. Coarena's API is currently free.
const FREE_MODEL = 'claude-haiku-5-5';
const FREE_QUALITY_MODEL = 'claude-haiku-5-5';

export const SETTINGS = {
  // ── AI ─────────────────────────────────────────────
  'llm.killswitch': { kind: 'boolean', default: false, group: 'AI', description: 'Block every LLM call (rules/caches keep working).' },
  'llm.reasoning.enabled': { kind: 'boolean', default: false, group: 'AI', description: 'Allow reasoning traces (costly output tokens).' },
  'llm.model.chat_route': { kind: 'string', default: FREE_MODEL, group: 'AI', description: 'Model that classifies chat messages.' },
  'llm.model.chat_answer': { kind: 'string', default: FREE_QUALITY_MODEL, group: 'AI', description: 'Model for conversational answers / guidance.' },
  'llm.model.planner': { kind: 'string', default: FREE_QUALITY_MODEL, group: 'AI', description: 'Model that plans steps on unknown sites.' },
  'llm.model.selector': { kind: 'string', default: FREE_MODEL, group: 'AI', description: 'Model that re-finds broken selectors.' },
  'llm.model.recovery': { kind: 'string', default: FREE_MODEL, group: 'AI', description: 'Model that suggests recovery steps.' },
  'llm.model.resume_parse': { kind: 'string', default: FREE_QUALITY_MODEL, group: 'AI', description: 'Model that turns resume text into a profile.' },
  'llm.model.field_answers': { kind: 'string', default: FREE_QUALITY_MODEL, group: 'AI', description: 'Model that drafts answers to open form questions.' },
  'llm.model.answer_bank': { kind: 'string', default: FREE_QUALITY_MODEL, group: 'AI', description: 'Model that polishes the profile\'s ready-made answers (about you, strengths…) once per résumé change.' },
  'ai.answer_bank': { kind: 'boolean', default: true, group: 'AI', description: 'Let the model polish the ready-made profile answers (one small call per résumé change). Off = answers assembled by rule only.' },
  'llm.model.copilot': { kind: 'string', default: FREE_MODEL, group: 'AI', description: 'Model for the admin observability copilot.' },
  'llm.budget.user_daily_tokens': { kind: 'number', default: 200_000, min: 0, group: 'AI', description: 'Max tokens per user per day (0 = unlimited).' },
  'llm.budget.global_daily_usd': { kind: 'number', default: 25, min: 0, group: 'AI', description: 'Max LLM spend per day across all users (0 = unlimited).' },
  'llm.prices': {
    kind: 'json',
    default: { [FREE_MODEL]: { input: 0, output: 0 } },
    group: 'AI',
    description: 'USD per 1M tokens by model: { "model": { "input": 0.1, "output": 0.4 } }.',
  },
  // ── Answers ────────────────────────────────────────
  'apply.respect_review_setting': { kind: 'boolean', default: false, group: 'Answers', description: 'Honour a person\'s saved "review before submit" choice. Off: every application is sent without asking.' },
  'notify.email_summary': { kind: 'boolean', default: true, group: 'Answers', description: 'Email the person a PDF summary of every application the site confirmed.' },
  'apply.hold_ai_answers': { kind: 'boolean', default: false, group: 'Answers', description: 'Hold an application for the person\'s review when a model wrote any of its answers (off: every application is sent without asking).' },
  'answers.defaults': {
    kind: 'json',
    default: { disabled: [], overrides: {}, custom: [] },
    group: 'Answers',
    description: 'Answers given without asking (edited on the Default answers screen): { disabled: [rule ids], overrides: { id: "answer" }, custom: [{ id, enabled, match, exclude, answer }] }.',
  },
  // ── Applications ───────────────────────────────────
  'apply.daily_limit_per_user': { kind: 'number', default: 50, min: 0, group: 'Applications', description: 'Applications a user can start per day.' },
  'apply.max_concurrent_per_user': { kind: 'number', default: 3, min: 1, max: 20, group: 'Applications', description: 'Applications running at once per user.' },
  'apply.park_after_seconds': { kind: 'number', default: 120, min: 30, max: 600, group: 'Applications', description: 'How long a run waits for an answer/review with its browser open before parking (browser freed, resumed when the user answers).' },
  'apply.park_expiry_days': { kind: 'number', default: 7, min: 1, max: 60, group: 'Applications', description: 'Parked applications nobody answers are closed (and refunded) after this many days.' },
  // ── Auto Apply ─────────────────────────────────────
  'autoapply.enabled': { kind: 'boolean', default: true, group: 'Auto Apply', description: 'Run Auto Apply for users who turned it on (global kill switch).' },
  'autoapply.interval_minutes': { kind: 'number', default: 60, min: 10, max: 1440, group: 'Auto Apply', description: 'Minutes between scheduled Auto Apply runs per user.' },
  'autoapply.max_daily_cap': { kind: 'number', default: 25, min: 1, max: 200, group: 'Auto Apply', description: 'Highest daily cap a user can set.' },
  'autoapply.min_score_floor': { kind: 'number', default: 60, min: 0, max: 100, group: 'Auto Apply', description: 'Lowest match score a user may let Auto Apply use.' },
  'autoapply.users_per_tick': { kind: 'number', default: 50, min: 1, max: 1000, group: 'Auto Apply', description: 'Users processed per scheduler tick.' },
  // ── Credits ────────────────────────────────────────
  'credits.enabled': { kind: 'boolean', default: true, group: 'Credits', description: 'Applications cost credits (reserved at start, refunded if nothing is sent).' },
  'credits.signup_grant': { kind: 'number', default: 25, min: 0, max: 100_000, group: 'Credits', description: 'Free credits every account gets once.' },
  'credits.cost_per_application': { kind: 'number', default: 1, min: 0, max: 100, group: 'Credits', description: 'Credits one application costs.' },
  // ── Payments ───────────────────────────────────────
  'payments.enabled': { kind: 'boolean', default: true, group: 'Payments', description: 'Let users buy credit packs (needs Razorpay and/or Stripe keys).' },
  'payments.packs': {
    kind: 'json',
    default: [
      { id: 'starter', credits: 100, label: 'Starter', prices: { INR: 49900, USD: 900 } },
      { id: 'pro', credits: 400, label: 'Pro', prices: { INR: 149900, USD: 2900 } },
      { id: 'power', credits: 1200, label: 'Power', prices: { INR: 349900, USD: 6900 } },
    ],
    group: 'Payments',
    description: 'Credit packs: [{ id, label, credits, prices: { INR: paise, USD: cents } }].',
  },
  // ── Notifications ──────────────────────────────────
  'notifications.push_enabled': { kind: 'boolean', default: true, group: 'Notifications', description: 'Send push notifications to the mobile app (needs FCM credentials).' },
  // ── Jobs feed ──────────────────────────────────────
  'jobs.poll.enabled': { kind: 'boolean', default: true, group: 'Jobs', description: 'Poll company job boards on schedule.' },
  'jobs.poll.batch_size': { kind: 'number', default: 120, min: 1, max: 2000, group: 'Jobs', description: 'Active boards queued per scheduler tick (every minute).' },
  'jobs.poll.candidates_per_tick': { kind: 'number', default: 40, min: 0, max: 2000, group: 'Jobs', description: 'Newly discovered boards checked per tick (kept separate so discovery never starves live boards).' },
  'jobs.discovery.enabled': { kind: 'boolean', default: true, group: 'Jobs', description: 'Weekly: look for new company boards (Common Crawl + verified seeds).' },
  'jobs.focus_countries': { kind: 'json', default: ['IN'], group: 'Jobs', description: 'Countries that matter most: boards with jobs here are polled most often.' },
  'jobs.poll.focus_minutes': { kind: 'number', default: 180, min: 15, max: 10080, group: 'Jobs', description: 'Poll interval for boards with jobs in the focus countries.' },
  'jobs.poll.other_minutes': { kind: 'number', default: 2880, min: 60, max: 43200, group: 'Jobs', description: 'Poll interval for boards with jobs, none in the focus countries.' },
  'jobs.poll.empty_minutes': { kind: 'number', default: 10080, min: 60, max: 43200, group: 'Jobs', description: 'Poll interval for boards with no open jobs.' },
  'jobs.poll.max_backoff': { kind: 'number', default: 4, min: 1, max: 16, group: 'Jobs', description: 'Boards that keep not changing are polled up to this many times less often.' },
  'jobs.max_age_days': { kind: 'number', default: 45, min: 1, max: 365, group: 'Jobs', description: 'Hide jobs posted longer ago than this.' },
  'jobs.region_only': { kind: 'boolean', default: true, group: 'Jobs', description: 'Show only jobs in the person\'s region (their country, from their profile or network location) plus remote jobs they can work.' },
  'jobs.match.min_score': { kind: 'number', default: 35, min: 0, max: 100, group: 'Jobs', description: 'Minimum match score shown in Top matches.' },
  'jobs.apply_ready_only': { kind: 'boolean', default: true, group: 'Jobs', description: 'Browse and search only list jobs from systems we have applied through end to end (see the list below).' },
  'jobs.apply_ready_systems': { kind: 'json', default: ['greenhouse', 'ashby'], group: 'Jobs', description: 'Systems with a confirmed clean submit. Add one only after a real application through it succeeded.' },
  // ── Features ───────────────────────────────────────
  'features.signups': { kind: 'boolean', default: true, group: 'Features', description: 'Allow new accounts.' },
  'features.resume_parse': { kind: 'boolean', default: true, group: 'Features', description: 'Parse uploaded resumes into the profile.' },
  'features.inbox': { kind: 'boolean', default: true, group: 'Features', description: 'Accept inbound application emails.' },
  'inbox.domain': { kind: 'string', default: 'inbox.jobpilot.local', group: 'Features', description: 'Domain for per-user application inboxes.' },
  'inbox.live': { kind: 'boolean', default: false, group: 'Features', description: 'Inbound mail for inbox.domain is routed here: apply with the private inbox address (users who chose it).' },
  'inbox.forward_replies': { kind: 'boolean', default: true, group: 'Features', description: 'Forward employer replies that reach a private inbox to the user\'s own email.' },
  'features.gmail': { kind: 'boolean', default: true, group: 'Features', description: 'Let users connect Gmail (read-only) for codes and employer replies. Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.' },
  'gmail.sync_minutes': { kind: 'number', default: 5, min: 1, max: 1440, group: 'Features', description: 'How often connected Gmail accounts are checked (every minute while an application waits for a code).' },
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

let cache: Map<string, unknown> | null = null;
let loading: Promise<void> | null = null;
let subscribed = false;

async function load(): Promise<void> {
  const { rows } = await getPgPool().query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  cache = new Map(rows.map((r) => [r.key, r.value]));
}

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  if (!loading) {
    loading = load()
      .catch((err) => {
        // DB not ready yet (e.g. before migrations) → serve defaults.
        logger.warn('settings:load-failed', { error: (err as Error).message });
        cache = new Map();
      })
      .finally(() => {
        loading = null;
      });
  }
  await loading;
  if (!subscribed) {
    subscribed = true;
    void subscribeToChanges();
  }
}

async function subscribeToChanges(): Promise<void> {
  try {
    const redis = await getRedisClient();
    const sub = redis.duplicate();
    sub.on('error', (err) => logger.warn('settings:sub-error', { error: (err as Error).message }));
    await sub.connect();
    await sub.subscribe(SETTINGS_CHANNEL, () => {
      void load().catch(() => {});
    });
  } catch (err) {
    subscribed = false;
    logger.warn('settings:subscribe-failed', { error: (err as Error).message });
  }
}

export async function getSetting<K extends SettingKey>(key: K): Promise<unknown> {
  await ensureLoaded();
  return cache!.has(key) ? cache!.get(key) : SETTINGS[key].default;
}

export async function getNumber(key: SettingKey): Promise<number> {
  return Number(await getSetting(key));
}
export async function getBool(key: SettingKey): Promise<boolean> {
  return (await getSetting(key)) === true;
}
export async function getString(key: SettingKey): Promise<string> {
  return String(await getSetting(key));
}

export function validateSetting(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const def = (SETTINGS as Record<string, SettingDef>)[key];
  if (!def) return { ok: false, error: `Unknown setting "${key}"` };
  switch (def.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, error: 'Must be true or false' };
      break;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'Must be a number' };
      if (def.min !== undefined && value < def.min) return { ok: false, error: `Must be ≥ ${def.min}` };
      if (def.max !== undefined && value > def.max) return { ok: false, error: `Must be ≤ ${def.max}` };
      break;
    }
    case 'string':
      if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Must be a non-empty string' };
      if (def.options && !def.options.includes(value)) return { ok: false, error: `Must be one of ${def.options.join(', ')}` };
      break;
    case 'json':
      if (value === null || typeof value !== 'object') return { ok: false, error: 'Must be a JSON object' };
      break;
  }
  return { ok: true, value };
}

/** Admin write: validate, persist with history, broadcast to every process. */
export async function setSetting(key: string, value: unknown, changedBy: string): Promise<void> {
  const v = validateSetting(key, value);
  if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 400 });
  const pool = getPgPool();
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  await pool.query(
    `INSERT INTO app_settings (key, value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(value), (SETTINGS as Record<string, SettingDef>)[key].description, changedBy],
  );
  await pool.query(
    'INSERT INTO app_settings_history (key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)',
    [key, rows[0] ? JSON.stringify(rows[0].value) : null, JSON.stringify(value), changedBy],
  );
  cache?.set(key, value);
  const redis = await getRedisClient();
  await redis.publish(SETTINGS_CHANNEL, key);
}

/** Admin reset: drop the override so the default applies again. */
export async function resetSetting(key: string, changedBy: string): Promise<void> {
  if (!(key in SETTINGS)) throw Object.assign(new Error(`Unknown setting "${key}"`), { statusCode: 400 });
  const pool = getPgPool();
  const { rows } = await pool.query('DELETE FROM app_settings WHERE key = $1 RETURNING value', [key]);
  if (rows[0]) {
    await pool.query(
      'INSERT INTO app_settings_history (key, old_value, new_value, changed_by) VALUES ($1, $2, NULL, $3)',
      [key, JSON.stringify(rows[0].value), changedBy],
    );
  }
  cache?.delete(key);
  const redis = await getRedisClient();
  await redis.publish(SETTINGS_CHANNEL, key);
}

/** Everything the admin settings screen needs. */
export async function listSettings() {
  await ensureLoaded();
  const { rows } = await getPgPool().query<{ key: string; updated_by: string | null; updated_at: string }>(
    'SELECT key, updated_by, updated_at FROM app_settings',
  );
  const meta = new Map(rows.map((r) => [r.key, r]));
  return Object.entries(SETTINGS as Record<string, SettingDef>).map(([key, def]) => ({
    key,
    group: def.group,
    kind: def.kind,
    description: def.description,
    default: def.default,
    value: def.secret ? undefined : cache!.has(key) ? cache!.get(key) : def.default,
    overridden: cache!.has(key),
    min: def.min,
    max: def.max,
    options: def.options,
    updatedBy: meta.get(key)?.updated_by ?? null,
    updatedAt: meta.get(key)?.updated_at ?? null,
  }));
}
