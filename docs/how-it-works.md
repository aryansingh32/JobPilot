> **Partly stale.** Added since: Auto Apply campaigns (`/me/campaign`), answer memory by intent, submission tri-state, recorder confirmation learning. See `docs/competitive/production-status.md` and `readiness-audit.md`.

# How JobPilot works — system, APIs and the apply engine

_Last verified end to end: 2026-10-21/22, local stack (Postgres, Redis, API, admin service, worker on real Chrome)._

## 1. Services

| Service | Port | Role |
|---|---|---|
| `api-service` | 3300 | User API (`/auth/*`, `/me/*`), chat over Socket.IO, inbound email webhook. Runs migrations + syncs workflow files on boot. |
| `admin-service` | 3100 | Admin API (`/admin/*`, `/auth/admin/*`) — separate origin, cookie, roles, audit log. Talks to workers only via the control bus. |
| `execution-service` (worker) | — | BullMQ consumers: `execute` (browser runs), `jobs-poll`, `parse` (résumés), `crawl`, `remap`, `ai-plan`. Owns the Playwright browser pool and the recorder. |
| `scheduler-service` | — | Cron: due job boards → `jobs-poll`, reconcile interrupted applications (every 5 min), proxy/session/selector housekeeping. |

Shared state: Postgres (users, profiles, jobs, applications, workflows, settings, audit) and Redis (queues, runtime state, pause/resume pub/sub, settings broadcast, live frames). The **control bus** (`shared/control-bus`) is Redis pub/sub: workers heartbeat, the admin service sends commands (`record.start`, `record.input`, `browser.recycle`, `worker.drain`…) and gets replies.

## 2. How jobs are fetched

1. A **board** = one company on one applicant system (`job_boards`: `ats_type`, `board_token`, `config`).
2. The scheduler enqueues boards whose `poll_interval_minutes` elapsed (`jobs.poll.batch_size` per tick).
3. The worker calls the source adapter (`shared/jobs/sources.ts`) — all public JSON endpoints, no scraping:

| System | Endpoint |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` (paged) |
| Workable | `apply.workable.com/api/v1/widget/accounts/{token}?details=true` |
| Recruitee | `{token}.recruitee.com/api/offers/` |
| **Custom JSON** | any URL + a field map defined in the admin panel (no deploy) |

4. Jobs are normalized (country, workplace, seniority, skills), upserted in one statement; jobs missing from the board are marked `closed`.
5. `GET /jobboard/recommendations` scores active jobs against the profile (roles, location/authorization, seniority, skills).

Admin: **Job sources** → add a source, **Test** it (count + sample, nothing saved), poll now, change interval, enable/disable, edit a custom source's field map, hide jobs.

## 3. How an application is filled and submitted (the apply engine)

Entry points — all end in `startApplication()` (`shared/applications/apply.ts`), no LLM involved:
- **Apply for me** on a job card → `POST /me/applications {jobId}`
- a pasted link → `POST /me/applications {url}`, or chat "apply … <link>"
- admin **Test run** (runs as the test profile, stops before submit unless told otherwise)

```
job/url ─► resolve (job row, ATS, board token) ─► apply URL
        ─► pick workflow: URL-pattern match → ATS (metadata.atsType) → generic
        ─► execute job (maxAttempts 1) ─► worker browser
             navigate {{job:applyUrl}}
             autofillForm  scan fields → answer from profile → remembered answers
                           → ask the user for required unknowns (and remember)
             reviewForm    pause: every answer with its source; user edits/approves
             submitForm    re-check answers (drift), click submit, detect confirmation
                           + reference, or the site's validation errors
