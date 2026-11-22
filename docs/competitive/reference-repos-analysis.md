# Reference repos vs JobPilot — what they do, what we do, what to take

_Written 2026-10-25 from reading the **code** of the six repos in `refrence_code/` (no READMEs) and of our own `backend/` + `chatflow-interface/`._

**Depth of reading (so you know how far to trust each section):**
read in full or near-full — `job-agent` (form_filler, applicator, outcome, greenhouse, workday, lever, ashby, linkedin, gmail_codes, client, classifier, tailor, mcp_filler), `job-pilot` (form_inspector, browser_apply), `Auto-Fill-Forms` (CLAUDE.md playbook + commands), our `form-filler.ts`, `ai-answers.ts`, `fillPage/fillWizard/reviewForm/submitForm` in `executor.ts`, `auto-apply.ts`.
Read as outline + key functions — `Workday_Auto` (intents, profileFacts, provenanceGate, pageAnswerEngine, pageLoop, selectVerified, preFillValidator, errorRepair, jobFormCache, workerPool/queue API, pipeline config), `applypilot-ai` (ats-adapters, gemini-service, review card, audit logger), `AutoApply` (local_mapper, field_mapper, filler.js, autofill router, overlay outline).
**Not read in depth:** `Workday_Auto/engine.mjs` + `workdayQuestionFill.mjs` (3.5k lines each), `job-pilot` ATS modules (greenhouse/workday/ashby), `AutoApply` overlay body, our admin frontend. Claims about those are inferred from names/outlines and marked _(inferred)_.

---

## 1. The six repos at a glance

| Repo | Stack | What it really is | Standout idea |
|---|---|---|---|
| **job-agent** | Python, Playwright, SQLite, OpenRouter | Full autonomous pipeline: scrape → classify → enrich → tailor résumé → apply, dedicated submitter per ATS | **Strict outcome truth** (`applied` only on positive confirmation, `UNCONFIRMED:` sentinel) and a very battle-scarred Greenhouse/Workday filler |
| **Workday_Auto** | Node (.mjs), Playwright, Supabase, React ops dashboards | Industrial Workday-only service run by "career associates" for many clients | **Scan → Resolve → human review → Submit** pipeline with 9 named workers, per-job form-schema cache, intent classifier, provenance gate |
| **job-pilot** | Python, Playwright, Claude as orchestrator (WAT framework) | Claude Code is the agent; Python tools do fill/submit; Google Sheet tracker | **Pre-flight `form_inspector`**: list every field + planned answer + source, exit 1 if anything unresolved |
| **Auto-Fill-Forms** | No code — a `CLAUDE.md` playbook + Playwright MCP | Claude drives the browser, fills, **stops before Submit** | The most complete **safety/threat model** (prompt injection, origin gate, scam detection, credential rules) and an answers file split into `confirmed` vs `rules` |
| **applypilot-ai** | Chrome MV3 extension, Gemini | In-page autofill with review card | **Multi-signal field dictionary + ComplexUIAdapters** (split date/phone/salary, segmented, switch, slider, tag input, cascading dropdowns), repeated-section index resolution |
| **AutoApply** | Chrome extension + FastAPI | Extension fills from backend "fill instructions" | **Local mapper before LLM**, third-party-field guard, LLM output validated as untrusted, **verify what the page kept** (mask/truncation), undo snapshot |

---

## 2. How each one fills a form (the mechanics worth knowing)

