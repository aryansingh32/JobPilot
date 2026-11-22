#!/usr/bin/env bash
# ============================================================
# JobPilot — run everything locally, reachable from this machine AND from
# other devices on your network (phone, another laptop).
#
#   ./dev-lan.sh            start (Postgres + Redis in Docker, services on the host)
#   ./dev-lan.sh share      the same, plus a public https link through ngrok (one tunnel:
#                           the app and its API; the admin panel stays on this machine)
#   ./dev-lan.sh stop       stop the services and the two containers (data is kept)
#   ./dev-lan.sh restart    restart the services after code changes (containers keep running)
#   ./dev-lan.sh status     what's running + the URLs
#   ./dev-lan.sh logs api   follow a log: api | admin | worker | scheduler | web
#   ./dev-lan.sh code       last sign-in code (email/SMS go to the log when no SMTP/Twilio is set)
#
# Uses backend/.env for keys and secrets; overrides only what local network
# use needs (ports, database, CORS, http cookies). Data lives in the Docker
# volumes jobpilot-dev-pgdata / jobpilot-dev-redisdata and ./.dev-data.
# This stack is separate from ./start.sh (Docker Compose).
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/chatflow-interface"
RUN="$ROOT/.dev-data/run"
LOGS="$ROOT/.dev-data/logs"
mkdir -p "$RUN" "$LOGS" "$ROOT/.dev-data/files" "$ROOT/.dev-data/tmp"

API_PORT=3300
ADMIN_PORT=3100
WEB_PORT=5173
PG_PORT=55432
DEV_REDIS_PORT=56379
PG_PASSWORD=jobpilot-dev

lan_ip() {
  local addr=""
  addr="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  if [ -z "$addr" ]; then
    addr="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "$addr"
}
LAN_IP="$(lan_ip)"

say() { printf '\033[36m[dev]\033[0m %s\n' "$1"; }

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
http_healthy() {
  curl -fsS --max-time 3 "$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).status==="healthy"?0:1)}catch{process.exit(1)}})' \
    2>/dev/null
}

stop_services() {
  for s in ngrok web scheduler worker admin api; do
    if running "$s"; then
      # Each service runs in its own process group (setsid): stop the whole group.
      kill -- -"$(cat "$RUN/$s.pid")" 2>/dev/null || kill "$(cat "$RUN/$s.pid")" 2>/dev/null || true
      say "stopped $s"
    fi
    rm -f "$RUN/$s.pid"
  done
}

stop_all() {
  stop_services
  docker stop jobpilot-dev-pg jobpilot-dev-redis >/dev/null 2>&1 || true
  say "containers stopped (data kept in Docker volumes)"
}

urls() {
  echo
  if running ngrok && [ -f "$RUN/public-url" ]; then
    echo "  Share    $(cat "$RUN/public-url")      ← send this link (app + sign-in; admin is not on it)"
  fi
  echo "  App      http://localhost:$WEB_PORT${LAN_IP:+          http://$LAN_IP:$WEB_PORT}"
  echo "  Admin    http://localhost:$WEB_PORT/admin${LAN_IP:+    http://$LAN_IP:$WEB_PORT/admin}"
  echo "  API      http://localhost:$API_PORT/health${LAN_IP:+   http://$LAN_IP:$API_PORT/health}"
  echo
  echo "  Sign-in codes (no SMTP/Twilio set): ./dev-lan.sh code"
  echo "  Admin login: ADMIN_USERNAME / ADMIN_PASSWORD from backend/.env"
  echo
}

case "${1:-start}" in
  stop) stop_all; exit 0 ;;
  restart) stop_services; sleep 2 ;;
  share) SHARE=1; stop_services; sleep 2 ;;
  status)
    for s in api admin worker scheduler web ngrok; do
      if ! running "$s"; then
        echo "  $s: stopped"
        continue
      fi
      case "$s" in
        api) http_healthy "http://127.0.0.1:$API_PORT/health" && echo "  api: healthy" || echo "  api: process running, health check failed" ;;
        admin) http_healthy "http://127.0.0.1:$ADMIN_PORT/health" && echo "  admin: healthy" || echo "  admin: process running, health check failed" ;;
        web) curl -sf --max-time 5 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && echo "  web: healthy" || echo "  web: process running, health check failed" ;;
        *) echo "  $s: process running" ;;
      esac
    done
    if docker exec jobpilot-dev-pg pg_isready -U postgres >/dev/null 2>&1; then
      echo "  postgres: healthy (PostgreSQL 16)"
    else
      echo "  postgres: container stopped/unavailable"
    fi
    if docker exec jobpilot-dev-redis redis-cli ping 2>/dev/null | grep -qx PONG; then
      echo "  redis: healthy"
    else
      echo "  redis: container stopped/unavailable"
    fi
    urls; exit 0 ;;
  logs) exec tail -n 100 -f "$LOGS/${2:-api}.log" ;;
  code) grep -ho "code is [0-9]*" "$LOGS/api.log" | tail -1 || echo "no code yet"; exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|share|stop|restart|status|logs <service>|code]"; exit 1 ;;
