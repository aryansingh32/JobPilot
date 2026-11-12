# JobPilot — production status

_2026-10-26. Based on the code, the test suite, and the dev database (`jobpilot-dev-pg`: 7 users, 117 applications, 1.2M jobs). Nothing here was run against live employer sites or a production deployment — there is none in this repo's history._

**Verdict: not production-ready for public launch. Ready for a closed beta with the supported systems and a human watching.** The platform layer (auth, queues, budgets, observability) is solid; the thing the product promises — applications that really go through — is proven on very little real data.

## 1. What is solid

| Area | Evidence |
|---|---|
| Job discovery | 11 systems, ~51k boards (≈19k active), 1.18M open jobs; matcher is rule-based (no AI); closed-job tracking; stale-board detection. |
| Tests | 193 backend tests pass; `tsc` has 2 old errors (`ai-answers.ts:168`, `form-filler.ts:1027`). Recorder script verified on a mock portal (10 checks). |
| AI controls | One gateway: kill switch, per-user token and global USD daily budgets, `llm_usage` row per call, purpose→model setting. 51 calls in dev, 0 errors, all on free models. |
| Safety of answers | Provenance gate, sensitive intents never reach the model, DB-enforced one live application per user and job, "may have been sent" tracked from before the click. |
| Ops | Fastify rate limit + CORS on API and admin, admin IP allow-list, admin service separate from the API, queues with worker pool, Prometheus/Grafana/Tempo/Alertmanager/Wazuh stack, Dockerfiles for 4 services, k8s deployment + worker HPA. |

## 2. What is not

### Real outcomes (the main blocker)
Non-test applications in dev: **7 submitted, 60 failed, 28 cancelled** (plus 9 still waiting for input or review). Recent failures are mostly Workday (0 ever submitted), Lever (0 submitted; résumé upload) and "never confirmed". Per-system verdicts are in `provider-readiness.md`. Only **Greenhouse** has repeated real confirmations; **Ashby** has one.

### Onboarding
5 of 8 profiles are `done`, 2 `skipped`, 1 `pending`. The flow exists (`/me/onboarding`, résumé parse, answers from résumé, notes). No funnel metric, no drop-off tracking, so you can't see where people quit. Skipping onboarding leaves the profile gaps that block Auto Apply.

### Bot (chat assistant)
`chat-orchestrator.ts` (640 lines) routes intents with an LLM (`chat_route`, 12 calls in dev) and starts jobs. Works, but it relies on a free reasoning model (3.7 s for routing, 10 s for an answer) and has no automated test. It's one LLM hop from starting a paid application — keep it behind the confirmation card.

### Auto Apply / campaigns
Campaign backend is new (migration `0016`, scratch-DB verified, unit-tested) but has no screen and has not run end to end. Dev shows 13 auto-sourced applications: 2 submitted, 4 needing input, 2 awaiting review, 3 failed, 2 cancelled.

### Security and config
- `chatflow-interface/.env` is **tracked in git** and holds `VITE_API_KEY`. Anything `VITE_*` ships to every browser, so that key is public by design. User data is protected by the user session, not by that key: **rotate it if it is a real production value and untrack the file.**
- The API-key check uses `!==` (not constant time) — low risk, trivial fix.
- API logs use `pino-pretty` in all environments (slow, unstructured for log shipping).
- Failure screenshots and receipts are written to `.dev-data/` on local disk: unencrypted, not per-user, not served by any route, lost on a container restart.
- Consent answers ("I certify…") are remembered globally.

### Delivery
- **No CI for the product.** The only workflow validates the observability compose file. Nothing runs tests, `tsc` or a build on push.
- No backup/restore plan for Postgres in the repo; migrations run at boot with no down-migrations.
- Free OpenRouter models are the default for chat, planning and field answers — rate limits and availability aren't guaranteed.
- `docs/how-it-works.md` and `backend/project_status_report.md` (from May) are stale.

## 3. This session's recorder work

| Change | Why |
|---|---|
| Job-form recordings no longer replay one person's answers. Typed values that aren't in the test profile, and clicks on radios, checkboxes, options and list items that look like answers, are skipped and listed as warnings. | Before, an admin who answered "5 years" or clicked "Yes" for sponsorship while recording baked that into the workflow for **every applicant**. Government recordings keep their literals. |
| The page after the recorded Submit click becomes the site's own confirmation signal (`submitForm.metadata.confirmation`: path and headline). `submitForm` accepts it only when the page moved on or the text was not there before the click. | Per-ATS "received" detection, taught by a recording instead of a regex (audit §5 item). |
| Clicks now record `type` and `role`. | Needed to tell answer clicks from navigation clicks. |
| The admin recorder panel lists the warnings and the learned confirmation when you compile. | Operators see what was dropped. |
| 5 new tests (`compile-recording.test.ts`). | The compiler had none. |

