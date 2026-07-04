# ChatFlow — Engineering Roadmap & Production Readiness Report

**Audience:** AI coding agents / developers picking up this build
**Purpose:** Ground-truth assessment of the current codebase (`aryansingh32/chatflow`) + a prioritized, ticket-level plan to take it from prototype to a production SaaS that can run **any** website workflow, not just the ~9 Indian gov-portal categories currently authored.

This document was written after reading the actual source (`chat-orchestrator.ts`, `executor.ts`, `captcha-handler.ts`, `captcha-service.ts`, `admin-routes.ts`, `WorkflowsPanel.tsx`, `user-memory.service.ts`, `styles.css`, infra manifests). Every "current state" claim below is traced to a real file so the next agent doesn't have to re-discover it.

---

## 1. Executive Summary

The core idea — **admin uploads a JSON workflow once, the chatbot picks and runs it, LLM only orchestrates, a deterministic executor drives the browser** — is already implemented end to end. That's the hard architectural part, and it's correct. What's missing is everything that turns it from "works in a demo" into "safe to put in front of paying users and run against sites you don't control":

- Workflow authoring is manual JSON + a metadata-only admin form — no recorder, no visual step builder, no versioning.
- Generalization is weak: workflows are hand-written per exact site, no generic "any site" fallback layer.
- Security has real holes: one shared static admin key, secrets handling is partially built, no RBAC, no per-tenant isolation of browser sessions.
- Reliability: 2 test files in the whole repo; premium captcha API is a stub that throws `Error('not fully implemented')`; retry logic exists but isn't circuit-broken or budget-aware.
- Frontend theme currently uses a green/teal accent (`oklch(0.72 0.16 155)`) on a blue-tinted dark background — reads as generic "AI app" styling, not the neutral-black/single-accent look of Grok or ChatGPT.

None of this requires re-architecting. It requires hardening. This doc is organized so tickets can be picked up independently.

---

## 2. Current Architecture (confirmed from source)

```
chatflow/
├── backend/
│   ├── packages/
│   │   ├── api-service/        Fastify HTTP API (chat-orchestrator.ts = LLM intent routing, admin-routes.ts = CRUD + observability)
│   │   ├── execution-service/  executor.ts (step runner), browser-pool.ts, session-manager.ts, captcha-handler.ts, captcha-service.ts
│   │   ├── scheduler-service/  change-detector.ts (selector drift detection)
│   │   ├── crawler-service/    crawler.ts (site discovery)
│   │   └── shared/             workflow-loader.ts, db, queue, logger
│   ├── workflows/*/*.json      Declarative workflow definitions (aadhaar, PAN, passport, voter-id, DL, EPFO, IRCTC, ration card, SSC)
│   └── infrastructure/         Dockerfiles (api/worker/scheduler), k8s deployment.yaml, prometheus
├── chatflow-interface/         React + Vite + Tailwind chat UI, separate admin panel (WorkflowsPanel.tsx, AdminLayout.tsx)
└── infra/observability/        Grafana/Tempo/Alertmanager/OTel stack — already present
```

**Data flow today:** User message → `chat-orchestrator.ts` classifies intent via LLM + keyword scoring against `site_workflows` table (populated by `WorkflowLoader` from the JSON files) → enqueues a BullMQ job → `executor.ts` walks the workflow's `starterActionPlan` step array against a pooled Playwright browser → pauses via Redis pub/sub (`chat:pause` / `job:resume:{id}`) whenever it hits a `pauseForUserInput` or `payment` step → resumes on user input → writes results to Postgres.

This is a legitimate, well-thought-out RPA architecture. The gaps below are about hardening it, not replacing it.

---

## 3. Frontend: Theme Overhaul (Grok / ChatGPT parity)

### What's wrong today
`src/styles.css` defines the whole palette in oklch. The two problem tokens:
```css
--background: oklch(0.16 0.012 260);   /* dark blue-gray, not true black/neutral */
--primary:    oklch(0.72 0.16 155);    /* saturated green/teal — reads as "default AI template" */
```
A blue-tinted near-black background plus a green-teal accent is the single most common "looks AI-generated" combo in shadcn-based apps — it's the library default palette, barely touched. Both reference screenshots avoid it: Grok uses true black + one electric-blue accent; ChatGPT uses a neutral (zero-chroma) near-black + white text + a single blue accent used only for the mic/voice affordance.

