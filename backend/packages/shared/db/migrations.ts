// ============================================================
// VERSIONED MIGRATIONS
// Applied in order after the idempotent baseline schema (SCHEMA_SQL in
// index.ts). Each runs once, inside a transaction, recorded in
// schema_migrations. NEVER edit a migration that has shipped — add a new one.
// ============================================================

export interface Migration {
  id: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0002_settings_audit_llm_usage',
    up: `
      -- Runtime config edited from the admin panel (cached in Redis, pushed live).
      CREATE TABLE app_settings (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        description TEXT,
        updated_by  TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE app_settings_history (
        id          BIGSERIAL PRIMARY KEY,
        key         TEXT NOT NULL,
        old_value   JSONB,
        new_value   JSONB,
        changed_by  TEXT,
        changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_settings_history_key ON app_settings_history(key, changed_at DESC);

      -- Every admin write.
      CREATE TABLE admin_audit_log (
        id          BIGSERIAL PRIMARY KEY,
        at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        admin_id    TEXT,
        role        TEXT,
        method      TEXT NOT NULL,
        path        TEXT NOT NULL,
        status      INTEGER,
        ip          TEXT,
        body        JSONB
      );
      CREATE INDEX idx_admin_audit_at ON admin_audit_log(at DESC);
      CREATE INDEX idx_admin_audit_admin ON admin_audit_log(admin_id, at DESC);

      -- One row per LLM call (token + cost accounting).
      CREATE TABLE llm_usage (
        id                BIGSERIAL PRIMARY KEY,
        at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        purpose           TEXT NOT NULL,
        model             TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
        cached_tokens     INTEGER NOT NULL DEFAULT 0,
        cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
        latency_ms        INTEGER,
        user_id           TEXT,
        job_id            TEXT,
        ok                BOOLEAN NOT NULL DEFAULT true,
        error             TEXT
      );
      CREATE INDEX idx_llm_usage_at ON llm_usage(at DESC);
      CREATE INDEX idx_llm_usage_purpose ON llm_usage(purpose, at DESC);
      CREATE INDEX idx_llm_usage_user ON llm_usage(user_id, at DESC);

      -- Admin roles: add 'support' (read + user help, no config writes).
      ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
      ALTER TABLE admins ADD CONSTRAINT admins_role_check
        CHECK (role IN ('viewer', 'support', 'editor', 'super-admin'));
    `,
  },
  {
    id: '0003_profiles_answers_resume',
    up: `
      -- Typed applicant profile (one per user) + history.
      CREATE TABLE profiles (
        user_id            TEXT PRIMARY KEY,
        data               JSONB NOT NULL DEFAULT '{}',
        version            INTEGER NOT NULL DEFAULT 1,
        onboarding_status  TEXT NOT NULL DEFAULT 'pending'
                           CHECK (onboarding_status IN ('pending', 'done', 'skipped')),
        completeness       INTEGER NOT NULL DEFAULT 0,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE profile_versions (
        id          BIGSERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        version     INTEGER NOT NULL,
        data        JSONB NOT NULL,
        source      TEXT NOT NULL DEFAULT 'user',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_profile_versions_user ON profile_versions(user_id, version DESC);

      -- Answers the user gave on forms, reused at zero AI cost.
      CREATE TABLE answer_memory (
        id             BIGSERIAL PRIMARY KEY,
        user_id        TEXT NOT NULL,
        question_hash  TEXT NOT NULL,
        question       TEXT NOT NULL,
        answer         TEXT NOT NULL,
        source         TEXT NOT NULL DEFAULT 'user',
        use_count      INTEGER NOT NULL DEFAULT 0,
        last_used_at   TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, question_hash)
      );

      CREATE TABLE resume_parses (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      TEXT NOT NULL,
        file_id      UUID,
        status       TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'failed')),
        text_chars   INTEGER,
        result       JSONB,
        model        TEXT,
        error        TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX idx_resume_parses_user ON resume_parses(user_id, created_at DESC);
    `,
  },
  {
    id: '0004_jobs_feed',
    up: `
      CREATE TABLE companies (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name        TEXT NOT NULL,
        domain      TEXT,
        country     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX idx_companies_name ON companies(lower(name));

      -- Registry of company boards on applicant systems (Tsenta-style).
      CREATE TABLE job_boards (
        id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        company_id             UUID REFERENCES companies(id) ON DELETE CASCADE,
        ats_type               TEXT NOT NULL,
        board_token            TEXT NOT NULL,
        country                TEXT,
        enabled                BOOLEAN NOT NULL DEFAULT true,
        poll_interval_minutes  INTEGER NOT NULL DEFAULT 180,
        last_polled_at         TIMESTAMPTZ,
        last_status            TEXT,
        last_error             TEXT,
        job_count              INTEGER NOT NULL DEFAULT 0,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (ats_type, board_token)
      );

      CREATE TABLE jobs (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        board_id         UUID NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
        company_id       UUID REFERENCES companies(id) ON DELETE SET NULL,
        external_id      TEXT NOT NULL,
        url              TEXT NOT NULL,
        title            TEXT NOT NULL,
        location         TEXT,
        country          TEXT,
        workplace        TEXT CHECK (workplace IN ('Remote', 'Hybrid', 'On-site')),
        employment_type  TEXT,
        department       TEXT,
        salary_min       NUMERIC,
        salary_max       NUMERIC,
        salary_currency  TEXT,
        salary_period    TEXT,
        posted_at        TIMESTAMPTZ,
        description      TEXT,
        skills           TEXT[] NOT NULL DEFAULT '{}',
        seniority        TEXT,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'hidden')),
        first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (board_id, external_id)
      );
      CREATE INDEX idx_jobs_active_posted ON jobs(status, posted_at DESC);
      CREATE INDEX idx_jobs_company ON jobs(company_id);

      CREATE TABLE saved_jobs (
        user_id    TEXT NOT NULL,
        job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, job_id)
      );
      CREATE TABLE job_feedback (
        user_id    TEXT NOT NULL,
        job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        action     TEXT NOT NULL CHECK (action IN ('pass', 'not_interested')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, job_id)
      );
    `,
  },
  {
    id: '0005_applications_inbox',
    up: `
      CREATE TABLE applications (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id        TEXT NOT NULL,
        job_id         UUID REFERENCES jobs(id) ON DELETE SET NULL,
        exec_job_id    TEXT UNIQUE,
        session_id     TEXT,
        title          TEXT NOT NULL,
        company        TEXT,
        url            TEXT,
        status         TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'needs_input', 'awaiting_review',
                                         'submitted', 'completed', 'failed', 'cancelled')),
        status_detail  TEXT,
        reference      TEXT,
        error          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at    TIMESTAMPTZ
      );
      CREATE INDEX idx_applications_user ON applications(user_id, updated_at DESC);
      CREATE INDEX idx_applications_status ON applications(status, updated_at DESC);

      CREATE TABLE application_events (
        id              BIGSERIAL PRIMARY KEY,
        application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        phase           TEXT NOT NULL,
        detail          JSONB NOT NULL DEFAULT '{}',
        at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_application_events_app ON application_events(application_id, at);

      CREATE TABLE inbox_addresses (
        user_id     TEXT PRIMARY KEY,
        address     TEXT UNIQUE NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE emails (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         TEXT NOT NULL,
        to_address      TEXT NOT NULL,
        from_name       TEXT,
        from_address    TEXT NOT NULL,
        subject         TEXT NOT NULL DEFAULT '',
        snippet         TEXT NOT NULL DEFAULT '',
        body_text       TEXT,
        category        TEXT NOT NULL DEFAULT 'other'
                        CHECK (category IN ('code', 'confirmation', 'reply', 'other')),
        extracted_code  TEXT,
        application_id  UUID REFERENCES applications(id) ON DELETE SET NULL,
        match_method    TEXT,
        read            BOOLEAN NOT NULL DEFAULT false,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_emails_user ON emails(user_id, received_at DESC);
    `,
  },
  {
    id: '0006_board_config',
    up: `
      -- Per-board settings; for 'custom' boards the endpoint + field map an admin defined.
      ALTER TABLE job_boards ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    id: '0007_mobile_park_credits',
    up: `
      -- Parked applications: the run released its browser while waiting for the
      -- user; resume_state holds what it was waiting for and how to continue.
      ALTER TABLE applications ADD COLUMN parked_at TIMESTAMPTZ;
      ALTER TABLE applications ADD COLUMN resume_state JSONB;
      ALTER TABLE applications ADD COLUMN credits_reserved INT NOT NULL DEFAULT 0;
      CREATE INDEX idx_applications_parked ON applications(parked_at) WHERE parked_at IS NOT NULL;

      -- Phones (FCM tokens) that get push notifications.
      CREATE TABLE push_devices (
        token         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        platform      TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'web')),
        app_version   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_push_devices_user ON push_devices(user_id);

      CREATE TABLE notifications (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        data        JSONB NOT NULL DEFAULT '{}',
        read        BOOLEAN NOT NULL DEFAULT false,
        pushed      INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

      -- Credits: append-only; balance = SUM(delta). A submitted application
      -- costs its reservation, a failed/cancelled one gets it back.
      CREATE TABLE credit_ledger (
        id              BIGSERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        delta           INT NOT NULL,
        reason          TEXT NOT NULL CHECK (reason IN ('grant', 'reserve', 'commit', 'refund', 'admin')),
        application_id  UUID REFERENCES applications(id) ON DELETE SET NULL,
        note            TEXT,
        actor           TEXT,
        balance_after   INT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, id DESC);

      -- Users an admin suspended can't sign in or call the API.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
      -- Bumped to sign a user out everywhere (tokens issued before it are rejected).
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;
    `,
  },
  {
    id: '0008_auto_apply',
    up: `
      -- Where an application came from (Auto Apply has its own daily cap).
      ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'chat', 'auto', 'admin_test'));
      CREATE INDEX idx_applications_user_source ON applications(user_id, source, created_at DESC);

      CREATE TABLE auto_apply_settings (
        user_id            TEXT PRIMARY KEY,
        enabled            BOOLEAN NOT NULL DEFAULT false,
        daily_cap          INT NOT NULL DEFAULT 10,
        min_score          INT NOT NULL DEFAULT 75,
        exclude_companies  TEXT[] NOT NULL DEFAULT '{}',
        last_run_at        TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_auto_apply_enabled ON auto_apply_settings(last_run_at) WHERE enabled;

      CREATE TABLE auto_apply_runs (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      TEXT NOT NULL,
        trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'admin')),
        status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'skipped', 'failed')),
        considered   INT NOT NULL DEFAULT 0,
        started      INT NOT NULL DEFAULT 0,
        application_ids UUID[] NOT NULL DEFAULT '{}',
        note         TEXT,
        started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at  TIMESTAMPTZ
      );
      CREATE INDEX idx_auto_apply_runs_user ON auto_apply_runs(user_id, started_at DESC);
    `,
  },
  {
    id: '0009_email_intent_outcome',
    up: `
      -- What an employer's email means (category stays the coarse inbox tab).
      ALTER TABLE emails ADD COLUMN intent TEXT
        CHECK (intent IN ('interview', 'assessment', 'offer', 'rejection'));
      -- Where the application stands with the employer after it was sent.
      ALTER TABLE applications ADD COLUMN outcome TEXT
        CHECK (outcome IN ('confirmed', 'interview', 'assessment', 'offer', 'rejected'));
    `,
  },
  {
    id: '0010_payments',
    up: `
      -- Credit pack purchases. Credits are granted once, when the provider
      -- confirms the payment (browser callback or webhook, whichever is first).
      CREATE TABLE payments (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id           TEXT NOT NULL,
        provider          TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
        provider_ref      TEXT,               -- Razorpay order id / Stripe checkout session id
        provider_payment  TEXT,               -- Razorpay payment id / Stripe payment intent
        pack_id           TEXT NOT NULL,
        credits           INT NOT NULL,
        amount            INT NOT NULL,       -- smallest unit (paise / cents)
        currency          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at           TIMESTAMPTZ,
        UNIQUE (provider, provider_ref)
      );
      CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);

      ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
      ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check
        CHECK (reason IN ('grant', 'reserve', 'commit', 'refund', 'admin', 'purchase'));
      ALTER TABLE credit_ledger ADD COLUMN payment_id UUID REFERENCES payments(id) ON DELETE SET NULL;
      -- One purchase entry per payment, however many confirmations arrive.
      CREATE UNIQUE INDEX idx_credit_ledger_payment ON credit_ledger(payment_id) WHERE reason = 'purchase';
    `,
  },
  {
    id: '0011_board_registry_scale',
    up: `
      -- Registry at scale (50k+ boards): where a board came from, whether it
      -- has jobs (and how many in the focus countries), and when to poll it
      -- next — busy boards often, quiet or irrelevant ones rarely.
      ALTER TABLE job_boards ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('candidate', 'active', 'empty', 'dead'));
      ALTER TABLE job_boards ADD COLUMN discovered_via TEXT NOT NULL DEFAULT 'seed';
      ALTER TABLE job_boards ADD COLUMN next_poll_at TIMESTAMPTZ;
      ALTER TABLE job_boards ADD COLUMN focus_job_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE job_boards ADD COLUMN unchanged_polls INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE job_boards ADD COLUMN last_change_at TIMESTAMPTZ;
      ALTER TABLE job_boards ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
      UPDATE job_boards SET next_poll_at = COALESCE(last_polled_at + (poll_interval_minutes || ' minutes')::interval, NOW());
      CREATE INDEX idx_job_boards_due ON job_boards(next_poll_at) WHERE enabled AND status <> 'dead';
      CREATE INDEX idx_job_boards_status ON job_boards(ats_type, status);

      -- Years of experience a job asks for ("2-5 yrs", Keka's "0-1"): eligibility for freshers vs experienced.
      ALTER TABLE jobs ADD COLUMN experience_min NUMERIC;
      ALTER TABLE jobs ADD COLUMN experience_max NUMERIC;
      CREATE INDEX idx_jobs_country_active ON jobs(country, posted_at DESC) WHERE status = 'active';

      -- Discovery runs (Common Crawl, open datasets, seed lists, pasted links).
      CREATE TABLE board_discovery_runs (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source       TEXT NOT NULL,
        params       JSONB NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
        found        INTEGER NOT NULL DEFAULT 0,
        added        INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at  TIMESTAMPTZ
      );
    `,
  },
  {
    id: '0012_mail_connections',
    up: `
      -- Connected mailboxes (Gmail, read-only): codes and employer replies for
      -- users who apply with their own address. Tokens are encrypted.
      CREATE TABLE mail_connections (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         TEXT NOT NULL,
        provider        TEXT NOT NULL CHECK (provider IN ('gmail')),
        address         TEXT NOT NULL,
        refresh_token   TEXT NOT NULL,
        access_token    TEXT,
        expires_at      TIMESTAMPTZ,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
        last_sync_at    TIMESTAMPTZ,
        last_error      TEXT,
        messages_kept   INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, provider)
      );
      CREATE INDEX idx_mail_connections_sync ON mail_connections(last_sync_at NULLS FIRST) WHERE status = 'active';

      -- Where a stored email came from, its id there (no duplicates), and the
      -- verification link it carries (opened for an application waiting on it).
      ALTER TABLE emails ADD COLUMN source TEXT NOT NULL DEFAULT 'inbox';
      ALTER TABLE emails ADD COLUMN external_id TEXT;
      ALTER TABLE emails ADD COLUMN extracted_link TEXT;
      CREATE UNIQUE INDEX idx_emails_external ON emails(user_id, source, external_id) WHERE external_id IS NOT NULL;
    `,
  },
  {
    id: '0013_job_deadlines',
    up: `
      -- Government notices have a closing date; a notice past it drops out of every list.
      ALTER TABLE jobs ADD COLUMN closes_at TIMESTAMPTZ;
      ALTER TABLE jobs ADD COLUMN vacancies INTEGER;
      CREATE INDEX idx_jobs_closes ON jobs(closes_at) WHERE closes_at IS NOT NULL;
    `,
  },
  {
    id: '0014_answer_intent_form_schemas',
    up: `
      -- Remembered answers are keyed by what the question MEANS (its intent) and where it holds (scope),
      -- so a reworded question reuses the answer, and a US work-authorisation answer isn't sent to a UK job.
      ALTER TABLE answer_memory ADD COLUMN intent TEXT;
      ALTER TABLE answer_memory ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
      CREATE INDEX idx_answer_memory_intent ON answer_memory(user_id, intent, scope) WHERE intent IS NOT NULL;

      -- What an application asks, learned from the first run at each posting (questions only, never anyone's answers).
      -- Later users see "this application asks N questions, M need you" before spending anything, and answers
      -- are resolved ahead of opening a browser.
      CREATE TABLE form_schemas (
        id           BIGSERIAL PRIMARY KEY,
        schema_key   TEXT NOT NULL UNIQUE,
        ats          TEXT,
        host         TEXT NOT NULL,
        url_sample   TEXT NOT NULL,
        fields       JSONB NOT NULL,
        pages        INTEGER NOT NULL DEFAULT 1,
        complete     BOOLEAN NOT NULL DEFAULT FALSE,
        seen_count   INTEGER NOT NULL DEFAULT 1,
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_form_schemas_host ON form_schemas(host, last_seen DESC);
    `,
  },
  {
    id: '0015_submit_attempt_unique_application',
    up: `
      -- Written just before the submit click: from then on a failure may still have sent the application,
      -- so a crash or timeout is "unconfirmed", never "not sent".
      ALTER TABLE applications ADD COLUMN submit_attempted_at TIMESTAMPTZ;
      UPDATE applications a SET submit_attempted_at = (SELECT MIN(e.at) FROM application_events e WHERE e.application_id = a.id AND e.phase = 'verified')
       WHERE a.status = 'failed' AND a.source <> 'admin_test';

      -- One live application per person per job, enforced by the database (two workers can both pass an
      -- application-level check). Skipped, not failed, if old data already breaks it.
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM applications WHERE job_id IS NOT NULL AND source <> 'admin_test' AND status NOT IN ('failed','cancelled')
           GROUP BY user_id, job_id HAVING COUNT(*) > 1
        ) THEN
          CREATE UNIQUE INDEX uq_applications_live_job ON applications(user_id, job_id)
            WHERE job_id IS NOT NULL AND source <> 'admin_test' AND status NOT IN ('failed','cancelled');
        ELSE
          RAISE NOTICE 'uq_applications_live_job skipped: duplicate live applications exist';
        END IF;
      END $$;
    `,
  },
  {
    id: '0016_campaigns',
    up: `
      -- "Apply to N jobs": a target with an honest end state, not just a daily cap.
      CREATE TABLE campaigns (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      TEXT NOT NULL,
        target       INT NOT NULL CHECK (target BETWEEN 1 AND 500),
        min_score    INT NOT NULL DEFAULT 75,
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'exhausted', 'stopped')),
        stop_reason  TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at  TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX uq_campaigns_one_active ON campaigns(user_id) WHERE status = 'active';
      CREATE INDEX idx_campaigns_user ON campaigns(user_id, created_at DESC);
      ALTER TABLE applications ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
      CREATE INDEX idx_applications_campaign ON applications(campaign_id) WHERE campaign_id IS NOT NULL;
    `,
  },
  {
    id: '0017_auto_submit',
    up: `
      -- Auto Apply sends by itself when nothing in the application was guessed (see review-policy.ts).
      ALTER TABLE auto_apply_settings ADD COLUMN auto_submit BOOLEAN NOT NULL DEFAULT true;
    `,
  },
  {
    id: '0018_clean_board_tokens',
    up: `
      -- Discovery once kept a link's query string as part of the board ("lithia/wd5/site?q=…"): thousands of
      -- junk candidates that only ever failed. Keep the real board, retire the junk rows.
      INSERT INTO job_boards (ats_type, board_token, status, discovered_via, next_poll_at)
      SELECT DISTINCT ats_type, split_part(board_token, '?', 1), 'candidate', 'cleanup', NULL::timestamptz
        FROM job_boards WHERE board_token LIKE '%?%' AND split_part(board_token, '?', 1) <> ''
      ON CONFLICT (ats_type, board_token) DO NOTHING;
      UPDATE job_boards SET status = 'dead', enabled = false, last_error = 'Token carried a query string' WHERE board_token LIKE '%?%' AND job_count = 0;
    `,
  },
  {
    id: '0019_llm_cache_write_tokens',
    up: `
      ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