### job-agent (closest to us in intent)
- **Order of operations is deliberate:** probe page (no AI spend: login wall? CAPTCHA? dead?) → materials (résumé tailoring; cover letter **only if the form has a field**) → submit → record → save screenshot + HTML for _every_ attempt.
- **Dispatch:** URL → dedicated submitter (Greenhouse/Lever/Ashby/Workday/iCIMS/LinkedIn Easy Apply) else `GenericFormFiller` (8-step loop: classify page as SUCCESS/CAPTCHA/LOGIN/ERROR/JOB_LISTING/MULTI_STEP/APPLICATION_FORM/UNKNOWN) else MCP/Claude-agent fallback — but fallback only if nothing was submitted.
- **Answering:** hard-coded profile map → keyword map → AI only for _required_ leftovers. AI is told to return one short value; for dropdowns it is shown the **real option list** and asked for a **number** (free text "rambles and fails the verbatim match").
- **Option matching** (`_choose_option`): exact → word-boundary partial (so alias `US` never matches `AUStralia`) → alias table (`United States`→`US/USA`) → yes/no semantics (`No` → "never/none/do not").
- **Combobox commit ladder** (react-select): JS `mousedown+mouseup+click` (react-select selects on mousedown) → real Playwright click → ArrowDown+Enter; after each step **verify** a single-value node exists or the input value changed (residual typed text ≠ selection). Leaves no half-typed text behind on failure.
- **Repair pass after a failed submit:** read exactly the fields marked `aria-invalid`, fix those (keyword map → AI-from-options → tick consent boxes → AI free text), resubmit, max 2 passes.
- **Hidden decoy buttons:** `_first_visible()` — Lever/Palantir has a `class="hidden"` submit earlier in the DOM.
- **Embedded/SPA fronts:** if the company page has no real form, load `boards.greenhouse.io/embed/job_app?for=X&token=Y`; detect the iframe with the most inputs and work inside it; Talemetry `CareerSite.Apply.launchApplicantJobExternalId`.
- **Email codes without a human:** IMAP (Gmail app password) polls for the Greenhouse security code and for Workday PIN/activation link, filters by sender domain + `SINCE`, picks the newest message after a timestamp.
- **Workday specifics:** one account per tenant (shared generated password), `data-automation-id` everywhere, dropdown = `button[aria-haspopup=listbox]` with **virtualised** options → keyboard-walk with ArrowDown reading `aria-activedescendant`, typeahead prefix; multiselect prompts (browse popup first, type only if empty); **skip honeypots** (`beecatcher`, `name=website`); resume-parsed **work-experience panels with empty dates** get filled from a known timeline or the **phantom panel is deleted**; today's date only for signature blocks, never in history; compensation fields after a rejection get a bare number.
- **Cost accounting:** per-job token/$ tracker; keyword prescreen avoids the classifier call; batch classifier (5 jobs/call); title-first gates, seniority gate, staffing-agency list.
- **Résumé:** parse once (cached by PDF hash) → AI _reorders skills and picks ≤4 projects, never invents_ → Jinja+WeasyPrint PDF. Multiple base résumés, AI picks best one per job.
- **Security smell:** Workday passwords stored plaintext JSON; Gmail app password; hCaptcha "vision solve" and 2captcha injection (we should **not** copy the captcha-solving — it breaks ToS and our human-tier design is the safer product).

