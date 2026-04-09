# Cover Art Debugging: In-Progress Context

## Problem
Cover art loads for some albums but returns `{"subsonic-response":{"status":"failed","error":{"code":70,"message":"Not found"}}}` for others.

## Root Cause Found
All 677 albums in the DB were synced from the **Xac peer** (instance_id = `faa8b80b-8aa7-4f4d-843d-f54eb7d36ddd`), not from local. Cover art IDs are encoded as `faa8b80b...:al-...`. The `getCoverArt` route routes these to the peer registry, but the peer registry is **empty** because `peers.yaml` was a directory instead of a file.

Art that happened to be in `art_cache` still worked (cache lookup bypasses peer lookup). Uncached art failed.

## What Was Done

### 1. Fixed `peers.yaml`
- `peers.yaml` was an **empty directory** (Docker creates a directory when the host file doesn't exist at mount time)
- Deleted the directory, created a proper YAML file:
  ```yaml
  peers: []
  ```
- File is at `/Users/nic/src/poutine/peers.yaml`

### 2. Cleared Stale Peer Data
Ran directly against the hub SQLite DB (`/app/data/poutine.db`):
- Deleted all `instance_albums`, `instance_artists`, `instance_tracks` for `instance_id = 'faa8b80b-8aa7-4f4d-843d-f54eb7d36ddd'`
- Deleted the Xac `instances` row
- Cleared all unified tables (`unified_artists`, `unified_release_groups`, `unified_releases`, `unified_tracks`, `unified_artist_sources`, `unified_release_sources`, `track_sources`)
- Cleared `art_cache`
- DB now has 0 `instance_albums` rows — ready for local sync

### 3. Fixed Navidrome Admin User
The local Navidrome had **no users** (the `admin` user was never created). `ND_INITIALADMINPASSWORD` is a **no-op** in Navidrome 0.52+. The correct env var is `ND_DEVAUTOCREATEADMINPASSWORD`. Additionally, `ND_ENCRYPTIONKEY` must be set or password storage silently fails.

Fix applied (now baked into docker-compose.yml and `clean-wipe.sh`):
```bash
# Wipe navidrome-data volume so first-boot env vars are applied cleanly
docker compose down navidrome
docker volume rm poutine_navidrome-data
docker compose up -d navidrome
# ND_DEVAUTOCREATEADMINPASSWORD creates admin:poutine on fresh first boot
```
Verified: `admin` user now exists in Navidrome with `is_admin=1`.

## What Still Needs To Be Done

### Trigger Local Sync
The hub needs to sync from the local Navidrome so albums get `instance_id = "local"` and cover art is encoded as `local:al-...`.

```bash
# Get admin token
ADMIN_TOKEN=$(curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"xac","password":"aq_o4CuT"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('accessToken',''))")

# Trigger sync
curl -s -X POST http://localhost:3000/admin/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -b /tmp/cookies.txt | python3 -m json.tool
```

After sync succeeds, cover art IDs will be `local:al-...` and all art will be served from the local Navidrome — no peer lookup needed.

### Verify
```bash
# Should show 677+ albums under instance_id=local
docker compose exec hub sh -c "node --input-type=commonjs <<'EOF'
const Database = require('/app/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3');
const db = new Database('/app/data/poutine.db', {readonly: true});
console.log(db.prepare('SELECT instance_id, COUNT(*) as count FROM instance_albums GROUP BY instance_id').all());
EOF"

# Should return image/jpeg
curl -s "http://localhost:8080/rest/getCoverArt?u=xac&p=aq_o4CuT&v=1.16.1&c=poutine&id=<some-id>&size=400" -o /dev/null -w "%{content_type}"
```

## Architecture Note
- This instance IS "Xac" — the local bundled Navidrome has all the music
- `peers.yaml` should stay empty (`peers: []`) — there are no federation peers configured
- `POUTINE_INSTANCE_ID=music-west.slackworks.com` in `.env`
- Music is served from the external drive at `/Volumes/BigWolf/Music/CD Rips` mounted into Navidrome

## Key Files
- Hub DB: Docker volume `poutine_hub-data` → `/app/data/poutine.db` in container
- Navidrome DB: Docker volume `poutine_navidrome-data` → `/data/navidrome.db`
- Peers config: `/Users/nic/src/poutine/peers.yaml` (mounted as `/app/config/peers.yaml:ro`)
- Cover art route: `hub/src/routes/subsonic.ts:619`
- Cover art encoding: `hub/src/library/cover-art.ts`
- Merge encodes art IDs: `hub/src/library/merge.ts:160-164`
