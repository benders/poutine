#!/usr/bin/env bash
# Federation regression test
#
# Starts three complete Poutine stacks (hub + Navidrome each), federated together,
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
PROJECT_C="poutine-fed-c"
FED_NETWORK="poutine-federation-test"

COMPOSE_A="docker compose -f $COMPOSE_FILE -p $PROJECT_A --env-file $SCRIPT_DIR/a.env"
COMPOSE_B="docker compose -f $COMPOSE_FILE -p $PROJECT_B --env-file $SCRIPT_DIR/b.env"
COMPOSE_C="docker compose -f $COMPOSE_FILE -p $PROJECT_C --env-file $SCRIPT_DIR/c.env"

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
echo "==> Removing existing hub data volumes..."
docker volume rm -f "${PROJECT_A}_hub-data"
docker volume rm -f "${PROJECT_B}_hub-data"
docker volume rm -f "${PROJECT_C}_hub-data"

echo "==> Pre-populating hub data volumes with test keys..."
docker volume create "${PROJECT_A}_hub-data"
docker volume create "${PROJECT_B}_hub-data"
docker volume create "${PROJECT_C}_hub-data"
docker run --rm \
  -v "${PROJECT_A}_hub-data:/data" \
  -v "$SCRIPT_DIR/keys:/keys:ro" \
  alpine cp /keys/poutine-a_ed25519.pem /data/poutine_ed25519.pem
docker run --rm \
  -v "${PROJECT_B}_hub-data:/data" \
  -v "$SCRIPT_DIR/keys:/keys:ro" \
  alpine cp /keys/poutine-b_ed25519.pem /data/poutine_ed25519.pem
docker run --rm \
  -v "${PROJECT_C}_hub-data:/data" \
  -v "$SCRIPT_DIR/keys:/keys:ro" \
  alpine cp /keys/poutine-c_ed25519.pem /data/poutine_ed25519.pem