### Workday_Auto (the depth reference for Workday)
- **Pipeline:** `scanning_worker_1..3 → resolving_worker_1..3 → (human review in dashboard) → submitting_worker_1..3`, tracked in `worker_status` / `bot_control` rows (stop/pause flags), queue leasing in Supabase.
- **Form-schema cache:** first client scans the whole wizard and stores the schema per canonical job URL; later clients load it, **pre-resolve every answer before opening a browser**, fill with zero discovery. Partial schemas (1 step, <20 fields) are invalidated. Dead URLs ("page doesn't exist") are purged from the queue for _all_ clients.
- **Answer engine (the best part):** `classifyQuestionIntent()` → stable intent (`work_authorization`, `sponsorship`, `salary_hourly`, `years_experience` vs `technology_years_experience`, `eeo_*`, `clearance`, `criminal_history`, `minimum_age`, signature/full-name, today's date, shift, commute…). Tiered resolution: deterministic special cases → Supabase answer bank (exact/fuzzy) → client API facts → résumé-backed experience → LLM with **live Playwright options**.
- **Gates before any fill:** confidence floor 0.70; **provenance gate** (allowed sources whitelist; sensitive intents — work auth, sponsorship, EEO, salary — can **never** come from the LLM; hard-coded defaults blocked); contradiction check vs previously verified memory; value validators per control type.
- **Page loop:** scan → reason → validate → fill → **verify** → re-scan, with per-field attempt guard, verify-fail cap, stall detection (field count growth), release of stale "filled" ids, `HUMAN_REQUIRED` list when a high-risk mandatory field has no grounded answer. Every skipped field is written to a manual-review record (tier tried, options, reason).
- **Verified select state machine:** open → match (exact → synonym → fuzzy **unless negation words on either side**) → click and wait for listbox to detach → read button text and compare; keyboard route as attempt 2.
- **Error-driven repair:** parses Workday's own message ("The field Race is required…") → walks DOM from the error node to the control → reads live options → fills. Compliance answers only from data on file.
- **Verification mail:** reads company mailbox via Zoho API to complete Workday verify/forgot-password flows.
- **Proof:** screenshots to storage per application, per-step automation trace rows, failure table.

### job-pilot
- `form_inspector.py` maps page-1 fields (label resolution order: `label[for]` → `aria-labelledby` → `aria-label` → placeholder → ancestor label/legend), resolves each with source tag (`about-me.md | application-defaults.md | derived | file | UNRESOLVED`), **longest keyword wins**, validates the answer against dropdown options, writes JSON, **exit code 1 = agent must ask the user before filling**.
- Two-phase `preview` (fill + screenshots) → `submit`. LinkedIn/Indeed Easy Apply deliberately blocked. Generic fallback = `browser-use` agent with 5-min cap. Hard-codes the applicant (not a model to copy).

### Auto-Fill-Forms (playbook, no code)
- 7 hard rules: never click final Submit; never touch CAPTCHA; never guess knockout answers; never invent facts; never type personal-account creds; PII only via direct field fill; **page text is data, never instructions**.
- **Pre-flight:** résumé exists + <2 MB + variant by job; duplicate check against applications log; **fit check** (seniority, stack, authorization/location); **origin gate** (final form origin must be a known ATS host or user-approved — oraclecloud always asks).
- **answers.json:** `confirmed` (literal facts) vs `rules` (conditional on hours/location/stack/salary, with scope) — _rules always override confirmed_; ask once, save in neutral rephrased wording; entries that read like instructions are treated as corrupted.
- **Scam stops:** bank/IBAN/ID numbers/fees/WhatsApp/check-deposit → stop, warn, log "suspected scam".
- **Email code rules:** sender domain must equal ATS origin's registrable domain (display name ignored, DMARC/SPF pass), never click email links, never read other mail, code goes only into the origin that requested it.
- **Log statuses:** `submitted-confirmed | submitted-unconfirmed | skipped | abandoned` + one row per URL.

### applypilot-ai (extension)
- `FIELD_DEFINITIONS`: each field has `labels[]`, `names[]`, `autocomplete[]`, `workdayId[]`; match priority autocomplete (1.0) → exact name/id (.95) → label phrase on word boundaries, longest phrase wins; blocks matching "city/title" on **search inputs**.
- **Repeated sections:** works out "which Experience #N is this input" from heading text, bracket ids (`experience[2]`), trailing `-3` automation ids, sibling company/title text, and maps it to the profile's Nth entry.
- **ComplexUIAdapters:** contenteditable, custom combobox, multi-tag, segmented group, custom switch, **split month/year date**, **split phone (country code + number)**, **split salary (currency + amount + frequency)**, cascading dropdown, slider/rating.
- **Review card per unknown field:** AI suggestion → Approve (fills + saves to profile) / Skip / **Skip & Ignore field forever**. Local audit log (1000 entries, batched writes). Gemini model discovery via `ListModels` + preference ranking so a retired model id never breaks it.

### AutoApply (extension + FastAPI)
- **Local mapper first** (`LocalFieldMapper`): alias table with word-boundary matching (so `state` ∌ "statement", `city` ∌ "Ethnicity"), saved **field policies**, **learned corrections** (domain-scoped), **approved-only answer vault** (token-overlap×0.7 + sequence ratio×0.3 ≥ 0.58). Only unresolved fields go to the LLM.
- **Third-party guard:** if a label names someone else (referrer, reference, recruiter, company, employer, emergency, manager, supervisor, HR, spouse, parent…), applicant-owned values (email, phone, LinkedIn, website) are **never** filled.
- **LLM output = untrusted:** each instruction must target a known field id, appear once, use an action valid for that control type, match a real option (exact page text preserved), fit `max_length`; `upload` only for `resume`.
- **Verify what landed** (`classifyFilledValue`): same → ok; same alphanumerics → ok but "site reformatted"; empty → "rejected"; prefix → "truncated"; else "reformatted to X". Phone mask gets one digits-only retry and a delayed re-read. Native-setter write + `input/change/blur`.
- **Review UI:** every instruction flagged `review_required` if skip / not high-confidence / from policy / from vault; **undo last fill** snapshot; cross-origin **iframe frame protocol** (child frames scanned/filled via postMessage); autopilot with confirm; duplicate-application warning; fit score; cover-letter and résumé-tailor endpoints.

---

## 3. JobPilot today (what we actually have)

**Architecture:** api-service (user API + chat/Socket.IO), admin-service (separate origin/cookie/roles/audit), execution-service worker (BullMQ, Playwright pool, recorder), scheduler-service, shared libs. Postgres + Redis, control bus on Redis pub/sub. TanStack frontend + Android shell.

**Apply engine** (`shared/applications/apply.ts` → worker `executor.ts`): URL/job → ATS → published **workflow** (rows in `site_workflows`, admin-editable, recorder-compiled) → `autofillForm` (scan → answer → ask) → `reviewForm` (user approves/edits every answer with source) → `submitForm`.

**What is genuinely strong (beats most of the references):**
- Workflows as data + recorder + admin studio, test runs, history/restore — nothing in the references has this.
- `review before submit` with per-answer **source** and values re-filled **verbatim**; **drift re-check** at submit; a run is **never replayed** (`maxAttempts:1`, no stalled retry); parked runs survive worker death.
- Zero-token answering ladder: profile → remembered answers → rules (`answerByRule`, `answerFromNotes`) → **one batched AI call limited to the user's own notes** → ask the user (batched into one form). `NEVER_GUESS` and `NOTES_ONLY` lists are the same instinct as Workday_Auto's high-risk intents.
- Real option handling: Indian-form niceties (notice-period buckets, LPA→number, experience ranges, "Other" for school lists, DD/MM/YYYY vs ISO), phone split by dial code, EEO → decline.
- Captchas as **human tier with cropped screenshot** + optional paid-solver plan gate; emailed-code reading via Gmail/inbox with per-ATS sender domains.
- Auto-apply with guard rails: per-company 30-day cooldown, ≤2 failures per job, **ATS health breaker** (≥80% failures in 48h pauses that system), dedicated-workflow-only, credits, daily cap.
- Job intake from public ATS JSON (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, custom JSON) + Sarkari; rules-only matcher with metro aliases.
- Locale/timezone-matched browser fingerprint, per-session cookies, proxy manager, stealth.
- Gov-portal engine (identity gates, OTP, photo/signature) — outside the references' scope.

---

## 4. Gaps and opportunities (ordered by value for a job-application product)

Legend: ✅ verified in code · 🔎 inferred / needs a check before building.

### P0 — reliability of the fill itself
1. **No iframe-hosted forms** ✅ — `scanForm` works on one page/root; frames are only used for captcha. Greenhouse **embed**, Jobvite, iCIMS, Workable/Personio embeds, Talemetry all live in iframes (job-agent `_form_frame`: pick frame with most inputs; AutoApply frame protocol). Also add the **embed-URL fallback** for company SPAs that front Greenhouse.
2. **React-select / combobox commit is click-only** ✅ (no `mousedown` anywhere) 🔎 whether our click is enough on Greenhouse v2. Port the **commit ladder + "was it really selected?" check** (single-value node / changed value) and clear residual text on failure.
3. **Verify what the page kept after each fill** 🔎 — we only drift-check text inputs at submit. Add AutoApply's `classifyFilledValue` (same/ reformatted / truncated / rejected) at fill time so the review shows "site changed this to X" instead of a surprise at submit.
4. **Validation-driven auto-repair before asking the user.** We catch a rejected page and `askAboutRejectedPage`. Workday_Auto and job-agent first parse the error (`aria-invalid`, "The field X is required"), map it back to the control, re-resolve (rules → memory → AI-from-options) and retry 1–2 times, **then** ask. Cuts "needs you" interruptions.
5. **Workday depth.** Our Workday support = generic scan + account + `fillWizard`, proven only against `tools/mock-ats/workday.mjs` ✅. Real tenants need: virtualised listbox keyboard-walk, multiselect prompts, split date sections (`dateSectionMonth/Day/Year`), résumé-parsed experience/education panels (empty dates, phantom panels → delete), honeypot skip (`beecatcher`), "Autofill with Resume then correct from profile", error-field repair, "Save and Continue" vs final Submit, tenant account bookkeeping + forgot-password. This is the single biggest Workday_Auto lesson: **a Workday module of its own**, plus a small real-tenant smoke list.
6. **Hidden decoys / honeypots** — we pick the last matching submit tier (good), but `scanForm` has no honeypot rule (`name=website`, `beecatcher`, off-screen/`aria-hidden` text inputs that are not widget internals).
7. **Third-party label guard** ✅ — `ruleFor` only excludes `referr(al|ed|er)`. "Emergency contact phone", "Manager email", "Reference name/email", "Recruiter", "Spouse", "Employer website" can still match `email/phone/website` rules. Add AutoApply's qualifier list.
8. **Negation-safe option matching** ✅ — `pickOption` uses prefix/contains with a length window; add `selectVerified`'s rule (no fuzzy when either side has no/not/never/don't/non) and word-boundary alias matching (job-agent `_choose_option`).

