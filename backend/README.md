# 🤖 Automation Platform

Production-grade intelligent browser automation with AI-powered decision making, scalable job queues, and adaptive selector resolution.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       CLIENT / USER                       │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP + API Key
┌─────────────────────────▼────────────────────────────────┐
│                    API SERVICE (Fastify)                   │
│     Rate limiting · Auth · Request validation             │
│     Every request → async job (never sync execution)      │
└──────────┬─────────────────────────────┬─────────────────┘
           │ enqueue                     │ enqueue
    ┌──────▼──────┐               ┌──────▼──────┐
    │  BullMQ     │               │  BullMQ     │
    │  execute    │               │  crawl      │
    │  queue      │               │  queue      │
    └──────┬──────┘               └──────┬──────┘
           │                             │
┌──────────▼─────────────────────────────▼────────────────┐
│                  WORKER CLUSTER (auto-scale)              │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              BROWSER POOL                            │ │
│  │   2-20 Chromium instances (pre-warmed)               │ │
│  │   Context per user (8 users per browser)             │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                 │
│  ┌──────────────┐  ┌────▼──────────┐  ┌───────────────┐ │
│  │  SESSION MGR │  │  EXEC ENGINE  │  │ SELECTOR ENG  │ │
│  │  cookies     │  │  click/fill   │  │  4-stage      │ │
│  │  localStorage│  │  navigate     │  │  fallback     │ │
│  │  proxy attach│  │  upload/dl    │  │  chain        │ │
│  └──────────────┘  └────┬──────────┘  └───────────────┘ │
│                         │ on selector fail               │
│                    ┌────▼──────────┐                     │
│                    │  AI SERVICE   │                     │
│                    │  (fallback    │                     │
│                    │   only)       │                     │
│                    └───────────────┘                     │
└──────────────────────────────────────────────────────────┘
           │                       │
    ┌──────▼──────┐         ┌──────▼──────┐
    │  POSTGRES   │         │    REDIS    │
    │  sites      │         │  sessions   │
    │  pages      │         │  flow cache │
    │  elements   │         │  proxy pool │
    │  selectors  │         │  dom snaps  │
    │  sessions   │         │  queues     │
    └─────────────┘         └─────────────┘
           │
    ┌──────▼──────────────────────┐
    │       SCHEDULER SERVICE      │
    │  change detection (10 min)   │
    │  proxy health  (5 min)       │
    │  session GC    (hourly)      │
    │  full remap    (weekly)      │
    └──────────────────────────────┘
```

---

## 📦 Services

| Service | Scales | Purpose |
|---|---|---|
| `api-service` | Horizontal (2+) | REST gateway, job enqueueing |
| `worker-service` | Auto (2–20 pods) | Crawl, execute, remap |
| `scheduler-service` | Fixed (1) | Cron jobs, change detection |
| `postgres` | Vertical | Structured data store |
| `redis` | Vertical | Queue + fast cache |
| `prometheus` | Fixed | Metrics collection |
| `grafana` | Fixed | Dashboards |

---

## 🚀 Quickstart

> **Fastest path:** `./start.sh` from the repo root brings up Postgres, Redis, the API, the worker, and the frontend dev server in one command, with secrets auto-generated on first run. See [`TESTING.md`](../TESTING.md) at the repo root for the full local-run and testing guide, including the isolated verification scripts for the CAPTCHA subsystem and Redis resilience.

### Docker Compose (local dev)

```bash
# 1. Clone
git clone <repo>
cd automation-platform

# 2. Configure
cp .env.example .env
# Edit .env — set OPENROUTER_API_KEY and POSTGRES_PASSWORD
# If your frontend runs on another dev port, add it to CORS_ORIGIN

# 3. Start everything
docker-compose up -d

# 4. Check health
curl http://localhost:3000/health
```

### Backend-only local development

Use Docker Compose for infrastructure, then run the API and worker in Node for faster iteration:

```bash
# Start Postgres + Redis in the background
docker compose up -d postgres redis

# Start the full backend in separate processes
npm run dev:full
```

If you prefer separate terminals:

```bash
npm run dev:api
npm run dev:worker
```

For a full local stack from Docker only, use:

```bash
docker compose up --build
```

### First crawl

```bash
# Register a site
curl -X POST http://localhost:3000/sites \
  -H "x-api-key: dev-key-change-in-prod" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'

# Start crawl
curl -X POST http://localhost:3000/crawl \
  -H "x-api-key: dev-key-change-in-prod" \
  -H "Content-Type: application/json" \
  -d '{
    "siteId": "<site-id-from-above>",
    "url": "https://example.com",
    "maxDepth": 3,
    "maxPages": 100
  }'

# Check job status
curl http://localhost:3000/jobs/<job-id> \
  -H "x-api-key: dev-key-change-in-prod"
