#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT_A="cd-rips"
PROJECT_B="digital-purchases"
PROJECT_C="other"
FED_NETWORK="poutine-local-cluster"

COMPOSE_A="docker compose -f $COMPOSE_FILE -p $PROJECT_A --env-file $SCRIPT_DIR/${PROJECT_A}.env"
COMPOSE_B="docker compose -f $COMPOSE_FILE -p $PROJECT_B --env-file $SCRIPT_DIR/${PROJECT_B}.env"
COMPOSE_C="docker compose -f $COMPOSE_FILE -p $PROJECT_C --env-file $SCRIPT_DIR/${PROJECT_C}.env"

POUTINE_OWNER_USERNAME="xac"
POUTINE_OWNER_PASSWORD="local"

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

# Sync an instance and wait until its local track count is nonzero.
# Outputs the admin JWT to stdout; all progress goes to stderr.
login_and_sync() {
  local port="$1" label="$2" timeout="${3:-180}"
  local elapsed=0

  local login_resp jwt
  login_resp=$(curl -sf -X POST "http://localhost:${port}/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${POUTINE_OWNER_USERNAME}\",\"password\":\"${POUTINE_OWNER_PASSWORD}\"}")
  jwt=$(echo "$login_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

  printf "  Waiting for %s local library..." "$label" >&2
  while true; do
    local sync_resp local_count local_errors
    sync_resp=$(curl -sf -X POST "http://localhost:${port}/admin/sync" \
      -H "Authorization: Bearer $jwt" 2>/dev/null || echo '{"local":{"trackCount":0}}')
    local_count=$(echo "$sync_resp" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('local',{}).get('trackCount',0))" 2>/dev/null || echo "0")

    if [ "$local_count" -gt 0 ]; then
      echo " ${local_count} local tracks" >&2
      echo "$jwt"   # JWT to stdout for capture by caller
      return 0
    fi

    # If Navidrome reports the library is empty/missing, it won't ever have
    # local tracks — accept it and move on (instance may be peers-only).
    local_errors=$(echo "$sync_resp" | python3 -c \
      "import sys,json; errs=json.load(sys.stdin).get('local',{}).get('errors',[]); print(' '.join(errs))" 2>/dev/null || echo "")
    if echo "$local_errors" | grep -qi "library not found or empty"; then
      echo " (empty local library — peers only)" >&2
      echo "$jwt"
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
wait_http "http://localhost:3003/api/health" "hub-c" 120

# The hub now bundles the frontend — no separate frontend service needed.

# echo ""
# echo "==> Syncing hub-b local library (navidrome-b must scan first)..."
# login_and_sync 3002 "hub-b" 180 > /dev/null # only care that it succeeds

# echo ""
# echo "==> Syncing hub-c local library (navidrome-c must scan first)..."
# login_and_sync 3003 "hub-c" 180 > /dev/null # only care that it succeeds

# echo ""
# echo "==> Syncing hub-a (local + federated from hub-b and hub-c)..."
# JWT_A=$(login_and_sync 3001 "hub-a" 180)

# echo ""
# echo "==> Verifying federated metadata on hub-a..."
# ALBUM_LIST=$(curl -sf \
#   "http://localhost:3001/rest/getAlbumList2?u=${POUTINE_OWNER_USERNAME}&p=${POUTINE_OWNER_PASSWORD}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500")

# if ! echo "$ALBUM_LIST" | python3 -c "
# import sys, json
# resp = json.load(sys.stdin)['subsonic-response']
# albums = [a['name'] for a in resp.get('albumList2', {}).get('album', [])]
# assert 'First Album' in albums, 'Missing local album: First Album'
# assert 'Other Album' in albums, 'Missing federated album from hub-b: Other Album'
# assert 'Third Album' in albums, 'Missing federated album from hub-c: Third Album'
# print('  Albums on hub-a: ' + ', '.join(sorted(albums)))
# "; then
#   echo "ERROR: Expected all three albums on hub-a" >&2
#   echo "Album list response: $ALBUM_LIST" >&2
#   exit 1
# fi

# ── Federated stream from hub-b ───────────────────────────────────────────────

# OTHER_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
# import sys, json
# albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
# match = [a for a in albums if a['name'] == 'Other Album']
# print(match[0]['id'])
# ")
# echo "  Other Album ID on hub-a: $OTHER_ALBUM_ID"

# ALBUM_DETAIL=$(curl -sf \
#   "http://localhost:3001/rest/getAlbum?u=${POUTINE_OWNER_USERNAME}&p=${POUTINE_OWNER_PASSWORD}&c=fed-test&v=1.14.0&f=json&id=${OTHER_ALBUM_ID}")
# TRACK_ID_B=$(echo "$ALBUM_DETAIL" | python3 -c "
# import sys, json
# songs = json.load(sys.stdin)['subsonic-response']['album']['song']
# print(songs[0]['id'])
# ")
# echo "  First track ID from Other Album: $TRACK_ID_B"

# echo ""
# echo "==> Testing federated stream from hub-b (hub-a proxies to hub-b's navidrome)..."
# HTTP_CODE=$(curl -s -o /tmp/fed-test-stream-b.bin -w "%{http_code}" \
#   "http://localhost:3001/rest/stream?u=${POUTINE_OWNER_USERNAME}&p=${POUTINE_OWNER_PASSWORD}&c=fed-test&v=1.14.0&id=${TRACK_ID_B}")
# STREAM_SIZE=$(wc -c < /tmp/fed-test-stream-b.bin | tr -d ' ')

# echo "  HTTP status   : $HTTP_CODE"
# echo "  Bytes received: $STREAM_SIZE"

# if [ "$HTTP_CODE" != "200" ]; then
#   echo "ERROR: expected HTTP 200 for federated stream from hub-b, got $HTTP_CODE" >&2
#   exit 1
# fi
# if [ "$STREAM_SIZE" -lt 1000 ]; then
#   echo "ERROR: streamed file from hub-b too small (${STREAM_SIZE} bytes) — expected real audio" >&2
#   exit 1
# fi

# # ── Federated stream from hub-c ───────────────────────────────────────────────

# THIRD_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
# import sys, json
# albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
# match = [a for a in albums if a['name'] == 'Third Album']
# print(match[0]['id'])
# ")
# echo "  Third Album ID on hub-a: $THIRD_ALBUM_ID"

# ALBUM_DETAIL_C=$(curl -sf \
#   "http://localhost:3001/rest/getAlbum?u=${POUTINE_OWNER_USERNAME}&p=${POUTINE_OWNER_PASSWORD}&c=fed-test&v=1.14.0&f=json&id=${THIRD_ALBUM_ID}")
# TRACK_ID_C=$(echo "$ALBUM_DETAIL_C" | python3 -c "
# import sys, json
# songs = json.load(sys.stdin)['subsonic-response']['album']['song']
# print(songs[0]['id'])
# ")
# echo "  First track ID from Third Album: $TRACK_ID_C"

# echo ""
# echo "==> Testing federated stream from hub-c (hub-a proxies to hub-c's navidrome)..."
# HTTP_CODE=$(curl -s -o /tmp/fed-test-stream-c.bin -w "%{http_code}" \
#   "http://localhost:3001/rest/stream?u=${POUTINE_OWNER_USERNAME}&p=${POUTINE_OWNER_PASSWORD}&c=fed-test&v=1.14.0&id=${TRACK_ID_C}")
# STREAM_SIZE=$(wc -c < /tmp/fed-test-stream-c.bin | tr -d ' ')

# echo "  HTTP status   : $HTTP_CODE"
# echo "  Bytes received: $STREAM_SIZE"

# if [ "$HTTP_CODE" != "200" ]; then
#   echo "ERROR: expected HTTP 200 for federated stream from hub-c, got $HTTP_CODE" >&2
#   exit 1
# fi
# if [ "$STREAM_SIZE" -lt 1000 ]; then
#   echo "ERROR: streamed file from hub-c too small (${STREAM_SIZE} bytes) — expected real audio" >&2
#   exit 1
# fi

# echo ""
# echo "==> All assertions passed!"

PASSED=1
$COMPOSE_A logs -f

# while (sleep 5); do
#   echo -n "....."
# done

cleanup
