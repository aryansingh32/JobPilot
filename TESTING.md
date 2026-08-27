# Running & testing JobPilot locally

This covers three layers, from fastest to most realistic:

1. **Isolated verification scripts** (seconds, no browser, no Docker) — for the CAPTCHA/human-verification subsystem and Redis resilience specifically.
2. **The full stack via `./start.sh`** (minutes, real Postgres/Redis/Playwright in Docker + the frontend dev server) — for exercising the actual product.
3. **Manual smoke testing** — the parts that need a human or a real external site and can't be scripted honestly.

None of this requires paid API keys to boot. Chat replies, workflow planning, and paid CAPTCHA solving are the only things gated behind a real key (`OPENROUTER_API_KEY` etc., `CAPTCHA_PROVIDER_*`); everything else — auth, the admin panel, the DB schema, the human-in-the-loop CAPTCHA path — works without one.

---

## 1. Fast isolated checks (run these first, always)

These import the *real* production code (not reimplementations) against a real local Postgres + Redis, with only the Playwright `Page` and any solver-provider HTTP call faked. No Docker, no frontend, ~10–30s each.

```bash
cd backend
npm install                 # first time only

# Start Postgres + Redis if you don't already have them running.
# Easiest: bring up just the infra containers from docker-compose —
docker compose up -d postgres redis
# — or use local installs (see docker-compose.yml / .env.example for the
# POSTGRES_*/REDIS_* env vars these scripts read; defaults match a plain
# `postgres`/`redis-server` on localhost with password "changeme").

npm run typecheck                    # tsc --build across all packages
npm run verify:captcha-fallback      # 50 checks: detection, tier-1/2/3 fallback,
                                      #   plan gating, idle timeout, cancellation,
                                      #   admin resolution, security blocks,
                                      #   wrong-answer recovery (retryLoop), and
                                      #   sequential/duplicate-answer edge cases
npm run verify:redis-reconnect       # kills and restarts a local Redis mid-pause,
                                      #   confirms the paused step recovers instead
                                      #   of hanging or crashing the process
node --import tsx --test packages/execution-service/captcha-handler.test.ts
```

`verify:redis-reconnect` genuinely stops and starts a `redis-server` process on `REDIS_PORT` (default 6379) — don't point it at a shared/production Redis.

### Live end-to-end (real API + worker, real HTTP, real browser)

Unlike the two scripts above, `verify:live-e2e` doesn't import the code directly — it makes real HTTP requests against an already-running API service and worker, so start those first:

```bash
# Terminal 1
cd backend && POSTGRES_PASSWORD=changeme node --import tsx packages/api-service/server.ts

# Terminal 2
cd backend && POSTGRES_PASSWORD=changeme node --import tsx packages/execution-service/worker.ts

# Terminal 3
cd backend && ADMIN_API_KEY=<whatever seeded it, see backend/.env> node --import tsx scripts/verify-live-e2e.mjs
```

