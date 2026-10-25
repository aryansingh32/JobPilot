# JobPilot Backend — Full Build Plan

**Date:** 2026-10-21
**Inputs:** audit of `backend/packages/*` (13.3k lines), Tsenta teardown (`docs/competitive/tsenta-teardown.md`), token plan (`docs/backend-cost-plan.md`).
**Supersedes the ordering in** `backend-cost-plan.md`; its token-saving tickets are folded in below.

---

## 0. Decisions (from you)

| Topic | Decision |
|---|---|
| Market | **India + US from day one** |
| Job source | **Own board crawler** (company → applicant-system registry, poll public job APIs) **+ keep recorded workflows** as per-site adapters |
| Apply engine | **Hybrid:** dedicated adapters for big applicant systems (API/HTTP first, scripted browser next), generic AI browser agent only for unknown sites |
| Infra | **Hybrid:** managed cloud for Postgres / Redis / object storage + API + admin; **Oracle VM** (4 OCPU / 24 GB) for browser workers; **cheap paid AI model** behind one gateway |
| Email | **Own inbox domain first** (name@inbox.<domain> → webhook); Gmail/Outlook OAuth later |
| Billing | **Credits ledger now**, Razorpay/Stripe checkout later |
| Resume | **Text extraction + one cheap AI call** → structured profile the user confirms |
| Chat | **Structured API first, chat on top** — every action is a REST endpoint; chat is a thin assistant calling the same actions |
| Admin | **Separate admin service + separate admin API**; the admin panel controls everything (users, jobs, adapters, AI, credits, workers, config…) |

**Assumed (you skipped these — change any of them):** beta scale ~**1k applications/day** (designed to add workers); **Auto Apply in phase 2**; first adapters **Greenhouse, Lever, Ashby → Workday**, then SmartRecruiters/SuccessFactors/Oracle and Naukri/Zoho.

---

## 1. Where the backend is today

**Good foundations to keep**
- Fastify API + Socket.IO, BullMQ queues on Redis, Playwright browser pool with stealth + fingerprints, proxy manager, captcha orchestrator with 3 providers, selector engine with self-healing (`selectors` table), recorder → workflow generalizer, dry-run service, change detector, AES-256-GCM secrets (`user_secrets`), OTP auth (email/mobile/Google), observability events + Prometheus + OTel hooks, admin auth with roles (viewer/editor/super-admin).

**Gaps for a job-application product**

| Area | Today | Problem |
|---|---|---|
| Data model | sites/pages/elements/selectors/workflows/flows; profile = one free-form JSON blob | No **jobs, companies, boards, applications, answers, emails, credits** tables. No typed profile. |
| Migrations | One idempotent SQL string in `shared/db/index.ts` run at boot | No versions, no rollback, risky as schema grows; every service runs DDL on start. |
| Control flow | Chat LLM decides everything; jobs are generic "execute task" | No application state machine, no review payload, no receipts tied to applications. |
| Retries | Execute jobs inherit `attempts: 3` | **A failure after the submit click can re-submit an application.** |
| Paused jobs | Executor blocks a worker slot + live browser waiting on Redis (15-min kill) | Wastes capacity; a worker restart loses the paused job. |
| Files | Local disk via shared Docker volume | Breaks across hosts (Oracle VM workers + cloud API). |
| Admin | Routes live inside the user API; import worker internals (`getBrowserPool()` in the API process) | **Admin browser stats/recycle act on the API's own empty pool, not the workers.** Admin and users share one attack surface. |
| AI | 5 call sites, no gateway, reasoning on, no usage tracking | See `backend-cost-plan.md`. |
| Tests | 2 test files | No safety net for refactors. |
| Notifications | Socket.IO only | No push, no email notifications, no SMS beyond OTP. |

---

## 2. Target architecture

```
                        ┌──────────────── Managed cloud ────────────────┐
  Web / mobile ──HTTPS──▶  api-service      (user REST + Socket.IO)      │
                        │   • auth, profile, jobs feed, applications     │
                        │   • review/approve, receipts, inbox, credits   │
                        │   • chat assistant (calls the same actions)    │
  Admin panel ──HTTPS──▶  admin-service    (separate app, port, auth)    │
                        │   • RBAC + audit log + IP allowlist            │
                        │   • controls everything via DB + control bus   │
  Mail provider ───────▶  inbound-mail webhook (part of api, own route)  │
                        │                                               │
                        │  Postgres (managed)   Redis (managed)          │
                        │  Object storage (S3/R2)  ← files, PDFs, traces │
                        └───────────────▲───────────────▲───────────────┘
                                        │ queues        │ control bus (Redis pub/sub + streams)
                        ┌───────────────┴───────────────┴───────────────┐
                        │  Oracle VM — worker node(s)                    │
                        │   apply-worker   (adapters + browser pool)     │
                        │   crawl-worker   (board pollers, enrichment)   │
                        │   parse-worker   (resume parse, mail parse)    │
                        │   scheduler      (cron: polls, cleanups,       │
                        │                   auto-apply in phase 2)       │
                        └────────────────────────────────────────────────┘
```