Still open for the recorder: replaying a compiled recording against a mock ATS in CI; recording inside the user's own browser (the recorder is admin-only and remote-controlled); expiring recordings when a site changes.

## 4. Launch checklist, in order

1. Untrack `chatflow-interface/.env`, rotate the key if real.
2. Add CI: install, `tsc`, `vitest`, build both apps on every push.
3. Run Workday and Lever stop-before-submit dry runs on real tenants (provider-readiness §4).
4. Campaign screen, then one real campaign with target 2 on Greenhouse.
5. Move receipts/screenshots to user-scoped object storage with an owner-checked route.
6. Paid or self-hosted model for chat routing and field answers; keep free ones as fallback only.
7. Onboarding funnel events; chat-bot tests.
8. Postgres backups and a restore drill; structured JSON logs.
9. Failure-injection tests (Redis down, browser killed after Submit, duplicate events).
10. Refresh `docs/how-it-works.md`.

## 5. Fixed after this report (2026-10-26)

| Item | Change |
|---|---|
| Committed `.env` | `chatflow-interface/.env` removed from the git index (file kept locally, already in `.gitignore`). It is still in git history — **rotate `VITE_API_KEY` if it was a real value.** |
| No CI | `.github/workflows/ci.yml`: backend `tsc` + tests, frontend `tsc` + build, on every PR and push to `main`. |
| 2 old type errors | `ai-answers.ts` (a model-returned unknown id would have crashed on `field.options`) and `form-filler.ts`; `tsc` is clean. |
| Key check / logs | API key compared in constant time (`shared/security/safe-equal.ts`); `pino-pretty` only outside production. |
| Consent remembered globally | Declarations ("I certify…", "I declare…") are never stored or recalled; they are confirmed again per application. Policy checkboxes still remembered. |
| Receipts on local disk | Paths built only from run ids (`shared/applications/receipts.ts`, `RECEIPTS_DIR` overridable, dirs `0700`); owner-checked `GET /me/applications/:id/receipt`. Object storage is still the production target. |
| Campaign had no screen | `CampaignCard` on the Auto Apply page: pick 10/25/50/100, live "N of M confirmed", stop. |
| Onboarding not measured | `GET /admin/funnel?days=30`: signed up → résumé → roles → onboarding done/skipped → first application → first confirmed. |
| Bot untested, and a bug | `shouldCancelTask` cancelled a running application on any message containing "stop"/"cancel" ("don't stop now"); now only short direct orders. `resolveUi` let malformed directives use up the 4-card cap. 8 new tests. |
| Lever "100 MB" message | The stock line blamed the résumé; the diagnostic shows the send was blocked by the site's bot check. The message now says so. |

**Not fixable from here:** Workday and Lever real-tenant dry runs (need authorised tenants and credentials), a paid model key, Postgres backups and object storage (infrastructure you own), failure-injection tests against a live Redis/Postgres.

## 6. Fewer questions, auto-submit, dynamic island (2026-10-26)

Measured by replaying real questions from the application history (`question-coverage.test.ts`) against a complete profile: only judgement questions ("experience with AI tools", "which office are you most interested in") and a right-to-work *document type* are still asked.

