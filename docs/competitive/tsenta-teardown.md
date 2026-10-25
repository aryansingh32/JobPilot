# Tsenta Teardown — What a YC (S26) Auto‑Apply Agent Actually Does, and What JobPilot Should Steal

**Date:** 2026-10-20
**Method:** Live session in Chrome on a real logged-in Tsenta account (free tier), network/console/DOM capture of the dashboard, one real end-to-end application run (QAD · SmartRecruiters) stopped at the review gate, plus the public site, `llms.txt`/`llms-full.txt`, sitemap and SSR job pages.
**Confidence legend:** **[O]** = observed directly (network payload / UI / trace). **[I]** = inferred from observed evidence.

> No credentials were extracted and no private API endpoints were probed. Everything below comes from what the site's own front-end fetched during normal use of our own account.

---

## 0. TL;DR — the 10 things that matter

1. **The "50,000 career pages" are ATS boards, not arbitrary websites. [O]** Every job carries `atsType` + the original ATS URL (`*.myworkdayjobs.com`, `jobs.smartrecruiters.com/<Company>/`, `*.zohorecruit.in`, CSOD, etc.). They poll each company's board on ~40 known ATS platforms, then supplement with a 3rd-party feed (`source: "jobo"`) and user-connected boards (Indeed, Naukri). Index size on the public board: **8,222,283 jobs**.
2. **Every job is LLM-enriched into a rich, filterable schema. [O]** `roleFamily`, `seniorityLevel`, `skillTags`, `coreResponsibilities`, `jobSummary`, `sponsorship`, `citizenOnly`, `clearanceRequired`, `minimumDegreeRequired`, `yearsOfExperienceMin/Max`, `internTerms`, normalized salary, `canonicalRoleKey` (dedupe key) and `siblings` (multi-location grouping).
3. **Apply engine = per-ATS adapters, API-first, browser as fallback. [O]** The trace for our run says `ats: "smartrecruiters-api"`, pipeline `warmup → fetch → parse → config → resume → location → answer → submit|needs-review`, **28.6 s total**, with `datadome:failed` and `transport:fallback` events — i.e. they detect bot protection and switch transport.
4. **One canonical applicant profile is the "answer bank". [O]** Structured JSON with personal info, work authorization *per country*, EEO/DEI, background-check, work preferences, and a stored **"Workday password"** reused to auto-create accounts on Workday/iCIMS/Oracle.
5. **Every answer has provenance. [O]** Each filled field records `source: llm | profile | fallback`, `kind`, `required`, `options`, `display`. The review screen is rendered *from this trace*, not from a screenshot.
6. **Résumé tailoring is an agent that edits JSON, not prose. [O]** Mastra agent, model `DeepSeek-V4-Flash` via an OpenAI-compatible provider, tools `editListItems` / `appendListItems` on JSON paths like `workExperience.1.responsibilities`, with `characterLimits` so it stays one page. A "FABRICATION STANCE — HONEST" prompt block is injected. Output: "14 edits · tailored" + keyword coverage (15/17 = 88%).
7. **Every user gets a private email inbox. [O]** Applications are submitted with `<handle>@my-privatemail.com` (AWS SES inbound). OTPs/verification links are auto-consumed mid-application; recruiter mail is auto-classified (Verification / Rejection / Interview / Recruiter / Assessment / Reminder / Offer) and **matched back to the application** (`matchMethod: COMPANY_UNIQUE`, `matchConfidence: HIGH`), then forwarded to the personal address.
8. **Trust UX is the product. [O]** Diff before send, "Review before submit" pause (37 ATSes), locked vs editable fields, "Skip & use original resume", "I've Applied" manual fallback, receipts, "every change is previewed, approved by you, and undoable."
9. **Monetization = credits for *successful* submissions. [O]** 25 free lifetime; $19/600, $39/1,500, $99/4,500 per 30 days; failed/skipped refunded; ledger has `free` / `monthly` / `pack` buckets; background Auto Apply is **Power-only** (the upsell hook); referrals give **+200 apps to both** on paid conversion.
10. **Distribution everywhere + AI-search SEO. [O]** Web, iOS, Android, iMessage, WhatsApp, Chrome extension, **MCP server** (OAuth, `claude mcp add …`), ~90 programmatic "best X for Y 2026" blog posts, comparison pages, `llms.txt`, `llms-full.txt`, `ai.txt`, Markdown twins of pages, robots that explicitly welcome ~30 AI crawlers.

