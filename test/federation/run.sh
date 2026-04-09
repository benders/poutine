#!/usr/bin/env bash
# Federation regression test
#
# Starts two complete Poutine stacks (hub + Navidrome each), federated together,
# using the same docker-compose.yml with separate project names and env files.
# Verifies metadata sync and federated audio streaming end-to-end.
#
# Usage:
#   pnpm test:federation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT_A="poutine-fed-a"
PROJECT_B="poutine-fed-b"
FED_NETWORK="poutine-federation-test"

COMPOSE_A="docker compose -f $COMPOSE_FILE -p $PROJECT_A --env-file $SCRIPT_DIR/a.env"
COMPOSE_B="docker compose -f $COMPOSE_FILE -p $PROJECT_B --env-file $SCRIPT_DIR/b.env"

SUB_USER="owner"
SUB_PASS="federation-test-password"

# ── Cleanup ───────────────────────────────────────────────────────────────────

PASSED=0
cleanup() {
  if [ "$PASSED" -eq 0 ]; then
    echo "" >&2
    echo "=== FAILURE: hub-a logs ===" >&2
    $COMPOSE_A logs --no-color hub 2>/dev/null | tail -40 >&2
    echo "=== FAILURE: hub-b logs ===" >&2
    $COMPOSE_B logs --no-color hub 2>/dev/null | tail -40 >&2
  fi
  echo ""
  echo "==> Tearing down federation stacks..."
  $COMPOSE_A down -v 2>/dev/null || true
  $COMPOSE_B down -v 2>/dev/null || true
  docker network rm "$FED_NETWORK" 2>/dev/null || true
}
trap cleanup EXIT

# ── Boot ──────────────────────────────────────────────────────────────────────

echo "==> Tearing down any previous federation stacks..."
$COMPOSE_A down -v 2>/dev/null || true
$COMPOSE_B down -v 2>/dev/null || true
docker network rm "$FED_NETWORK" 2>/dev/null || true

echo "==> Creating shared federation network..."
docker network create "$FED_NETWORK"

# Pre-populate hub data volumes with the committed test keypairs so each hub
# boots with a known identity (matching the public keys in peers-{a,b}.yaml).
echo "==> Pre-populating hub data volumes with test keys..."
docker volume create "${PROJECT_A}_hub-data"
docker volume create "${PROJECT_B}_hub-data"
docker run --rm \
  -v "${PROJECT_A}_hub-data:/data" \
  -v "$SCRIPT_DIR/keys:/keys:ro" \
  alpine cp /keys/poutine-a_ed25519.pem /data/poutine_ed25519.pem
docker run --rm \
  -v "${PROJECT_B}_hub-data:/data" \
  -v "$SCRIPT_DIR/keys:/keys:ro" \
  alpine cp /keys/poutine-b_ed25519.pem /data/poutine_ed25519.pem

echo "==> Building and starting federation stacks (hub + navidrome only)..."
$COMPOSE_A up -d --build hub navidrome
$COMPOSE_B up -d --build hub navidrome

# Connect hub containers to the shared network with stable DNS aliases so that
# peers-a.yaml (http://hub-a:3000) and peers-b.yaml (http://hub-b:3000) resolve.
echo "==> Connecting hubs to shared federation network..."
docker network connect --alias hub-a "$FED_NETWORK" "${PROJECT_A}-hub-1"
docker network connect --alias hub-b "$FED_NETWORK" "${PROJECT_B}-hub-1"

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

# Sync an instance and wait until its local track count is nonzero.
# Outputs the admin JWT to stdout; all progress goes to stderr.
login_and_sync() {
  local port="$1" label="$2" timeout="${3:-180}"
  local elapsed=0

  local login_resp jwt
  login_resp=$(curl -sf -X POST "http://localhost:${port}/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"owner\",\"password\":\"${SUB_PASS}\"}")
  jwt=$(echo "$login_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

  printf "  Waiting for %s local library..." "$label" >&2
  while true; do
    local sync_resp local_count
    sync_resp=$(curl -sf -X POST "http://localhost:${port}/admin/sync" \
      -H "Authorization: Bearer $jwt" 2>/dev/null || echo '{"local":{"trackCount":0}}')
    local_count=$(echo "$sync_resp" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('local',{}).get('trackCount',0))" 2>/dev/null || echo "0")

    if [ "$local_count" -gt 0 ]; then
      echo " ${local_count} local tracks" >&2
      echo "$jwt"   # JWT to stdout for capture by caller
      return 0
    fi

    if [ "$elapsed" -ge "$timeout" ]; then
      echo "" >&2
      echo "ERROR: $label local library empty after ${timeout}s" >&2
      echo "Last sync response: $sync_resp" >&2
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    printf "." >&2
  done
}

# ── Test execution ────────────────────────────────────────────────────────────

echo ""
echo "==> Checking hub health..."
wait_http "http://localhost:3001/api/health" "hub-a" 120
wait_http "http://localhost:3002/api/health" "hub-b" 120

echo ""
echo "==> Syncing hub-b local library (navidrome-b must scan first)..."
login_and_sync 3002 "hub-b" 180 > /dev/null  # only care that it succeeds

echo ""
echo "==> Syncing hub-a (local + federated from hub-b)..."
JWT_A=$(login_and_sync 3001 "hub-a" 180)

echo ""
echo "==> Verifying federated metadata on hub-a..."
ALBUM_LIST=$(curl -sf \
  "http://localhost:3001/rest/getAlbumList2?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500")

if ! echo "$ALBUM_LIST" | python3 -c "
import sys, json
resp = json.load(sys.stdin)['subsonic-response']
albums = [a['name'] for a in resp.get('albumList2', {}).get('album', [])]
assert 'First Album' in albums, 'Missing local album: First Album'
assert 'Other Album' in albums, 'Missing federated album: Other Album'
print('  Albums on hub-a: ' + ', '.join(sorted(albums)))
"; then
  echo "ERROR: Expected both 'First Album' and 'Other Album' on hub-a" >&2
  echo "Album list response: $ALBUM_LIST" >&2
  exit 1
fi

# Locate "Other Album" ID (peer content from hub-b)
OTHER_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
import sys, json
albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
match = [a for a in albums if a['name'] == 'Other Album']
print(match[0]['id'])
")
echo "  Other Album ID on hub-a: $OTHER_ALBUM_ID"

# Get a track ID from that album
ALBUM_DETAIL=$(curl -sf \
  "http://localhost:3001/rest/getAlbum?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&id=${OTHER_ALBUM_ID}")
TRACK_ID=$(echo "$ALBUM_DETAIL" | python3 -c "
import sys, json
songs = json.load(sys.stdin)['subsonic-response']['album']['song']
print(songs[0]['id'])
")
echo "  First track ID from Other Album: $TRACK_ID"

echo ""
echo "==> Testing federated stream (hub-a proxies to hub-b's navidrome)..."
HTTP_CODE=$(curl -s -o /tmp/fed-test-stream.bin -w "%{http_code}" \
  "http://localhost:3001/rest/stream?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&id=${TRACK_ID}")
STREAM_SIZE=$(wc -c < /tmp/fed-test-stream.bin | tr -d ' ')

echo "  HTTP status   : $HTTP_CODE"
echo "  Bytes received: $STREAM_SIZE"

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: expected HTTP 200 for federated stream, got $HTTP_CODE" >&2
  exit 1
fi
if [ "$STREAM_SIZE" -lt 1000 ]; then
  echo "ERROR: streamed file too small (${STREAM_SIZE} bytes) — expected real audio" >&2
  exit 1
fi

echo ""
echo "==> All assertions passed!"
PASSED=1
