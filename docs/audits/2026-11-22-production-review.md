# JobPilot production review — 22 November 2026

## Verdict and scope

**Not yet certified for unrestricted production automation.** This change fixes reproduced recorder, workflow, AI and cost-accounting defects and establishes repeatable checks. No finite test suite proves support for every website. The product should advertise tested capabilities and return a clear unsupported/needs-input outcome for the rest.

Reviewed `feat/auto-apply-reliability` at `d520d5f`, then rebased onto merged `main` at `a204b91b7c7ded24d19b1aea340e2dc467bd5a91` at the owner's request. The earlier default branch `d055dd0` was substantially older than the supplied audits; its recorder findings are not treated as defects in the merged implementation.

The supplied audits were leads, not evidence: percentages of production readiness, claimed GPU utilization, viral conversion rates and CAPTCHA success rates were not measured here. The merged source already has deterministic compilation, browser form tests, purpose-based model routing, budget settings, campaign guards, and frame/popup recording. Preserve these strengths.

## Reproduced defects fixed

| Area | Failure | Change and evidence |
| --- | --- | --- |
| Runtime | Tracked `planner.js` and `crawler.js` shadow the newer TypeScript modules when `.js` imports resolve. Planner tests initially executed the stale implementation. | Remove generated source-directory JS/declaration artifacts; use the existing TypeScript runner or compiled `dist` output. New planner tests exercise the source implementation. |
| Recorder | Open-shadow-root input events retarget to their host; field values are missed. | Use composed event paths and input capture. Real Chromium regression. Closed roots and full structural shadow snapshots remain outside this fix. |
| Selectors | `data-qa`/`data-test` are emitted as `data-testid`; quoted attribute values generate invalid CSS. | Preserve attribute names, support `data-automation-id`, escape values. Real Chromium regressions. |
| Compiler | Consecutive identical selectors in separate frames are merged. | Include frame and tab in field coalescing identity. Regression. |
| Compiler | Repeated clicks are dropped even when each increments quantity; unrelated div/span clicks before a fill are removed. | Preserve distinct clicks; drop only same-target focus clicks. Regressions. |
| Compiler | Raw source events are mutated while normalizing input/change. | Copy events before normalization; frozen-input regression. |
| Compiler | Final Submit inside an iframe survives because the wrapper hides the click from removal. Appended job-tail IDs can collide with nested step IDs. | Remove the final recorded submit before wrapping; allocate monotonic IDs and reset frame metadata for the standard tail. Regression. This does not certify every possible earlier submit or side effect. |
| General workflows | All uploads bind to the user's résumé. | General recordings bind to `userFile:document`; job recordings retain résumé binding. Explicit multiple-document mapping remains needed. |
| Dry-run | A real click can submit; skipped/empty workflows can report success; URL checks do not check the URL. | Inspect interactive targets without executing them; skipped steps mean incomplete validation, empty plans fail, URL assertions execute. Browser regressions verify a Submit handler is not invoked. Full interaction tests belong on controlled fixtures/staging. |
| Recording lifecycle | Failed start retains a browser lease; release is not awaited. | Clean up failed initialization and await release. |
| Streaming cost | Every CDP frame is forwarded through Redis and Socket.IO. | Coalesce to at most about 10 updates/second, preserve the trailing frame, dispose on close. Tests cover burst collapse and cancellation. This bounds transport traffic; it does not claim lower CDP rendering cost. |
| Workflow matching | Any workflow with steps gets a positive score even for an unrelated request; active drafts are eligible. | Require actual relevance and published state in planner queries. Regression. |
| AI plans | JSON shape is accepted without step validation; model-specified retries can duplicate effects. | Validate actions, IDs, targets, nesting, navigation and timeouts; normalize ordering and disable blind retries in generated/recovery plans. Generated arbitrary JavaScript is rejected; reviewed authored workflows retain their existing executor capabilities. |
| AI learning | Plan generation counts as success and caches unexecuted plans; failure does not invalidate Redis. | Store pending plans with zero successes, invalidate stale cache, increment on AI/cached execution feedback only. Regressions. |
| Auto-apply | Eligibility checks ATS type only, excluding custom sites with dedicated URL-matched recorded workflows. | Include published, non-generic URL-specific recordings. Preserve human-check exclusions, profile requirements, caps and company/failure guards. Tests reject unrelated recorded sites. |
| Legacy generalization | The legacy AI endpoint produces a different target schema from the executor, while value masking/restoration can lose values. | Compile locally through the same deterministic compiler; no model call or personal-data transfer is needed to convert a recorded trace. |
| AI cost | Empty replies lose billed usage, SDK retries multiply gateway attempts, input cache pricing is ignored. | Account for empty-response tokens, disable SDK retries inside the gateway, recheck budgets between attempts, use reported provider cost when available, support cached-input rates. Mocked-provider tests. |