---

## 1. Positioning & Psychology

### Headline & framing **[O]**
- *"Be the first to apply to every job that fits you. Hands off."* — the core promise is **speed / first-mover advantage**, not "AI".
- Loss-aversion stat: *"Recruiters typically review the first 100 applications."* Animated scanner log (`scanning stripe.com/careers … +1 new`) + "applicants ahead of you: via tsenta 00h 00m vs LinkedIn & co." → manufactured urgency.
- Fake-but-plausible dashboard demo above the fold (Alex Morgan, 47 applications, statuses "Tailoring résumé… Reading job description…") — shows the *product working* before signup.
- Social proof: "Backed by Y Combinator" badge first; logo wall "Where Tsenta users have been hired"; in-app "We are now processing over 100k applications every 24 hours".
- Identity targeting in pricing copy: Pro is *"For the desperate, the laid-off, the OPT-clocked."* — speaks directly to anxious segments (layoffs, F‑1/OPT clocks). ~15 blog posts target OPT/F‑1/sponsorship.
- Objection handling in FAQ: "Will recruiters know?" (honest: not promised undetectable), "Why connect email?" (very explicit privacy story), "Pay only for jobs actually submitted".
- Reciprocity + low friction: "Free to start. No card required." / "Get the next 25 applications off your plate by tonight."
- Founder intimacy: "A real founder will reply" → founders@ email.

### Control/transparency as the antidote to "spray and pray" **[O]**
They sell volume but frame it as **controlled** volume: diff view, approve-before-send, receipts ("6 of 6 fields · 0 skipped · 0 generic answers"), honest vs aggressive résumé mode, undoable assistant actions. This defuses the main fear (an AI embarrassing me in front of employers).

### Upsell mechanics **[O]**
- Persistent "24 left" pill in top nav (scarcity counter).
- Auto Apply page: *"Tsenta could already be applying to 8 jobs you're an excellent match for."* — computes a personalized number of missed opportunities → "Upgrade to Power".
- Background auto-apply gated behind the most expensive plan; lower tiers are manual-trigger only.
- Free credit reserved **at click time** (25→24→23 visibly drops immediately).

---

## 2. Surfaces & Information Architecture **[O]**

| Surface | What it is |
|---|---|
| `tsenta.com` | Next.js (Turbopack) marketing site on Vercel; SSR public job board with `JobPosting` JSON-LD; first-party analytics beacon `/c.js` → `POST /api/c` (ad-blocker-proof), plus PostHog, GA4, Meta Pixel |
| `dashboard.tsenta.com` | SPA dashboard; logo proxy `/api/logo?domain=` + logo.dev; Sentry, PostHog (flags, surveys, dead-click & exception autocapture, web vitals), Intercom (JWT-verified user) |
| `api.tsenta.com/api/v1` | REST backend (legacy brand host `api.autojobs.me` still serves MCP) |
| Mobile | Native iOS/Android (`tsenta://` deep links, Smart App Banner meta) |
| Messaging | iMessage & WhatsApp numbers on `/start` — conversational onboarding + "reply yes to apply" |
| Chrome extension | Detects job forms on any page and fills them ("executionTarget" alternative to CLOUD) |
| MCP / CLI | `claude mcp add --transport http tsenta …/api/v1/mcp`; OAuth (Google) — tools: search, profile, apply, track |

### Dashboard navigation
`Dashboard · Browse jobs · Auto Apply · Tracker · Networking · Profile · Research · Settings · [N left]` + a **persistent left-docked AI chat panel** on every page with context-aware starter prompts (Dashboard: "Why are my recommendations off? / Apply to my top matches / Where are my applications?"; Profile: "Improve this resume / Tailor it for a role"; Networking: "Who should I contact next?").