```

### Execute a task

```bash
curl -X POST http://localhost:3000/execute \
  -H "x-api-key: dev-key-change-in-prod" \
  -H "Content-Type: application/json" \
  -d '{
    "siteId": "<site-id>",
    "task": "Log in with email user@example.com and password secret123, then navigate to the dashboard",
    "priority": "high"
  }'
```

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | System health |
| `/metrics` | GET | Prometheus metrics |
| `/sites` | POST | Register site |
| `/sites` | GET | List sites |
| `/sites/:id/graph` | GET | Site navigation graph |
| `/sites/:id/elements` | GET | Extracted elements |
| `/crawl` | POST | Start crawl job |
| `/execute` | POST | Execute natural language task |
| `/remap` | POST | Trigger site remap |
| `/jobs/:id` | GET | Job status |
| `/queues` | GET | Queue depths |
| `/proxies/import` | POST | Bulk import proxies |
| `/proxies/stats` | GET | Proxy pool health |

---

## 🧠 How the AI Works

AI is **fallback, not primary path**. This keeps costs low and speed high.

```
Task received
    │
    ▼
Check flow cache ──hit──→ Execute cached steps (free, fast)
    │ miss
    ▼
Call Claude API → Generate action plan
    │
    ▼
Cache the plan for future runs
    │
    ▼
Execute with Playwright

During execution:
    Selector fails
        │
        ▼
    Try stored selectors (ranked)
        │ all fail
        ▼
    Try text/heuristic match
        │ fail
        ▼
    Call Claude to re-identify element (1 AI call)
```

---

## ⚙️ Selector Fallback Chain

```
1. Stored selectors (ranked by confidence score)
        ↓ fail
2. Text content match (button text, aria-label, placeholder)
        ↓ fail
3. DOM heuristic (fuzzy attribute search)
        ↓ fail
4. AI semantic identification (Claude, last resort)

On each failure: confidence -= 0.15
On each success: confidence += 0.02
Selectors with failure_count >= 5 are excluded
```

---

## 📊 Monitoring

- **Grafana**: http://localhost:3001 (admin / set in .env)
- **Prometheus**: http://localhost:9090
- **Queue depths**: GET /queues
- **Proxy health**: GET /proxies/stats

Key metrics:
- `worker_jobs_total{type,status}` — job throughput
- `worker_job_duration_seconds` — latency histograms  
- `worker_active_browsers` — browser pool usage
- `pg_stat_activity` — database connections

---

## 🔐 Security Notes

- All API requests require `x-api-key` header
- Workers run as non-root users
- No credentials stored in browser memory after session save
- Proxy passwords encrypted at rest (add pgcrypto for prod)
- Rate limiting: 100 req/min per IP (configurable)
- Robots.txt respected by default (`respectRobots: true`)

---

## 🐳 Production Deployment (Kubernetes)

```bash
# Apply manifests
kubectl apply -f infrastructure/kubernetes/deployment.yaml

# Install KEDA for queue-based autoscaling
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace

# Watch workers autoscale as queue grows
kubectl get hpa worker-hpa -n automation-platform -w
```

Workers scale from **2 → 20** pods based on:
- CPU utilization > 70%
- Memory utilization > 80%  
- Redis queue depth > 10 jobs/worker (via KEDA)

---

## 📁 Project Structure

```
automation-platform/
├── packages/
│   ├── api-service/          # Fastify REST gateway
│   │   └── server.ts
│   ├── crawler-service/      # Crawlee + Playwright crawler
│   │   └── crawler.ts
│   ├── execution-service/    # Core automation engine
│   │   ├── browser-pool.ts   # Pooled browser management
│   │   ├── executor.ts       # Action plan executor
│   │   ├── selector-engine.ts # 4-stage selector resolution
│   │   ├── session-manager.ts # Cookie/storage persistence
│   │   ├── proxy-manager.ts  # Health-scored proxy pool
│   │   ├── captcha-handler.ts # Detection + solving
│   │   └── worker.ts         # Queue consumer entry point
│   ├── ai-service/           # LLM integration
│   │   └── planner.ts        # Task → action plan + caching
│   ├── scheduler-service/    # Cron jobs
│   │   ├── scheduler.ts      # Cron definitions
│   │   └── change-detector.ts # DOM change detection
│   └── shared/
│       ├── types/index.ts    # All TypeScript types
│       ├── queue/index.ts    # BullMQ wrappers
│       └── db/index.ts       # Postgres + Redis + schema
├── infrastructure/
│   ├── docker/               # Dockerfiles
│   ├── kubernetes/           # K8s + HPA + KEDA
│   └── prometheus/           # Metrics config
├── docker-compose.yml
└── .env.example
```
