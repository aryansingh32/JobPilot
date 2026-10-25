# Backend Plan — Do More Work With Fewer AI Tokens

**Date:** 2026-10-21 · **Inputs:** a read of our backend (`backend/packages/*`) + the Tsenta teardown (`docs/competitive/tsenta-teardown.md`).
**Goal:** a robust backend where the LLM is the *last* resort, not the first. Every task should be done by the cheapest thing that can do it correctly: rules → cache → deterministic engine → small model → big model.

> Token numbers below are **estimates** from reading prompts and code. Phase 0 adds real measurement so every later phase is judged on actual numbers.

---

## 1. Where tokens go today

There is exactly one LLM client (`shared/llm/index.ts`, OpenAI-compatible, OpenRouter by default) and five call sites:

| # | Call site | Fires when | Model | What's sent each time | Cached? |
|---|---|---|---|---|---|
| 1 | `chat-orchestrator.ts` `handleMessage` | **Every user message** — including OTP digits, "yes", "stop" not caught by regex | `chatModel` **with reasoning on** | ~8 KB system prompt (~2.2k tok) + **all** workflows (one JSON line each) + profiles with samples + file list + session memory + **entire chat history** | No |
| 2 | `chat-orchestrator.ts` `generateManualGuidance` | "How do I…" with no workflow | `chatModel` + reasoning | prompt + question | No |
| 3 | `planner.ts` `planTask` | Task with no structured workflow and no exact-text cache hit | `plannerModel` + reasoning | system prompt + workflow context + **80 elements as pretty-printed JSON** | Only by **exact task-text hash** |
| 4 | `planner.ts` `recoverFromFailure` / `resolveSelector` | A step fails / selector stage-4 | lightweight model, no reasoning ✓ | failed step + 2 KB DOM / 1.5 KB page text | Selector results stored in `selectors` ✓; no negative cache |
| 5 | `llm-generalizer.ts`, `observability.service.ts` copilot | Admin actions | chat model / gpt-4o-mini | recorded steps / error context | No (admin-only, low volume) |

### The five biggest leaks

1. **The chat LLM is the router for everything.** An OTP reply like `482913` costs a full turn: ~2.2k system + workflows + profiles + history + reasoning trace. A single task with 5 user replies is ~25–35k tokens before any automation runs.
2. **Reasoning is on by default** (`OPENROUTER_ENABLE_REASONING` defaults true) for a task that is mostly classification. Reasoning traces are often 500–2,000 extra output tokens per turn — the most expensive kind of token.
3. **Context grows without bound.** `state.history` is never trimmed (only a 24h TTL), and *every* workflow is sent every turn. Cost per turn rises with both conversation length and catalog size.
4. **Cache keys are too literal.** Planner cache = hash of the exact task string, so "download my aadhaar" and "Download Aadhaar e-card please" both miss.
5. **Nothing is measured.** No table records tokens, cost or latency per call — we can't see which purpose, user or site is expensive.

Free OpenRouter models make the bill ~$0 today, but every leak still costs **rate-limit headroom (429s), latency and reliability** — and becomes real money the moment we move to a paid model.

---

## 2. What Tsenta teaches about cost

From the live run (QAD application, 37 s end to end):

| Tsenta pattern | Why it's cheap |
|---|---|
| Per-site adapters, **API transport first** (`smartrecruiters-api`), browser only as fallback | Most of the job is HTTP + parsing — zero tokens |
| Form schema parsed deterministically (`parse:done` at 1.4 s) | No LLM to "see" the form |
| `profile-direct` fills ~40 of 47 fields; LLM only for 5 screening questions, **in one batch** (`answer:start → answer:done`) | Tokens scale with *unknown questions*, not form size |
| Small, cheap model (`DeepSeek-V4-Flash`) for tailoring; JSON-path edit tools with `characterLimits` | Short structured outputs, no prose rewrites |
| One canonical profile = answer bank; "What Tsenta remembers" | Answered once, reused forever |
| Email: per-user inbox, `matchMethod: COMPANY_UNIQUE` | Rules match mail to tasks; no LLM needed for most mail |

And one thing **not** to copy: on resume after review, Tsenta **re-ran the whole pipeline and regenerated LLM answers** (salary changed 15L → 16L/18L). That is both a correctness bug and a doubled token bill. We submit the approved payload verbatim.

---

## 3. Principle: the cost ladder

Every request walks down this ladder and stops at the first rung that can answer correctly:

```
0. Rules / regex          OTP digits, yes/no, cancel, greetings, known commands      0 tokens
1. Cache                  same normalized question / task / form / selector seen     0 tokens
2. Deterministic engine   workflow match, profile→field mapping, API adapter          0 tokens
3. Embeddings             similarity search over workflows / cached flows / answers   ~0.01× chat cost
4. Small model, no reasoning   intent JSON, field classification, short extraction    1×
5. Large / reasoning model     open-ended answers, novel-site planning                5–20×
```

