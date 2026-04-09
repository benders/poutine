#!/usr/bin/env bash
# clean-wipe.sh — Tear down all containers + volumes and start from a clean state.
# Waits for Navidrome to finish its initial library scan, then triggers a Poutine sync.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 1. Validate .env
# ---------------------------------------------------------------------------
ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  echo "       Copy example.env to .env and fill in values." >&2
  exit 1
fi

# Source .env so we can validate variable values
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REQUIRED_VARS=(
  JWT_SECRET
  NAVIDROME_USERNAME
  NAVIDROME_PASSWORD
  POUTINE_INSTANCE_ID
  POUTINE_OWNER_USERNAME
  POUTINE_OWNER_PASSWORD
)

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: The following required variables are not set in .env:" >&2
  for var in "${MISSING[@]}"; do
    echo "       $var" >&2
  done
  exit 1
fi

echo "All required environment variables are set."

# ---------------------------------------------------------------------------
# 2. Confirm destructive action
# ---------------------------------------------------------------------------
echo ""
echo "WARNING: This will permanently delete all Poutine data:"
echo "         - hub-data volume (Poutine SQLite DB, private key, art cache)"
echo "         - navidrome-data volume (Navidrome DB, transcoding cache)"
echo ""
read -r -p "Type YES to continue: " CONFIRM
if [[ "$CONFIRM" != "YES" ]]; then
  echo "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Tear down
# ---------------------------------------------------------------------------
echo ""
echo "==> Stopping and removing containers + volumes..."
docker compose down -v --remove-orphans

# ---------------------------------------------------------------------------
# 4. Start fresh
# ---------------------------------------------------------------------------
echo ""
echo "==> Building images and starting services..."
docker compose up --build -d

# ---------------------------------------------------------------------------
# 5. Wait for Navidrome scan to complete
# ---------------------------------------------------------------------------
echo ""
echo "==> Waiting for Navidrome initial library scan to complete..."
TIMEOUT=600  # 10 minutes
ELAPSED=0
INTERVAL=5

while true; do
  if docker compose logs navidrome 2>/dev/null | grep -q "Scan completed"; then
    echo "    Scan complete."
    break
  fi
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo "ERROR: Timed out waiting for Navidrome scan after ${TIMEOUT}s." >&2
    echo "       Run: docker compose logs navidrome" >&2
    exit 1
  fi
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "    Still scanning... (${ELAPSED}s elapsed)"
done

# ---------------------------------------------------------------------------
# 6. Trigger Poutine sync
# ---------------------------------------------------------------------------
echo ""
echo "==> Triggering Poutine sync..."

HUB_URL="http://localhost:3000"

# Wait for hub to be ready
ELAPSED=0
until curl -sf "$HUB_URL/api/health" >/dev/null 2>&1; do
  if [[ $ELAPSED -ge 30 ]]; then
    echo "ERROR: Hub did not become healthy within 30s." >&2
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

ACCESS_TOKEN=$(curl -sf -X POST "$HUB_URL/admin/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$POUTINE_OWNER_USERNAME\",\"password\":\"$POUTINE_OWNER_PASSWORD\"}" \
  | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "ERROR: Failed to log in to Poutine hub. Check POUTINE_OWNER_USERNAME/PASSWORD." >&2
  exit 1
fi

SYNC_RESULT=$(curl -sf -X POST "$HUB_URL/admin/sync" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

TRACK_COUNT=$(echo "$SYNC_RESULT" | grep -o '"trackCount":[0-9]*' | head -1 | cut -d: -f2)
ERRORS=$(echo "$SYNC_RESULT" | grep -o '"errors":\[[^]]*\]' | head -1)

echo "    Sync result: ${TRACK_COUNT:-0} tracks imported"
if echo "$ERRORS" | grep -qv '"errors":\[\]'; then
  echo "    Errors: $ERRORS"
fi

echo ""
echo "Done. Poutine is running at http://localhost:8080"