```

Pipeline stages are written to the application timeline (`parse`, `answers` with per-field source, `awaiting_review`, `verified`, `submitted` with reference) — the user's Applications screen and the admin trace render from it.

**Answer sources, in order:** profile (exact or derived, e.g. first/last from full name, authorized-to-work from the job's country) → answer memory (the user's past answers, exact-question match) → ask the user. Voluntary EEO questions pick the "decline" option. Dropdown answers must match one of the field's real options; long open questions never get a profile value just because they mention "GitHub" or "location".

**Safety rules (borrowed from what went wrong at Tsenta):**
- Nothing is invented: no AI writes answers; unknown required answers are asked.
- What was reviewed is what's sent: approved values are filled verbatim; choice edits must match an option.
- A run is never replayed: `maxAttempts: 1`, BullMQ `maxStalledCount: 0`. A run whose worker dies is marked failed by the scheduler; if it had passed the final check it says "may have gone through — check your inbox".

**Verified live (test profile, stopped before submit):** Greenhouse (Figma, 14 answers), Lever (Palantir, 22 answers), Ashby (Linear, 6 answers). **Submitted** end to end against a local mock form (reference captured, review edit applied).

### Captchas (no live view)

The user never watches a browser. Captchas are shown as a **cropped screenshot of just the captcha**, right before submit:

- **Text captcha** (image + input, e.g. Keka): the user types the characters; never answered from memory. If the site rejects the code it re-asks with the new image (twice at most), restoring anything a server re-render dropped (files always are).
- **Click captcha** (reCAPTCHA / hCaptcha checkbox or picture grid): only that area is shown and is tappable. Each tap is replayed on the page and a fresh crop comes back, until the check closes or the user taps Done.

Live view is admin-only now: the executor only takes frames while an admin watches a run (`live:watch:<jobId>`), instead of one screenshot per second on every run.

## 4. Workflows — the background bots

A workflow is an ordered action plan (`site_workflows.starter_action_plan`) run by `execution-service/executor.ts` in a real (headless) browser. Actions include `navigate, click, fill, select, upload, pauseForUserInput, extractData, conditional, customJS…` and the job actions `autofillForm, reviewForm, submitForm`. Values can use tokens: `{{job:applyUrl}}`, `{{profile:firstName}}` (or any profile path), `{{userFile:resume}}`, `{{userInput:<stepId>}}`, `{{extracted:<key>}}`.

Sites without APIs are handled exactly this way: record or write a workflow, give it URL patterns, publish it — the apply engine (for `metadata.kind = "job-apply"`) or the chat router (other workflows) starts using it immediately.

Sources of workflows:
- **Files** in `backend/workflows/**` (synced on boot). Once a workflow is edited in the admin panel the DB owns it and the file no longer overwrites it.
- **Admin → Workflows**: create from template, import/export JSON, edit steps (list or raw JSON), publish/unpublish, duplicate, history with restore, run stats.
- **Admin → Recorder**.

**Example — an Indian site with no API:** `workflows/jobs/keka-apply.json` was recorded in the admin Recorder on Zenskar's Keka careers page (any `*.keka.com/careers` job uses it). Recorded steps open the job, click Apply and fill name/phone/email as profile tokens; the standard tail then uploads the résumé, answers screening questions (asking once, then remembering), shows the review, and handles Keka's text captcha before submit. Tested from a user's account up to the review (not submitted to the real company).

Status today: 5 job-apply workflows (Greenhouse, Lever, Ashby, Keka, generic) published and verified; 5 government workflows have real plans (not run in testing — they hit live government portals); 47 government entries are 2-step placeholders kept as test fixtures (draft).

## 5. Recording a workflow (manual)

1. Admin → **Recorder** → start URL (+ "job application" toggle) → **Start recording**. A worker opens the page headless.
2. The page streams live to the admin (CDP screencast). Click on the screen and type — clicks/keys are forwarded to the remote browser (`record.input`).
3. Every click/field change is captured with several selector candidates (test id, id, name, aria-label, placeholder, path).
4. **Stop & compile** — deterministic, no AI: keeps the last value per field, drops focus-only clicks, turns values that match the **test profile** into `{{profile:*}}` tokens, file picks into `{{userFile:resume}}`, passwords/IDs into "ask the user" steps, and the first page into `{{job:applyUrl}}` for job forms.
5. Edit if needed → **Save as draft** → open it in Workflows → **Test run** on a real URL, watched live → **Publish**.

## 6. Admin panel map

- **Product:** Overview · Applications (status, per-stage trace with answer sources, watch live and answer/approve for a user, cancel, correct status) · Users · Job sources · Inbox & résumés.
- **Automation:** Workflows (studio + live test runs) · Recorder · Test profile (+ résumé) · Run queue · Captcha · Browsers & workers · Sites.
- **Platform:** Settings (every runtime knob: AI models/budgets/killswitch, apply limits, polling, features — applied live, with history) · AI usage · Team & audit (roles viewer/support/editor/super-admin, every write audited) · Security.
- **Observability:** command center, sessions, copilot, reliability, logs, errors, network, metrics.

## 7. Key endpoints

User API (`/me`, cookie session):
`GET /me` · `GET/PUT /me/profile` · `POST /me/onboarding` · `POST /me/resume` · `GET /me/resume/parses/latest` · `GET/POST/DELETE /me/answers` · `GET /jobboard/recommendations` · `POST/DELETE /jobboard/jobs/:id/save` · `POST /jobboard/jobs/:id/feedback` · **`POST /me/applications`** · `GET /me/applications[/:id]` (includes `pending`: question or review) · **`POST /me/applications/:id/respond`** · `POST /me/applications/:id/cancel` · `GET /me/inbox` · `POST /me/inbox/:id/read`.

Admin API (new this round): `POST /admin/workflows/import` · `GET /admin/workflows/:id/export|history|runs` · `POST /admin/workflows/:id/duplicate|test-run|restore/:entry` · `GET/PUT /admin/test-profile` · `GET /admin/jobs/:jobId/pending` · `POST /admin/jobs/:jobId/respond` · `POST /admin/record/input|compile` · `GET /admin/record/status` · `GET /admin/jobs-feed/source-types` · `POST /admin/jobs-feed/sources/test`. Socket `/admin`: `watch-job` → `job:frame`; `workflow:record-frame`, `workflow:record-step`.

## 8. Known gaps

- Résumé parsing without an AI key extracts contact details and skills only; name/experience/education need the configured model.
- Workday / iCIMS (account creation, multi-page wizards) need their own workflows — record them per tenant pattern.
- No credits ledger yet; no Gmail/Outlook connection yet; inbox domain still to choose.
- Captchas on real forms fall back to the human tier (live view) — Greenhouse forms carry invisible reCAPTCHA that may challenge on submit.