Every LLM call must declare its **purpose**, go through one gateway, and have a `max_tokens`.

---

## 4. The plan

### Phase 0 — Measure (1–2 days) · prerequisite for everything

| Ticket | What | Where |
|---|---|---|
| **P0.1 LLM gateway** | Single `llm.complete({ purpose, model, messages, maxTokens, json, cacheKey? })` wrapping the OpenAI client. All 5 call sites go through it. Enforces `max_tokens`, timeout, JSON mode, retry-on-429 with backoff + model fallback. | new `shared/llm/gateway.ts`; migrate `chat-orchestrator.ts`, `planner.ts`, `llm-generalizer.ts`, `observability.service.ts` |
| **P0.2 `llm_usage` table** | Per call: purpose, model, prompt/completion/reasoning tokens (from `response.usage`), cached-prompt tokens, latency, user, job, cache hit, estimated cost (price table per model). | `shared/db` migration |
| **P0.3 Admin cost view** | Tokens & cost by purpose / day / user, top expensive jobs, cache-hit rate. | `admin-routes.ts` + admin panel card |
| **P0.4 Budgets** | Per-user daily token cap and per-job cap; on overrun degrade to small model or ask user. Kill switch env. | gateway |

### Phase 1 — Quick wins (2–4 days) · expected **~70–85% fewer chat tokens**

| Ticket | What | Saves |
|---|---|---|
| **P1.1 Deterministic pre-router** | Before calling the LLM in `handleMessage`: if `awaitingInput` and message matches the expected shape (digits for OTP, captcha-like token, "yes/paid/done", email/phone pattern) → `provide_input` with **no LLM**. Extend the existing cancel/memory regexes. High-confidence workflow match from `scoreWorkflowMatch` + no ambiguity → `start_job` with a templated reply. Greetings/thanks → canned reply. | Every OTP/confirm turn → 0 tokens |
| **P1.2 Reasoning off for routing** | `chatModel` routing call uses a small non-reasoning model; reasoning only for `manual_guidance` and long-form `chat` answers (two-stage: classify cheap, answer with stronger model only when needed). Default `OPENROUTER_ENABLE_REASONING=false`, opt-in per purpose. | 500–2,000 output tokens/turn |
| **P1.3 Context diet** | History: last 6 turns + a rolling 1-paragraph summary (summarize with small model every ~10 turns). Workflows: only the **top 5 candidates** by keyword/embedding score, not all. Profiles: field *names* + which are filled, never sample values. Files: names + category only. | Turn cost stops growing with chat length and catalog size |
| **P1.4 Prompt-cache-friendly ordering** | Put the static system prompt first and byte-identical across calls; dynamic blocks after. OpenAI / DeepSeek / Anthropic / Gemini discount cached prefixes (often 50–90%). Split the 8 KB prompt: core rules (always) + examples (only when needed). | Up to ~50–90% off the system-prompt share on supporting providers |
| **P1.5 Compact planner input** | Minified JSON (drop `null, 2` pretty print ≈ −25–30%), compact element lines `id|type|label|selector`, dedupe identical labels, drop invisible elements, cap by token count not element count. Force `response_format: json_object` and `max_tokens`. | ~40–60% of planner input |

### Phase 2 — Reuse what we already paid for (1 week)

| Ticket | What |
|---|---|
| **P2.1 Normalized task keys** | Normalize task text (lowercase, strip filler words, canonical verbs: get/download/fetch → `download`; entity slots like `{document}`, `{site}`) before hashing in `getCachedFlow`/`saveFlow`. |
| **P2.2 Embedding lookup (pgvector)** | Embed workflow triggers, cached-flow tasks and FAQ answers once. Match new tasks by cosine similarity (threshold + keyword agreement). Embeddings cost ~1% of a chat call and replace both "send every workflow to the LLM" and literal-hash misses. |
| **P2.3 Answer cache for guidance/FAQ** | `manual_guidance` and general `chat` answers cached by normalized question (TTL 7 days, per-locale). Same question from 1,000 users = 1 LLM call. |
| **P2.4 Selector negative cache** | If AI selector resolution failed for `(site, label)` in the last N hours, don't call again — escalate to human/recording instead. Share resolved selectors across all users of a site (already stored in `selectors`; make it the first lookup). |
| **P2.5 Form schema cache** | Hash a form's field list per URL template. Store the parsed schema + the field→profile mapping once; every later user on that form reuses it with zero tokens. |

### Phase 3 — Deterministic form filling (Tsenta's core lesson) (1–2 weeks)

