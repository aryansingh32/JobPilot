# Readiness audit — the seven questions, the seven findings, and the product vision, checked against the code

_2026-10-26. Method: every claim below was checked by reading our code, running a probe, or running the change against a scratch Postgres. Where I only read and did not run, it says so. Reference repos were read as code only._

**Verified vs. not:** everything marked ✅ FIXED has a test or a scratch-DB run. Nothing here has been run against a live employer site. Workday remains fixture-tested only.

## 0. Reference repos — the parts that were previously only outlined

| File | What it does | Take / avoid |
|---|---|---|
| `Workday_Auto/backend/lib/engine.mjs` (3.5k) `verifyFieldFilled`, `executeFillWithVerification`, `verifyAndSubmitReview` | Fill → wait 80 ms → read the control back → retry once → escalate to manual review. Reads the **Review page** (`parseReviewDOM`) and cross-checks it against what was filled. Waits for Workday's own confirmation markers (`data-automation-id` `submissionSuccess` / `applicationSubmitted` / `congratulations`). | **Take:** read-back after each field; the Review-page cross-check (the only place Workday shows what the *server* kept); the Workday-specific confirmation selectors. **Avoid:** last line of `verifyAndSubmitReview` records `status: 'submitted'` even when no confirmation was found — the exact failure Q1 warns about. Dropdown verify uses fuzzy `tokenSetRatio ≥ 85`. |
| `Workday_Auto/.../workdayQuestionFill.mjs` (3.5k) | Per-question tiers: stored QA → profile → CRM → LLM with live options. `leadingYesNo`/`selectionMatchesAnswer` keep Yes/No polarity. Salary matched "exact only, never fuzzy". | **Take:** polarity guard, "salary exact-only". **Avoid:** hardcoded candidate lists (sponsorship → "No", disability → "No, I do not have a disability", Race → "Asian", min-age → Yes, NDA/arbitration auto-agree), `fillEmptyRequiredWithNearestLlm` (fills any required field with the nearest option the LLM likes — a provenance bypass), `saveAnswerToYaml` persisting model-resolved answers as memory. |
| `job-pilot/modules/apply/ats/greenhouse.py`, `workday.py` | Greenhouse: after submit prints "Submitted!" and takes a screenshot — **no outcome check at all**. Workday: clicks the first visible "Submit"/"Apply" button, prints "Application submitted!". | **Avoid** both: no evidence, any click = success. Security-code modal handling (Gmail fetch, `#security-input-N`) matches what we already do. |
| `AutoApply/extension/content/overlay.js` (2.5k) | Never submits. Detects a confirmation page (`isSubmissionConfirmationPage`), then asks the **user** to click "Record submission" (writes `user_confirmed: true`). "Nothing was submitted" messaging everywhere. | **Take:** the user-confirmed fallback — our "I've applied" button is the same idea; it is now offered when the outcome is *unconfirmed*. |
| Our admin frontend (`chatflow-interface/src/components/admin`, `chat/TasksView.tsx`) | Showed `status` only; the tri-state `submission` field existed in the API and was displayed nowhere. | ✅ FIXED: the failed/cancelled card now says "This may already have been sent" for unconfirmed runs. The admin panel still shows raw status (open item). |

## 1. The seven questions

### Q1 — Can we prove an application was submitted?  **Was: partially. Now: much stronger.**
Found:
- Success needed a regex match of the page text. **Defect A:** the match could be text that was *already on the page before the click* ("Thank you for your interest…"). **Defect B:** "Moved past the form" (URL changed and form gone) counted as submitted — a login redirect or an error page would qualify.
- **Defect C:** a browser crash, timeout or lost worker *after* the click ended as `failed` with the raw engine error, which `submissionState` called **`not_sent`**. The only pre-click marker was the `verified` event, which is also written for test runs and before captcha waits.
- **Defect D:** `completed` was always "confirmed", including a test run that stopped before the click.
- **Defect E:** `cancel()` wrote "Cancelled — nothing was sent" even if the click had been made.

✅ FIXED (migration `0015`, `executor.submitForm`, `applications/index.ts`):
- `applications.submit_attempted_at` is written **before** the click (`markSubmitAttempt`); if it cannot be written, the click is not made.
- After that point any failure except "the site rejected the form" (the site refusing proves nothing was accepted) is **`unconfirmed`**, and the stored error is rewritten to say so. Same for cancel (both paths).
- Confirmation text that existed before the click only counts once the URL changed or the form is gone. "Moved past the form" now requires a confirmation-looking URL.
- Test runs → `not_sent`.
- Duplicate guard and auto-retry now key on `submit_attempted_at`, not on an error-message regex.

Still open: per-ATS confirmation strategies (Workday `submissionSuccess` markers, Greenhouse/Lever/Ashby thank-you URLs) and reading the Workday Review page back. A confirmation page is still matched by generic text for most systems.