### Concrete token changes
```css
:root {
  --radius: 1rem;
  --background: oklch(0.10 0.002 260);        /* near-true black, chroma ~0 */
  --foreground: oklch(0.97 0.002 260);
  --card: oklch(0.14 0.003 260);
  --popover: oklch(0.16 0.003 260);
  --primary: oklch(0.62 0.19 258);            /* single blue accent, used sparingly */
  --primary-foreground: oklch(0.98 0 0);
  --secondary: oklch(0.18 0.003 260);
  --muted: oklch(0.16 0.002 260);
  --muted-foreground: oklch(0.65 0.005 260);
  --accent: oklch(0.20 0.003 260);
  --border: oklch(0.22 0.003 260);
  --input: oklch(0.20 0.003 260);
  --ring: oklch(0.62 0.19 258);
  --sidebar: oklch(0.08 0.002 260);
  --bubble-user: oklch(0.24 0.01 260);         /* neutral gray bubble, not colored */
}
```
Key rule going forward: **drop chroma to near-zero on every neutral token** (background/card/border/muted). Reserve the one saturated hue (`--primary`) for buttons, the active tab underline, and the voice/mic control only — exactly how both reference apps use blue.

### Layout/UX parity checklist (from the two screenshots)
- [ ] Pill-shaped, full-width bottom input bar with rounded-full corners (`rounded-full`, not `rounded-lg`), `+` attach icon left, mic icon + a distinct "Speak"/voice pill on the right.
- [ ] Top bar: hamburger (☰) far left, tab switcher center (e.g. "Chat / Workflows" instead of Grok's "Ask / Imagine"), a secondary icon far right (Grok uses a connector icon — ChatFlow's equivalent should be "Live browser view" toggle).
- [ ] Suggestion chips/rows sit **above** the input, not scattered in the empty state (ChatGPT's "Follow the World Cup / Create an image / Look something up" pattern) — for ChatFlow: "Download Aadhaar", "Apply for a job", "Check application status".
- [ ] Empty-state should be near-blank with a faint centered mark, not decorative gradients — both refs are almost entirely negative space.
- [ ] Remove any drop-shadow/glow on buttons; both refs use flat fills + 1px borders only.
- [ ] The live-execution view (screen-share of the bot filling a form) should render inside the chat thread as a bordered card, not a separate modal — keeps the "agent working" feeling ChatGPT/Grok have with tool-call cards.

**Ticket:** `FE-01` Replace theme tokens, `FE-02` rebuild bottom input bar component, `FE-03` add suggestion-chip row, `FE-04` restyle live-execution card.

---

## 4. Making Workflows Run on *Any* Site

This is the highest-leverage work item, and it splits into three layers. Right now you only have layer 1.

### Layer 1 — Hand-authored workflows (exists)
JSON per site, loaded by `WorkflowLoader`, matched by keyword/trigger phrases in `chat-orchestrator.ts`. Fine for your top 20–30 highest-traffic government/utility sites. Keep this as the "pinned, tested, fast-path" tier.

### Layer 2 — Workflow Recorder (missing — build this next)
Several workflow JSON files literally contain a comment telling a human to run `npx playwright codegen` and hand-translate the output. **Automate that translation instead of leaving it as a human step:**
1. Admin clicks "Record New Workflow" in the admin panel → spins up a headed/streamed Playwright session (reuse `browser-pool.ts`) that the admin controls directly (mouse/keyboard passthrough over the same WebSocket you already use for live-execution streaming).
2. Every action (click, fill, navigate, upload) is captured as a raw event log.
3. A conversion pass turns the raw log into your `ActionStep[]` schema — this is a mechanical transform (Playwright's own trace format → your JSON), not something needing an LLM.
4. A **separate LLM pass** then reviews the generated steps and: (a) generalizes brittle selectors (absolute XPath → role/text/testid selectors, matching your existing 4-tier selector fallback in `executor.ts`), (b) infers which fields map to which user-profile keys (name, DOB, address) so the same workflow can reuse saved profile data, (c) flags steps that look like they need a `pauseForUserInput` (payment iframe, captcha, OTP field) and inserts them automatically.
5. Admin reviews the generated JSON in a diff view before publishing (never auto-publish an LLM-touched workflow untested).

**Ticket:** `WF-01` Recorder session infra, `WF-02` raw-event → ActionStep converter, `WF-03` LLM generalization pass, `WF-04` admin review/diff UI.

### Layer 3 — Zero-shot "any site" fallback (the real "any site" capability)
For sites with no recorded workflow at all, you need a fallback executor that doesn't rely on a pre-written step list:
- Give the LLM the current page's accessibility tree (Playwright's `page.accessibility.snapshot()` — cheap, no screenshots needed for most steps) plus the user's goal ("fill this job application").
- LLM proposes the *next single action* (click/fill/select), executor performs it, re-snapshots, loop — this is the standard "agentic browser" pattern (same idea as Anthropic's computer-use / browser-use style loops), bounded by a max-step budget and a per-step cost cap.
- **Every successful zero-shot run should be logged and offered to the admin as "promote to a saved workflow"** — this is how your library of Layer-1 workflows grows over time instead of staying hand-authored forever. This closes the loop between "AI figures it out once" and "deterministic replay forever after," which is the whole point of your cost/speed argument.

**Ticket:** `WF-05` accessibility-tree-based step proposer, `WF-06` step budget/cost guardrails, `WF-07` "promote zero-shot run to workflow" pipeline.

### Self-healing for selector drift (partially exists — finish it)
`scheduler-service/change-detector.ts` and `crawler-service/crawler.ts` already exist for this purpose — confirm they're actually scheduled in production (cron/BullMQ repeatable job), not just present in the repo. When a selector fails all 4 fallback tiers in `executor.ts`, that should auto-trigger a re-crawl of that specific workflow rather than just failing the job silently.

**Ticket:** `WF-08` verify/wire change-detector scheduling, `WF-09` auto-retrigger crawl on selector-fallback exhaustion.

---

## 5. Backend Robustness & Production-Readiness Gaps

### 5.1 Security (P0 — fix before any real users)
- `admin-routes.ts` → `adminAuth()` checks a single static header (`x-admin-key`) against one shared `ADMIN_API_KEY` env var, with a **hardcoded fallback of `'dev-key-change-in-prod'`** if the env var is unset. That fallback must be removed — fail closed, not open, if the key is missing.
- No RBAC: every admin key holder has full access to every route (delete workflows, cancel any job, view all users). Add per-admin accounts + roles (`viewer`, `editor`, `super-admin`) before this goes multi-admin.
- No audit log of who created/edited/deleted a workflow. Add a `workflow_audit_log` table (admin_id, workflow_id, diff, timestamp) — critical once workflows can execute payments and fill government forms.
- Secrets: `user-memory.service.ts` correctly scrubs password/aadhaar/pan/cvv/otp before writing to `user_profiles` — good. But the "opt-in save my Aadhaar" feature discussed earlier doesn't exist yet; when built it needs its own encrypted table (`user_secrets`, envelope-encrypted, decrypted only inside the worker process, never logged) — see Section 6.

**Tickets:** `SEC-01` remove default admin key fallback, `SEC-02` per-admin accounts + RBAC, `SEC-03` workflow audit log, `SEC-04` `user_secrets` table + envelope encryption.

### 5.2 Reliability & Testing
- Only **2** test files exist in the entire monorepo (`tests/execution-service/session-manager.test.ts` and one other). For a system that fills real forms and moves real money/documents, this is the single biggest risk.
- Minimum bar before production: unit tests for `workflow-loader.ts` (schema validation), `chat-orchestrator.ts` (intent matching), the selector-fallback chain in `executor.ts`; integration tests that record a fixture site (a local static HTML page mimicking a gov portal) and replay a workflow against it in CI.
- `retryLoop` and step-level retries exist (`executor.ts` lines ~683, ~1152) but there's no circuit breaker — a systemically broken site (layout changed, portal down) will retry every job against it individually rather than tripping a breaker and pausing all jobs for that `siteId`.
- Add a per-workflow **dry-run / staging mode**: run against the real site but stop before any payment/submit step, for admins to validate a newly recorded workflow before flipping `isActive: true`.

**Tickets:** `REL-01` CI test harness + fixture sites, `REL-02` circuit breaker per siteId, `REL-03` dry-run mode flag on workflow schema.

### 5.3 Captcha cost/reliability (extends prior discussion)
- `captcha-service.ts` → `solveWithPremiumAPI()` currently just **throws `'Premium API solver not fully implemented'`** whenever a key is present — meaning today, even "premium" users silently fall back to human-in-the-loop. Needs real 2Captcha/CapSolver/Anti-Captcha HTTP integration, gated by subscription tier, with per-user monthly spend caps (store spend in Redis with a TTL'd counter, hard-stop past the cap and fall back to free/manual tier rather than an unbounded bill).
- Add captcha-type-specific cost/success metrics to the observability stack you already have (Prometheus/Grafana are already wired — just add a `captcha_solve_total{type,method,success}` counter).

**Tickets:** `CAP-01` real premium solver integration + spend caps, `CAP-02` captcha metrics dashboard.

### 5.4 Isolation & Scaling
- Confirm `browser-pool.ts` isolates browser **contexts** per job (not just per worker process) — cross-user session/cookie leakage would be a severe privacy bug for a tool that logs into government portals on users' behalf.
- Consider sandboxing each execution worker container (gVisor/Firecracker or at minimum strict seccomp + no outbound network except allow-listed target domains) since workflows execute admin-authored automation against arbitrary third-party sites — a malicious or buggy workflow shouldn't be able to pivot to your internal network.
- `docker-compose.yml`/k8s manifests exist — confirm HPA (horizontal pod autoscaler) is configured on worker pods keyed to BullMQ queue depth, not just CPU.

**Tickets:** `INF-01` verify per-job browser context isolation, `INF-02` sandbox worker egress, `INF-03` queue-depth-based autoscaling.

---

## 6. Payments, Logins & PII — Concrete Schema

Building on what's already scaffolded (`payment` and `pauseForUserInput` steps, ephemeral Redis storage with TTL, `sanitizeProfileData`):

```sql
-- Never stores raw secret material outside a short-lived encrypted blob
CREATE TABLE user_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  secret_type TEXT NOT NULL,           -- 'aadhaar' | 'site_login:<domain>' etc.
  ciphertext BYTEA NOT NULL,           -- envelope-encrypted (KMS-wrapped DEK)
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE workflow_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL,
  workflow_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- created|updated|deleted|activated
  diff JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```
- New action type `paymentGateway` (formalizing what the `payment` handler already does ad hoc): declarative `successUrlPattern` / `successSelector` per workflow so job-resume-on-payment-success isn't hardcoded per site.
- New action type `credentialFill`: checks `user_secrets` for `site_login:<domain>`, shows a confirmation card ("Use saved login for incometax.gov.in?") before ever auto-filling, decrypts only inside the worker, wipes the in-memory value immediately after the `fill` step executes.

**Legal note (India-specific, since these are Aadhaar/gov workflows):** the Aadhaar Act and the DPDP Act 2023 place specific restrictions on storing/transmitting Aadhaar numbers — "fill and vanish" (never persisting) is the right default. If you do add opt-in storage, get that reviewed against DPDP consent/retention requirements before launch, not after — this isn't a normal PII compliance question, Aadhaar has its own statute.

**Tickets:** `PII-01` `user_secrets` table + KMS envelope encryption, `PII-02` `paymentGateway` action type, `PII-03` `credentialFill` action type + confirmation UI, `PII-04` legal review of Aadhaar/DPDP retention rules.

---

## 7. Admin Panel — Beyond Metadata CRUD

`WorkflowsPanel.tsx` today only edits top-level fields (name, trigger phrases, URLs, instructions) — the actual `starterActionPlan` step array has no visual editor; admins hand-edit JSON or files. Priority additions:
1. **Step list editor** — drag-reorder cards, one per `ActionStep`, typed forms per action type (a `fill` step shows selector + value fields, a `conditional` step shows branch config, etc.) instead of raw JSON.
2. **Test-run button** inline in the panel — triggers dry-run mode (Section 5.2) and streams the live browser view right there, before publishing.
3. **Version history** per workflow (pairs with `workflow_audit_log`) with one-click rollback.
4. **Workflow analytics** — success rate, average duration, most common failure step, captcha-hit-rate per workflow — surfaced per-row in the panel so admins know which workflows are decaying and need re-recording.

**Tickets:** `ADM-01` visual step editor, `ADM-02` inline dry-run/test button, `ADM-03` version history + rollback, `ADM-04` per-workflow analytics panel.

---

## 8. Prioritized Roadmap

| Phase | Focus | Tickets |
|---|---|---|
| **P0 — Before any real users** | Close security holes, minimum test coverage | SEC-01, SEC-02, REL-01, REL-02, CAP-01 (spend cap part) |
| **P1 — Core product gap** | Workflow recorder, admin step editor, theme | WF-01→04, ADM-01, ADM-02, FE-01→04 |
| **P2 — Scale & trust** | Any-site fallback, self-healing, PII/payment formalization | WF-05→09, PII-01→04, INF-01→03 |
| **P3 — Polish** | Analytics, version history, cost dashboards | ADM-03, ADM-04, CAP-02 |

---

## 9. File-by-File Reference (what exists vs. what's a stub)

| File | State |
|---|---|
| `chat-orchestrator.ts` | Solid — intent classification + workflow matching implemented |
| `executor.ts` | Solid core loop, retry logic present, needs circuit breaker |
| `captcha-handler.ts` | Detection + open-source solvers implemented for recaptcha-v2/hCaptcha/slider; v3/turnstile/puzzle/image fall to manual |
| `captcha-service.ts` | Human-in-the-loop path works; **premium API path throws, not implemented** |
| `workflow-loader.ts` | Solid — JSON → Postgres sync works |
| `admin-routes.ts` | Functional CRUD; **auth is a single static key with an insecure default fallback** |
| `WorkflowsPanel.tsx` | Metadata-only editor, no step-array UI |
| `user-memory.service.ts` | Solid PII-scrubbing on profile save; no `user_secrets`/opt-in storage yet |
| `change-detector.ts` / `crawler.ts` | Present, unclear if actively scheduled — verify |
| `styles.css` | Functional but off-theme (blue-tinted neutrals + green/teal accent) |
| Test suite | **2 files total** — needs real coverage before production |

---

*End of report. Recommend tackling this in the phase order above — Phase P0 items are security/reliability fixes with no UX dependency and can start immediately in parallel with FE-01 theme work.*