It covers: real email-OTP login (reading the code back out of the API's dev-fallback console log) and admin login, protected-route gating (401s with no/wrong credentials), a real structured workflow created via the live admin API and executed by a real Playwright browser against a small local test HTTP server this script spins up (navigate/fill/select/check/extractData/click/assertText/download/screenshot — a real form submission and a real file download, verified against the actual bytes the server sent), and 4 of those jobs fired concurrently to confirm the circuit breaker doesn't spuriously trip under real concurrent load.

If you're on this sandbox-style environment and hit `browserType.launch: Executable doesn't exist` when running the API/worker bare-metal (rather than via `./start.sh`'s Docker path), set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` in `backend/.env` to a Chromium binary you do have — this is an intentional opt-in override, not a workaround for anything a normal `npm install && npx playwright install` setup would hit.

If you only changed frontend code, the equivalent is:

```bash
cd chatflow-interface
npm install
npx tsc --noEmit
npm run build
```

---

## 2. The full stack

```bash
./start.sh
```

This is the real "run it locally" answer — it's already built into the repo and does more than a manual walkthrough would:

- First run: creates `backend/.env` and `chatflow-interface/.env` from their `.env.example` files and generates the secrets that have no safe default (`API_KEY`, `SESSION_JWT_SECRET`, `APP_SECRET_KEY`, an admin username/password). Anything you've already set is left alone on later runs.
- Builds and starts Postgres, Redis, the API service, and the worker via Docker Compose — the worker/API images run `npx playwright install --with-deps chromium` at build time, so the browser version always matches what's pinned in `package.json` (this matters: a bare-metal `node --import tsx packages/api-service/server.ts` on a machine with a different/older cached Playwright browser will fail browser-pool init with a "browserType.launch: Executable doesn't exist" error — Docker sidesteps this entirely, which is why it's the recommended path).
- Waits for `/health` to respond, then starts the frontend dev server in the foreground.
- Prints the admin login URL + generated admin username/password when it's done.

Useful flags:
```bash
./start.sh --no-build       # skip the image rebuild (fast path after the first run)
./start.sh --no-frontend    # backend-only
./start.sh --observability  # also bring up Prometheus + Grafana
./stop.sh                   # tear everything down
```

Add a `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) to `backend/.env` before starting if you want real chat replies and AI-generated plans — `start.sh` warns but still boots without one (you'll just get the "backend not available for chat" state in the UI for anything that needs the LLM).

### Exercising it once it's up

- **Chat** — `http://localhost:8080` (or whatever port Vite prints). Try a task matching one of the six shipped workflows (e.g. "download my aadhaar" — see `backend/workflows/` for the full list: IRCTC, Voter ID, Ration Card, EPFO, UIDAI/Aadhaar, PAN, Passport, SSC, DigiLocker, Driving License scaffolds).
- **Admin panel** — `/admin/login` with the username/password `start.sh` printed. Check the **Workflows**, **Captcha**, **Jobs**, and **Reliability** panels — the Captcha panel now shows provider status and 30-day intervention metrics from the work in this session.
- **Login without Google** — email/mobile OTP still works with no SMTP/Twilio configured; the OTP code prints to the API container's logs (`docker compose logs -f api`) instead of being sent.
- **A live CAPTCHA/OTP pause** — trigger any workflow with a `pauseForUserInput` step (most of the shipped ones have at least one) and confirm: the live browser view appears, the pause shows in the admin Captcha panel's pending queue, and answering from either the chat UI or the admin panel resolves it.

---

## 3. What's manual, and why

Some things genuinely can't be verified honestly by an automated script in this environment, and claiming otherwise would be worse than saying so plainly:

- **Real execution against the live target sites** (IRCTC, UIDAI, SSC, etc.). These are real government/public-service portals with their own uptime, layout, and rate limits — running the shipped workflows against them for real needs a live network path to India-region infrastructure, real test credentials/documents where the workflow requires them, and acceptance that layouts can drift out from under a recorded workflow at any time (that's what the scheduler's change-detection jobs are for in production, not something a one-off local test proves).
- **Paid CAPTCHA-provider solving** (2Captcha/Anti-Captcha/CapSolver) end-to-end against a *real* CAPTCHA. `verify:captcha-fallback` proves the plumbing (provider selection, cost tracking, plan gating, fallback) against a fake local HTTP server standing in for the provider API — it does not prove a specific real account/key actually solves a real challenge. Set `CAPTCHA_PROVIDER_2CAPTCHA_KEY` (etc.) and try a real workflow to confirm that.
- **Payment steps** (`payment`/`paymentGateway` actions) — these pause for a human to complete a real payment; there's no safe automated way to test the money-moving part itself.
- **Load/concurrency** — the browser pool, circuit breaker, and queue depth behavior under real concurrent load haven't been load-tested here; `MIN_BROWSERS`/`MAX_BROWSERS`/`MAX_CONTEXTS_PER_BROWSER` in `.env.example` are the levers if you want to.

If you want any of these covered, the honest next step is scoping which of them matters most and running it against a real (ideally staging, not production-critical) target — not a broader claim that the whole platform has been "tested."