### Q2 — Can retries submit twice?  **Was: race possible. Now: DB-enforced for one job.**
Found: the Redis lock (`SET NX`, keyed by apply URL, 30-min TTL, never refreshed) stops a double click on one link; the duplicate checks are *check-then-insert* with no database constraint. Two alternate URLs, a lock that expired during a long human wait, or two workers could both pass. BullMQ `maxStalledCount: 0` means a lost worker is failed, never replayed — good; the scheduler then closed it using the `verified` event.

✅ FIXED: partial unique index `uq_applications_live_job (user_id, job_id)` for non-test, non-failed/cancelled rows; `create()` maps the violation to `DuplicateApplicationError` → 409 and releases the lock. Migration skips (does not fail) if old data already has duplicates. **Run on scratch Postgres:** two concurrent creates → one ok, one `DuplicateApplicationError`; a post-click crash → `unconfirmed`; a new attempt after a *failed* one is allowed (the 7-day unconfirmed guard in `startApplication` still asks first).

Still open: link-only applications (no `job_id`) are still check-then-insert (the Redis lock is their only race guard); lock TTL is not refreshed; the 60-day company+title rule is a hard 409 with `confirmDuplicate`, which matches your "warn, don't block" intent only because the user can override. Windows (60/7 days) are constants, not settings.

### Q3 — Does the review show what the site accepted?  **Partly.**
Chain today: intended answer → `fillField` → `verifyFilled` (ok / reformatted / truncated / rejected) → re-scan right before submit → `readFormErrors` after submit → repair loop → confirmation. That covers *committed control value* and *valid form state*. It does not cover *server persisted it* except via the confirmation page. The reference repos' Review-page read-back (Workday) is the missing link; not built.

### Q4 — Similar but different questions?  **Probe found three real defects. ✅ FIXED.**
Probe (run, not guessed), with notes `Years of experience: 2`:
- "Years of experience with React?" and "…with Java?" were answered **2** from the *total* experience note.
- "Do you have professional experience with React?" was answered **Yes** because React was a listed skill.
- Sponsorship, work-authorisation and "expected hourly rate" were *eligible for the model* — the intent gate existed but the AI path (`executor` → `fillField` with source `ai`) never called it.
- No notion of pay period: a yearly figure (12 LPA) could land in an hourly box.

Fix: notes never cross between confusable intents (total vs technology years, expected vs current salary, work authorisation vs sponsorship); a listed skill never answers "professional/years"; sensitive intents are removed from the model path **and its cache**; pay period is detected (`payPeriod`) so hourly/monthly boxes are asked, and remembered yearly answers aren't reused for them. Ambiguity now ends in *ask the user* (required field) rather than a guess. Tests: `ai-answers.test.ts`.

### Q5 — Workday dynamic controls without corrupting data?  **Fixture-level only.**
Done earlier: virtualised walk, mousedown commit ladder, `datesplit`, panel repair, `#N` section keys, polarity-safe `pickOption` (No ≠ "No sponsorship required" mix-ups). Not proven on a real tenant; the 36 historic failures predate it. Adopt from `Workday_Auto`: the Review-page cross-check. Next step stays: stop-before-submit dry runs on authorised accounts.

### Q6 — Are sensitive answers protected across users, jobs, companies?  **Mostly; four gaps.**
Verified: `answer_memory` is always queried by `user_id`; country-dependent intents are hashed with `@country:XX`; by-meaning recall excludes consent/signature/date; consent boxes are *never* ticked automatically (asked once). Gaps: (1) an answer saved when the country was unknown goes in the `global` scope and is reused anywhere; (2) consent answers are remembered globally — fine for "I accept the terms", wrong for "I certify/declare…" (per-application confirmation recommended); (3) receipts and failure screenshots are written to `.dev-data/` on local disk under the job id — not served by any route (so not leaking), but unencrypted, not user-scoped, lost on a multi-host deploy; (4) form-schema keys dropped *all* query parameters, so a company career page serving many jobs at one path (`?gh_jid=`) collapsed into one schema — **✅ FIXED** (`postingKey` keeps identity params, strips tracking noise; also used for the pasted-link duplicate check). Schemas store labels/options/types only (no values); labels are not PII-scrubbed.

### Q7 — Concurrency and recovery?  **Reasoned from code, not load-tested.**
Good: no replay of stalled runs, task lock released in `finally`, parked runs release their browser, cancel flag in Redis + pub/sub. Risks: lock TTL not refreshed (a >30-min run can be duplicated — now backstopped by the DB index); the cancel flag is checked between steps, so a cancel during the submit click may complete the submit (now reported as unconfirmed rather than "nothing sent"); a Redis outage fails runs closed (the lock and cancel keys live there). Not tested: Redis failover, browser-pool crash mid-submit end to end, duplicate event delivery.

## 2. The seven findings (the second pasted block)

