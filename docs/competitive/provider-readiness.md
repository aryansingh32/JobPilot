# Job provider readiness — what the reference repos do per ATS vs what JobPilot has

_2026-10-25. Sources: the six repos in `refrence_code/` (code only), our `backend/workflows/jobs/*.json`, `backend/tools/mock-ats/`, and the application history in the dev database (`jobpilot-dev-pg`, table `applications`, grouped by host)._

**How to read "ready":** a provider is **Ready** only with real confirmed submissions on real sites. Mock-ATS passes show the flow works, not that real tenants accept it. The dev history mixes older code and test runs, so treat the counts as a signal, not a pass rate.

## 1. Verdict table

| Provider | Detected by | Our workflow | Mock / fixture tests | Real runs (dev history) | Reference depth | Verdict |
|---|---|---|---|---|---|---|
| **Greenhouse** | `greenhouse.io`, `grnh.se`, embed iframe, `gh_jid` | `greenhouse-apply` (autofill→review→submit) | browser fixtures (iframe, react-select-like) | 2 submitted · 8 failed · 8 cancelled · 3 needs_input | job-agent 1,100 lines, job-pilot 933, AutoApply, applypilot | **Usable — best-proven.** Failures were "never confirmed" (4), location checkboxes, no form. Iframe + dropdown work now added. Needs: emailed security-code path re-verified after the change. |
| **Ashby** | `ashbyhq.com` | `ashby-apply` | — | 1 submitted · 2 failed · 1 awaiting_review | job-agent 312 lines (UUID-id labels, Turnstile), job-pilot 642 | **Usable, thin evidence.** One failure was an unanswered "5 days in person" yes/no; now covered by `defaultYesNo`/`onsite_ok` intent only when a default exists — still asks otherwise. |
| **Lever** | `lever.co` | `lever-apply` | — | 0 submitted · 10 failed · 8 cancelled | job-agent 247, job-pilot 227 | **Not proven.** Most failures are the résumé upload ("larger than this site accepts" / "100MB" notice). Needs a real run after checking the résumé file size path; the hidden decoy submit button is already handled (we pick `#btn-submit` first). |
| **Workday** | `myworkdayjobs.com`, `wd*` | `workday-apply` (openApplication→siteAccount→fillWizard) | `mock-ats/workday.mjs` + new fixtures | **0 submitted** · ~36 failed (slow site 11, "Invalid Username/Password" 8, circuit breaker 3, My Information rejected 4) | Workday_Auto (60k lines), job-agent 1,354, job-pilot 1,958 | **Not ready on real tenants.** Fixes landed this session (phone device type/country code rules, history panels, prompts, date widgets, forgot-password recovery) — none yet run on a live tenant. |
| **SmartRecruiters** | `smartrecruiters.com` | `smartrecruiters-apply` | — | 0 submitted · 3 failed (no form found) | Auto-Fill-Forms notes only (guest apply, one page, collapsible sections) | **Not proven.** "No form found" ×3 suggests the form lives behind an Apply click or collapsed sections. |
| **Oracle Recruiting Cloud** | `oraclecloud.com` + `/CandidateExperience/` | `oracle-apply` (emailed-code sign-in) | `mock-ats/oracle.mjs` | 0 submitted · 3 failed (terms checkbox on sign-in; control timeout) | Auto-Fill-Forms notes | **Not ready.** Sign-in terms checkbox rejected on real tenant. |
| **SAP SuccessFactors** | `successfactors.*`, `sapsf.*` | `successfactors-apply` | `mock-ats/successfactors.mjs` | none | Auto-Fill-Forms notes (account wall, consent screens) | **Mock-only.** |
| **Keka** | `keka.com` | `keka-apply` | — | 3 cancelled | none | **Untested.** |
| **Zoho Recruit** | `zohorecruit.*` | `zoho-apply` | `mock-ats/zoho.mjs` | none | none (Zoho label quirks are ours) | **Mock-only.** |
| **Freshteam** | `freshteam.com` | `freshteam-apply` | `mock-ats/freshteam.mjs` | none | none | **Mock-only.** |
| **Workable** | `apply.workable.com` | `workable-apply` | — | none | Auto-Fill-Forms notes (import résumé, phone widget) | **Untested.** |
| **Recruitee** | `recruitee.com` | `recruitee-apply` | — | none | notes only | **Untested.** |
| **iCIMS** | `*.icims.com` (usually an iframe) | _none_ → generic | iframe support now exists | none | job-agent 245 (guest apply, `applicant.*` names), Auto-Fill-Forms (account wall, session timeouts) | **Gap — no dedicated workflow.** Iframe scan now works; account/guest path missing. |
| **Taleo** | `taleo.net` | _none_ | — | none | Auto-Fill-Forms only (account wall, Source Type dropdown, eSignature) | **Gap.** |
| **Personio / Teamtailor / BambooHR / Breezy / Jobvite / Comeet** | host suffixes | _generic_ | — | none | Auto-Fill-Forms notes | **Generic only.** Safe-origin list now recognises them. |
| **LinkedIn Easy Apply / Indeed / Bayt / Wellfound** | — | not supported by policy | — | — | job-agent (LinkedIn session), others fill-only | **Intentionally out** (personal accounts, ban risk). |
| **Custom-domain career sites** | none | `generic-apply` | — | 1 submitted (mastercontrol.com), 1 needs_input | job-agent GenericFormFiller | Works for simple forms. |

