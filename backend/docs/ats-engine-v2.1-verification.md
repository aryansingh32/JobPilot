# JobPilot ATS Engine V2.1 — Verification Report

**Reviewed:** 2026-11-13  
**Recommendation:** **NO-GO for production canary**

## Scope and evidence

Reviewed the six TypeScript provider adapters, the API client and resolver, `startApplication`, application state tests, the credit ledger, auth/OTP implementation, and provider documentation linked below. Local checks were run against mocks/unit tests and static source. The live-submission script was inspected but deliberately not run: it deletes application records, uses a hardcoded candidate account, targets real public vacancies, and sets `dryRun: true`. It therefore cannot prove a real ATS submission and is unsafe as a live test harness.

No provider-specific test credentials, authorized test tenant/posting IDs, or provider-side verification credentials were found among the checked `backend/.env` key names. No application POST, resume upload, or credit settlement against an ATS was performed. Consequently there are no provider response IDs, employer-side records, or genuine timing measurements in this report. A provider ID in an HTTP response alone would still not constitute independent employer-side verification.

## Provider matrix

| Provider | Documented endpoint | Actual endpoint | Auth | Real submission | Independent verification |
|---|---|---|---|---|---|
| Greenhouse | `POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}`; multipart form | Same documented URL after this review's change. The adapter previously also tried `boards.greenhouse.io/...`, a browser surface. | `AUTHORIZATION_REQUIRED` — Greenhouse requires Basic Auth with the employer's Job Board API key; adapter sends no Authorization header. [Official docs](https://docs.greenhouse.io/job-board.html) | `DOCUMENTED_BUT_NOT_TESTED` | `UNSUPPORTED` |
| Lever | `POST https://api.lever.co/v0/postings/{site}/{posting-id}?key={API_KEY}`; JSON or multipart | Same path, but omits `key`; multipart body, browser-like headers. | `AUTHORIZATION_REQUIRED` — employer Super Admin must generate the Postings API key. Custom questions are not exposed by the documented public API. [Official docs](https://github.com/lever/postings-api) | `DOCUMENTED_BUT_NOT_TESTED` | `UNSUPPORTED` |
| Ashby | `POST https://api.ashbyhq.com/applicationForm.submit`; JSON or documented multipart | `POST https://jobs.ashbyhq.com/{company}/{jobId}/application`, with flattened multipart fields. This is not the documented submit endpoint. | `AUTHORIZATION_REQUIRED` — documented endpoint requires `candidatesWrite` permission and Basic credentials. [Submit reference](https://developers.ashbyhq.com/reference/applicationformsubmit), [custom careers guide](https://developers.ashbyhq.com/docs/creating-a-custom-careers-page) | `UNDOCUMENTED_ENDPOINT` | `UNSUPPORTED` |
| SmartRecruiters | `POST https://api.smartrecruiters.com/postings/{posting-uuid}/candidates`; JSON | `POST https://api.smartrecruiters.com/v1/companies/{company}/postings/{posting}/candidates`; wrong route shape; company slug is used where documented API requires Posting UUID. | `AUTHORIZATION_REQUIRED` — API key or OAuth; OAuth requires `candidate_applications_manage`. The adapter sends no auth header. [Official apply docs](https://developers.smartrecruiters.com/docs/partners-post-an-application) | `UNSUPPORTED` | `UNSUPPORTED` |
| Workable | No documented public candidate-facing application POST found in Workable's developer API materials. | `POST https://apply.workable.com/api/v3/accounts/{subdomain}/jobs/{shortcode}/candidates`; undocumented web-app endpoint; JSON payload. | `UNSUPPORTED` — official developer API access is account/partner integration access; this adapter has no documented authorization or contract for this endpoint. [Developer API](https://www.workable.com/developers/) | `UNDOCUMENTED_ENDPOINT` | `UNSUPPORTED` |
| Recruitee | Careers Site API: `POST https://{company}.recruitee.com/api/offers/{offer_slug}/candidates` | Same host/path family; multipart form; adapter extracts an offer identifier but does not supply the required careers-site token. | `AUTHORIZATION_REQUIRED` — `X-Careers-Sites-Token` is required; official docs state calls without it will return 401 starting 2027-02-10. [Official auth docs](https://docs.recruitee.com/reference/authentication-1), [API intro](https://docs.recruitee.com/reference/intro-to-careers-site-api) | `DOCUMENTED_BUT_NOT_TESTED` | `UNSUPPORTED` |

Labels describe the current evidence. `DOCUMENTED_BUT_NOT_TESTED` means an official apply endpoint exists, not that this adapter is production-ready. None has a real submission plus independent employer-side verification.

## Implementation differences and submission readiness

- **Greenhouse:** public job/schema GET is documented; application POST requires the employer's secret API key. The adapter omitted auth, tried an undocumented first URL, and treated 200/201 as success. It previously manufactured a reference from board/job IDs. The undocumented fallback and generated reference were removed; its remaining POST path still cannot work as an authorized integration until credentials and provider response verification are implemented.
- **Lever:** the application route is documented, but its `key` query parameter is missing. The official docs warn about rate limits and require handling 429s. The implementation neither queues/retries 429s nor respects the provider's per-account form configuration. Its public posting GET does not expose custom questions. It previously substituted a fabricated application ID when no ID came back.
- **Ashby:** the public job-board GET does not retrieve the actual application-form definition. The adapter builds a guessed static form and posts to a candidate-facing website route; documented submission uses `applicationForm.submit`, form `fieldSubmissions` keyed by returned paths, `candidatesWrite`, and upload handles or a specific multipart envelope. It previously generated an Ashby-looking ID for any 200/201/302 response.
- **SmartRecruiters:** the schema is hard-coded rather than fetched from the Application API configuration endpoint. The apply route, posting identifier, auth, consent payload, and screening answer format do not match the current docs. It also accepts 202 as success, which is only an acknowledgment. The response candidate ID is not independent verification.
- **Workable:** both schema and submit behavior are inferred from a private-looking `/api/v3` browser endpoint. No official public candidate-application endpoint was verified. A successful HTTP status from an undocumented endpoint cannot certify employer-side application creation.
- **Recruitee:** schema is hard-coded and the Careers Site API token is absent. The provider can return an application candidate ID, but the adapter has no credential path and does not independently retrieve the resulting application.

The API client also supplied placeholder candidate identity values, defaulted unknown sponsorship to `false`, and generated a valid-looking placeholder PDF when no resume existed. These behaviors were removed: missing core identity or resume data now returns `REQUIRES_USER_ACTION`, unknown sponsorship stays unanswered, and an absent resume is no longer replaced with a synthetic file. “Verified” is no longer inferred from a submit response or provider-generated ID, and fabricated confirmation IDs were removed from all six adapters. The central API client now reports provider recognition separately from live eligibility and refuses every live direct submission before profile access or network I/O; `startApplication` therefore continues through the existing browser workflow.

## Question resolver

The resolver previously guessed work authorization, sponsorship, protected veteran status, disability, criminal/background answers, employment history, conflict-of-interest answers, legal attestations, relocation, salary, years of experience, and free-text responses. It also filled EEO fields from defaults and could silently skip required questions with missing field metadata.

Changes made in this review:

- Sensitive legal, criminal, background, work-authorization, sponsorship, and demographic questions are not inferred from generic defaults or unrelated answer-bank matches.
- Work authorization and sponsorship require explicit profile facts; unknown values stay unanswered.
- Voluntary EEO questions use a provider's explicit decline option when present. Required unanswered EEO questions block submission.
- Empty values and required questions without field metadata block submission.
- Unprovided employment, salary, experience, address, and free-text facts no longer receive invented defaults.

**Remaining gap:** the shared answer type remains scalar and the adapters do not consistently retain provider question IDs, field IDs, option IDs, compound records, conditional questions, or multi-select arrays end to end. This resolver is safer, but compound and multi-select forms are not production-ready until each adapter models and validates its provider's exact schema.

## State, retries, credits, and concurrency

- Dry-run results are `simulated` and do not carry a confirmation reference. `startApplication` skips credit reservation for dry runs and deletes its temporary application row.
- Provider adapters previously called a submit acknowledgment `verified` when a response contained an ID; that inference is removed. The application record still uses its general `submitted` status for an accepted HTTP response and settles credits on that response, so the ledger does not establish employer-side verification.
- The legacy direct-API branch still refunds/deletes on errors and falls back to browser submission. It is unreachable through the central client while the fail-closed gate remains in place. If re-enabled before adding a durable unknown/pending state, a timeout after provider acceptance can cause a duplicate application or incorrect refund.
- Application duplicate checks and task locks exist, but timeout recovery and all concurrent transition cases were not exercised against a dedicated database/test account in this review.
- The credit ledger is append-only balance accounting (`SUM(delta)`), **not double-entry accounting**. Reservation and settlement use PostgreSQL transactions plus a per-user advisory lock. This review added an application-row lock/idempotency check so reserving the same application twice reuses its existing hold instead of appending a duplicate debit. No concurrent database integration test was run.
- Refund/commit settlement clears `applications.credits_reserved` under row lock, making settlement idempotent while the application row exists. Deleting an application preserves ledger rows with a nulled `application_id`; that weakens reconciliation. Application create, reserve, and queue are not one transaction.

## Account and data security audit

- OTP values use cryptographic random generation and Redis TTL. This review changed OTP issuance/cooldown and verification/consumption to atomic Redis Lua operations, preventing concurrent verification from consuming the same code or racing the attempt counter. Route-level IP/device rate limits were not found in the auth routes reviewed; identifier cooldown alone is insufficient abuse control. The Lua paths still need integration testing against the deployed Redis version.
- Password hashing uses async `scrypt`; JWT signing/validation uses async `jose`. Sessions are JWTs, refresh issues a new JWT without refresh-token rotation or per-session records. Logout clears the browser cookie; logout-all invalidates sessions via `sessions_valid_after`, with a one-minute in-process user cache window.
- OAuth refresh tokens are encrypted with AES-256-GCM. The key is derived by padding/truncating `APP_SECRET_KEY`, with no demonstrated key-version/rotation mechanism.
- Resume load verifies ownership by user ID, but the API engine accepts caller-provided buffers and has no provider-independent MIME, extension, size, malware, or content validation in the reviewed path.
- User-scoped profile/file lookup is present in the direct apply path. Broader tenant isolation was not exhaustively tested.
- API-apply logs were reduced to provider and timing/count metadata; user/application IDs, confirmation IDs, question labels, error text, and unknown inbound recipient addresses were removed from those log calls. Provider error bodies/raw responses elsewhere may still contain candidate data. Centralized structured-log redaction and a negative log-capture test remain required before production.
- Inbound mail processing is implemented, but this review did not establish an authenticated public webhook boundary for inbound email; the source describes an upstream Cloudflare Email Routing/SES integration. Verify signature/identity checks at that ingress before enabling it.

## Verification run

- Targeted Vitest suites: **9 files, 31 tests passed** (resolver, API client, six adapters, and application submission-state tests).
- The first run exposed two stale expectations that relied on incomplete synthetic profiles/IDs; tests were corrected to assert the new fail-closed and no-fake-reference behavior.
- Typecheck: `npm run typecheck` passed after the final live-submission gate and log edits.
- No real ATS POST, upload, account-side lookup, credit settlement, DB concurrency test, or latency measurement was performed. Mock adapter tests are not live evidence.

## Deployment decision

**NO-GO. Do not activate the production canary.** Five adapters are missing required authorization or use an undocumented/wrong endpoint; Workable is unsupported as a direct API adapter. There is no authorized test tenant evidence, no independently verified application record, no safe timeout/idempotency story, no concurrency evidence, and unresolved auth/logging/billing reconciliation risks. The current 99.5% reliability/sub-second readiness claims are not supported by these tests.

Canary eligibility requires a controlled employer-owned test tenant/posting for each provider, provider credentials/partner approval where applicable, exact schema and upload conformance, provider-generated application IDs, a separate employer-side lookup confirming each record, observed settlement/refund behavior, and concurrency/ambiguous-timeout tests on isolated infrastructure. Until then, use the existing reviewed browser workflow or stop for applicant action; do not claim direct ATS API submission succeeded. The direct API client is fail-closed by default.