| # | Finding | Status |
|---|---|---|
| 1 | Evidence-based outcomes, persist attempt first, reconcile before resubmit | ✅ attempt persisted first; reconcile = unconfirmed guard + user-confirm path. Not built: ATS-specific confirmation strategies; attempt id (we use the application row + `exec_job_id`). |
| 2 | Provenance enforced at the *final* boundary; confidence ≠ evidence | ✅ Closed the AI-path bypass (the one route that skipped `gate`). `answerFromNotes` is user-sourced and still allowed for sensitive intents. No confidence score exists to override anything. |
| 3 | Fill ≠ commit; exact before alias before fuzzy; no fuzzy across negation | ✅ already (`pickOption`, commit ladder). Probe re-confirmed: "No" never picks "Sponsorship required". |
| 4 | Dedicated Workday layer | ✅ `workday.ts` exists beside the generic filler. Production-ready? **No** — see Q5. |
| 5 | Schema cache privacy | ✅ identity params fixed; values never stored. Open: version/invalidate on form change, treat cache as a hint only (the preview card does not claim "unchanged"). |
| 6 | Race-safe duplicates | ✅ for job-linked applications (DB index). Open: link-only, configurable windows. |
| 7 | Security across the workflow | Origin and scam-text check (`assertSafePage`) runs when a form or wizard starts, not before every field. Open: unknown-but-ordinary domains are allowed rather than approval-gated; no DMARC/SPF header check (we don't store mail headers); `looksLikeInjection` is a filter, but page text is never given instruction authority — the model sees only the user's notes plus the question text. |

## 3. Product vision (§9) vs the system

| Vision | What exists | Gap |
|---|---|---|
| Step 1 — understand a free-text goal | Chat + onboarding collect roles, locations, workplace, experience | No "apply to 100 jobs" command that creates a campaign |
| Step 2 — discover, dedupe, rank | Public ATS APIs only (policy), normalised job table, `closes_at`/status expiry, rule-based `scoreJob` (**role 40, skills 30, location 20, seniority 10**, workplace −10), hard eligibility filters, zero tokens per match | Weights differ from the sample formula: **no freshness, no salary, no employment-type term**. Hard filters correctly separate eligibility from score. |
| Step 3 — build from memory, deterministic first | Order today: rules/profile → remembered answer (intent + country scope) → defaults for non-sensitive yes/no → notes → one batched model call → ask the user | Remembered answers carry `source`, `intent`, `scope` but **not** `verified`, `last_confirmed_at` or a reuse policy; profile facts have versions but no per-fact provenance |
| Step 4 — execute the queue | Per-user concurrency and daily limits, credits reserve/commit/refund, parked runs, per-job events | — |
| "100" means 100 eligible, distinct jobs; report when short | `plan()` already refuses ineligible jobs, repeats (company cooldown 30 d, failed twice, unhealthy system) and explains why it started fewer | **No campaign target N and no progress record** ("43 of 100 — target not reached"). Today there is a **daily cap** and a minimum score. This is the largest vision gap. |
| Metrics: AI calls/app, % fields without AI, cost | `llm_usage` per job and purpose; admin sees cost per run | ✅ added: the `verified` event now carries `sources` (profile/memory/user/default/ai/prefilled counts) so "% without a model" is a query. No dashboard yet. |
| IP location is a hint only | `/me/geo` prefills country and nationality, always editable | Nationality derived from IP, once saved to the profile, is indistinguishable from a confirmed fact. It must not feed work-authorisation answers (it doesn't today: those need the user's own answer, but nothing in the data model enforces it). Detected vs home vs search locations are not three separate fields. |
| Discovery connector ≠ application connector | Discovery is public-feed only; applying is browser automation with dedicated workflows; no API-submission path (correct: those need employer keys) | — |
| Fast execution | Form-schema cache, parked browsers, bounded concurrency, profile preload | Browser contexts are not reused across jobs; no per-ATS rate-limit backoff |
| Never claim success when unconfirmed | ✅ now enforced (Q1) | UI shows it only on the task detail card |

## 4. What I changed this pass

Migration `0015`; `markSubmitAttempt`; `submissionState`; `DuplicateApplicationError`; `cancel()` and `updateByExecJob` honesty; `submitForm` confirmation hardening; `ai-answers` (confusable intents, pay period, model gate); `payPeriod` in `intent.ts`; period-aware memory recall; `postingKey`; `sources` in the `verified` event; TasksView copy and types. Tests: **184 pass** (was 177): `ai-answers.test.ts`, `form-schema.test.ts`, extended `submission-state.test.ts`. `tsc` shows only the two errors that already existed.

## 5. Recommended next, in order
1. **Campaigns:** a `campaigns` table (goal, target N, criteria snapshot, progress, reason-if-short), created from chat, driving `plan()`; replaces the implicit daily cap as the user-facing concept.
2. **Per-ATS confirmation strategies** and the Workday Review-page read-back; then Workday stop-before-submit dry runs on authorised tenants.
3. **Fact provenance** in the profile and answer memory (`verified`, `last_confirmed_at`, `reuse_policy`), and expiry for sensitive answers.
4. Link-only duplicate reservation, lock heartbeat, configurable windows.
5. Receipt store scoped by user with an owner-checked route; scrub schema labels.
6. Matcher: add freshness, salary and employment-type terms; keep hard eligibility separate.
7. Failure-injection tests: Redis down, browser killed mid-submit, duplicate events.