## 2. Field mapping from the reference repos

Every provider shares one canonical set of questions. These are the field names/ids the repos actually target, next to what we use.

### Greenhouse (job-agent `greenhouse.py`, job-pilot, Auto-Fill-Forms)
- Standard: `#first_name`, `#last_name`, `#email`, `#phone`, `#resume`/`#cover_letter` file inputs; v2 boards use `input[role=combobox]` (react-select) for country/location and `fieldset` radio groups.
- Location is a typeahead: type the city, pick the suggestion (job-pilot keeps `city_typeahead_type` vs `city_typeahead_pick`). **Ours:** `fillField` combobox path + the city/state/country joined value.
- Custom questions are matched by label regex → profile answer (`_CUSTOM_Q_MAP`): work authorization, sponsorship, veteran, disability, relocate, graduation date, years of experience, how-did-you-hear, onsite days, 18+, "worked here before" → No, SMS consent → Yes, terms → Yes, gender, country, sanctioned-country citizenship → No. **Ours:** `RULES` + intents (`classifyIntent`) + `defaultYesNo`. Same coverage; ours adds the sensitive-intent gate.
- Emailed security code after submit (`#security-input-0..7`), read via IMAP in job-agent. **Ours:** `enterEmailedSecurityCode` + inbox/Gmail.
- Embed fallback: `boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` — **ours:** already in `autofillForm`, plus iframe scanning now.

### Lever
- Fields: `name` (single full-name), `email`, `phone`, `org` (current company), `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `location`, `comments` (cover letter), `.application-question` blocks with select/radio/text; hidden decoy submit before the real `#btn-submit`.
- **Ours:** Lever location typeahead special-case, `#btn-submit` first in submit tiers, parser-notice filtering. Gap: résumé upload failure handling (see verdict).

### Ashby
- Fields: `_systemfield_name`, `_systemfield_email`, UUID-id custom questions found through `label[for=<uuid>]`, yes/no button toggles, location typeahead, Turnstile checkbox. **Ours:** `scanForm` handles UUID labels and button toggles; Turnstile via captcha tier.