### Pages
- **Dashboard:** search (AI-matching vs keyword "Title + description" scope), Exclude box ("Hide jobs mentioning…"), filter chips (Date, Location, Workplace, Companies, Degree, Max Experience, Sponsors Visa, Role, Job Type, Employment Type), plan banner, *Top job matches* carousel with circular match % rings + **Pass / Apply** per card + **"Apply to all 5"**, *All applications* table with tabs **All / Submitted / In flight / Needs you / Failed / Skipped**, **Approve all**.
- **Browse jobs:** same filters, "Add Your Own Link" card (paste any URL + optional JD), "Quick Apply — any supported job board", "Jobs look off? Ask the feed assistant", Saved list, **6-step guided tour** (react-joyride style).
- **Job details drawer:** type chips, Internship terms, **Student Eligibility (graduation window)**, Education requirement, View original posting, Not interested, Save, Apply.
- **Auto Apply:** "Lanes" (up to 5 role profiles each with own filters/threshold/instructions/review flag), **shared daily cap** (10/day default, best matches first), match threshold (75), its own chat agent ("See what Auto Apply would do for you"), run history (`auto-apply-runs`).
- **Tracker = Inbox:** pipeline view + categorized email (see §6), Compose, Mark all read.
- **Networking:** per-applied-company card (ticker, size, HQ, industry tags), "Build outreach bundle" → top 3 contacts, verified email status, email drafts, LinkedIn notes; **10 lookups/day**; live company news feed.
- **Profile:** multiple **resume profiles** (`Default` + "Add Profile"), Resume / Cover Letter / Profile Details tabs, WYSIWYG renderer with templates **Standard / Jake** (Jake's Résumé LaTeX look), fonts, size, align, **Fit to one page**, Reorder sections, Download (PDF/DOCX).
- **Research:** long-form editorial ("The biggest ATS myths", "Read this if you are not getting interviews") — trust + retention content inside the app.
- **Settings:** Apply settings (Résumé optimization **Off / Honest / Aggressive**, Auto-approve, Review before submit), **What Tsenta remembers** (AI memory you can edit), Public portfolio, **Workday password**, Job Boards (Indeed connect; Naukri behind flag), Plans & billing, Referrals, Email integrations (Gmail/Outlook OAuth; daily 9 AM recommendation emails with timezone), AI assistants (Claude/ChatGPT connector setup), Account.

---

## 3. Backend Architecture (reconstructed)

```
                ┌──────────── Sources ────────────┐
 ~40 ATS board   │ Workday CXS, Greenhouse, Lever,  │   3rd-party feed ("jobo")
 pollers         │ Ashby, SmartRecruiters, iCIMS,   │   user boards (Indeed, Naukri)
                 │ SuccessFactors, CSOD, Oracle...  │   user-pasted URLs
                └───────────────┬──────────────────┘
                                ▼
           Normalize → LLM enrich (summary, skills, roleFamily, seniority,
           sponsorship, degree, YoE, intern terms) → canonicalRoleKey dedupe
           → embeddings (user.hasEmbeddings) → job_listings (8.2M rows)
                                ▼
      Recommender: embedding similarity + filters → matchScore (0–100)
                                ▼
  POST /applications ──► OPTIMIZING_RESUME (Mastra agent, JSON-path edits)
                         └► PENDING_RESUME_REVIEW (if auto-approve off)
  POST /applications/:id/approve ──► execution job (jobId, idempotent on URL)
                         └► worker: per-ATS adapter (API transport, browser fallback,
                            anti-bot detection) → answers (profile | llm | fallback)
                         └► PENDING_SUBMIT_REVIEW (if review-before-submit) → SUBMITTED
                         └► trace {meta, timeline, answers, reviewChallenge, derivedMissingFields}
                                ▼
  SES inbound mail ─► classify ─► match to application ─► status update ─► forward
  Realtime: AdonisJS Transmit SSE (/__transmit/subscribe) + client polling
```

### Stack fingerprints **[O]/[I]**
- **AdonisJS** (Node/TS) — `/__transmit/subscribe` is Adonis Transmit (SSE). [O endpoint → I framework]
- **Firebase Auth** — 28-char user UIDs in every `/users/:uid/*` route. [I]
- **Prisma-style cuid** ids for profiles/messages; **UUID** for jobs/applications. [O]
- **Mastra** agent framework, threads keyed `resume-<applicationId>-optimize`, `resourceId=<uid>`, message `parts` with `tool-*` calls; provider `openai.chat` with `DeepSeek-V4-Flash`. [O]
- **AWS SES** inbound for per-user mailboxes. [O `source: "SES"`]
- Response envelope inconsistency (`{message,data}` vs `{success,data}` vs bare) → several teams/iterations. [O]

### Key API surface seen (front-end usage only)
```
GET  /dashboard/bootstrap                 GET /jobs/recommendations?limit&page&datePosted&locations&autoApplyOnly
GET  /jobs/recommendations/sources        GET /jobboard/jobs/:id
GET  /applications/list?filter=all|needs  GET /applications/list/counts   GET /applications/count
GET  /applications/rate-limit  (credit ledger: free/monthly/pack/total/isAdminBypass)
POST /applications  → {applicationId, status: OPTIMIZING_RESUME}
GET  /applications/:id  /detail  /trace  /optimized-resume  /resume-download-url  /cover-letter-data
POST /applications/:id/approve → {jobId, url, isExisting}
GET/PUT /users/:uid/apply-preferences    GET /users/:uid/auto-apply-config  /auto-apply-runs
GET  /users/:uid/profile  /resume-profiles  /feed-filters  /public-profile  /referral  /referral-context
GET  /ai/assistant-chat/threads  /ai/auto-apply-chat/threads  /ai/resume-chat/history
GET  /inbox/messages  /inbox/settings  /inbox/unread-count     GET /email/connections
GET  /networking/applications  /networking/applications/:id/contacts  /networking/companies/news  /networking/usage
GET  /naukri/status  /indeed/status  /workday/password/status  /subscription/current  /subscription/plans
GET  /saved-jobs/ids
```

---

## 4. Where the 50k career pages come from

**[O]** Sampled 45 public job pages: `atsType` ∈ {csod, zohorecruit, talentreef, rippling, personio, jazzhr, breezyhr, workday, greenhouse, ashby, icims, successfactors, oraclecloud, smartrecruiters, workable, join, dover, paylocity…}. Every job keeps its source URL. In-app `source` is `ats-boards` or `jobo`.

**How it works [I, standard industry technique]:** each ATS exposes per-company boards with predictable URLs and usually a public JSON endpoint — Greenhouse `boards-api.greenhouse.io/v1/boards/{co}/jobs`, Lever `api.lever.co/v0/postings/{co}`, Ashby `api.ashbyhq.com/posting-api/job-board/{co}`, SmartRecruiters `api.smartrecruiters.com/v1/companies/{co}/postings`, Workday `{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`, etc. You build a **company → (ATS, board slug)** registry (seeded from Common Crawl / search / sitemaps / user-pasted URLs — every URL a user pastes grows the registry), then poll each board on a schedule, diff by job id, and enrich new jobs. "50,000 pages" = 50k company boards.

**Data-quality bugs we saw [O]** (their weak spot, our opportunity):
- `datePosted` in the future (2027, 2028, even 2035) → "Posted -535 days ago" and those jobs pinned at the top as "Just now". They appear to store close/expiry date as posted date for some ATSes (CSOD/Zoho).
- Title parsing leak: "Software Engineer Intern **Location Bangalore… Department… Date Oct 19, 2026**".
- `addressCountry: "US"` on Indian jobs in JSON-LD.
- Match score (75%) ignored a hard eligibility constraint (graduation window 2026 vs user 2027).

---

## 5. The Apply Engine (from a real run)

**Job:** QAD · Software / Full Stack Engineer · SmartRecruiters.

| t | phase | notes |
|---|---|---|
| 0 s | click Apply | credit reserved instantly (24→23); `POST /applications` → `OPTIMIZING_RESUME`; route `/dashboard/applications/:id?firstRun=1` |
| ~10 s | `PENDING_RESUME_REVIEW` | 14 edits, keyword coverage 15/17 (88%) — required vs preferred keywords, ✓/✗ |
| click Approve & submit | `POST /approve` → execution `jobId` | UI: "Preparing your application → Reading the application form… → Filling in your details…" + "We'll pause for you to review before anything is submitted." |
| 0.0 s | `warmup:start` | |
| 1.0 s | `datadome:failed`, `warmup:done`, `fetch:done` | anti-bot probe, then fetch the job/form |
| 1.4 s | `parse:done` | form schema extracted |
| 7.7 s | `config:done` | |
| 7.7–12.3 s | `resume:start/done` | upload tailored PDF |
| 12.3–13.1 s | `location:*` | location typeahead resolution |
| 13.1–28.6 s | `answer:*` | LLM answers screening questions |
| 28.6 s | `submit:needs-review`, `transport:fallback` | paused at `PENDING_SUBMIT_REVIEW` |

**Review screen [O]:** 47 fields grouped by section (Personal Information 5 fields, Work Experience 21, Education 18…), kinds `text / textarea / date / boolean / single_select / email / phone / file`. Profile-backed fields **locked** ("Edit in your profile"), everything else editable inline. Buttons: **Cancel application / Submit application**. Left rail: "Review before submit — Waiting for your approval".

**Answer provenance [O]:**
```
llm      single_select  req  "What is your current work location status for Pune?" → "outside Pune but willing to relocate immediately"
fallback text           req  "Which AI-native development tools do you actively use…" → "None"
llm      textarea       req  "What is your current salary? Fixed/Variable" → 1500000   ← fabricated for a student
llm      text           req  "What is your Expected Salary?" → 1500000                ← fabricated
llm      single_select  req  "What is your notice period?" → "Immediately Available"
```
**Lesson:** even a polished YC product hallucinates compensation. The review gate is what saves it — and their *default* is auto-submit with no review. JobPilot should **never let an LLM invent numeric/legal/identity answers**; those must come from the profile or block as "Needs you".

**Submission phase (after "Submit application") [O]:** `POST /applications/:id/resume-submit` → `{status: RUNNING}`; UI "Submitting your application… usually under a minute · You can leave this page, we'll finish in the background". Final trace `outcome: submitted`, 37.1 s:

```
0.0 warmup:start → 1.2 datadome:failed → 1.2 fetch/parse → 9.1 config → 9.1–11.4 resume
→ 11.4–12.3 location → 12.3–22.2 answer → 22.2 review:resume → 35.6 submit:start
→ 37.1 submit:outcome → transport:fallback          (status COMPLETED ~1m50s after click)
```
- **The worker re-runs the entire pipeline on resume and regenerates LLM answers.** Reviewed salary 1500000/1500000 → *submitted* 1600000/1800000. Only the field the user edited survived (and it was relabeled `source: llm`). **"What you reviewed" ≠ "what was sent."** → JobPilot must commit the reviewed payload verbatim (hash it; submit exactly that; diff on any drift).
- Answer sources in final trace: `llm` for screening questions, `profile-direct` for work/education repeaters.
- **Receipt page:** status pill "Submitted", tabs **Form / Resume / Cover / Job**, the exact form values, linked emails ("RECEIVED · Thank you for applying to QAD" arrived in the alias inbox and auto-linked within ~1 min), and an upsell card "Reach out at QAD — find the person most relevant to this application and draft a short note".

### 5b. Second run — Workday (Accenture · Custom Software Engineer) [O]

- Clicking **Apply** on the card left the button in a spinner indefinitely and never navigated; the ledger had already debited (22 left) while the nav pill still said 23. The application only appeared in the table as **Needs you · Review** with an inline **Approve** button. → *Optimistic UI without reconciliation; credit pill not invalidated.*
- New review surface (v2): **"Excellent match · 16 of 17 keywords covered"**, keyword chips, a "WHAT I CHANGED" list ("Rewrote 5 bullets to lead with impact", "Updated 6 skills to cover the role"), suggestion chips ("Weave in the missing keywords I genuinely have", "Make the summary punchier", "Fit it to one page"), **hover a highlight on the résumé to see why it changed**, and a **Prev / 1 of 3 / Next** triage bar across pending applications with arrow-key navigation + coach mark.
- **"Honest" mode still fabricated skills.** The agent added Angular, Vue.js, RAG, GraphQL APIs, "AgentAI tools", "Enterprise SDLC" to the skills section — none present in the master profile — and described them as "genuinely supported". The 16/17 "Excellent match" is inflated by its own additions. We stopped this run before submit rather than send invented skills.
- **Lesson for us:** guardrails in a prompt are not guardrails. Enforce them in code: any token added to a skills/claims field must exist in the source profile (or be user-confirmed), else it's rejected and surfaced as "Suggest adding X? (you'll confirm)".