**Packages (monorepo stays):**
- `shared/` — db (+ migrations), queue, config/settings, llm gateway, storage, auth, logger, types, **control-bus**.
- `api-service/` — user API only.
- `admin-service/` — **new**, admin API only (moved out of api-service).
- `apply-service/` — evolves from `execution-service`: adapters, executor, browser pool, captcha.
- `jobs-service/` — evolves from `crawler-service`: board registry, pollers, normalizer, enrichment, matcher.
- `parse-service/` — resume + email parsing (can start inside `jobs-service` worker process).
- `scheduler-service/` — cron + change detection (kept).
- `ai-service/` — planner/agent for unknown sites; everything LLM goes through `shared/llm/gateway`.

---

## 3. Data model (new / changed tables)

Versioned migrations (`node-pg-migrate` or Drizzle migrations) replace the boot-time SQL string. **Only a dedicated migrate step runs DDL**, not every service on start.

| Table | Purpose / key columns |
|---|---|
| `profiles` | Typed applicant profile per user (+ `profile_versions`): personal, contact, work_auth per country, education[], experience[], skills[], preferences (roles, locations, workplace, salary, notice), EEO (optional), documents refs. Replaces the free-form `user_profiles.data` blob (migrated). |
| `answer_memory` | `(user_id, question_hash, normalized_question, answer, source, confirmed_at)` — answers the user gave/edited, reused across forms. |
| `companies` | name, domain, logo, country, size. |
| `job_boards` | registry: `company_id, ats_type, board_slug/url, country, poll_interval, last_polled_at, health, enabled`. |
| `jobs` | `board_id, external_id, url, title, location(s), country, workplace, employment_type, salary_min/max/currency/period, posted_at (validated), closes_at, description, enrichment JSONB (skills, seniority, role_family, YoE, degree, sponsorship, intern terms), canonical_key, status (active/closed)`. Unique `(board_id, external_id)`. |
| `job_matches` | `(user_id, job_id, score, reasons, eligibility_flags, computed_at)` — rules + embeddings, no LLM. |
| `saved_jobs`, `job_feedback` | save / pass / not-interested signals. |
| `applications` | `user_id, job_id (nullable for pasted links), url, ats_type, status (state machine), adapter, transport, credits_reserved, approved_payload_hash, reference, submitted_at, error_code`. |
| `application_events` | append-only timeline: phase, at, detail (feeds UI timeline + receipts). |
| `application_fields` | per field: `field_key, label, kind, value, source (profile/memory/rule/ai/user), confidence, required, locked`. Feeds Review card + receipt. |
| `application_artifacts` | tailored resume PDF, cover letter, screenshots, confirmation page → object storage keys. |
| `inbox_addresses`, `emails` | per-user address; emails with `category, extracted_code, matched_application_id, match_method, confidence`. |
| `credit_ledger` | `user_id, delta, reason (grant/reserve/commit/refund/admin), application_id, balance_after`. `plans` + `user_plans`. |
| `llm_usage` | per call: purpose, model, tokens (prompt/completion/cached/reasoning), cost, latency, user, application, cache_hit. |
| `app_settings` | **runtime config** the admin panel edits: feature flags, model per purpose, budgets, credit prices, poll rates, adapter switches, rate limits. Cached in Redis, invalidated over the control bus. |
| `adapters` | `ats_type, version, enabled, transport_order, success_rate, last_error, kill_switch`. |
| `notifications` | in-app + push + email notifications per user; `push_subscriptions`. |
| `admin_audit_log` | every admin write: who, what, before/after, IP. (extends `workflow_audit_log`). |

Kept as-is: sites/pages/elements/selectors/page_edges (now serve the generic agent + recorded workflows), site_workflows, cached_flows, proxies, user_files (→ object storage keys), user_secrets, observability tables.

---

## 4. Core flows