| Ticket | What |
|---|---|
| **P3.1 Field classifier, rules first** | Map each form field to a canonical profile key using `autocomplete` attributes, `type`, `name/id`, label synonyms dictionary (first/last/full name, email, phone, DOB, gender, address lines, PIN/ZIP, city, state, country, PAN/Aadhaar refs, education, employer…), and option-list matching. Output `source: profile` with confidence. |
| **P3.2 One batched LLM call per form** | Only fields the rules can't map **and** that are open-ended go to the LLM — all in a single request with the profile summary, returning `{fieldId: answer, confidence}`. Never one call per field. |
| **P3.3 Hard "never invent" policy** | Numeric (salary, CTC), legal (work authorization, criminal record), identity (IDs, DOB) and skills fields are **profile-only or `NEEDS_USER`** — enforced in code. Saves tokens *and* prevents Tsenta's fabricated-salary bug. |
| **P3.4 Answer memory** | When the user answers or edits a field in the Review card, store `(normalized question → answer)` per user. Next form with the same question fills from memory at 0 tokens. Surface it as "What jobpilot remembers" (editable). |
| **P3.5 Immutable approved payload** | `review` pause sends the filled fields (feeds the U3 Review card); resume submits exactly the approved `values` (hash-checked) — **no re-planning, no regenerated answers**. |
| **P3.6 Field provenance in the trace** | Every filled value records `source` (`profile` / `memory` / `rule` / `ai` / `user`) + confidence → Review card badges and the receipt. |

### Phase 4 — API-first transports (ongoing, per high-traffic site)

| Ticket | What |
|---|---|
| **P4.1 Transport interface** | `SiteAdapter { detect(url), fetchForm(), submit(payload), transport: 'api' | 'http-form' | 'browser' }`. Executor tries API/HTTP first, records `datadome:failed`-style events, falls back to browser. |
| **P4.2 Adapters by volume** | Use `llm_usage` + job counts to pick the top sites; write adapters for those with public/predictable endpoints. Each adapter turns a multi-call browser+LLM run into plain HTTP. |
| **P4.3 Email rules before LLM** (for the Inbox) | OTP extraction by regex near keywords (`OTP`, `code`, `verification`), sender-domain → task matching (`COMPANY_UNIQUE` equivalent), category by subject patterns. LLM only for mail no rule classifies. |

### Phase 5 — Model routing & resilience

| Ticket | What |
|---|---|
| **P5.1 Purpose → model table** | Config (env or DB) per purpose: `route` (nano), `extract`/`field_answers` (small), `guidance`/`plan_novel` (medium/large). One place to swap providers. |
| **P5.2 Fallback chain** | On 429/5xx: same-tier alternate model → wait/backoff → degrade gracefully (ask user / templated reply). Free models rate-limit often; this keeps the app working. |
| **P5.3 Output discipline** | JSON schemas with short field names, `max_tokens` sized per purpose, no "explain your reasoning" fields unless used. |

---

## 5. Expected impact (estimates — Phase 0 replaces these with real numbers)

**Typical task:** "Download my bank statement" — 1 request, 1 OTP, 1 confirmation, 1 follow-up question.

| | Today (est.) | After P1 | After P1–P3 |
|---|---|---|---|
| Chat routing turns (4) | ~4 × 6–8k = **24–32k** | 1 × ~1.5k (OTP + confirm via rules) = **~1.5–3k** | same |
| Planning (no recorded workflow) | ~6–9k | ~3–4k | 0 on cache/embedding hit; ~3k on first-ever |
| Form filling, 40-field form | (planner-driven) | — | rules fill ~85–90%; 1 batched call for ~5 open questions ≈ **1–2k** |
| Resume after review | — | — | **0** (approved payload replayed) |
| **Total per task** | **~30–40k** | **~6–8k** | **~2–5k** (first time) · **~0–1.5k** (repeat site/form) |

Roughly **85–95% fewer tokens per task**, fewer 429s, faster replies (no reasoning wait on routing), and more correct forms.

---

## 6. Order of work

1. **P0.1–P0.2** gateway + usage table — measure before changing anything.
2. **P1.1 + P1.2** pre-router and reasoning-off — biggest single cut, small diff in `chat-orchestrator.ts`.
3. **P1.3 + P1.4 + P1.5** context diet, prompt ordering, compact planner input.
4. **P3.5 + P3.6** review payload + provenance — unblocks the U3 Review card in the UI.
5. **P3.1–P3.4** deterministic form filling + answer memory.
6. **P2.x** caching/embeddings, then **P4/P5** adapters and routing as data shows where cost is.

## 7. Risks & guards

- **Pre-router false positives** (treating a new request as an OTP): only fire when `awaitingInput` is set *and* the shape matches; otherwise fall through to the LLM.
- **Over-trimmed context**: keep the rolling summary + the last turns; measure intent accuracy on a fixed eval set of ~100 real messages before/after (P0 makes this cheap to run).
- **Stale caches**: TTLs, invalidate flow/schema caches on selector drift (`change-detector.ts` already detects drift).
- **Model swaps changing behavior**: purpose-level eval sets gate any model change.
