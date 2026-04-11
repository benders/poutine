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

# ── Boot ──────────────────────────────────────────────────────────────────────

echo "==> Building and starting federation stacks (hub + navidrome only)..."
$COMPOSE_A up -d --build --force-recreate hub #navidrome
$COMPOSE_B up -d --build --force-recreate hub #navidrome
$COMPOSE_C up -d --build --force-recreate hub #navidrome

# Connect hub containers to the shared network with stable DNS aliases so that
# peers-{a,b,c}.yaml URLs (http://hub-{a,b,c}:3000) resolve.
echo "==> Connecting hubs to shared federation network..."
docker network connect --alias hub-a "$FED_NETWORK" "${PROJECT_A}-hub-1"
docker network connect --alias hub-b "$FED_NETWORK" "${PROJECT_B}-hub-1"
docker network connect --alias hub-c "$FED_NETWORK" "${PROJECT_C}-hub-1"
