#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT_A="cd-rips"
PROJECT_B="digital-purchases"
PROJECT_C="other"
FED_NETWORK="poutine-local-cluster"

COMPOSE_A="docker compose -f $COMPOSE_FILE -p $PROJECT_A --env-file $SCRIPT_DIR/${PROJECT_A}.env"
COMPOSE_B="docker compose -f $COMPOSE_FILE -p $PROJECT_B --env-file $SCRIPT_DIR/${PROJECT_B}.env"
COMPOSE_C="docker compose -f $COMPOSE_FILE -p $PROJECT_C --env-file $SCRIPT_DIR/${PROJECT_C}.env"

# ── Cleanup ───────────────────────────────────────────────────────────────────

PASSED=0
cleanup() {
  if [ "$PASSED" -eq 0 ]; then
    echo "" >&2
    echo "=== FAILURE: hub-a logs ===" >&2
    $COMPOSE_A logs --no-color hub 2>/dev/null | tail -40 >&2
    echo "=== FAILURE: hub-b logs ===" >&2
    $COMPOSE_B logs --no-color hub 2>/dev/null | tail -40 >&2
    echo "=== FAILURE: hub-c logs ===" >&2
    $COMPOSE_C logs --no-color hub 2>/dev/null | tail -40 >&2
  fi
  echo ""
  echo "==> Tearing down federation stacks..."
  $COMPOSE_A down -v 2>/dev/null || true
  $COMPOSE_B down -v 2>/dev/null || true
  $COMPOSE_C down -v 2>/dev/null || true
  docker network rm "$FED_NETWORK" 2>/dev/null || true
}
trap cleanup EXIT

# ── Boot ──────────────────────────────────────────────────────────────────────

echo "==> Tearing down any previous federation stacks..."
$COMPOSE_A down -v 2>/dev/null || true
$COMPOSE_B down -v 2>/dev/null || true
$COMPOSE_C down -v 2>/dev/null || true
docker network rm "$FED_NETWORK" 2>/dev/null || true

echo "==> Creating shared federation network..."
docker network create "$FED_NETWORK"

# Pre-populate hub data volumes with the committed test keypairs so each hub
# boots with a known identity (matching the public keys in peers-{a,b,c}.yaml).
echo "==> Pre-populating hub data volumes with test keys..."
docker volume create "${PROJECT_A}_hub-data"
docker volume create "${PROJECT_B}_hub-data"
docker volume create "${PROJECT_C}_hub-data"
docker run --rm \
  -v "${PROJECT_A}_hub-data:/data" \
  -v "$REPO_ROOT/test/federation/keys:/keys:ro" \
  alpine cp /keys/poutine-a_ed25519.pem /data/poutine_ed25519.pem
docker run --rm \
  -v "${PROJECT_B}_hub-data:/data" \
  -v "$REPO_ROOT/test/federation/keys:/keys:ro" \
  alpine cp /keys/poutine-b_ed25519.pem /data/poutine_ed25519.pem
docker run --rm \
  -v "${PROJECT_C}_hub-data:/data" \
  -v "$REPO_ROOT/test/federation/keys:/keys:ro" \
  alpine cp /keys/poutine-c_ed25519.pem /data/poutine_ed25519.pem

echo "==> Building and starting federation stacks (hub + navidrome only)..."
$COMPOSE_A up -d --build --force-recreate hub navidrome
$COMPOSE_B up -d --build --force-recreate hub navidrome
$COMPOSE_C up -d --build --force-recreate hub navidrome

# Connect hub containers to the shared network with stable DNS aliases so that
# peers-{a,b,c}.yaml URLs (http://hub-{a,b,c}:3000) resolve.
echo "==> Connecting hubs to shared federation network..."
docker network connect --alias hub-a "$FED_NETWORK" "${PROJECT_A}-hub-1"
docker network connect --alias hub-b "$FED_NETWORK" "${PROJECT_B}-hub-1"
docker network connect --alias hub-c "$FED_NETWORK" "${PROJECT_C}-hub-1"

# ── Wait helpers ──────────────────────────────────────────────────────────────

wait_http() {
  local url="$1" label="$2" timeout="${3:-120}"
  local elapsed=0
  printf "  Waiting for %s..." "$label" >&2
  while true; do
    if curl -sf --max-time 3 "$url" > /dev/null 2>&1; then
      echo " up" >&2
      return 0
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "" >&2
      echo "ERROR: $label did not become available within ${timeout}s" >&2
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    printf "." >&2
  done
}

# ── Test execution ────────────────────────────────────────────────────────────

echo ""
echo "==> Checking hub health..."
wait_http "http://localhost:3001/api/health" "hub-a" 120
wait_http "http://localhost:3002/api/health" "hub-b" 120
wait_http "http://localhost:3003/api/health" "hub-c" 120

PASSED=1
$COMPOSE_A logs -f

cleanup