## UI work

Keep the existing visual design. General workflow mode and the All workflow filter are now defaults. New workflow templates follow the selected mode. Improve recorder labels, mobile URL-field sizing, save-in-progress feedback, document requirements, and object-URL cleanup. Replace the absolute promise that passwords/IDs are never stored with accurate wording about recognized secret fields.

A real test admin logged into the local admin UI. Recorder checks at 1440×1000 and 390×844 produced no browser page errors and no mobile horizontal overflow. These are checks of the recorder screen, not every admin/product route. Existing full frontend lint has 778 errors and 16 warnings; the changed recorder/studio files pass targeted lint after formatting. The production build has large-chunk warnings; split heavy admin/3D modules before claiming good low-end-device performance. Do not replace the current interface with the supplied audit's speculative game-style redesign.

## Test environment and evidence

Created isolated PostgreSQL 16 and Redis 7 containers bound to loopback, generated test-only credentials, ran migrations, and started the real admin service and execution worker. No production credentials, real applications, paid AI requests or CAPTCHA purchases were used. The scheduler was not started.

`scripts/audit-recorder-e2e.mts` serves its own local non-ATS task form and validates: unauthenticated API rejection, worker discovery, remote click/type commands, captured data, deterministic compilation, draft persistence, queue dispatch, worker execution, and a receipt from the fixture. The expected receipt appears once during recording and once during replay. The script requires the test admin/worker and configured test database/Redis. It deliberately submits only to its own fixture.

Baseline: **345 tests / 49 files passed**. Added real-browser and unit regressions; **383 tests / 61 files passed** on the final source changes. Backend typecheck and frontend production build are run. A new CI workflow runs these checks and installs Chromium for browser tests. CI execution itself must be confirmed on GitHub after the PR is opened.

Useful commands:

```sh
cd backend
npm ci
npx playwright install chromium
npm run typecheck
npm test -- --maxWorkers=2
# For a machine using system Chromium:
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test -- --maxWorkers=2
# With test-only environment variables and local services:
node --import tsx scripts/audit-recorder-e2e.mts
# Read-only financial report against the explicitly configured database:
node --import tsx scripts/cost-report.ts 2026-11 ../docs/audits/operating-inputs.example.json
```

## Cost and profit

Repository defaults, not confirmed live prices:

| Pack | Credits | INR price | INR/credit | USD price | USD/credit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | 100 | ₹499 | ₹4.9900 | $9 | $0.0900 |
| Pro | 400 | ₹1,499 | ₹3.7475 | $29 | $0.0725 |
| Power | 1,200 | ₹3,499 | ₹2.9158 | $69 | $0.0575 |

Default application charge: one credit. Payment fees, taxes, refunds, free signup credits (default 25), retries, support, and unsuccessful work reduce realized contribution. Credits sold are not automatically recognized revenue; unused credits create delivery obligations.

**Actual current production cost and profit are unknown:** no production bills or payment ledger were provided. The new report reads paid receipts by currency, recorded LLM usage, monthly recorded CAPTCHA spend, application outcomes and runtime price overrides. Missing costs remain null. The isolated test database correctly reports no customer revenue and unknown total cost/profit, not a fabricated positive margin.