### P1 — answer quality & trust
9. **Intent layer.** Replace/augment regex `RULES` with a named **intent** per field (work_authorization, sponsorship, years_total vs years_in_tech, salary_annual vs hourly, eeo_*, minimum_age, signature, today's date, shift, commute, clearance, criminal_history…). Gives: one place for the high-risk list, per-intent defaults, analytics on which intents fail, and a stable key for caching.
10. **Provenance gate + confidence floor as code, not convention.** We tag source but nothing _blocks_ (e.g. a sensitive intent filled from `ai` source). Add Workday_Auto's gate: whitelist of sources per intent, sensitive ⇒ never `ai`, floor 0.70, contradiction vs previously approved answer.
11. **Answer scopes.** Our memory is exact-question → value. Auto-Fill-Forms' `confirmed` vs `rules` distinction (salary by location, hours, stack) and AutoApply's domain-scoped learned corrections avoid wrong reuse. Add `scope` (global | company | ats | job-type) to `answerMemory`.
12. **"Ignore this field" and per-field approve-and-remember** (applypilot) in the review card; we already ask-and-remember, but cannot say "never ask this optional one".
13. **Repeated sections** (Experience #N / Education #N) with profile arrays — applypilot's index resolver. We read only `education[0]`/`experience[0]`, so multi-entry education/work blocks (Workday, Taleo, Indian portals) can't be filled faithfully.
14. **Split-control adapters** for date (M/Y), salary (currency+amount+frequency), segmented/switch/slider/tag inputs (applypilot ComplexUIAdapters). We have phone split and Yes/No button groups only.
15. **Compensation from options** (Workday_Auto `pickCompensationFromOptions`, currency-required formatting, hourly = annual/2080).

### P2 — product features the references prove people like
16. **Pre-apply form preview / schema cache** ✅ _(not built)_. Cache scanned fields per canonical job URL (Workday_Auto `job_form_schemas`, job-pilot `form_inspector`). Uses: (a) job detail shows "this application will ask you 6 questions — 2 need you" **before** credits are spent; (b) pre-resolve answers for the next user applying to the same posting; (c) invalidate partial schemas; (d) purge dead URLs for everyone.
17. **Résumé selection + tailoring** ✅ _(absent — `tailor` is not in our code)_. job-agent: pick best of N résumés per job, AI **reorders skills / picks projects, never invents**, render PDF, cover letter only if the form has a field (we already generate a cover letter on demand; make it field-conditional to save tokens). Auto-Fill-Forms `resume_variants` is the cheap version.
18. **Fit / seniority / authorization check before applying** (Auto-Fill-Forms step 0; job-agent title-first + seniority gate). Our matcher scores; auto-apply uses `minScore`. Add an explicit "needs sponsorship in this country" and "seniority mismatch" reason in the verdict, and block auto-apply on them.
19. **Duplicate-application detection by URL _or_ company+role** (AutoApply, Auto-Fill-Forms). We have a company cooldown; add exact-job duplicate across aggregator URL and ATS URL (log both).
20. **Outcome vocabulary** — keep our "never confirmed" error but expose a first-class tri-state (`confirmed | unconfirmed(needs-check) | failed`) on the Applications screen (job-agent `UNCONFIRMED:`; Auto-Fill-Forms `submitted-unconfirmed`). Recent commit says Browse lists only confirmed-clean systems — extend the same truth to each application row.
21. **Evidence for every attempt**: screenshot + HTML + final URL + POST statuses saved per application (job-agent artifacts, Workday_Auto storage proof). We write a diagnostic only on _unconfirmed_ submit; keep a lightweight "receipt" (final-page screenshot) on success too — also good UX (ReceiptCard exists).
22. **Per-run cost line** (job-agent QuotaTracker) next to credits: tokens by stage per application, visible in admin.

### P3 — security hardening (take from Auto-Fill-Forms, even though we're server-side)
23. **Prompt-injection / scam posture on page text.** Our AI step reads only the user's notes, which is good, but form _labels_ flow into the batched prompt. Strip/flag labels containing instruction-like text ("assistant", "ignore previous", "paste your profile").
24. **Scam stop** for postings asking for fees, IDs, bank/crypto, WhatsApp/Telegram, check deposit → fail fast with reason "suspected scam" and warn the user.
25. **Origin gate before PII**: after redirects, if the form origin isn't a known ATS host or the company's own domain, require approval (oraclecloud/any-tenant hosts always).
26. **Email sender authentication**: our MAILERS list matches sender domains; add the DMARC/SPF-pass requirement and "ignore display name" rule where the mail source exposes headers; never follow non-allow-listed links (we already allow-list `VERIFY_LINK_HOSTS`).
27. **Secrets at rest**: references store plaintext passwords — we already encrypt (`crypto-service`); keep it that way and never log Workday-style generated passwords.

### Things _not_ to copy
- Auto-solving captchas (hCaptcha vision, 2captcha token injection): conflicts with ToS and with our human-tier design.
- Hard-coded applicant data in source (job-pilot) and plaintext credential files.
- "AI invents a short value for any required field" (job-agent `_ai_fill_unknown_field`): our notes-only AI is better — keep it.
- Default password constants (Workday_Auto has one in `pageLoop`) — never.
- Mass-applying through LinkedIn/Indeed Easy Apply with a user's own account (job-agent does; job-pilot and Auto-Fill-Forms block or limit it) — account-ban risk; our public-ATS-API-only policy is right.

---

## 5. Suggested build order

1. **Week 1 (fill reliability):** iframe form support + embed fallback; combobox commit ladder + selected-check; third-party label guard; negation-safe `pickOption`; honeypot skip; unit tests in `form-rules.test.ts` for each.
2. **Week 2 (repair & verify):** fill-time landed-value verification; aria-invalid/error-text auto-repair loop before `askAboutRejectedPage`; per-attempt evidence screenshot.
3. **Week 3 (Workday module):** listbox walker, multiselect prompt, date sections, experience/education panel handling with repeated-section profile arrays, honeypots, error repair; extend `mock-ats/workday.mjs` to include them; then 3–5 real tenants in test-run mode (stop before submit).
4. **Week 4 (answers):** intent layer + provenance gate + answer scopes; "ignore field".
5. **Week 5 (product):** form-schema cache + "questions this application will ask" on job detail; résumé variants + tailoring (reorder only); outcome tri-state in UI; fit/authorization verdict that blocks auto-apply.
6. **Ongoing:** prompt-injection/scam/origin gates; cost-per-application line.

## 6. Open questions for you
- Do we want **multiple résumés** per user (variants), or one résumé + tailoring? (Changes onboarding and storage.)
- Is **cross-user form-schema caching** acceptable privacy-wise? (Schemas hold questions, not answers — I'd say yes, but it's your call.)
- Real-tenant Workday testing needs throwaway accounts at real companies — OK to do in stop-before-submit mode only?

---

## 7. Implementation status (2026-10-25)

**Built and tested (161 backend tests pass, incl. real-Chromium fixtures):**
| Gap # | What | Where |
|---|---|---|
| 1 | Forms inside iframes: scan/fill/submit/confirmation work in the frame that holds the form (widget frames excluded) | `form-filler.ts` (`scanForm`, `formSurface`), `executor.ts` submit |
| 2 | Dropdown commit ladder (click → synthesised mousedown/up/click → keyboard) with a "did it stay selected" check; residual typed text cleared on failure | `commitOption`, `committed` |
| 3 | Landed-value check after each fill (ok / reformatted / truncated / rejected), phone digits-only retry, note shown on the answer | `verifyFilled`, `fillPage` |
| 4 | Self-repair before asking: pages flag invalid fields → redone (also ones with a value), up to 2 resubmits on the final submit | `invalidFieldIdx`, `askAboutRejectedPage`, `submitForm` |
| 5 | Workday pass: résumé-parsed history panels get dates from the profile, phantom panels deleted, signature dates = today (never in history), searchable prompts (“How did you hear”), virtualised listbox scroll-collect + ArrowDown walk | `workday.ts`, `form-filler.ts` |
| 6 | Honeypots skipped (beecatcher, honeypot, off-screen) | `scanSurface` |
| 7 | Third-party guard (referee, emergency contact, manager/supervisor/HR contact, spouse, parent, recruiter) | `isThirdParty` |
| 8 | Negation-safe, whole-word, alias-aware option matching | `pickOption` |
| 9–10 | Intent taxonomy (≈55 intents), sensitive set, provenance gate (sensitive never from a model/default) | `shared/profile/intent.ts`, `planAnswers` |
| 11 | Answer memory keyed by intent + scope (country-scoped for work-auth/sponsorship/salary…); reworded question reuses the answer; UK job never gets a US answer | migration `0014`, `answerMemory` |
| 16 | Form-schema cache per posting + `GET /jobboard/jobs/:id/form-preview` (“N questions, M need you”) computed with no browser | `form-schema.ts`, `form-preview.ts`, `me-routes.ts` |

**Already covered by existing code (corrected from §4):** gap 18 — the matcher already drops roles in countries the user isn't authorised for (`matcher.ts`).

**Not built yet / needs your call:**
- Workday "Add" for empty Work Experience / Education panels (only repair of existing panels is done); needs a real-tenant run.
- Workday date widgets for non-signature fields (DOB, availability) are still scanned as three text boxes.
- UI for the form preview (the endpoint exists; the job detail screen doesn't call it yet).
- Résumé variants + reorder-only tailoring, per-run cost line, prompt-injection/scam/origin gates (§4 items 17, 22–26).
- Not run against a live Workday tenant — only the fixtures above and the existing mock.

## 8. Second pass (same day) — the rest of the 27

| # | Item | Status |
|---|---|---|
| 12 | "Skip & ignore" field | **Not needed.** We only ever ask for *required* fields; optional ones are skipped silently, so there is nothing to ignore. |
| 13 | Repeated sections (School 2, `education[1]`) | **Done** — `sectionIndex` + `school#N`/`degree#N`/`currentCompany#N`… in the answer book; a later section gets its own entry or nothing, never entry 0 again. |
| 14 | Split controls | **Done for dates** (Workday month/day/year → one `datesplit` field; signature date = today). Phone split already existed. Salary currency+amount+frequency, sliders, tag inputs: **not done**. |
| 15 | Pay from option bands | **Done** — "12 LPA" → the band that contains it. |
| 17 | Résumé variants | **Done (backend)** — up to 5 role-specific résumés, picked by job title (`POST/DELETE /me/resume-variants`). **No UI yet.** Tailoring (reorder skills / pick projects → new PDF) **not done**: we send the person's own PDF and have no résumé renderer; `settings.resumeTailoring` exists but nothing reads it. |
| 19 | Duplicate detection | **Done** — same posting via another link already existed; added: same company + title applied in the last 60 days, and a previous attempt that was sent but never confirmed (7 days). Both 409 with `confirmDuplicate: true` to proceed. |
| 20 | Tri-state outcome | **Done** — `submission: confirmed | unconfirmed | not_sent | in_progress` on every application. UI doesn't show it yet. |
| 21 | Evidence on success | **Done** — screenshot of the confirmation page saved and referenced on the `submitted` event. |
| 22 | Cost per application | **Done (admin)** — `usage {calls, tokens, costUsd, byPurpose}` on the admin application record. |
| 23 | Prompt injection | **Partly** — a label that gives orders is never sent to the model (`looksLikeInjection`); the model already saw only the user's own notes. |
| 24 | Scam stop | **Done** — fees/deposits, money transfer, bank/card, crypto, WhatsApp/Telegram interviews, ID-before-offer stop the run before anything is typed (government workflows exempt from the text check). |
| 25 | Origin gate | **Done in the safe form** — look-alike hosts (punycode, `taleo.net.evil.io`, plain http) stop the run. We do **not** block unknown-but-ordinary company domains (that would break custom career sites). |
| 26 | Email sender check | **Done** — for the first 25 s only mail from the site's own mailer domains is used; after that any sender (existing behaviour for odd mailers). No DMARC check: we don't store headers. |
| 27 | Secrets at rest | **Already true** (encrypted per-site secrets); added nothing. |
| — | Workday: add experience panels | **Done** (fixture-tested). Degree / field-of-study prompts still generic. |
| — | Workday: forgot-password recovery | **Done, not run on a live tenant** — only when mail is readable and sign-in fails with a password we generated. |
| — | Workday: required "Select One" on My Information | **Fixed at the rule level** — phone device type → Mobile, country phone code → profile country (the most likely cause of the 4 rejected "My Information" runs). |
| — | Form preview in the app | **Done** — "What applying asks" card in the job drawer (hidden until we've seen the form once). |
| — | Provider readiness map | `docs/competitive/provider-readiness.md` |
