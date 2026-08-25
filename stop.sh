#!/usr/bin/env bash
# Stops the Docker services started by ./start.sh.
#
# Usage:
#   ./stop.sh              stop containers, keep the Postgres/Redis data volumes
#   ./stop.sh --volumes    also DELETE the Postgres/Redis data volumes (wipes the DB)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

DOCKER_COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker-compose)
  else
    echo "Neither 'docker compose' nor 'docker-compose' is available." >&2
    exit 1
  fi
fi

DOWN_ARGS=(--profile observability)
if [ "${1:-}" = "--volumes" ] || [ "${1:-}" = "-v" ]; then
  echo "This will permanently delete the Postgres and Redis data volumes."
  read -r -p "Type 'yes' to continue: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
  DOWN_ARGS+=(--volumes)
fi

(cd "$BACKEND_DIR" && "${DOCKER_COMPOSE[@]}" "${DOWN_ARGS[@]}" down)
echo "Docker services stopped."