Supply infrastructure, proxies, payment fees, refunds, indirect taxes, support/other expenses and an explicit INR/USD exchange rate in the input JSON. The report calculates cash surplus before income tax, not audited accounting profit. Reconcile vendor invoices: legacy empty model replies, unpriced models, provider errors and failed CAPTCHA charges may be undercounted. A configured zero model price is an operator assertion, not independent proof that inference is free.

For unit economics, let R be net revenue per charged completion, V variable cost per attempted run, S verified-success probability, and F allocated fixed cost per charged completion. Contribution per charged completion is `R − V/S − F`. Break-even requires `V/S + F < R`. For a target 70% contribution margin, total allocated cost must be at most 30% of net revenue. Using gross default INR prices only, the absolute upper bounds before fees/taxes are approximately ₹1.497 Starter, ₹1.124 Pro and ₹0.875 Power. These are thresholds, not measured costs.

Priorities: maximize verified deterministic replay; avoid AI for already-mapped actions; meter browser-seconds and proxy bytes per run; stop retries after uncertain submission; keep parked sessions out of browser RAM; load-test browser concurrency on actual hosts; reserve AI budget atomically before dispatch; version and scope caches; reconcile provider invoices monthly. The gateway's current check-then-spend budget remains a soft limit under concurrency, not a strict reservation system. Avoid choosing a model solely because a free tier exists; benchmark field accuracy, invalid-plan rate, latency and cost per verified outcome.

## Remaining launch gates

1. **Workflow execution safety and completion evidence:** arbitrary click/fill/custom steps can have side effects. `stopBeforeSubmit` is not a universal safeguard for generic workflows. Require workflow-specific confirmation, idempotency/checkpoints, and explicit retry policy, especially after a disconnect immediately following submission.
2. **Recorder coverage:** closed shadow roots, canvas/native controls, contenteditable, nested frame identity, duplicate selectors, virtualized option lists, popup close/tab reindexing, back navigation and dynamic conditional branches need broader fixture coverage. A captured trace represents the path exercised; it cannot discover every possible path/option.
3. **Selectors:** explicit candidate resolution now waits across fallbacks and requires a unique visible target (hidden upload inputs remain supported), with Chromium tests for delayed, hidden and ambiguous matches. Database/AI selector fallback still needs the same uniqueness guarantees and typed fallback normalization. Do not let AI silently choose among ambiguous consequential actions.
4. **Publishing and schemas:** validate imported/edited workflows server-side and gate publishing on a version-specific validation record. The AI validator added here does not replace a universal workflow import schema. Regular-expression URL patterns need host-aware matching and complexity limits.
5. **Privacy and access:** recorder screenshots, URLs, dialog text and DOM-derived hints may contain personal information despite field redaction. Apply retention/redaction and session-scoped access. Admin recorder frames currently broadcast across the admin namespace. Verify intended viewer permissions.
6. **AI cache isolation:** shared site/task cache keys need user/data/version scoping for literal-bearing plans. Execution success alone is not business confirmation. Do not promote generated workflows without reviewer approval and known outcomes.
7. **AI quality:** provider behavior is mocked in gateway tests; no live model-quality benchmark was run. Build a labeled evaluation set of general tasks and form fields, measure grounded answers, abstentions, schema validity and completion receipts before changing model defaults. Never infer missing personal facts.
8. **Auto-apply and queues:** stress concurrent schedules/manual runs, lock expiry/ownership, worker restarts, duplicate delivery, charging/refunds and uncertain submissions. Existing per-user locks are time-based and require ownership-safe renewal/release. URL-workflow support does not bypass job-feed region/readiness filters.
9. **Financial enforcement:** atomically reserve cost budgets; reject or explicitly flag unknown provider pricing; account for failed paid CAPTCHA requests; add browser/proxy/storage costs and reconcile refunds/taxes.
10. **Operations:** exercise database restore, migration rollback, queue backpressure, long-session memory, provider outage/fallback, browser crashes and production-like load. Current tests do not establish production capacity or a success SLA.

Ship these changes through review and staging. Keep unsupported sites and ambiguous outcomes visible rather than describing them as successful automated work.
