import pg from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { createLogger } from '../logger/index.js';

// ============================================================
// DATABASE & CACHE LAYER
// Postgres for structured data, Redis for fast cache + sessions.
// Full schema migrations run on startup.
// ============================================================

const { Pool } = pg;
const logger = createLogger('shared-db');

// ─── Postgres ────────────────────────────────────────────────

let pgPool: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new Pool({
      host:     process.env.POSTGRES_HOST ?? 'localhost',
      port:     parseInt(process.env.POSTGRES_PORT ?? '5432'),
      database: process.env.POSTGRES_DB ?? 'automation',
      user:     process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'changeme',
      max:      20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pgPool.on('error', (err) => {
      logger.error('postgres:pool-error', err);
    });
  }
  return pgPool;
}

// ─── Transaction Helper ──────────────────────────────────────

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Redis ───────────────────────────────────────────────────

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    const password = process.env.REDIS_PASSWORD;
    const url = password
      ? `redis://:${password}@${process.env.REDIS_HOST ?? 'localhost'}:${process.env.REDIS_PORT ?? '6379'}`
      : `redis://${process.env.REDIS_HOST ?? 'localhost'}:${process.env.REDIS_PORT ?? '6379'}`;

    redisClient = createClient({ url }) as RedisClientType;

    redisClient.on('error', (err: Error) => {
      logger.error('redis:client-error', err);
    });

    await redisClient.connect();
    logger.info('redis:connected');
  }
  return redisClient;
}

// ─── Cache Helpers ───────────────────────────────────────────

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  try {
    const redis = await getRedisClient();
    const data = await redis.get(key);
    return data ? JSON.parse(data) as T : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 1800): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    logger.error('cache:set-failed', err, { key, ttlSeconds });
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(key);
  } catch {}
}

// ─── Cache Key Constants ─────────────────────────────────────

export const CacheKeys = {
  session:     (id: string) => `session:${id}`,
  domSnapshot: (pageId: string) => `dom:${pageId}`,
  siteGraph:   (siteId: string) => `graph:${siteId}`,
  flowCache:   (siteId: string, taskHash: string) => `flow:${siteId}:${taskHash}`,
  jobRuntime:  (jobId: string) => `job-runtime:${jobId}`,
  jobCancel:   (jobId: string) => `job-cancel:${jobId}`,
  proxyPool:   () => 'proxy:pool',
};

// ─── Schema Migrations ───────────────────────────────────────