esac

[ -f "$BACKEND/.env" ] || { echo "backend/.env is missing — run ./start.sh once or copy backend/.env.example"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is unavailable. Start Docker and verify your user can access the Docker socket, then retry."; exit 1; }

# ── Data: Postgres + Redis (own containers + volumes, not the Compose ones) ──
if ! docker ps --format '{{.Names}}' | grep -qx jobpilot-dev-pg; then
  docker rm -f jobpilot-dev-pg >/dev/null 2>&1 || true
  docker run -d --name jobpilot-dev-pg -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=jobpilot \
    -p "$PG_PORT:5432" -v jobpilot-dev-pgdata:/var/lib/postgresql/data postgres:16-alpine >/dev/null
  say "postgres started on :$PG_PORT"
fi
if ! docker ps --format '{{.Names}}' | grep -qx jobpilot-dev-redis; then
  docker rm -f jobpilot-dev-redis >/dev/null 2>&1 || true
  docker run -d --name jobpilot-dev-redis -p "$DEV_REDIS_PORT:6379" -v jobpilot-dev-redisdata:/data redis:7-alpine \
    redis-server --appendonly yes >/dev/null
  say "redis started on :$DEV_REDIS_PORT"
fi
READY=0
for _ in $(seq 1 60); do
  if docker exec jobpilot-dev-pg pg_isready -U postgres >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "PostgreSQL 16 did not become ready on :$PG_PORT; recent container logs:"
  docker logs --tail 50 jobpilot-dev-pg 2>&1 || true
  exit 1
fi
READY=0
for _ in $(seq 1 30); do
  if docker exec jobpilot-dev-redis redis-cli ping 2>/dev/null | grep -qx PONG; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "Redis did not become ready on :$DEV_REDIS_PORT; recent container logs:"
  docker logs --tail 50 jobpilot-dev-redis 2>&1 || true
  exit 1
fi

# ── Share: a public https link (ngrok) to the web app; the API rides along on /api ──
PUBLIC_URL=""
if [ -n "${SHARE:-}" ]; then
  command -v ngrok >/dev/null || { echo "ngrok is not installed — https://ngrok.com/download"; exit 1; }
  rm -f "$RUN/public-url"
  (setsid ngrok http "$WEB_PORT" --log=stdout >"$LOGS/ngrok.log" 2>&1 < /dev/null & echo $! >"$RUN/ngrok.pid")
  for _ in $(seq 1 30); do
    PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c 'import json,sys; t=[x["public_url"] for x in json.load(sys.stdin).get("tunnels",[]) if x["public_url"].startswith("https")]; print(t[0] if t else "")' 2>/dev/null || true)"
    [ -n "$PUBLIC_URL" ] && break
    running ngrok || { echo "ngrok stopped — see .dev-data/logs/ngrok.log"; tail -5 "$LOGS/ngrok.log"; exit 1; }
    sleep 1
  done
  [ -n "$PUBLIC_URL" ] || { echo "ngrok gave no public URL — see .dev-data/logs/ngrok.log"; exit 1; }
  echo "$PUBLIC_URL" >"$RUN/public-url"
  say "public link: $PUBLIC_URL"
fi