echo "==> Building and starting federation stacks (hub + navidrome only)..."
$COMPOSE_A up -d --build hub navidrome
$COMPOSE_B up -d --build hub navidrome
$COMPOSE_C up -d --build hub navidrome

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
    -d "{\"username\":\"owner\",\"password\":\"${SUB_PASS}\"}")
  jwt=$(echo "$login_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

  printf "  Waiting for %s local library..." "$label" >&2
  while true; do
    local sync_resp local_count
    sync_resp=$(curl -sf -X POST "http://localhost:${port}/api/admin/hub/sync" \
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

# ── v5 invitation admission helpers ───────────────────────────────────────────

login_only() {
  # echoes the admin JWT
  local port="$1"
  curl -sf -X POST "http://localhost:${port}/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"owner\",\"password\":\"${SUB_PASS}\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])"
}

# admit <inviter-port> <inviter-url-on-fed-net> <invitee-port> <invitee-url-on-fed-net>
# Inviter issues a v5 signed invitation; invitee posts it to inviter's
# /federation/handshake via /admin/peers/accept. Both hubs end up with each
# other in their `instances` table.
admit() {
  local in_port="$1" in_url="$2" out_port="$3" out_url="$4"
  local in_jwt out_jwt invite invite_resp accept_resp
  in_jwt=$(login_only "$in_port")
  out_jwt=$(login_only "$out_port")

  invite_resp=$(curl -sf -X POST "http://localhost:${in_port}/api/admin/hub/peers/invite" \
    -H "Authorization: Bearer $in_jwt" \
    -H "Content-Type: application/json" \
    -d "{\"ourUrl\":\"${in_url}\",\"inviteeUrl\":\"${out_url}\",\"expiresInSec\":600}")
  invite=$(echo "$invite_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['invitation'])")

  accept_resp=$(curl -sf -X POST "http://localhost:${out_port}/api/admin/hub/peers/accept" \
    -H "Authorization: Bearer $out_jwt" \
    -H "Content-Type: application/json" \
    -d "{\"invitation\":\"${invite}\",\"ourUrl\":\"${out_url}\"}")
  echo "  admitted: $(echo "$accept_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('peerId','?'))")"
}

# ── Test execution ────────────────────────────────────────────────────────────

echo ""
echo "==> Checking hub health..."
wait_http "http://localhost:3011/api/health" "hub-a" 120
wait_http "http://localhost:3012/api/health" "hub-b" 120
wait_http "http://localhost:3013/api/health" "hub-c" 120

echo ""
echo "==> Admitting peers via v5 signed invitations..."
# Direct admission for two pairs; hub-a discovers hub-c via gossip during sync.
admit 3011 "http://hub-a:3000" 3012 "http://hub-b:3000"   # a ↔ b
admit 3012 "http://hub-b:3000" 3013 "http://hub-c:3000"   # b ↔ c

echo ""
echo "==> Syncing hub-c local library (navidrome-c must scan first)..."
login_and_sync 3013 "hub-c" 180 > /dev/null  # only care that it succeeds

echo ""
echo "==> Syncing hub-b local library (navidrome-b must scan first)..."
login_and_sync 3012 "hub-b" 180 > /dev/null  # only care that it succeeds

echo ""
echo "==> Syncing hub-a (local + federated from hub-b and hub-c)..."
JWT_A=$(login_and_sync 3011 "hub-a" 180)

# ── #252: real on-disk paths via native-API player provisioning ───────────────
# After a local sync, instance_tracks.path for the LOCAL instance must be real
# absolute paths (prefix "/music/"), not Navidrome's tag-derived virtual paths.
# This locks in end-to-end that the navidrome-native provisioning pass ran
# inside the Docker cluster (no ND_SUBSONIC_DEFAULTREPORTREALPATH env flag).
echo ""
echo "==> Verifying hub-a local tracks report real /music/ paths (#252)..."
PATH_STATS=$($COMPOSE_A exec -T hub node -e "
const { execSync } = require('child_process');
const dir = execSync('find /app/node_modules/.pnpm -maxdepth 3 -name better-sqlite3 -type d 2>/dev/null | head -1').toString().trim();
const db = new (require(dir))('/app/data/poutine.db', { readonly: true });
const r = db.prepare(\"SELECT COUNT(*) AS total, SUM(CASE WHEN path LIKE '/music/%' THEN 1 ELSE 0 END) AS real FROM instance_tracks WHERE instance_id='local'\").get();
console.log(JSON.stringify(r));
")
echo "  Local path stats: $PATH_STATS"
if ! echo "$PATH_STATS" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
assert r['total'] > 0, f'no local instance_tracks rows: {r}'
assert r['real'] == r['total'], f'local tracks not on real /music/ paths: {r}'
"; then
  echo "ERROR: hub-a local tracks are not reporting real /music/ paths — native-API provisioning did not take effect" >&2
  exit 1
fi

echo ""
echo "==> Verifying federated metadata on hub-a..."
ALBUM_LIST=$(curl -sf \
  "http://localhost:3011/rest/getAlbumList2?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500")

if ! echo "$ALBUM_LIST" | python3 -c "
import sys, json
resp = json.load(sys.stdin)['subsonic-response']
albums = [a['name'] for a in resp.get('albumList2', {}).get('album', [])]
assert 'First Album' in albums, 'Missing local album: First Album'
assert 'Other Album' in albums, 'Missing federated album from hub-b: Other Album'
assert 'Third Album' in albums, 'Missing federated album from hub-c: Third Album'
print('  Albums on hub-a: ' + ', '.join(sorted(albums)))
"; then
  echo "ERROR: Expected all three albums on hub-a" >&2
  echo "Album list response: $ALBUM_LIST" >&2
  exit 1
fi

# ── Issue #123: peers exposed as MusicFolders ─────────────────────────────────
echo ""
echo "==> Verifying getMusicFolders exposes local + 2 peers on hub-a..."
FOLDERS_JSON=$(curl -sf \
  "http://localhost:3011/rest/getMusicFolders?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json")
LOCAL_FOLDER_ID=$(echo "$FOLDERS_JSON" | python3 -c "
import sys, json
folders = json.load(sys.stdin)['subsonic-response']['musicFolders']['musicFolder']
assert len(folders) >= 3, f'expected >=3 folders (self + 2 peers), got {len(folders)}: {folders}'
ids = [f['id'] for f in folders]
assert all(isinstance(i, int) for i in ids), f'non-int folder ids: {ids}'
assert len(set(ids)) == len(ids), f'duplicate folder ids: {ids}'
local = [f for f in folders if f['name'] == 'Local']
assert local, f'no Local folder in {folders}'
print(local[0]['id'])
print('  Folders on hub-a: ' + ', '.join(f\"{f['id']}={f['name']}\" for f in folders), file=sys.stderr)
")
echo "  Local folder id: $LOCAL_FOLDER_ID"

echo "==> Verifying musicFolderId scopes getAlbumList2 to the local folder..."
LOCAL_ALBUMS=$(curl -sf \
  "http://localhost:3011/rest/getAlbumList2?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500&musicFolderId=${LOCAL_FOLDER_ID}")
if ! echo "$LOCAL_ALBUMS" | python3 -c "
import sys, json
albums = [a['name'] for a in json.load(sys.stdin)['subsonic-response'].get('albumList2', {}).get('album', [])]
assert 'First Album' in albums, f'Local folder missing local album: {albums}'
assert 'Other Album' not in albums, f'Local folder leaked peer-b album: {albums}'
assert 'Third Album' not in albums, f'Local folder leaked peer-c album: {albums}'
print('  Local-folder albums on hub-a: ' + ', '.join(sorted(albums)))
"; then
  echo "ERROR: musicFolderId filter did not isolate the local folder" >&2
  echo "Response: $LOCAL_ALBUMS" >&2
  exit 1
fi

# ── Federated stream from hub-b ───────────────────────────────────────────────

OTHER_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
import sys, json
albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
match = [a for a in albums if a['name'] == 'Other Album']
print(match[0]['id'])
")
echo "  Other Album ID on hub-a: $OTHER_ALBUM_ID"

ALBUM_DETAIL=$(curl -sf \
  "http://localhost:3011/rest/getAlbum?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&id=${OTHER_ALBUM_ID}")
TRACK_ID_B=$(echo "$ALBUM_DETAIL" | python3 -c "
import sys, json
songs = json.load(sys.stdin)['subsonic-response']['album']['song']
print(songs[0]['id'])
")
echo "  First track ID from Other Album: $TRACK_ID_B"

echo ""
echo "==> Testing federated stream from hub-b (hub-a proxies to hub-b's navidrome)..."
HTTP_CODE=$(curl -s -o /tmp/fed-test-stream-b.bin -w "%{http_code}" \
  "http://localhost:3011/rest/stream?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&id=${TRACK_ID_B}")
STREAM_SIZE=$(wc -c < /tmp/fed-test-stream-b.bin | tr -d ' ')

echo "  HTTP status   : $HTTP_CODE"
echo "  Bytes received: $STREAM_SIZE"

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: expected HTTP 200 for federated stream from hub-b, got $HTTP_CODE" >&2
  exit 1
fi
if [ "$STREAM_SIZE" -lt 1000 ]; then
  echo "ERROR: streamed file from hub-b too small (${STREAM_SIZE} bytes) — expected real audio" >&2
  exit 1
fi

# ── Federated stream from hub-c ───────────────────────────────────────────────

THIRD_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
import sys, json
albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
match = [a for a in albums if a['name'] == 'Third Album']
print(match[0]['id'])
")
echo "  Third Album ID on hub-a: $THIRD_ALBUM_ID"

ALBUM_DETAIL_C=$(curl -sf \
  "http://localhost:3011/rest/getAlbum?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&id=${THIRD_ALBUM_ID}")
TRACK_ID_C=$(echo "$ALBUM_DETAIL_C" | python3 -c "
import sys, json
songs = json.load(sys.stdin)['subsonic-response']['album']['song']
print(songs[0]['id'])
")
echo "  First track ID from Third Album: $TRACK_ID_C"

echo ""
echo "==> Testing federated stream from hub-c (hub-a proxies to hub-c's navidrome)..."
HTTP_CODE=$(curl -s -o /tmp/fed-test-stream-c.bin -w "%{http_code}" \
  "http://localhost:3011/rest/stream?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&id=${TRACK_ID_C}")
STREAM_SIZE=$(wc -c < /tmp/fed-test-stream-c.bin | tr -d ' ')

echo "  HTTP status   : $HTTP_CODE"
echo "  Bytes received: $STREAM_SIZE"

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: expected HTTP 200 for federated stream from hub-c, got $HTTP_CODE" >&2
  exit 1
fi
if [ "$STREAM_SIZE" -lt 1000 ]; then
  echo "ERROR: streamed file from hub-c too small (${STREAM_SIZE} bytes) — expected real audio" >&2
  exit 1
fi

# ── Search by ID (share-ID workflow) ──────────────────────────────────────────
# Simulates a user copying an album/artist ID from another hub and pasting it
# into Search to look it up.

ARTIST_ID=$(echo "$ALBUM_DETAIL" | python3 -c "
import sys, json
print(json.load(sys.stdin)['subsonic-response']['album']['artistId'])
")
export OTHER_ALBUM_ID ARTIST_ID TRACK_ID_B
echo ""
echo "==> Testing search3 by album ID ($OTHER_ALBUM_ID)..."
SEARCH_ALBUM=$(curl -sf \
  "http://localhost:3011/rest/search3?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&query=${OTHER_ALBUM_ID}")
if ! echo "$SEARCH_ALBUM" | python3 -c "
import sys, json, os
target = os.environ['OTHER_ALBUM_ID']
albums = json.load(sys.stdin)['subsonic-response'].get('searchResult3', {}).get('album', [])
match = [a for a in albums if a['id'] == target]
assert match, f'No album with id {target} in search results: {[a[\"id\"] for a in albums]}'
assert match[0]['name'] == 'Other Album', f'Expected Other Album, got {match[0][\"name\"]}'
print(f'  search3 by album ID returned: {match[0][\"name\"]}')
"; then
  echo "ERROR: search3 by album ID did not return the expected album" >&2
  echo "Response: $SEARCH_ALBUM" >&2
  exit 1
fi

echo ""
echo "==> Testing search3 by artist ID ($ARTIST_ID)..."
SEARCH_ARTIST=$(curl -sf \
  "http://localhost:3011/rest/search3?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&query=${ARTIST_ID}")
if ! echo "$SEARCH_ARTIST" | python3 -c "
import sys, json, os
target = os.environ['ARTIST_ID']
artists = json.load(sys.stdin)['subsonic-response'].get('searchResult3', {}).get('artist', [])
match = [a for a in artists if a['id'] == target]
assert match, f'No artist with id {target} in search results: {[a[\"id\"] for a in artists]}'
print(f'  search3 by artist ID returned: {match[0][\"name\"]}')
"; then
  echo "ERROR: search3 by artist ID did not return the expected artist" >&2
  echo "Response: $SEARCH_ARTIST" >&2
  exit 1
fi

echo ""
echo "==> Testing search3 by track ID ($TRACK_ID_B)..."
SEARCH_TRACK=$(curl -sf \
  "http://localhost:3011/rest/search3?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&query=${TRACK_ID_B}")
if ! echo "$SEARCH_TRACK" | python3 -c "
import sys, json, os
target = os.environ['TRACK_ID_B']
songs = json.load(sys.stdin)['subsonic-response'].get('searchResult3', {}).get('song', [])
match = [s for s in songs if s['id'] == target]
assert match, f'No song with id {target} in search results: {[s[\"id\"] for s in songs]}'
print(f'  search3 by track ID returned: {match[0][\"title\"]}')
"; then
  echo "ERROR: search3 by track ID did not return the expected song" >&2
  echo "Response: $SEARCH_TRACK" >&2
  exit 1
fi

# ── Share ID scenarios (issue #83) ────────────────────────────────────────────
# Sender mints a shareId (a Navidrome remote_id) via getAlbum on its own hub;
# receiver pastes into search3. Four scenarios exercised:
#   A: album from hub-a's local Navidrome — B resolves via its sync of A.
#   B: album from hub-b's Navidrome — A minted via sync of B; B resolves locally.
#   C: album from hub-c's Navidrome (mutual peer) — B resolves via its own sync of C.
#   D: a random remote_id that no hub knows — B returns empty results.

echo ""
echo "==> Share-ID scenarios (A/B/C/D)..."

# Look up an album detail on a given hub, return its shareId.
get_share_id() {
  local port="$1" album_id="$2"
  curl -sf "http://localhost:${port}/rest/getAlbum?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&id=${album_id}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['subsonic-response']['album'].get('shareId',''))"
}

assert_search_finds() {
  local port="$1" query="$2" expected_name="$3" label="$4"
  local resp
  resp=$(curl -sf "http://localhost:${port}/rest/search3?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&query=${query}")
  if ! echo "$resp" | EXPECTED="$expected_name" Q="$query" python3 -c "
import sys, json, os
name = os.environ['EXPECTED']
albums = json.load(sys.stdin)['subsonic-response'].get('searchResult3', {}).get('album', [])
match = [a for a in albums if a['name'] == name]
assert match, f'Scenario ${label}: {name} not in results: {[a[\"name\"] for a in albums]}'
print(f'  Scenario ${label}: hub on port ${port} resolved shareId {os.environ[\"Q\"]!r} -> {name}')
"; then
    echo "ERROR: scenario $label failed" >&2
    echo "Response: $resp" >&2
    exit 1
  fi
}

assert_search_empty() {
  local port="$1" query="$2" label="$3"
  local resp
  resp=$(curl -sf "http://localhost:${port}/rest/search3?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&query=${query}")
  if ! echo "$resp" | python3 -c "
import sys, json
r = json.load(sys.stdin)['subsonic-response'].get('searchResult3', {})
assert not r.get('album') and not r.get('artist') and not r.get('song'), f'Expected empty results, got {r}'
print(f'  Scenario ${label}: empty results as expected')
"; then
    echo "ERROR: scenario $label expected empty results" >&2
    echo "Response: $resp" >&2
    exit 1
  fi
}

# Resolve album IDs on hub-a for each scenario (A/B/C sourced albums).
FIRST_ALBUM_ID=$(echo "$ALBUM_LIST" | python3 -c "
import sys, json
albums = json.load(sys.stdin)['subsonic-response']['albumList2']['album']
print([a for a in albums if a['name'] == 'First Album'][0]['id'])
")

SHARE_A=$(get_share_id 3011 "$FIRST_ALBUM_ID")
SHARE_B=$(get_share_id 3011 "$OTHER_ALBUM_ID")
SHARE_C=$(get_share_id 3011 "$THIRD_ALBUM_ID")
echo "  hub-a shareIds: A=${SHARE_A}  B=${SHARE_B}  C=${SHARE_C}"

if [ -z "$SHARE_A" ] || [ -z "$SHARE_B" ] || [ -z "$SHARE_C" ]; then
  echo "ERROR: getAlbum did not return shareId for all scenarios" >&2
  exit 1
fi

assert_search_finds 3012 "$SHARE_A" "First Album" "A"
assert_search_finds 3012 "$SHARE_B" "Other Album" "B"
assert_search_finds 3012 "$SHARE_C" "Third Album" "C"
assert_search_empty  3012 "ffffffffffffffffffffffffffffffff" "D"

# ── 3rd-party Subsonic client compatibility (py-sonic) ───────────────────────
# Drives all three hubs through the libsonic Python client to verify real-world
# Subsonic clients (DSub, Symfonium, Substreamer, etc.) can talk to Poutine.

echo ""
echo "==> Running py-sonic Subsonic client compatibility harness..."
HARNESS_DIR="$REPO_ROOT/test/federation/subsonic-compat"
POUTINE_USER="$SUB_USER" \
POUTINE_PASS="$SUB_PASS" \
POUTINE_TARGETS="hub-a=http://localhost:3011,hub-b=http://localhost:3012,hub-c=http://localhost:3013" \
  "$HARNESS_DIR/run.sh"

# ── Peer lifecycle: tombstone gossip propagation (issue #244 Phase 3) ───────
# Deliberately the LAST scenario: it evicts hub-c from the mesh, so anything
# running after it (e.g. the py-sonic harness driving all three hubs) would
# see a degraded federation — hub-c's proxy streams to a/b start failing 403.
# hub-a evicts hub-c via the admin API. After hub-b's next sync (which
# gossips hub-a's peer list, now including the tombstone), hub-b must:
#   - locally tombstone hub-c too (gossiped eviction, not just hub-a's own)
#   - drop hub-c's content from its merged catalog (same sync's merge step)
#   - start refusing hub-c's own inbound federation requests with 403

echo ""
echo "==> Testing tombstone gossip propagation (hub-a evicts hub-c)..."

JWT_B=$(login_only 3012)
JWT_C=$(login_only 3013)

echo "  Tombstoning hub-c from hub-a..."
TOMBSTONE_RESP=$(curl -sf -X DELETE "http://localhost:3011/api/admin/hub/peers/poutine-c" \
  -H "Authorization: Bearer $JWT_A" \
  -H "Content-Type: application/json" \
  -d '{"reason":"federation test eviction"}')
if ! echo "$TOMBSTONE_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['lifecycle'] == 'tombstoned', f'expected tombstoned lifecycle, got {d}'
print(f'  hub-a tombstone response: {d}')
"; then
  echo "ERROR: DELETE peer did not report lifecycle=tombstoned" >&2
  echo "Response: $TOMBSTONE_RESP" >&2
  exit 1
fi

echo "  Triggering a hub-b sync so it gossips the tombstone from hub-a..."
curl -sf -X POST "http://localhost:3012/api/admin/hub/sync" -H "Authorization: Bearer $JWT_B" > /dev/null

echo "  Verifying hub-b locally tombstoned hub-c after gossip..."
PEERS_B=$(curl -sf "http://localhost:3012/api/admin/hub/peers" -H "Authorization: Bearer $JWT_B")
if ! echo "$PEERS_B" | python3 -c "
import sys, json
peers = json.load(sys.stdin)
match = [p for p in peers if p['id'] == 'poutine-c']
assert match, f'poutine-c missing from hub-b peers: {peers}'
assert match[0]['lifecycle'] == 'tombstoned', f'hub-b did not gossip the tombstone: {match[0]}'
print(f'  hub-b now sees poutine-c as: {match[0][\"lifecycle\"]}')
"; then
  echo "ERROR: hub-b did not pick up hub-a's tombstone of hub-c via gossip" >&2
  echo "Response: $PEERS_B" >&2
  exit 1
fi

echo "  Verifying hub-c's content dropped out of hub-b's merged catalog..."
ALBUMS_B=$(curl -sf \
  "http://localhost:3012/rest/getAlbumList2?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500")
if ! echo "$ALBUMS_B" | python3 -c "
import sys, json
albums = [a['name'] for a in json.load(sys.stdin)['subsonic-response'].get('albumList2', {}).get('album', [])]
assert 'Third Album' not in albums, f'hub-c content still present on hub-b after tombstone gossip: {albums}'
print('  hub-b albums after tombstone: ' + ', '.join(sorted(albums)))
"; then
  echo "ERROR: hub-c content did not disappear from hub-b's catalog after tombstone gossip" >&2
  echo "Response: $ALBUMS_B" >&2
  exit 1
fi

echo "  Verifying hub-c's own sync against hub-b now fails (403, refused peer)..."
SYNC_C=$(curl -s -X POST "http://localhost:3013/api/admin/hub/sync" -H "Authorization: Bearer $JWT_C")
if ! echo "$SYNC_C" | python3 -c "
import sys, json
d = json.load(sys.stdin)
peers = d.get('peers', [])
match = [p for p in peers if p.get('instanceId') == 'poutine-b']
assert match, f'no peer sync report for poutine-b in hub-c sync response: {d}'
p = match[0]
assert p.get('errors'), f'expected hub-c sync against tombstoned hub-b to fail: {p}'
print(f'  hub-c sync against hub-b failed as expected: {p[\"errors\"]}')
"; then
  echo "ERROR: hub-c was not refused by hub-b after the tombstone propagated" >&2
  echo "Response: $SYNC_C" >&2
  exit 1
fi

# ── Peer lifecycle: re-admission (issue #244 Phase 3) ────────────────────────
# hub-a re-invites hub-c. The fresh invitation postdates the tombstone, so:
#   - hub-a's handshake clears its own tombstone and re-admits hub-c
#   - hub-b's next gossip from hub-a sees the postdated invitation, clears
#     ITS tombstone too (convergence — the stale tombstone must not win),
#     and hub-c's kept content rows re-enter hub-b's merged catalog
#   - hub-c's sync against hub-b succeeds again

echo ""
echo "==> Testing re-admission (hub-a re-invites hub-c)..."

echo "  Re-admitting via a fresh invitation (issued after the tombstone)..."
sleep 1  # invitation issued_at must strictly postdate the tombstone created_at
admit 3011 "http://hub-a:3000" 3013 "http://hub-c:3000"

echo "  Verifying hub-a re-admitted hub-c as active..."
PEERS_A=$(curl -sf "http://localhost:3011/api/admin/hub/peers" -H "Authorization: Bearer $JWT_A")
if ! echo "$PEERS_A" | python3 -c "
import sys, json
peers = json.load(sys.stdin)
match = [p for p in peers if p['id'] == 'poutine-c']
assert match, f'poutine-c missing from hub-a peers: {peers}'
assert match[0]['lifecycle'] == 'active', f'hub-a did not re-admit poutine-c: {match[0]}'
print('  hub-a sees poutine-c as active again')
"; then
  echo "ERROR: hub-a did not re-admit hub-c after the fresh invitation" >&2
  echo "Response: $PEERS_A" >&2
  exit 1
fi

echo "  Triggering a hub-b sync so gossip clears its tombstone via the postdated invitation..."
curl -sf -X POST "http://localhost:3012/api/admin/hub/sync" -H "Authorization: Bearer $JWT_B" > /dev/null

echo "  Verifying hub-b re-admitted hub-c and restored its content..."
PEERS_B=$(curl -sf "http://localhost:3012/api/admin/hub/peers" -H "Authorization: Bearer $JWT_B")
if ! echo "$PEERS_B" | python3 -c "
import sys, json
peers = json.load(sys.stdin)
match = [p for p in peers if p['id'] == 'poutine-c']
assert match, f'poutine-c missing from hub-b peers: {peers}'
assert match[0]['lifecycle'] == 'active', f'hub-b did not clear its tombstone via gossip: {match[0]}'
print('  hub-b sees poutine-c as active again')
"; then
  echo "ERROR: hub-b did not re-admit hub-c via gossip after the re-invitation" >&2
  echo "Response: $PEERS_B" >&2
  exit 1
fi

ALBUMS_B=$(curl -sf \
  "http://localhost:3012/rest/getAlbumList2?u=${SUB_USER}&p=${SUB_PASS}&c=fed-test&v=1.14.0&f=json&type=alphabeticalByName&size=500")
if ! echo "$ALBUMS_B" | python3 -c "
import sys, json
albums = [a['name'] for a in json.load(sys.stdin)['subsonic-response'].get('albumList2', {}).get('album', [])]
assert 'Third Album' in albums, f'hub-c content did not return to hub-b after re-admission: {albums}'
print('  hub-b albums after re-admission: ' + ', '.join(sorted(albums)))
"; then
  echo "ERROR: hub-c content did not return to hub-b's catalog after re-admission" >&2
  echo "Response: $ALBUMS_B" >&2
  exit 1
fi

echo "  Verifying hub-c's sync against hub-b succeeds again..."
SYNC_C=$(curl -s -X POST "http://localhost:3013/api/admin/hub/sync" -H "Authorization: Bearer $JWT_C")
if ! echo "$SYNC_C" | python3 -c "
import sys, json
d = json.load(sys.stdin)
peers = d.get('peers', [])
match = [p for p in peers if p.get('instanceId') == 'poutine-b']
assert match, f'no peer sync report for poutine-b in hub-c sync response: {d}'
p = match[0]
assert not p.get('errors'), f'hub-c sync against hub-b still failing after re-admission: {p}'
print('  hub-c sync against hub-b succeeds again')
"; then
  echo "ERROR: hub-c still refused by hub-b after re-admission" >&2
  echo "Response: $SYNC_C" >&2
  exit 1
fi

echo ""
echo "==> All assertions passed!"
PASSED=1
