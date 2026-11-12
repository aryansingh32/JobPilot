#!/usr/bin/env bash
# ============================================================
# JobPilot — one-command local test environment
#
# Brings up Postgres + Redis + the API + admin + worker via
# Docker Compose (packages/api-service and packages/execution-service,
# including the Playwright browser they need), then runs the
# chatflow-interface frontend dev server in the foreground.
#
# First run: creates backend/.env and chatflow-interface/.env from
# their .env.example files and fills in the secrets that have no safe
# default (API_KEY, SESSION_JWT_SECRET, APP_SECRET_KEY, an admin
# username/password) so the stack boots without manual setup. Any
# value you've already set is left untouched on later runs.
#
# Usage:
#   ./start.sh                 start everything, rebuild images if needed
#   ./start.sh --no-build      skip the docker image rebuild step
#   ./start.sh --no-frontend   only bring up Postgres/Redis/API/admin/worker
#   ./start.sh --no-scheduler  skip the scheduler service (change detection,
#                              selector-health-triggered remaps, proxy/session
#                              cleanup — self-healing runs by default)
#   ./start.sh --observability also start Prometheus + Grafana
#   ./start.sh -h              show this help
#
# Stop with ./stop.sh (Ctrl+C here only stops the frontend dev server —
# the Docker services keep running so they don't need a slow rebuild
# next time).
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/chatflow-interface"

BUILD=1
START_FRONTEND=1
OBSERVABILITY=0
SCHEDULER=1

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-frontend) START_FRONTEND=0 ;;
    --no-scheduler) SCHEDULER=0 ;;
    --observability) OBSERVABILITY=1 ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use -h for help)" >&2
      exit 1
      ;;
  esac
done

# ── Output helpers ────────────────────────────────────────────
c_info()  { printf '\033[36m[start]\033[0m %s\n' "$1"; }
c_ok()    { printf '\033[32m[ ok ]\033[0m %s\n' "$1"; }
c_warn()  { printf '\033[33m[warn]\033[0m %s\n' "$1"; }
c_err()   { printf '\033[31m[fail]\033[0m %s\n' "$1" >&2; }
http_healthy() {
  curl -fsS --max-time 3 "$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).status==="healthy"?0:1)}catch{process.exit(1)}})' \
    2>/dev/null
}

# ── Prerequisite checks ───────────────────────────────────────
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    c_err "Missing required command: $1"
    exit 1
  fi
}
require_cmd docker
require_cmd node
require_cmd npm

DOCKER_COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker-compose)
  else
    c_err "Neither 'docker compose' nor 'docker-compose' is available. Install Docker Desktop / the Compose plugin first."
    exit 1
  fi
fi
if ! docker info >/dev/null 2>&1; then
  c_err "Docker daemon isn't running. Start Docker Desktop (or the docker service) and re-run this script."
  exit 1
fi

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
  fi
}
gen_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 9
  else
    node -e "process.stdout.write(require('crypto').randomBytes(9).toString('hex'))"
  fi
}

# Fill in only the blank/missing keys in an .env file; anything the user
# already set (including a deliberately blank optional value from a prior
# run) is left exactly as-is except for the keys listed in FORCE_KEYS.
env_fill() {
  local file="$1" json="$2" force_json="${3:-[]}"
  node -e '
    const fs = require("fs");
    const [file, json, forceJson] = process.argv.slice(1);
    const updates = JSON.parse(json);
    const force = JSON.parse(forceJson);
    let lines = fs.readFileSync(file, "utf8").split("\n");
    const seen = new Set();
    lines = lines.map((line) => {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return line;
      const [, key, val] = m;
      if (key in updates) {
        seen.add(key);
        if (force.includes(key) || val.trim() === "") {
          return `${key}=${updates[key]}`;
        }
      }
      return line;
    });
    for (const [k, v] of Object.entries(updates)) {
      if (!seen.has(k)) lines.push(`${k}=${v}`);
    }
    fs.writeFileSync(file, lines.join("\n"));
  ' "$file" "$json" "$force_json"
}