const SCHEMA_SQL = `

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Sites ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain      TEXT UNIQUE NOT NULL,
  config      JSONB DEFAULT '{}',
  page_count  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Pages ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id           UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  title             TEXT,
  load_time_ms      INTEGER,
  dom_hash          TEXT,
  reliability_score REAL DEFAULT 1.0,
  last_verified     TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (site_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_site_id ON pages(site_id);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);

-- ── Elements ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS elements (
  id            TEXT PRIMARY KEY,
  page_id       UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  label         TEXT,
  attributes    JSONB DEFAULT '{}',
  bounding_box  JSONB,
  visible       BOOLEAN DEFAULT true,
  interactable  BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_elements_page_id ON elements(page_id);
CREATE INDEX IF NOT EXISTS idx_elements_type ON elements(type);

-- ── Selectors ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS selectors (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  element_id      TEXT NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
  value           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('css', 'xpath', 'text', 'aria', 'ai-generated')),
  confidence      REAL DEFAULT 0.5,
  last_validated  TIMESTAMPTZ DEFAULT NOW(),
  failure_count   INTEGER DEFAULT 0,
  UNIQUE (element_id, value)
);
CREATE INDEX IF NOT EXISTS idx_selectors_element_id ON selectors(element_id);

-- ── Page Edges (Navigation Graph) ────────────────────────────
CREATE TABLE IF NOT EXISTS page_edges (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_page_id    UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_text       TEXT,
  selector        TEXT,
  navigation_type TEXT DEFAULT 'click' CHECK (navigation_type IN ('click', 'form-submit', 'direct')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_page_edges_site ON page_edges(site_id);

-- ── Sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,
  cookies             JSONB DEFAULT '[]',
  local_storage       JSONB DEFAULT '{}',
  proxy_id            UUID,
  browser_context_id  TEXT,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  last_used           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── User Profiles (safe long-term memory) ───────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       TEXT NOT NULL,
  profile_name  TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, profile_name)
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);

-- ── Site Workflows / Custom Mapping Instructions ────────────
CREATE TABLE IF NOT EXISTS site_workflows (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_key          TEXT UNIQUE,
  site_id               UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  category              TEXT DEFAULT 'general',
  name                  TEXT NOT NULL,
  trigger               TEXT NOT NULL,
  trigger_phrases       TEXT[] DEFAULT '{}',
  portal_type           TEXT CHECK (portal_type IN ('government', 'jobs', 'education', 'banking', 'general', 'aadhaar', 'shopping', 'media', 'ticketing', 'subscriptions', 'healthcare', 'travel', 'general-web')),
  site_section          TEXT,
  entry_url             TEXT,
  page_url              TEXT,
  page_url_pattern      TEXT,
  page_url_patterns     TEXT[] DEFAULT '{}',
  required_inputs       TEXT[] DEFAULT '{}',
  required_files        TEXT[] DEFAULT '{}',
  instructions          TEXT NOT NULL,
  default_profile_name  TEXT,
  starter_action_plan   JSONB DEFAULT '[]',
  error_recovery_plan   JSONB DEFAULT '[]',
  version               INTEGER DEFAULT 1,
  is_active             BOOLEAN DEFAULT true,
  completion_artifact   TEXT,
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (site_id, name)
);
CREATE INDEX IF NOT EXISTS idx_site_workflows_site_id ON site_workflows(site_id);
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS portal_type TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS site_section TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS entry_url TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS page_url TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS page_url_pattern TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS workflow_key TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS trigger_phrases TEXT[] DEFAULT '{}';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS page_url_patterns TEXT[] DEFAULT '{}';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS required_inputs TEXT[] DEFAULT '{}';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS required_files TEXT[] DEFAULT '{}';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS error_recovery_plan JSONB DEFAULT '[]';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS completion_artifact TEXT;
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE site_workflows ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
-- Widen portal_type beyond the original gov/jobs/education/banking/general/aadhaar
-- set (additive — existing rows and values are unaffected) so workflows can be
-- authored for arbitrary site categories, not just Indian government portals.
ALTER TABLE site_workflows DROP CONSTRAINT IF EXISTS site_workflows_portal_type_check;
ALTER TABLE site_workflows ADD CONSTRAINT site_workflows_portal_type_check
  CHECK (portal_type IN ('government', 'jobs', 'education', 'banking', 'general', 'aadhaar', 'shopping', 'media', 'ticketing', 'subscriptions', 'healthcare', 'travel', 'general-web'));
UPDATE site_workflows
SET workflow_key = COALESCE(workflow_key, CONCAT(site_id::text, ':', lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))))
WHERE workflow_key IS NULL;
UPDATE site_workflows
SET category = COALESCE(NULLIF(category, ''), portal_type, 'general')
WHERE category IS NULL OR category = '';
UPDATE site_workflows
SET trigger_phrases = CASE
  WHEN COALESCE(array_length(trigger_phrases, 1), 0) = 0 THEN ARRAY[trigger]
  ELSE trigger_phrases
END;
UPDATE site_workflows
SET page_url_patterns = CASE
  WHEN COALESCE(array_length(page_url_patterns, 1), 0) = 0 AND page_url_pattern IS NOT NULL THEN ARRAY[page_url_pattern]
  WHEN COALESCE(array_length(page_url_patterns, 1), 0) = 0 THEN '{}'
  ELSE page_url_patterns
END;
CREATE INDEX IF NOT EXISTS idx_site_workflows_workflow_key ON site_workflows(workflow_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_workflows_workflow_key_unique ON site_workflows(workflow_key);

-- ── User Files (uploads/download artifacts) ─────────────────
CREATE TABLE IF NOT EXISTS user_files (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          TEXT NOT NULL,
  profile_name     TEXT,
  category         TEXT NOT NULL CHECK (category IN ('resume', 'signature', 'photo', 'document', 'receipt', 'other')),
  original_name    TEXT NOT NULL,
  stored_name      TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  file_size_bytes  BIGINT NOT NULL,
  storage_path     TEXT NOT NULL,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_files_user_id ON user_files(user_id);
CREATE INDEX IF NOT EXISTS idx_user_files_category ON user_files(category);

-- ── Proxies ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proxies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password      TEXT,
  protocol      TEXT DEFAULT 'http' CHECK (protocol IN ('http', 'https', 'socks5')),
  health_score  REAL DEFAULT 1.0,
  latency_ms    INTEGER,
  failure_rate  REAL DEFAULT 0.0,
  is_active     BOOLEAN DEFAULT true,
  last_checked  TIMESTAMPTZ DEFAULT NOW(),
  tags          TEXT[] DEFAULT '{}',
  UNIQUE (host, port)
);

-- ── Cached Flows (AI Task Memory) ────────────────────────────
CREATE TABLE IF NOT EXISTS cached_flows (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  task_hash       TEXT NOT NULL,
  task            TEXT NOT NULL,
  action_plan     JSONB NOT NULL,
  success_count   INTEGER DEFAULT 0,
  failure_count   INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  last_used       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (site_id, task_hash)
);
CREATE INDEX IF NOT EXISTS idx_cached_flows_lookup ON cached_flows(site_id, task_hash);

-- ── Job Logs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_logs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id                TEXT NOT NULL,
  type                  TEXT NOT NULL,
  site_id               UUID REFERENCES sites(id) ON DELETE SET NULL,
  user_id               TEXT,
  session_id            TEXT,
  status                TEXT DEFAULT 'pending',
  started_at            TIMESTAMPTZ DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,
  success               BOOLEAN,
  ai_call_count         INTEGER DEFAULT 0,
  selector_fallback_cnt INTEGER DEFAULT 0,
  retry_count           INTEGER DEFAULT 0,
  result                JSONB,
  error                 TEXT,
  task                  TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE job_logs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE job_logs ADD COLUMN IF NOT EXISTS session_id TEXT;
-- Original task text, needed so a failed job can actually be re-enqueued on
-- retry instead of just flipping a status flag (Redis runtime state has a
-- 24h TTL and may be long gone by the time an admin retries an old job).
ALTER TABLE job_logs ADD COLUMN IF NOT EXISTS task TEXT;
ALTER TABLE job_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_status ON job_logs(status);
CREATE INDEX IF NOT EXISTS idx_job_logs_user_id ON job_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_session_id ON job_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_started_at ON job_logs(started_at);

-- ── File Indexes ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_files_created_at ON user_files(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used);


-- ── Change Log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS change_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_id           UUID REFERENCES pages(id) ON DELETE CASCADE,
  change_type       TEXT NOT NULL,
  old_hash          TEXT,
  new_hash          TEXT,
  remap_triggered   BOOLEAN DEFAULT false,
  detected_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_change_log_page ON change_log(page_id);

-- ── Observability: unified client + server events (session replay source) ──
CREATE TABLE IF NOT EXISTS observability_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ts           TIMESTAMPTZ DEFAULT NOW(),
  source       TEXT NOT NULL CHECK (source IN ('client', 'server', 'security')),
  event_type   TEXT NOT NULL,
  user_id      TEXT,
  session_id   TEXT,
  trace_id     TEXT,
  span_id      TEXT,
  request_id   TEXT,
  route        TEXT,
  release      TEXT,
  git_sha      TEXT,
  ip_hash      TEXT,
  payload      JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_obs_events_ts ON observability_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_events_session ON observability_events(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_events_user ON observability_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_events_type ON observability_events(event_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_events_trace ON observability_events(trace_id);

-- ── Error intelligence (enriched failures for admin + AI copilot) ─────────
CREATE TABLE IF NOT EXISTS error_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ts            TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'api',
  fingerprint   TEXT,
  message       TEXT NOT NULL,
  stack         TEXT,
  user_id       TEXT,
  session_id    TEXT,
  request_id    TEXT,
  trace_id      TEXT,
  route         TEXT,
  method        TEXT,
  http_status   INTEGER,
  severity      TEXT DEFAULT 'error',
  context       JSONB DEFAULT '{}',
  resolved      BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_error_reports_ts ON error_reports(ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_reports_fingerprint ON error_reports(fingerprint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_reports_user ON error_reports(user_id, ts DESC);


-- ── Users (real end-user accounts — Google / email OTP / mobile OTP) ──
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE,
  email_verified  BOOLEAN DEFAULT false,
  mobile_number   TEXT UNIQUE,
  mobile_verified BOOLEAN DEFAULT false,
  google_id       TEXT UNIQUE,
  display_name    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile_number);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- ── Admins ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key TEXT UNIQUE,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'super-admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE admins ALTER COLUMN api_key DROP NOT NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ── Workflow Audit Log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  workflow_id UUID REFERENCES site_workflows(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  diff JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_admin_id ON workflow_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_workflow_id ON workflow_audit_log(workflow_id);

-- ── Zero Shot History ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zero_shot_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url TEXT NOT NULL,
  prompt TEXT NOT NULL,
  steps JSONB NOT NULL,
  result JSONB,
  success BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── User Secrets (PII) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, site_id, key_name)
);
CREATE INDEX IF NOT EXISTS idx_user_secrets_user_id ON user_secrets(user_id);

`;