| Change | Detail |
|---|---|
| Work status lists | "Citizen / Permanent Resident / Visa Holder / Require Sponsorship" answered from the profile when it settles it (needs sponsorship; citizen of the job's country; "do not require" wording). Never a guess between visa types. |
| Years of experience | Falls back to the span of the experience entries (overlaps once) or 0 for a fresher, instead of asking. |
| Onboarding | Now collects street address, state, PIN/ZIP, country and current salary (all optional), which used to be asked on the first application. |
| Auto-submit | New "Send without asking me" switch on Auto Apply (migration `0017`). An auto application is sent without review only if no answer was written by AI and nothing required is unanswered (`review-policy.ts`); otherwise it waits and the island says why ("Held because 2 answers were written by AI"). The user's own review setting still applies to manual applications. |
| Dynamic island | Results queue instead of overwriting each other; several finished applications merge into "N applications sent"; a sent-but-unconfirmed result says "May already be sent" instead of "Couldn't finish"; a running campaign shows "Campaign · 12 of 50" in the pill; hovering or focusing a notice holds it on screen. |

Not done: the island has not been looked at in a browser this session (type-check and production build pass).

## 7. Admin defaults, auto-submit everywhere, PDF summary, log review (2026-10-26)

| Item | Detail |
|---|---|
| Default answers in admin | Admin → "Default answers": toggle/reword built-in rules (privacy acknowledgement, "worked here before", licences → "None", "how did you hear", EEO decline…), add custom rules, "Try a question". Setting `answers.defaults`. |
| New defaults | Licences list → "None"; "how/where did you first learn…" → a plain public source; "worked for <company>" → No unless the company is in the person's experience, current employer or a "Previous employers: …" note. |
| Auto-submit everywhere | Applications are sent without a review step. Admin settings: `apply.respect_review_setting` (default off: honour a person's saved "review first"), `apply.hold_ai_answers` (default off: hold applications containing AI-written answers). |
| PDF summary | After each confirmed submit a one-page PDF of what was sent is saved (`receipts/summaries`), shown in the application detail, served at `GET /me/applications/:id/summary.pdf` (owner-checked) and emailed when `notify.email_summary` (default on) and SMTP is set. |
| Island | Tapping the working pill opens the list of running applications, campaign progress and "sent today". |

### Log review findings (dev logs + DB)
| Finding | Fix |
|---|---|
| ~11k Workday "candidate" boards failing 400/403/500 up to 51 times, never retired | A candidate that fails 5 times in a row is now marked dead (`poller.ts`). |
| App's own polling and `/health` returned 429 (182 hits) at a flat 100/min | `/health` exempt; callers with a session get 600/min (`RATE_LIMIT_SESSION`), still counted per IP. |
| `/auth/google` 500 on duplicate email | Concurrent sign-in resolves to the same account; a foreign-identity clash returns 409. |
| Stripe webhook with a malformed body returned 500 | Now 400. |
| Greenhouse "submitted, never confirmed" when the form actually said "Resume/CV is required" | The résumé's S3 upload counted as "the form was sent", hiding the validation error; uploads are now ignored for that check, so it reports the rejection. The résumé-required-after-upload behaviour itself is still unexplained. |
Not fixed: Workday/Lever site-side failures; Ashby "never confirmed" cases (graphql 200s, no visible error).

## 8. Region-first jobs and stronger answers (2026-10-26)
| Change | Detail |
|---|---|
| Region from network location | On `/me` (at most weekly) the country is read from the CDN header or the IP and stored as `personal.detectedCountry`; the person's own `country` always wins. Private/dev addresses detect nothing. |
| Region-first matching | Top matches / Auto Apply: with no city named, jobs in the person's region score as a good fit, global remote as a full fit, remote tied to another country and on-site jobs abroad are dropped. Browse/search lists the region and remote jobs only (region first) unless the person picks a country or place. Admin setting `jobs.region_only` (default on). Remote is welcome unless they chose only office/hybrid. |
| Open-ended answers | "Why this role / about yourself / strengths" now use the résumé facts and the skills the posting asks for that the person really has (truthful overlap), written as 2–4 specific sentences; they no longer require notes. Cached answers are keyed to the job, so a "why us" for one company is not reused for another (was a bug). The cover letter leads with the same matched skills. The job's skills and a description snippet are passed in the run context (the posting text is marked untrusted in the prompt). |
Behaviour change to know: the AI previously read only the person's notes; for open-ended questions it also reads résumé facts (no identity, legal or demographic data).

## 9. Résumé analyzer, prepared answers, required onboarding, more sources (2026-10-26)
| Change | Detail |
|---|---|
| Résumé analyzer | `shared/profile/resume-analysis.ts` (rules, no AI): score 0–100 over contact, summary, experience (bullets, numbers, action verbs), skills (+ keywords roles like theirs list, "add only if true"), education, preferences, extras; and "your profile already answers N% of what applications ask". Works for an uploaded résumé and for onboarding answers. `GET /me/resume/analysis`; card in onboarding's last step and in Settings. |
| Prepared answers | `profile.answerBank` (about you, strengths, biggest achievement, career goals) built from the résumé by rule; at most ONE small model call (`answer_bank`, setting `ai.answer_bank`) polishes the wording, only when the facts hash changed, and is rejected if it adds a number the facts lack. Runs after a résumé is applied and when onboarding finishes; `POST /me/resume/optimize`; people can edit (`PUT /me/answer-bank`, edited answers never overwritten). The form filler uses them with no model call ("Tell us about yourself", strengths, achievement, career goals). |
| Required onboarding | The global "Skip for now" is gone. About-you needs name, mobile, city, experience, work authorisation; Preferences needs roles, place/workplace, notice period, expected salary. The server also refuses `done`/`skipped` until these exist (409 with the list). |
| Match score | Also counts job titles from the résumé ("Like your work at X"), tools named in achievements/projects/certifications/notes. |
| Residence and citizenship | "Do you reside in <country>?", "citizen of <country>?", "country of residence/citizenship" are answered against the country the question names and the person's country (own answer, else network location) and nationality. Relocation and unnamed places are still asked. |
| Sources | Breezy HR and Personio adapters (checked against live endpoints), Common Crawl discovery for Workable, Recruitee, Breezy, Personio, URL detection. Not in the apply-ready list: nothing has been submitted through them yet. |
| Source fixes | Discovery kept link query strings as part of Workday boards (≈11k junk candidates); tokens are cleaned and migration `0018` retires the junk rows (scratch-DB verified). |
Not done: apply workflows for Breezy/Personio, per-site description fetch for Breezy (its list has none), resume text-level checks (page count, formatting) — the analysis reads the structured profile only.

## 10. Migrations + live provider test run (2026-10-26)

- Migrations 0016 (campaigns), 0017 (auto_submit), 0018 (clean_board_tokens) applied to the dev DB.
- Chrome extension could not open localhost/LAN, so the UI was not driven through Chrome. Providers were exercised through admin test runs (real Playwright worker, stop-before-submit; nothing submitted).

| Provider | Result |
|---|---|
| Greenhouse, Lever, Freshteam, Keka | ready for review (12/11/-/13 answers) |
| Ashby | 3-5 genuine questions; intermittent "no form found" on some runs (open) |
| Oracle HCM | reaches emailed sign-in code step (needs real mailbox) |
| Workday | verification link to test email (expected) |
| Workable / Zoho | human-only questions / profile gaps (postal, address) |
| SmartRecruiters | bot wall detected, reported honestly (not bypassed) |
| SuccessFactors (Cipla) | open: account-form control times out; apply-menu selector fixed |
| Breezy (generic workflow) | "no form found" on a trial account (unverified) |

Fixes: bot-wall detection, hidden-checkbox ticking, success-banner false error, combobox default/how-did-you-hear rules, `adult-18` default rule, dial-code select, long current-employer labels, SuccessFactors apply-menu selector.

## 11. Government jobs: eligibility (2026-10-28)

- `shared/jobs/govt-eligibility.ts` reads age band, "as on" date, minimum qualification and women/men-only from a notice, and compares with `profile.government` + education (category relaxations OBC +3, SC/ST +5, PwD +10, ex-serviceman ~+3). A doubtful reading says "check", never a silent yes. On the 42 live notices in dev: age limit parsed on 37, qualification on 41.
- `GET /jobboard/jobs/:id` returns `eligibility` for Government jobs; the job drawer shows it and asks only for the missing date of birth / category.
- sarkari adapter: state for rojgarresult.com notices now comes from the title (its category ids were being read as sarkarinaukri ids, so UP/Bihar notices showed "Himachal Pradesh").
- Not done: background auto-apply for government portals (they need Aadhaar/OTP/fee payment from the person), live-site verification of the gov workflows.

## 12. Résumé analysis, round 2 (2026-10-28)

- **Résumé vs one job** (`shared/jobs/job-fit.ts`, returned as `resumeFit` by `GET /jobboard/jobs/:id`, shown in the job drawer): required vs nice-to-have skills the résumé shows or lacks, skills the résumé's own text shows but its skills list omits, years asked vs held, a verdict (strong/good/stretch/unlikely) and advice. Rules only; never tells anyone to claim a skill.
- **Rule parser fixes** (no AI needed): "Title, Company, City" headers were read as title="" / company=city; Indian "City, State" headers gave no location; the summary, certifications, skills-section lists and CGPA/percentage were dropped. 6 new tests (`resume-rules.test.ts`, `job-fit.test.ts`).
- Not done: PDF layout edge cases (two-column résumés), non-English résumés, scoring `resumeFit` inside the job list (only the drawer for now).

## 13. Match maths (2026-10-28)

`shared/jobs/fit-math.ts`: IDF skill weights from open-job frequencies (92 distinct skills in dev; ~4.6 s query, cached 1 h), shrinkage toward a prior for jobs naming few skills, Gaussian years fit (σ 1.5 short / 4 over), cosine similarity of sublinear-TF vectors. Used by `scoreJob` (skills 30 pts, seniority 10 pts) and `analyzeFit` (0–100 `score` = 55% coverage + 25% years + 20% wording). A perfect match now scores ~93–97 rather than a flat 100. Weights are hand-set, not fitted to outcomes: they need calibration against real interview/offer data.