### 4.1 Application state machine
```
DRAFT → QUEUED → PREPARING (resume tailor, cover letter)
      → FILLING (adapter reads form, maps fields)
      → NEEDS_INPUT (OTP / missing required / captcha)   ⇄ resumes
      → AWAITING_REVIEW (review payload shown)            ⇄ user edits
      → SUBMITTING → SUBMITTED → (CONFIRMED via email)
      ↘ FAILED (refund) / CANCELLED (refund) / SKIPPED (refund)
```
- **Pause without holding a browser:** on NEEDS_INPUT / AWAITING_REVIEW the worker saves state (cookies, storage, form position) and **releases the slot**; resume re-enqueues a continuation job. Long waits stop costing capacity.
- **Exactly-once submit:** `attempts: 1` for the submit phase; idempotency key per application; the submit step records `SUBMITTING` before clicking and never auto-retries after it; ambiguous outcomes go to NEEDS_INPUT ("Did it go through?") or admin review.
- **Approved payload is immutable:** resume submits exactly `approved_payload_hash` values — no re-planning (Tsenta's bug).

### 4.2 Apply engine (hybrid)
```
URL → detect ats_type (URL patterns, page markers)
    → adapter registry: [api] → [http-form] → [browser script] → [generic AI agent]
    → read form schema (deterministic) → field mapper:
         profile/answer_memory/rules  (≈85–90% of fields, 0 tokens)
         one batched LLM call for open questions (cheap model)
         numeric / legal / identity / skills → profile-only or NEEDS_INPUT (never invented)
    → review (if user setting) → submit → receipt + confirmation capture
```
- Adapter interface: `detect(url)`, `fetchJob()`, `readForm()`, `fill(fields)`, `submit()`, `transport`.
- Recorded `site_workflows` become a **workflow adapter** (your current approach stays first-class).
- Account-creating systems (Workday, iCIMS, Oracle): per-user generated password stored in `user_secrets` (AES-GCM), email verification via our inbox.
- Bot protection: detect (DataDome/Cloudflare/captcha) → captcha providers → proxy rotation → fall back transport → NEEDS_INPUT with live view.

### 4.3 Jobs feed
- `job_boards` registry seeded per ATS (Greenhouse/Lever/Ashby/SmartRecruiters/Workday CXS/SuccessFactors/Oracle/Zoho; India sources), grown from every pasted URL.
- Pollers per ATS (rate-limited, ETag/diff by external id) → normalizer (validated dates/countries — fixes Tsenta's "-535 days ago") → enrichment (rules first; cheap model only for skills/seniority when rules can't) → dedupe by canonical key.
- Matcher: eligibility rules (location, work auth, grad year, YoE, job type) + skill overlap + embedding similarity → `job_matches`. Recomputed on profile change and new jobs. **No LLM per match.**

### 4.4 Resume → profile
`parse-worker`: PDF/DOCX text extraction (pdf-parse / mammoth) → one cheap-model call with a strict JSON schema → typed profile draft → user confirms in UI → `profile_versions`.

### 4.5 Inbox
Inbound webhook (Cloudflare Email Routing or SES) → store raw in object storage → rules: OTP regex near keywords, sender domain/company match → application, category by subject patterns → LLM only for unclassified → feeds NEEDS_INPUT auto-resume (codes) and application status (confirmations/rejections/interviews) → forward to user's email.

### 4.6 Credits
Grant on signup → **reserve** on QUEUED → **commit** on SUBMITTED → **refund** on FAILED/SKIPPED/CANCELLED. Per-user daily caps + global kill switch from `app_settings`. Payments plug in later as `grant` entries.

### 4.7 Chat assistant
Deterministic pre-router (OTP/yes/cancel/links) → intent → calls the same application/job/profile actions. Small model, no reasoning, trimmed context (see cost plan). Tokens only for real conversation.

---

## 5. Admin service — controls everything

**Separate app** (`admin-service`, own port/domain e.g. `admin-api.<domain>`), own session cookie, RBAC (viewer / support / editor / super-admin), **IP allowlist + 2FA**, rate limits, and **every write audited** (`admin_audit_log`). It never imports worker internals: it reads Postgres/Redis and sends commands over the **control bus** (Redis streams), which workers execute and acknowledge.

| Area | Admin can |
|---|---|
| **Overview** | live KPIs: applications/hour by status, success rate per adapter, queue depth, worker capacity, AI spend today, credits issued/used, error rate |
| **Users** | search, view profile/applications/emails/credits, suspend/unsuspend, reset onboarding, grant/revoke credits, change plan, force logout, delete (GDPR), read-only "view as user" |
| **Applications** | list/filter by status/adapter/user; open full trace (events, fields with sources, screenshots, receipt); retry from a phase, cancel, mark submitted/failed, refund, re-run review |
| **Jobs feed** | boards registry (add/disable/edit poll rate), trigger poll, view poller health, jobs search, close/hide jobs, block companies, edit enrichment rules |
| **Adapters & workflows** | enable/disable per ATS, transport order, kill switch, version pin, success/failure stats, last errors; record/generalize/dry-run workflows (existing tools), selector health |
| **AI** | model per purpose, provider keys (write-only), budgets per user/day and global, prompt versions, usage & cost by purpose/user, cache hit rate, eval runs |
| **Inbox** | domains & routing, unmatched emails queue (manually match), rules (OTP patterns, category rules), forwarding status |
| **Credits & plans** | plan definitions, credit prices, free-credit amount, ledger viewer, bulk grants, refunds |
| **Workers & browsers** | worker nodes (heartbeat, CPU/mem, active browsers), pause/drain/resume a node, recycle browsers, concurrency per queue, proxy pool (import, health, disable), captcha providers & spend |
| **Config & flags** | every `app_settings` key with validation, change history, instant rollout via control bus |
| **Notifications** | templates (email/push/in-app), broadcast announcements, delivery logs |
| **Security** | admin accounts & roles, API keys, active sessions, rate-limit rules, blocked IPs, audit log viewer |
| **Observability** | logs, errors (grouped), traces, LLM copilot (existing), Prometheus/Grafana links |

Admin Socket.IO feed moves to the admin service (live applications/worker events).

---

## 6. Security & reliability

- Separate user vs admin surfaces; CORS per app; CSRF on cookie auth; secrets only in env/secret manager.
- PII: encrypt sensitive profile fields (DOB, address, IDs) at rest; object storage private with signed URLs; data export + delete.
- Per-user and per-IP rate limits; abuse caps on applications/day.
- Exactly-once submit + idempotency keys; dead-letter queues; graceful worker drain on deploy.
- Backups: managed Postgres PITR; object storage versioning.
- Observability: OTel traces across api → queue → worker; per-adapter success dashboards; alerts on success-rate drops.

## 7. Infra (hybrid)

| Component | Where |
|---|---|
| api-service, admin-service | managed (Railway/Fly/K8s) — 2 small instances each |
| Postgres (+pgvector), Redis | managed |
| Object storage | Cloudflare R2 or S3 |
| apply/crawl/parse workers + scheduler | **Oracle VM** via Docker Compose (beta: ~8–12 parallel browsers); add nodes later — workers only need DB/Redis/storage URLs |
| Mail inbound | Cloudflare Email Routing → api webhook (or SES) |
| AI | paid cheap model via gateway (DeepSeek/Gemini Flash class), free model as fallback |

Workers connect outbound only (no inbound ports on the VM besides SSH). Compose files: `compose.worker.yml` for the VM; managed services configured by env.

## 8. Testing

- Unit: field mapper, state machine, credit ledger, parsers (resume/email), normalizer, matcher.
- Adapter contract tests against **recorded fixtures** (saved HTML/JSON per ATS) — run in CI without hitting real sites.
- Live canary: nightly dry-runs per adapter against test postings (no submit) → success-rate dashboard.
- API integration tests (api + admin) with a disposable Postgres/Redis.

---

## 9. Roadmap

| Phase | Scope | Outcome |
|---|---|---|
| **0 · Foundations** (1–2 wk) | versioned migrations; `shared/config` + `app_settings` + control bus; object storage; LLM gateway + `llm_usage`; **extract admin-service** (move routes, fix worker-internal imports via control bus, RBAC + audit); fix `attempts: 3` on execute | Safe base; admin separated |
| **1 · Profile & resume** (1–2 wk) | typed `profiles` + migration from blob; resume parse worker; onboarding endpoints (already-built UI); answer memory | Real profile powering forms |
| **2 · Applications core** (2–3 wk) | applications tables + state machine + events; pause/resume without holding browsers; exactly-once submit; review payload (U3) + receipts (U5) from real data; credits ledger; deterministic chat pre-router | Trustworthy apply loop end-to-end |
| **3 · Adapters wave 1** (2–3 wk) | adapter interface + registry; Greenhouse, Lever, Ashby (API/HTTP); recorded-workflow adapter; generic agent fallback with token caps | High success on easy systems |
| **4 · Jobs feed** (2–3 wk) | boards registry, pollers for wave-1 ATS + India sources, normalizer, enrichment, matcher, `/jobs/recommendations` → Top matches cards | Home screen shows real matches |
| **5 · Inbox** (1–2 wk) | inbound domain + webhook, parsing, auto-resume on codes, status from confirmations | Codes & confirmations automatic |
| **6 · Adapters wave 2** (3–4 wk) | Workday (accounts + multi-page), SmartRecruiters, SuccessFactors, Oracle, Naukri, Zoho | Enterprise + India coverage |
| **7 · Admin completeness** (parallel from phase 2) | every admin area in §5 as each feature lands | Admin controls everything |
| **8 · Auto Apply + payments** | lanes/filters/daily caps scheduler; Razorpay + Stripe checkout into the ledger; push/email notifications | Growth features |

Each phase ends with: migrations applied, tests green, admin controls for the new feature, metrics on the overview dashboard.

## 9b. Progress

**Phase 0 — done so far (2026-10-21)**
- ✅ Execute jobs run exactly once (`attempts: 1`); crawl/remap/plan keep 3 retries.
- ✅ `admin-service` package: own Fastify app (port 3100), own CORS allowlist (clean 403 for foreign origins), own session cookie, login brute-force lock (5 fails → 15 min), optional `ADMIN_IP_ALLOWLIST`, `/auth/admin/me`, live `/admin` Socket.IO feed. All admin + observability-admin routes moved out of the user API; the user API now returns 404 for every `/admin/*` and admin login.
- ✅ `shared/control-bus`: worker heartbeats (real browser stats, load, memory, active jobs) + request/reply commands. Admin browsers/recycle/recorder/dry-run now reach the real workers; new `/admin/workers`, `/workers/:id/drain|resume`, `/workers/prune`.
- ✅ User API no longer launches a browser pool; API image drops Chromium. Admin Dockerfile, compose service, k8s Deployment/Service, env examples, frontend admin client (`VITE_ADMIN_API_BASE_URL`).
- ✅ `npm run typecheck` actually checks code now (`tsconfig.check.json`; the old root config checked nothing). Removed stray `@fastify/cookie@11` from `shared` (Fastify 5 plugin in a Fastify 4 app).
- ✅ Runtime smoke test against throwaway Postgres/Redis: login/me/lockout/CORS, workers + browsers via control bus, recycle, recorder start→stop on the same worker, API health from heartbeats.

**Phase 0 — next:** versioned migrations; `app_settings` + live config over the control bus; object storage for files; LLM gateway + `llm_usage`; admin RBAC per route (viewer/support/editor/super-admin) + `admin_audit_log`.

**Follow-ups found:** `tools/playwright-converter.ts` has pre-existing type errors (excluded from typecheck until fixed); user API still exposes operator routes behind the static `x-api-key` (`/sites`, `/crawl`, `/proxies/*`, `/queues`, `/workflow*`) — move to admin-service next.

**Frontend on live data (done):** home matches, applications, Tasks→Applications view (server timeline, cancel), Inbox (address, codes, mark-read), sidebar/bell badges from `/me`, onboarding saves to `/me/profile` + `/me/onboarding` and pre-fills from the résumé parse. `/preview` demo fixtures removed. Matcher fixes from the run-through: US country detection was case-sensitive (`Remote - USA` unplaced), remote jobs tied to a country the user can't work in are hidden unless they want sponsorship, 0–2 yrs excludes senior/lead, matched-skill chips no longer fall back to the job's own skills. Inbox address is now allocated lazily (users who skipped onboarding had none).

**Apply engine + admin control (done, 2026-10-22):** deterministic apply engine (`shared/applications/apply.ts`, `POST /me/applications`, `/respond`) with job-apply workflows per ATS (Greenhouse/Lever/Ashby/generic) and executor actions `autofillForm → reviewForm → submitForm` (profile → answer memory → ask; per-field provenance on the timeline; verbatim review; pre-submit drift check). Runs never replay (`maxAttempts 1`, `maxStalledCount 0`) and the scheduler reconciles interrupted applications. Sources: + SmartRecruiters, Workable, Recruitee, admin-defined Custom JSON (migration 0006 `job_boards.config`). Recorder is now remote-controlled (CDP screencast + forwarded input) and compiles without AI (profile tokens). Admin panel: Applications, Job sources, Workflow studio (import/export/history/restore/runs/live test runs), Recorder, Test profile, Settings, AI usage, Team & audit, Inbox & résumés. Fixed: admin sign-in blocked by `x-api-key` CORS; workflow cache not invalidated on admin edits; file loader overwrote admin edits. Verified live (no submit) on Greenhouse/Lever/Ashby; submitted on a local mock. See `docs/how-it-works.md`.

**Mobile + apply loop hardening (done, 2026-10-22):**
- **Bearer sessions for the app:** `x-jp-client: android|ios` returns the token at sign-in. `Authorization: Bearer` works on every route and on Socket.IO (`auth.token`). Added `POST /auth/refresh` (sliding 30 days) and `POST /auth/logout-all`. Suspended users and tokens issued before `users.sessions_valid_after` are rejected (60 s cache).
- **Parking:** a run waiting on a question or a review holds its browser for `apply.park_after_seconds` (default 120), then parks. The row keeps the question or review plus the job, and the browser is released. The answer starts a continuation run: autofill recalls the new answer from memory, and an approved review is applied verbatim without asking again (asked again only if the form gained fields). Parked runs don't count toward concurrency and expire after `apply.park_expiry_days`. Verified on a mock form: it parked twice with 0 browser contexts held, then submitted once with the edited answer.
- **Credits ledger** (migration 0007): the signup grant is given lazily, starting an application reserves its cost, a submitted one commits it, and a failed or cancelled one is refunded. Refunds are idempotent. Admin test runs are free. Settings: `credits.*`.
- **Notifications:** `notifications` table (bell) + FCM HTTP v1 push to `push_devices`. Triggers: needs input, review, submitted, failed, and employer reply or confirmation email. Endpoints: `/me/notifications`, `/me/devices`.
- **Account:** `GET /me/export`, `DELETE /me` (cancels running applications, deletes rows and files, anonymises logs).
- **Admin:** a real `/admin/users` (from `users`, with credits, devices and suspended flag), credits grant/ledger/summary, suspend, force sign-out, export, delete (confirm by id), notification stats + broadcast, parked applications list, answer on the user's behalf.
- **Apply workflows:** added SmartRecruiters (opens the form from "I'm interested"), Workable (`/apply/`) and Recruitee (`/c/new`). Apply buttons that are links are followed in the same tab.
- **Android app:** see `docs/android-app.md`.

**Auto Apply, employer replies, résumé rules (done, 2026-10-22):**
- **Auto Apply** (`shared/applications/auto-apply.ts`, migration 0008).
  - **Per user:** on/off, daily cap, minimum match score, excluded companies.
  - **Each run:** the top matches at or above that score, only on applicant systems with a dedicated workflow (never the generic filler). How many start is limited by the daily cap, free run slots, credits and the daily limit. "Review before submit" still applies.
  - **Runs:** the scheduler runs it every `autoapply.interval_minutes`. A Redis lock allows one run per user at a time, and "run now" works at most every 5 minutes.
  - **User API:** `GET/PUT /me/auto-apply`, `GET /me/auto-apply/preview` (what it would start now, or why not), `POST /me/auto-apply/run`, `GET /me/auto-apply/runs`.
  - **Admin API:** `GET /admin/auto-apply`, `GET /admin/auto-apply/:userId/preview`, `PUT /admin/auto-apply/:userId`, `POST /admin/auto-apply/:userId/run`. Settings: `autoapply.*`.
  - `applications.source` records manual, chat, auto or admin_test.
- **Employer replies** (migration 0009): `emails.intent` (interview / assessment / offer / rejection) from rules. A matched email moves `applications.outcome` forward only (confirmed < assessment < interview < rejected < offer), adds an `employer_*` timeline event, and sends a notification worded for the intent. Inbox categories are unchanged, so the UI is too.
- **Résumé rules** (`shared/profile/resume-sections.ts`): work history (title, company, location, dates, current job, highlights) and education (school, degree, field, years) without AI. PDF text keeps its lines, so name and header rules work.
- **Matcher:** metro areas (Bay Area, Seattle, NYC, LA), other cities capped at 60 ("may need to relocate"), workplace mismatch −10.
- **Tests:** +17 unit tests (`tests/shared`: résumé rules, email intents, matcher).
**Workday, payments, Auto Apply screens, local network run (done, 2026-10-22):**
- **Run locally + on the LAN:** `./dev-lan.sh` (start / stop / restart / status / logs / code).
  - Postgres and Redis run in their own containers and volumes; the services run on the host.
  - The frontend reads `{host}` in its API URLs, so the same build works from `localhost` and from `192.168.x.x`, and cookies stay same-site.
- **Workday jobs** (`atsType: 'workday'`, token `tenant/wdN/site`):
  - Read from the public CXS API, 20 per page.
  - Details (description, country, remote) only for jobs not already stored, up to `config.maxDetails` per poll.
  - Listing-only rows update title, date and status and keep the stored details.
  - 429/503 responses are retried with backoff.
  - Seeded: NVIDIA, Salesforce, Adobe, Intel, Mastercard, PayPal, Cisco.
  - Accenture blocks non-browser user agents. We don't spoof one.
- **Workday apply** (`workflows/jobs/workday-apply.json`), three new executor actions:
  - `openApplication`: clicks Apply, then Apply Manually.
  - `siteAccount`: creates the account (generated password, stored encrypted per site) or signs in. An unknown password is asked masked and never kept in answer memory; email verification is asked.
  - `fillWizard`: fills page by page and asks for unknowns, through to the review.
  - The review groups answers per page and locks them.
  - Required consent checkboxes are asked as Yes/No, then remembered.
  - "I do not wish to answer" counts as a decline option.
  - Résumés upload under their original file name.
  - A reference number must contain a digit.
- **Workday testing:** verified against `tools/mock-ats/workday.mjs` (same `data-automation-id`s and button overlay).
  - Covered: account created → signed in on the next run → changed password asked and stored → 13 answers over 4 pages → submitted.
  - **Not yet run against a live company**: custom Workday dropdowns and "add experience" sections may need work.
- **Naukri: not built.** Its search API answers "recaptcha required" to non-browser clients, and getting around that would break its terms.
- **Payments** (migration 0010, `shared/payments`, `api-service/payment-routes.ts`):
  - Credit packs are set in `payments.packs`. INR goes through a Razorpay order and Checkout.js; USD through Stripe Checkout.
  - Credits are granted once, on a verified browser callback or webhook, whichever comes first; a unique ledger entry per payment prevents a second grant.
  - Webhooks are signature-checked on the raw body; Stripe also checks the timestamp tolerance.
  - Endpoints: `GET /me/payments/packs`, `POST /me/payments/checkout`, `POST /me/payments/razorpay/confirm`, `GET /me/payments`, `GET /admin/payments`.
  - Verified with locally signed events: grant, duplicate ignored, tampered body rejected.
  - **No real charge yet**: that needs your test keys (see `backend/.env.example`).
- **Screens:**
  - Auto Apply view (on/off, cap, score, exclusions, live preview, run now, history).
  - Outcome and "Auto" badges.
  - Buy credits dialog, plus the credit balance and Buy in the sidebar.
  - The Applications review shows multi-page answers by page; password questions are masked.
- Tests: 32 unit tests (payment signatures, voluntary/consent questions added).

- Verified on a live stack with 3,035 real jobs. Auto Apply previewed 39 matches, started 3 (the cap), held 3 credits, notified, refused an early re-run, and the admin run was skipped because the cap was used up. Cancelling refunded all 3. Emails moved an application from interview to rejected, and a later interview email didn't reopen it.

### India jobs + 50k-board registry (migration 0011)
- **Registry:** `job_boards` is a registry of 50,805 boards. Each has a `status` (candidate → active / empty / dead), `discovered_via`, an adaptive `next_poll_at`, and a failure count.
  - Boards that hire in focus countries (`jobs.focus_countries`, default `['IN']`) are polled every 3h. Others are polled every 48h, empty boards weekly, and boards that stop changing back off up to 4×.
  - The scheduler leases due boards with `FOR UPDATE SKIP LOCKED` and applies backpressure. Some systems also have per-system concurrency caps (Workday 6, Oracle 6, SuccessFactors 4).
- **Discovery** (`shared/jobs/discovery.ts`, queue `jobs-discover`, weekly cron, admin "Registry" tab):
  - Verified seeds.
  - The MIT dataset Feashliaa/job-board-aggregator (pinned commit).
  - Common Crawl URL index, read straight from `cluster.idx` with range requests, because the index server often times out.
  - Links that users paste become candidates.
- **New sources** (public JSON/RSS only):
  - Keka (`/careers/api/embedjobs/...`)
  - Zoho Recruit (embedded careers JSON)
  - Freshteam (`/hire/widgets/jobs.json`)
  - Oracle Recruiting Cloud (`recruitingCEJobRequisitions`, company name from the site page)
  - SuccessFactors (RSS + sitemap)
- **Not built (bot-protected / not authorised):** Naukri (recaptcha), Darwinbox (403), Eightfold (PCSX auth), NCS (no public API). Accenture's Workday is excluded because it rate-limits bots.
- **India matching:**
  - Experience ranges are parsed from text ("3–5 yrs", freshers) and scored against the user.
  - Metro aliases (NCR, Bangalore→Bengaluru…), INR salaries shown as LPA, and country pre-filter.
  - Form rules for total/relevant experience, preferred location and qualification.
  - Cookie banners are declined.
- **Apply workflows:** Zoho and Freshteam were added (scanned read-only, not yet run end to end). Oracle and SuccessFactors need an account/OTP flow and are excluded from Auto Apply for now.
- Live dev numbers (2026-10-23): 426k active jobs, 80k in India across 1,688 companies (Oracle 53k, Keka 7k, SuccessFactors 6.5k, Greenhouse 5k, Lever 3k, Workday 2k, Zoho 1.7k, Freshteam 1.2k, Ashby 750). There are 27.6k candidate boards still to validate.

### Oracle / SuccessFactors apply, application email, Gmail, live pulse (migration 0012)
- **Application email**: `applicationEmailMode` is now used when applying (`shared/inbox applicationEmail`).
  - Private inbox: only once `inbox.live` is on (needs real inbound mail for `inbox.domain`).
  - Connected Gmail, else the user's own email.
  - Codes and verification links that land in the inbox or Gmail are handed to the waiting application. That includes ones that arrive before the run pauses (`deliverToWaiting`), and a link already in the mailbox from an earlier run.
  - Verification links open only on the site's own domain or a known applicant system, and each link is opened once.
- **Oracle Recruiting Cloud** (`job-apply-oracle`, action `emailCodeSignIn`): email + terms → emailed code (split boxes) or texted code → multi-step form, including the e-signature beside Submit (`fillWizard.fillLastPage`).
- **SuccessFactors** (`job-apply-successfactors`): Apply now → Apply Now → SAP account.
  - Sign-up: `fbclc_*` fields (retyped email, India (+91) + national number, country, privacy dialog).
  - Passwords are 16 characters (SAP allows 8–18) and keyed per company tenant.
  - Verification email handled, then the single application page.
- **Phones**: asked once (`mobile` card) and saved to the profile. A national number goes beside a country-code picker.
- **Cover letters**: required ones are written from profile facts only (the model, else a template) and printed to PDF by the run's browser.
- **Verified on local copies** of all four systems (`tools/mock-ats/{oracle,successfactors,zoho,freshteam}.mjs`), built from live markup that was only read, never submitted.
  - Covered: inbox code auto-fill, the texted-code path, the verification link (fresh and recovered), Zoho's image CAPTCHA typed by the user, submission.
  - Real Zoho and Freshteam pages were dry-run with the scanner and planner, nothing filled. This led to Zoho City/State labels and required-detection on Zoho and Freshteam.
  - Real Freshteam forms carry a reCAPTCHA, which the user solves.
- **Freshteam jobs** now link to `<sub>.freshteam.com/jobs/<id>`, where the form lives.
- **Gmail** (`shared/gmail`, `/me/integrations/*`, `/integrations/gmail/callback`, scheduler `gmail-sync`, admin `/admin/mail-connections`):
  - Read-only OAuth; tokens are encrypted.
  - The search only matches the user's application companies and applicant-system senders, and only mail that belongs to an application is kept.
  - Disconnecting revokes at Google.
  - Tested against `tools/mock-google/gmail.mjs`: a bank OTP and a newsletter were never read, and an interview email moved the application to interview.
  - `gmail.readonly` is a restricted scope: production use needs Google's app verification.
- **Jobs pulse** (`/jobboard/pulse`, `JobPulse.tsx`): personal live line on home (matches since yesterday, the user's city, "just in", companies watched). Refreshed every minute, numbers count up.
- **LLM**: reasoning is off unless asked for, and empty replies fall through to the fallback model.
  - Defaults: `nemotron-3.5-lightning:free` for fast jobs, `nemotron-3-ultra:free` for text users read, planning and parsing.
- **Sharing**: `./dev-lan.sh share` gives one ngrok tunnel for the app plus `/api` (Vite proxy). Admin stays local.
  - Fixed: the dev stack used Redis on :6379 (`.env` overrode the dev port).

## 10. Open items before Phase 0
1. **Database password mismatch** — local stack can't boot until `.env` matches the existing volume or the volume is reset.
2. **Domain** for the inbox (e.g. `inbox.jobpilot.<tld>`) and object storage choice (R2 vs S3).
3. **AI provider account** for the cheap paid model.
4. Confirm or change the assumed scale / Auto Apply timing / first adapters.