# ── Environment: backend/.env + local-network overrides ──
set -a
# shellcheck disable=SC1091
. "$BACKEND/.env"
NODE_ENV=development          # plain-http cookies (production cookies need https)
HOST=0.0.0.0
PORT=$API_PORT
ADMIN_PORT=$ADMIN_PORT
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=$PG_PORT
POSTGRES_DB=jobpilot
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$PG_PASSWORD
REDIS_HOST=127.0.0.1
REDIS_PORT=$DEV_REDIS_PORT
REDIS_PASSWORD=
CORS_ORIGIN="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT${LAN_IP:+,http://$LAN_IP:$WEB_PORT}${PUBLIC_URL:+,$PUBLIC_URL}"
ADMIN_CORS_ORIGIN="$CORS_ORIGIN"
USER_FILE_STORAGE_ROOT="$ROOT/.dev-data/files"
TEMP_STORAGE_ROOT="$ROOT/.dev-data/tmp"
INBOUND_EMAIL_SECRET="${INBOUND_EMAIL_SECRET:-dev-inbound-secret}"
if [ -n "$PUBLIC_URL" ]; then
  # Links in emails and OAuth redirects (Gmail) go to the shared address.
  PUBLIC_APP_URL="$PUBLIC_URL"
  PUBLIC_API_URL="$PUBLIC_URL/api"
else
  PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:$WEB_PORT}"
fi
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ] || [ ! -x "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]; then
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v google-chrome-stable || command -v chromium || true)"
fi
set +a

start() {
  local name="$1"; shift
  if running "$name"; then say "$name already running"; return; fi
  # setsid: own process group, so `stop` also ends child processes (vite, browsers).
  # A plain backgrounded command, so $! is the service itself (not a wrapper shell).
  (cd "$BACKEND"; setsid "$@" >"$LOGS/$name.log" 2>&1 < /dev/null & echo $! >"$RUN/$name.pid")
  say "started $name (log: .dev-data/logs/$name.log)"
}

# The API runs migrations; start it first and wait until dependencies are healthy.
start api node --import tsx packages/api-service/server.ts
READY=0
for _ in $(seq 1 90); do
  if http_healthy "http://127.0.0.1:$API_PORT/health"; then READY=1; break; fi
  running api || { echo "API failed to start — see .dev-data/logs/api.log"; tail -20 "$LOGS/api.log"; exit 1; }
  sleep 1
done
if [ "$READY" != "1" ]; then echo "API did not become healthy in 90 seconds:"; tail -50 "$LOGS/api.log"; exit 1; fi
start admin node --import tsx packages/admin-service/server.ts
READY=0
for _ in $(seq 1 60); do
  if http_healthy "http://127.0.0.1:$ADMIN_PORT/health"; then READY=1; break; fi
  running admin || { echo "Admin service failed to start — see .dev-data/logs/admin.log"; tail -20 "$LOGS/admin.log"; exit 1; }
  sleep 1
done
if [ "$READY" != "1" ]; then echo "Admin service did not become healthy in 60 seconds:"; tail -50 "$LOGS/admin.log"; exit 1; fi
start worker node --import tsx packages/execution-service/worker.ts
start scheduler node --import tsx packages/scheduler-service/scheduler.ts

# Frontend: "{host}" = whatever host the page was opened from (localhost or the LAN IP).
# Shared: the API on this server's /api (one origin through the tunnel); else straight to :$API_PORT.
WEB_API_BASE="http://{host}:$API_PORT"
[ -n "$PUBLIC_URL" ] && WEB_API_BASE="/api"
if running web && ! curl -sf --max-time 5 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then
  say "web PID exists but Vite is not responding; restarting it"
  kill -- -"$(cat "$RUN/web.pid")" 2>/dev/null || kill "$(cat "$RUN/web.pid")" 2>/dev/null || true
  rm -f "$RUN/web.pid"
fi
if ! running web; then
  (cd "$FRONTEND"; VITE_API_BASE_URL="$WEB_API_BASE" JP_API_TARGET="http://127.0.0.1:$API_PORT" VITE_ADMIN_API_BASE_URL="http://{host}:$ADMIN_PORT" \
    VITE_API_KEY="$API_KEY" VITE_GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}" setsid npx vite dev --host :: --port "$WEB_PORT" --strictPort \
    >"$LOGS/web.log" 2>&1 < /dev/null & echo $! >"$RUN/web.pid")
  say "started web (log: .dev-data/logs/web.log)"
fi

# Shared: warm up the dev server (first page compile, proxy) so the first visitor isn't kept waiting.
if [ -n "$PUBLIC_URL" ]; then
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$WEB_PORT/" || true
  curl -s -m 60 -o /dev/null "http://127.0.0.1:$WEB_PORT/api/health" || true
fi

say "ready"
urls