### 5c. MCP/OAuth surface (public metadata, read-only) [O]

`GET /` → `{"hello":"world"}` (AdonisJS starter route, confirms framework) · `/health` → ok · `/.well-known/oauth-authorization-server` → authorize/token/**register** (dynamic client registration)/revoke, `code` flow, **PKCE S256**, `token_endpoint_auth_methods: none` (public clients) · `/.well-known/oauth-protected-resource` → resource `…/api/v1/mcp` · `/api/v1/mcp` without token → 401 with `WWW-Authenticate: Bearer resource_metadata=…`. This is the exact spec set Claude/ChatGPT connectors need — copy it verbatim for our MCP endpoint.

**Answer-source hierarchy (what we should implement):** `profile (exact) → profile (derived, deterministic) → memory (user-confirmed past answers) → LLM (only for open-ended/soft) → fallback → NEEDS_USER`. Each tagged with source + confidence and surfaced in review.

---

## 6. Email Layer (their real moat for status tracking)

**[O]** `inbox/settings`: `inboxAddress`, `inboxLocalPart`, `forwardTo`, `applicationEmailMode: PERSONAL` (alt: Tsenta alias). Messages: `category` (GENERAL, VERIFICATION, REJECTION, INTERVIEW, RECRUITER, ASSESSMENT, REMINDER, OFFER, APPLIED), `direction`, `source: SES`, `threadId`, `applicationId`, `matchMethod: COMPANY_UNIQUE`, `matchConfidence: HIGH`.

Why it matters:
1. **OTP/verification links mid-application** are handled without the user (Workday account creation, iCIMS email verification).
2. **Status moves on its own** — rejections/interviews update the tracker.
3. Optional Gmail/Outlook OAuth with 30-day backfill + AI job-email filter for users who insist on their own address; drafts replies into the user's *own* drafts folder (never sends).

---

## 7. Résumé System

- **Structured profile is the source of truth**; PDF is a render (templates Standard/Jake, font/size/align, fit-to-one-page, section order, hidden sections/links). DOCX projection flags exist (`hasDocx`, `docxProjectionEnabled`).
- **Per-application snapshot** (`optimizedProfile`) so tailoring never mutates the master.
- **Agent prompt anatomy [O]:** role title → "autonomous tailoring pass in ONE response" → fabrication stance (HONEST: "reframe … aggressively … do NOT invent tools, skills, employers") → standing preferences → "end with ONE short question … about something you don't already know" → answers feed **"What Tsenta remembers"** memory. This is a slick preference-learning loop.
- Tools: `editListItems(path, items{idx:text}, characterLimits)`, `appendListItems(path, items)`.
- Post-tailor chat: "Ask me to change anything…" on the same thread; `resumeRedoCount`, `redoEnabled`, `supportsInstructions` flags.

---

## 8. Growth & SEO Engine **[O]**

- Sitemap: ~90 `/blog/*-2026` long-tail posts ("best auto apply tools for OPT students", "does mass applying hurt your chances"), 6 competitor comparison pages, programmatic `/jobs/{slug-uuid}` pages with `JobPosting` schema (Google for Jobs eligible), hubs `/jobs/remote|internships|entry-level`, `/international`, `/auto-apply`, `/ai-agent`.
- **AEO/GEO:** `llms.txt`, `llms-full.txt`, `ai.txt` (Allow-Training: yes), `.md` twins of key pages, robots explicitly allowing GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc. Goal: be the answer when someone asks an AI "what's the best auto-apply tool?".
- Ad-blocker-resistant first-party analytics (`/c.js` → `/api/c`), Meta pixel, GA4, PostHog session features, Intercom.
- Changelog page + in-app bell ("We ship improvements almost every day").
- Referral: +25 free for invitee, +200 each on paid conversion; custom codes; share to X/LinkedIn.

---

## 9. Weaknesses we observed (attack surface for JobPilot)

1. **Hallucinated salary answers** on required fields (§5) — and **the reviewed values are not what gets submitted** (answers regenerated on resume).
2. **Bad date normalization** → future-dated "Just now" jobs polluting the feed.
3. **Eligibility not in the match score** (graduation window, location/relocation, YoE).
4. **US-centric defaults** — EEO/OPT/H-1B everywhere, timezone list ET/CT/MT/PT, `addressCountry: US` on Indian jobs; India support (Naukri) still flagged `available:false`. **India is under-served.**
5. **Recommendations dominated by low-quality feed** on the public board (CSOD/Zoho noise).
6. Several analytics endpoints failing (PostHog 503s) — noisy client.
7. Profile data quality isn't validated (e.g. a clearance flag set to `true` that probably shouldn't be — answers inherit it silently).

---

## 10. What JobPilot should do — mapped to our codebase

> Context: JobPilot is a **general-purpose** chat-driven web agent (`backend/packages/*`). The gov-portal JSON files in `backend/workflows/*` are test fixtures only. Tsenta is the best public reference for how a "do-it-for-me" agent earns trust at volume; everything below is written to apply to *any* site/task.

### P0 — Architecture patterns to adopt now

| # | Tsenta pattern | JobPilot change | Where |
|---|---|---|---|
| 1 | **Run trace with phases + per-field provenance** (`timeline[]`, `answers[{fieldId,label,kind,source,required,display}]`, `derivedMissingFields`) | Emit a structured trace from the executor for every run; persist to Postgres; expose `GET /runs/:id/trace` | `packages/execution-service/executor.ts`, `observability.service.ts` |
| 2 | **Review-before-submit gate rendered from the trace** (locked vs editable fields) | Before any irreversible step (`submit`, `payment`), pause with a typed `reviewChallenge` payload instead of a free-text pause; UI renders a form | `executor.ts` pause logic, `chat-orchestrator.ts`, chat UI |
| 2b | **Do better than Tsenta: reviewed payload is immutable** | On resume, skip re-planning; submit the exact approved values (store `reviewedPayloadHash`, refuse to submit on drift) | `executor.ts` resume path, `session-manager.ts` |
| 3 | **Explicit state machine** (`OPTIMIZING → PENDING_REVIEW → RUNNING → PENDING_SUBMIT_REVIEW → SUBMITTED / NEEDS_YOU / FAILED / SKIPPED`) | Replace ad-hoc job statuses with an enum + transitions table; UI tabs = states | `shared/types`, `shared/db`, `worker.ts` |
| 4 | **Answer-source hierarchy; LLM never invents numbers/IDs/legal facts** | Field classifier: `identity/numeric/legal → profile only, else NEEDS_USER`; LLM only for free-text | `llm-generalizer.ts`, `ai-service/planner.ts` |
| 5 | **Canonical user profile = answer bank** (versioned, per-application snapshot) | Promote `user-memory.service.ts` into a typed profile (identity, address, IDs refs, family, education, documents) + snapshot per run | `api-service/user-memory.service.ts`, `user-file-store.ts` |
| 6 | **API-first transport, browser fallback, anti-bot detection event** | Per-site adapter interface `{transport: 'api' | 'http-form' | 'browser'}`; detect captcha/WAF and record `*:failed → transport:fallback` | `executor.ts`, `captcha/detector.ts`, `browser-pool.ts` |
| 7 | **Credit reserved at start, refunded on fail/skip; ledger buckets** | `credits` table with `reserve/commit/refund`; show "N left" pill | new `billing` module, `server.ts` |
| 8 | **Idempotent run creation** (`isExisting`) | Hash(user, workflow, target, inputs) → dedupe concurrent duplicates | `worker.ts`, queue |

### P1 — Product features

9. **Per-user inbox / OTP capture.** For gov portals, OTP arrives by SMS — add an Android SMS-forwarder companion or ask-user OTP card with countdown; for email OTPs (DigiLocker, EPFO email flows) provision `user@<our-domain>` via SES/Cloudflare Email Routing and auto-read codes. Link messages back to runs (`matchMethod`, `matchConfidence`).
10. **Persistent context-aware assistant panel** with 3 starter prompts per page (we already have chat — make it page-aware).
11. **Memory you can see & edit** ("What JobPilot remembers") — trust + fewer repeated questions. Ask ONE learning question at the end of each run.
12. **Receipts**: after every run show "what was sent" (fields, files, reference numbers, confirmation screenshot), downloadable.
13. **Watch live or run headless + replay** — we already have `recorder.ts`; expose a corner live view (CDP screencast) and a replay link in the trace.
14. **"Add your own link"** — user pastes any portal URL → crawler + LLM generalizer drafts a workflow → admin/AI review → becomes reusable. This is how Tsenta grows its board registry; it's how we grow workflow coverage.
15. **Lanes + daily cap** pattern for anything recurring (status checks, re-tries, slot booking).

### P2 — Growth

16. `llms.txt`, `llms-full.txt`, `ai.txt`, `.md` page twins, robots allowing AI crawlers; programmatic SEO pages per service ("How to apply for PAN online 2026 — done for you").
17. **MCP server** (`/api/v1/mcp`, OAuth) exposing `list_services`, `start_run`, `get_status`, `provide_input` — let Claude/ChatGPT users drive JobPilot.
18. **WhatsApp channel** — in India this beats iMessage by far; "reply YES to proceed", OTP relay, receipts.
19. First-party analytics proxy, PostHog funnels, changelog page + in-app bell, referral (+N free runs both sides).
20. Pricing copy: pay per **successful** run, free first N, no card — remove risk.

### P3 — If we enter jobs (India-first wedge)

- Their India coverage is weak (Naukri flag off, US-centric fields, bad JSON-LD country). An India-first agent with Naukri/Instahyre/Foundit/Wellfound + Workday/SuccessFactors/Oracle (used by Indian MNCs) + correct INR/LPA/notice-period handling is a real gap.
- Copy their ATS registry approach: company→(ATS, slug) table, per-ATS poller, LLM enrichment with *validated* dates, eligibility-aware scoring (grad year, notice period, location, CTC).

---

## 10b. UI/UX Playbook for JobPilot (the priority)

What makes Tsenta *feel* trustworthy is not the bot, it's six UI primitives. Map each onto our chat UI (`chatflow-interface/src/components/chat/*`):

| # | Tsenta primitive | What it does for the user | JobPilot implementation |
|---|---|---|---|
| U1 | **Run workspace page** (`/applications/:id`): header with entity + status pill + "View original", left = agent/chat, right = artifact | One place per task; chat is context, artifact is truth | New route `routes/runs.$id.tsx`; reuse `LiveScreenPanel.tsx` on the right while running, swap to Review/Receipt when paused/done |
| U2 | **Narrated progress** ("Reading the application form… → Filling in your details…") + 4-dot stepper + "You can leave this page, we'll finish in the background" | Kills anxiety during 30–120 s waits; makes background execution legible | Drive `Timeline` in `MessageItem.tsx` from trace phases (not hard-coded steps); add the leave-page reassurance + notify on finish |
| U3 | **Review card rendered from the trace**: sections with field counts, locked (from profile) vs editable, required markers, provenance per field, single primary CTA "Submit" + quiet "Cancel" | Users approve *facts*, not screenshots | New `ReviewCard.tsx` message type (`type: "review"`) fed by `reviewChallenge` payload; badge each field `from profile · AI-written · needs you`; AI-written numeric fields shown in amber |
| U4 | **Diff + "why"**: "14 edits · tailored", hover a highlight to see the reason, "WHAT I CHANGED" list, suggestion chips, "Use original" escape hatch | Shows the agent's work without making users read everything | Generic `ChangeSet` component: list of `{path, before, after, reason}`; inline highlights; chips = follow-up prompts; always offer "use original / undo all" |
| U5 | **Receipt**: tabs Form / Files / Source, exact submitted values, linked follow-up emails, next-step upsell card | Proof + memory; the moment of delight | Extend `DownloadCard` into `ReceiptCard` (`type: "receipt"`): submitted fields, confirmation number/screenshot, replay link, "What next" card |
| U6 | **Inbox of runs with state tabs** (All / In flight / Needs you / Failed / Skipped) + bulk **Approve all** + **Prev/Next triage with arrow keys** | Turns many async tasks into a to-do list the user can clear in seconds | Sidebar section in `ChatSidebar.tsx` with counts per state; "Needs you" badge; keyboard triage view |

Supporting patterns:
- **Context-aware assistant dock** on every page with 3 starter prompts tuned to that page (we have a single chat; add page-specific suggestions in `Composer.tsx`).
- **Scarcity/usage pill** ("22 left") always visible — and *invalidate it on every mutating call* (Tsenta's is stale).
- **Settings as plain-language toggles with live preview illustration** (their Apply settings page shows a mini animated card for each mode). Use for our "Ask before submitting / Auto-run / Review only risky fields".
- **Editable memory page** ("What JobPilot remembers") + one learning question at the end of each run.
- **Coach marks** only at first use of each surface (tour 1/6, "Flip between applications… Got it").
- **Optimistic UI must reconcile**: never leave a button spinning — after N s show "Still working — it's in your Runs" and route there (Tsenta's Workday click hung).

Do-better-than-Tsenta rules (they fail these, we shouldn't):
1. **Approved payload is immutable** — what the user saw is what's sent.
2. **No invented facts** — numeric, legal, identity and skills fields are profile-only or "Needs you"; enforced in code, not prompt.
3. **Match/confidence scores exclude the agent's own additions**.
4. **Dates and locations validated** before display (no "-535 days ago").

## 11. Suggested ticket order

0. UI primitives U1–U6 (§10b) — start with U3 Review card + U5 Receipt on top of the trace
1. Trace schema + persist + `/trace` endpoint (P0-1)
2. Run state machine + UI tabs (P0-3)
3. Typed review gate before irreversible steps (P0-2)
4. Answer-source policy + "Needs you" (P0-4)
5. Canonical profile + per-run snapshot (P0-5)
6. Credit ledger reserve/refund (P0-7)
7. Receipts + replay link (P1-12/13)
8. Editable memory + one-question learning loop (P1-11)
9. WhatsApp channel + OTP relay (P1-9, P2-18)
10. AEO files + MCP server (P2-16/17)