env_read() {
  local file="$1" key="$2"
  node -e '
    const fs = require("fs");
    const [file, key] = process.argv.slice(1);
    const m = fs.readFileSync(file, "utf8").match(new RegExp("^" + key + "=(.*)$", "m"));
    process.stdout.write(m ? m[1].trim() : "");
  ' "$file" "$key"
}

# ── Backend .env bootstrap ─────────────────────────────────────
if [ ! -f "$BACKEND_DIR/.env" ]; then
  c_info "Creating backend/.env from backend/.env.example"
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi

BACKEND_UPDATES=$(node -e '
  console.log(JSON.stringify({
    API_KEY: process.argv[1],
    SESSION_JWT_SECRET: process.argv[2],
    APP_SECRET_KEY: process.argv[3],
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: process.argv[4],
  }));
' "$(gen_secret)" "$(gen_secret)" "$(gen_secret)" "$(gen_password)")
env_fill "$BACKEND_DIR/.env" "$BACKEND_UPDATES"

API_KEY_VALUE=$(env_read "$BACKEND_DIR/.env" "API_KEY")
ADMIN_USERNAME_VALUE=$(env_read "$BACKEND_DIR/.env" "ADMIN_USERNAME")
ADMIN_PASSWORD_VALUE=$(env_read "$BACKEND_DIR/.env" "ADMIN_PASSWORD")
API_PUBLIC_PORT_VALUE=$(env_read "$BACKEND_DIR/.env" "API_PUBLIC_PORT")
API_PUBLIC_PORT_VALUE="${API_PUBLIC_PORT_VALUE:-3000}"

if [ -z "$(env_read "$BACKEND_DIR/.env" "COARENA_API_KEY")" ] \
  && [ -z "$(env_read "$BACKEND_DIR/.env" "OPENROUTER_API_KEY")" ] \
  && [ -z "$(env_read "$BACKEND_DIR/.env" "OPENAI_API_KEY")" ] \
  && [ -z "$(env_read "$BACKEND_DIR/.env" "ANTHROPIC_API_KEY")" ]; then
  c_warn "No COARENA_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY set in backend/.env — chat replies and workflow planning need one. Everything else (auth, admin panel, DB) will still work."
fi
if [ -z "$(env_read "$BACKEND_DIR/.env" "GOOGLE_CLIENT_ID")" ]; then
  c_warn "GOOGLE_CLIENT_ID is unset — Google sign-in will be unavailable, but email/mobile OTP login still works (codes print to the API container's logs since no SMTP/Twilio is configured)."
fi

# ── Frontend .env bootstrap ────────────────────────────────────
if [ ! -f "$FRONTEND_DIR/.env" ]; then
  c_info "Creating chatflow-interface/.env from chatflow-interface/.env.example"
  cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env"
fi
# VITE_API_KEY must equal the backend's API_KEY or every request 401s, so
# this one is always kept in sync rather than only filled when blank.
FRONTEND_UPDATES=$(node -e '
  console.log(JSON.stringify({
    VITE_API_BASE_URL: `http://localhost:${process.argv[1]}`,
    VITE_API_KEY: process.argv[2],
  }));
' "$API_PUBLIC_PORT_VALUE" "$API_KEY_VALUE")
env_fill "$FRONTEND_DIR/.env" "$FRONTEND_UPDATES" '["VITE_API_KEY","VITE_API_BASE_URL"]'

# ── Bring up Docker services ───────────────────────────────────
COMPOSE_SERVICES=(postgres redis api admin worker)
COMPOSE_PROFILE_ARGS=()
if [ "$SCHEDULER" = "1" ]; then
  COMPOSE_PROFILE_ARGS+=(--profile scheduler)
  COMPOSE_SERVICES+=(scheduler)
fi
if [ "$OBSERVABILITY" = "1" ]; then
  COMPOSE_PROFILE_ARGS+=(--profile observability)
  COMPOSE_SERVICES+=(prometheus grafana)
fi

BUILD_ARGS=()
if [ "$BUILD" = "1" ]; then
  BUILD_ARGS=(--build)
  c_info "Building/starting Docker services (first build installs Playwright's Chromium — can take a few minutes): ${COMPOSE_SERVICES[*]}"
else
  c_info "Starting Docker services without rebuilding: ${COMPOSE_SERVICES[*]}"
fi

(cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" "${COMPOSE_PROFILE_ARGS[@]}" up -d "${BUILD_ARGS[@]}" "${COMPOSE_SERVICES[@]}")

ADMIN_PUBLIC_PORT_VALUE=$(env_read "$BACKEND_DIR/.env" "ADMIN_PUBLIC_PORT")
ADMIN_PUBLIC_PORT_VALUE="${ADMIN_PUBLIC_PORT_VALUE:-3100}"
c_info "Waiting for API and admin health endpoints ..."
READY=0
for _ in $(seq 1 90); do
  if http_healthy "http://localhost:${API_PUBLIC_PORT_VALUE}/health" \
    && http_healthy "http://localhost:${ADMIN_PUBLIC_PORT_VALUE}/health"; then
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" != "1" ]; then
  c_err "API/admin didn't become healthy in time. Container status and recent logs:"
  (cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" ps && "${DOCKER_COMPOSE[@]}" logs --tail=50 postgres redis api admin worker scheduler)
  exit 1
fi
RUNNING_SERVICES=$(cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" ps --status running --services)
MISSING_SERVICES=()
for service in "${COMPOSE_SERVICES[@]}"; do
  if ! grep -qx "$service" <<<"$RUNNING_SERVICES"; then MISSING_SERVICES+=("$service"); fi
done
if [ "${#MISSING_SERVICES[@]}" -gt 0 ]; then
  c_err "Services failed to stay running: ${MISSING_SERVICES[*]}. Container status and recent logs:"
  (cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" ps && "${DOCKER_COMPOSE[@]}" logs --tail=50 "${MISSING_SERVICES[@]}")
  exit 1
fi
(cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" ps)
c_ok "All requested Compose services are running; API and admin health checks pass."

# ── Frontend deps + dev server ─────────────────────────────────
if [ "$START_FRONTEND" = "1" ]; then
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    c_info "Installing frontend dependencies (first run only) ..."
    (cd "$FRONTEND_DIR" && npm install)
  fi

  echo
  c_ok "Backend stack is up:"
  echo "    API:            http://localhost:${API_PUBLIC_PORT_VALUE}"
  echo "    API health:     http://localhost:${API_PUBLIC_PORT_VALUE}/health"
  echo "    Admin health:   http://localhost:${ADMIN_PUBLIC_PORT_VALUE}/health"
  echo "    Admin login:    http://localhost:5173/admin/login"
  echo "    Admin username: ${ADMIN_USERNAME_VALUE}"
  echo "    Admin password: ${ADMIN_PASSWORD_VALUE}"
  if [ "$OBSERVABILITY" = "1" ]; then
    echo "    Grafana:        http://localhost:$(env_read "$BACKEND_DIR/.env" "GRAFANA_PUBLIC_PORT")  (admin / $(env_read "$BACKEND_DIR/.env" "GRAFANA_PASSWORD"))"
    echo "    Prometheus:     http://localhost:$(env_read "$BACKEND_DIR/.env" "PROMETHEUS_PUBLIC_PORT")"
  fi
  echo
  c_info "Starting the frontend dev server (Ctrl+C stops just this — Docker services keep running; use ./stop.sh to bring them down)."
  echo

  cd "$FRONTEND_DIR" && exec npm run dev
else
  echo
  c_ok "Backend-only stack is up (--no-frontend passed):"
  echo "    API:            http://localhost:${API_PUBLIC_PORT_VALUE}"
  echo "    Admin health:   http://localhost:${ADMIN_PUBLIC_PORT_VALUE}/health"
  echo "    Admin username: ${ADMIN_USERNAME_VALUE}"
  echo "    Admin password: ${ADMIN_PASSWORD_VALUE}"
  echo
  c_info "Run 'cd chatflow-interface && npm run dev' whenever you want the frontend, or re-run without --no-frontend."
fi