### Workday (Workday_Auto `workdayAdapter`, job-agent `workday.py`)
| Area | Selectors / ids | Ours |
|---|---|---|
| Start | `adventureButton`, `applyManually`, `autofillWithResume`, `useMyLastApplication` | `openApplication` buttons (workflow) ✔ |
| Account | `email`, `password`, `verifyPassword`, `createAccountCheckbox`, `createAccountSubmitButton`, `signInSubmitButton`, `SignInWithEmailButton`, `forgotPasswordLink`, `click_filter` overlay | `siteAccount` ✔ + **forgot-password recovery (new, untested live)** |
| Steps | `progressBarActiveStep`, `bottom-navigation-next-button`, `pageFooterNextButton`, `bottom-navigation-save-button` | `fillWizard` ✔ |
| My Information | country/state `button[aria-haspopup=listbox]`, `phone-device-type`, `countryPhoneCode`, `legalNameSection_*`, `addressSection_*`, `multiselectInputContainer`/`searchBox` ("How did you hear") | listbox support ✔, **device-type + country-code rules (new)**, **prompt filler (new)** |
| My Experience | `workExperience-N--jobTitle/companyName/location/roleDescription/startDate-dateSection{Month,Year}-input/currentlyWorkHere`, `education-N--school/degree/fieldOfStudy/gradeAverage/firstYearAttended`, `panel-set-delete-button`, `add-button`, `file-upload-input-ref` | **panel repair + add + phantom delete (new)**; degree/field-of-study prompts still generic |
| Questions | listbox buttons (virtualised), radios, text, `aria-invalid` repair, `errorMessage` text | virtualised walk ✔ (new), repair-before-ask ✔ (new) |
| Disclosures | `dateSection{Month,Day,Year}-input` (signature = today), CC-305 "No, I do not have…" checkbox, agreement checkboxes | **split date field + signature date (new)**; CC-305 box relies on the consent path |
| Honeypot | `beecatcher`, `name=website` | skipped (new) |
| Review/submit | final button text "Submit", confirmation text/URL | ✔ |

### SmartRecruiters / Workable / Recruitee / Personio / Teamtailor (Auto-Fill-Forms notes only)
- One page, guest apply, résumé import first, then correct from profile; Workable phone = country flag widget then national number (**ours:** `splitPhone` ✔); Personio often German labels (**gap:** non-English label map); Teamtailor "Connect" is not an application; skip social-login buttons.

### iCIMS (job-agent `icims.py`)
- Names: `applicant.firstName`, `applicant.lastName`, `applicant.email`, `applicant.cellPhone`; flow lives in an iframe; guest-apply link; per-company account on newer tenants; aggressive session timeouts. **Ours:** iframe now scanned; no workflow.

## 3. How the repos store questions, profiles and results (and what we adopted)

| Concept | job-agent | Workday_Auto | job-pilot | Auto-Fill-Forms | AutoApply / applypilot | JobPilot now |
|---|---|---|---|---|---|---|
| Applicant profile | `CANDIDATE_PROFILE` python dict (gitignored) | Supabase `clients` + API facts | markdown files + hardcoded fn | `profile.json` | backend profile router / extension storage | Postgres `profiles` JSONB, versioned ✔ |
| Question → answer | keyword→profile maps in code | Supabase QA bank (exact/fuzzy) + intents | markdown defaults | `answers.json`: `confirmed` literals vs conditional `rules` | answer vault (approved flag, similarity ≥0.58), learned mappings by domain | `answer_memory` keyed by **intent + country scope** (new) |
| Form structure | — | `job_form_schemas` per canonical URL | `form_inspector` JSON | — | — | `form_schemas` per posting (new) + preview endpoint & drawer card (new) |
| Outcomes | SQLite `applications` + strict statuses | status tables + screenshots in storage | Google Sheet | applications-log.md | dashboard | `applications` + events; **tri-state `submission`** (new) + receipt screenshot (new) + per-run LLM cost (admin) (new) |
| Credentials | plaintext JSON | per-client DB | — | plaintext `credentials.json` | — | encrypted secrets per site ✔ (keep) |
| Provenance | — | provenance gate, confidence floor | source tag per answer | rules/confirmed | `review_required` flags | source on every answer ✔ + **gate (new)** |

## 4. What to do next (provider order)
1. **Workday real-tenant dry runs (stop-before-submit)** on 3–5 tenants from the failure list (amcor, thehartford, micron, jj, generalmotors) — they are the highest-volume failures and the new code has only seen fixtures.
2. **Lever résumé path:** reproduce the "100MB" rejection with the actual user résumé (likely the upload not completing before submit).
3. **SmartRecruiters / Oracle:** record one successful run each with the Recorder, then compile.
4. **iCIMS & Taleo:** new workflows (guest/account, iframe) built on the existing `siteAccount` + `fillWizard` actions.
5. Add Personio/German label map; keep LinkedIn/Indeed out of scope.