export async function seedAdmins(): Promise<void> {
  const pool = getPgPool();
  try {
    const res = await pool.query(`SELECT COUNT(*) FROM admins`);
    if (parseInt(res.rows[0].count) === 0) {
      const username = process.env.ADMIN_USERNAME;
      const password = process.env.ADMIN_PASSWORD;
      const defaultKey = process.env.ADMIN_API_KEY;

      if (!username && !password && !defaultKey) {
        throw new Error(
          'FATAL: no admin credentials configured — set ADMIN_USERNAME + ADMIN_PASSWORD (for the admin login screen) and/or ADMIN_API_KEY (for scripted/CI access).'
        );
      }

      if (username && password) {
        const { hashPassword } = await import('../auth/index.js');
        const passwordHash = await hashPassword(password);
        await pool.query(
          `INSERT INTO admins (username, password_hash, api_key, role) VALUES ($1, $2, $3, 'super-admin')`,
          [username, passwordHash, defaultKey ?? null]
        );
        logger.info('migrations:seeded-default-admin', { username });
      } else if (defaultKey) {
        await pool.query(`INSERT INTO admins (api_key, role) VALUES ($1, 'super-admin')`, [defaultKey]);
        logger.info('migrations:seeded-default-admin-key-only');
      }
    }
  } catch (err) {
    logger.error('migrations:seed-admins-failed', err);
    throw err;
  }
}

export async function runMigrations(): Promise<void> {
  const pool = getPgPool();
  try {
    await pool.query(SCHEMA_SQL);
    logger.info('migrations:complete');
    await seedAdmins();
  } catch (err) {
    logger.error('migrations:failed', err);
    throw err;
  }
}
