# CLAUDE.md

## Project overview

Poutine is a federated music player. Each instance bundles a Navidrome (internal-only) and exposes a native **Subsonic API** (`/rest/*`) so any Subsonic-compatible mobile app or the React SPA can connect directly. Instances federate with each other via signed peer-to-peer requests (`/federation/*`). The React SPA frontend proxies through nginx in production.

## Monorepo structure

- pnpm workspace with `hub/` (backend) and `frontend/` (React SPA)
- Root `package.json` has workspace-level scripts: `dev`, `build`, `test`, `lint`, `typecheck`

## Commands

```bash
pnpm dev              # Start hub in dev mode (tsx watch)
pnpm build            # Build hub + frontend
pnpm test             # Run hub unit tests (vitest)
pnpm lint             # Lint both packages
pnpm typecheck        # Typecheck both packages
docker compose up --build  # Full stack via Docker (requires .env with JWT_SECRET)
```

## Key conventions

- Hub uses ESM (`"type": "module"`) — all local imports use `.js` extensions in source (e.g., `./config.js`)
- TypeScript `erasableSyntaxOnly` is enabled in the frontend — do NOT use parameter properties (`public foo: string` in constructors), enums, or other non-erasable TS syntax in `frontend/`
- Hub has no such restriction

## Build & Docker gotchas

- **Native deps**: `argon2` and `better-sqlite3` require native compilation. The root `package.json` has `pnpm.onlyBuiltDependencies` to allow their build scripts. The hub Dockerfile installs `python3 make g++` for this.
- **Non-TS assets**: `tsc` does not copy `.sql` files. The hub Dockerfile explicitly copies `hub/src/db/*.sql` into `hub/dist/db/` after `tsc`. If new non-TS assets are added under `hub/src/`, the Dockerfile copy step must be updated.
- **pnpm v10 build scripts**: pnpm v10+ ignores package build scripts by default. Any new native dependency must be added to `pnpm.onlyBuiltDependencies` in the root `package.json` or its postinstall won't run.

## Environment variables (hub)

- `JWT_SECRET` — required in production (signs admin session tokens)
- `DATABASE_PATH` — defaults to `./data/poutine.db`
- `PORT` / `HOST` — defaults to `3000` / `0.0.0.0`
- `NAVIDROME_URL` — defaults to `http://navidrome:4533`
- `NAVIDROME_USERNAME` / `NAVIDROME_PASSWORD` — required in production
- `POUTINE_INSTANCE_ID` — required in production (e.g. `poutine-alice`)
- `POUTINE_OWNER_USERNAME` / `POUTINE_OWNER_PASSWORD` — seeds the owner user on first boot if `users` table is empty
- `POUTINE_PRIVATE_KEY_PATH` — defaults to `./data/poutine_ed25519.pem` (auto-generated if absent)
- `POUTINE_PEERS_CONFIG` — defaults to `./config/peers.yaml`
- See `hub/src/config.ts` for the full list

## Album art caching

- Album art is served via the Subsonic endpoint `GET /rest/getCoverArt?id={encodedId}` and cached to disk on first fetch
- Cache metadata lives in the `art_cache` SQLite table; files live at `{dataDir}/cache/art/`
- LRU eviction runs automatically when cache exceeds the configured max size (stored in `settings` table, default 10 MB)
- Cache size is configurable via `GET/PUT /admin/cache`; clear via `DELETE /admin/cache`
- The `image_url` field in `unified_release_groups` stores encoded IDs in `{instanceId}:{coverArtId}` format — this encoding is required for the art endpoint to resolve the correct upstream instance
- Encoding/decoding helpers live in `hub/src/library/cover-art.ts`

## Frontend Subsonic client (`frontend/src/lib/subsonic.ts`)

- All library browsing and search calls go through the native Subsonic API — `getAlbumList2`, `getArtists`, `getArtist`, `getAlbum`, `search3`
- Auth uses the JWT from `getAccessToken()` (shared with the admin API) — no separate Subsonic credentials are stored
- `subsonicFetch()` sends JWT via `Authorization: Bearer` header; `artUrl()` and `streamUrl()` pass JWT as a `token` query param (for `<img>`/`<audio>` elements that can't set headers)
- Subsonic song IDs are prefixed (`t<uuid>`), album IDs are `al<uuid>`, artist IDs are `ar<uuid>` — these prefixed IDs appear in URL routes (e.g. `/albums/al<uuid>`) and are passed directly to `getAlbum(id)` / `getArtist(id)`
- `SubsonicSong.durationMs` is computed from the Subsonic `duration` field (seconds × 1000) — the rest of the frontend uses milliseconds

## API surface (Phase 2–7)

- **Subsonic API** (`/rest/*`) is the primary client-facing API — browse library, stream, cover art, playlists. Auth via JWT (header, cookie, or `token` query param) or legacy Subsonic `u`+`p` query params for third-party clients.
- **Federation API** (`/federation/*`) is peer-to-peer only — requires Ed25519 signature. Routes: `/federation/library/export`, `/federation/stream/:trackId`, `/federation/art/:encodedId`
- **Admin API** (`/admin/*`) — owner-only management: login, users CRUD, peer list, sync trigger, cache stats/control, instance identity + Navidrome status (`GET /admin/instance`), Navidrome scan trigger (`POST /admin/instance/scan`). Auth via JWT cookie set by `POST /admin/login`.
- **Health** (`/api/health`) — unauthenticated, returns `{ status: "ok" }`

## Federation architecture

- Peers configured in `peers.yaml`; loaded at boot and reloaded on SIGHUP via `hub/src/federation/peers.ts`
- When calling `federatedFetch(peer, path, opts)`, the path must include the `/federation` prefix — the fetcher concatenates `peer.url + path`
- `track_sources` has `source_kind` (`'local'` | `'peer'`) and `peer_id` columns; streaming/art routes check `source_kind` to choose local Navidrome vs. federated peer
- `selectBestSource()` in `hub/src/library/source-selection.ts` scores sources by format quality → bitrate → local tie-break; single decision point for stream routing
- The federation library export emits raw `coverArtId` (no peer prefix); importing peers encode it as `{peerId}:{coverArtId}` during `merge.ts`
- `seedSyntheticInstances()` is idempotent — called at startup and before every `syncAll()` to ensure instance rows exist for the local Navidrome and each peer
- `syncAll()` in `sync.ts` is the main sync entry point (local Navidrome + all peers → merge)

## Lessons learned

- **Subsonic routes accept JWT or traditional Subsonic auth** — The hub's `/rest/*` routes accept JWT (via `Authorization: Bearer` header, `access_token` cookie, or `token` query param) as the primary auth method. Traditional Subsonic `u`+`p` query-param auth is still supported for third-party Subsonic clients. The frontend uses JWT exclusively — `subsonicFetch()` sends the Bearer header, while `streamUrl()`/`artUrl()` use the `token` query param (since `<audio>`/`<img>` elements can't set headers).
- **Cover art IDs must be encoded with instance context** — Subsonic cover art IDs are instance-local. The merge process must encode them as `{instanceId}:{coverArtId}` so the hub knows which upstream to query. Bare cover art IDs are not usable. Helpers in `hub/src/library/cover-art.ts`.
- **After a schema or merge logic change, a resync is required** — changes to how data is stored in unified tables only take effect after `syncAll()` + merge runs.
- **Runtime settings live in the `settings` table** — use this key-value table (not env vars) for settings that admins should be able to change without restarting the server. The `hub/src/services/art-cache.ts` pattern shows how to read from it with a fallback default.
- **`federatedFetch` paths need the full route prefix** — federation routes are under `/federation`, so all `federatedFetch` calls must use `/federation/...` paths, not just the route suffix.
- **Owner seeding is async** — argon2 hashing requires an async call, so owner seeding must happen in `buildApp()` (not in the synchronous `createDatabase()`). Pattern established in `hub/src/server.ts::seedOwner()`.
- **Admin login sets a JWT cookie AND returns the token** — the cookie enables future admin API calls; the token in the response body is stored in localStorage for the Authorization header on admin endpoints. The same JWT is used for Subsonic API auth — no separate credentials are stored.
- **Subsonic `coverArt` field IS the encoded art ID** — in the hub's `buildAlbum`/`buildSong`, `coverArt` is set to `row.image_url` which already holds the `{instanceId}:{coverArtId}` encoded form. Pass it directly to `artUrl()` on the frontend; no further encoding needed.
- **`getAlbumList2` replaces the old release-group list** — Subsonic has no "release group" concept; albums are flat. The frontend's Library page now fetches 500 albums client-side and sorts/filters locally, same as before.
- **Peer `track_sources.remote_id` is the peer's `unified_track_id`, not its Navidrome ID** — When A syncs B, `instance_tracks.remote_id` is set to B's `unified_track_id`. After `mergeLibraries`, A's `track_sources.remote_id` (for peer sources) holds B's unified ID. A calls `/federation/stream/<B-unified-id>`; B then looks that up in its own `track_sources` to get the real Navidrome `remote_id`. This two-hop indirection is intentional.
- **Stream route tests need a real HTTP server for the fake Navidrome** — `/rest/stream` uses `reply.raw.writeHead()` + `nodeStream.pipe(reply.raw)` and `SubsonicClient.stream()` calls real `fetch()`. Fastify inject captures the piped bytes correctly, but the upstream call is a real HTTP request, so the fake Navidrome must be a real `http.createServer` instance bound to a random port. See `hub/test/stream.test.ts` for the pattern.
- **Testing source selection: use distinct byte payloads per fake Navidrome** — When verifying which source (`local` vs `peer`) `selectBestSource` chose, give each fake Navidrome a unique audio buffer (e.g. `FAKE_AUDIO_LOCAL` vs `FAKE_AUDIO_PEER` differing in trailing bytes). Assert `res.rawPayload` equals the expected buffer — more unambiguous than checking content-type alone. The `buildSharedTrackSetup` helper in `hub/test/stream.test.ts` shows the full two-hub setup for source-selection tests.
- **Track deduplication across hubs requires matching title + track_number + duration AND same release** — Two `instance_tracks` from different instances merge into one `unified_track` (with two `track_sources`) when: (1) same normalized title, same `track_number`, duration within 3 s tolerance; AND (2) they fall under the same `unified_release`. For (2), their parent albums must share the same normalized artist name, normalized album name, AND `track_count`. A mismatched `track_count` creates a separate release even within the same release group.
- **Exclude `*.integration.test.ts` from CI** — `vitest.config.ts` has an `exclude` for this glob. Integration tests that hit real external servers (e.g. `subsonic.integration.test.ts`) should only be run manually.
- **`streamUrl` is the correct subsonic export, not `currentStreamUrl`** — `frontend/src/lib/subsonic.ts` exports `streamUrl(id, format, maxBitRate)`. Naming a local variable `currentStreamUrl` and calling `currentStreamUrl(...)` causes a self-reference error; use a distinct local variable name.
- **Owner seeding only runs on first boot (empty `users` table)** — `seedOwner()` is a no-op if any user exists. If the `.env` credentials change after first boot, reset the password directly in the DB using `hashPassword` from `hub/dist/auth/passwords.js` via `docker exec`.
- **Rebuild Docker images after source changes** — the running containers use the compiled image, not live source. After code changes, run `docker compose build <service> && docker compose up -d <service>` or stale routes/assets will be served.
- **Navidrome admin bootstrap: use `ND_DEVAUTOCREATEADMINPASSWORD`, not `ND_INITIALADMINPASSWORD`** — `ND_INITIALADMINPASSWORD` is a silent no-op in Navidrome 0.52+. The internal config key changed to `DevAutoCreateAdminPassword`, so the correct env var is `ND_DEVAUTOCREATEADMINPASSWORD`. Also set `ND_ENCRYPTIONKEY` or password storage fails silently. Both are required on a fresh volume — if the navidrome-data volume already has an `InitialSetup` property row, the auto-create won't re-run; wipe the volume and restart. Use `clean-wipe.sh` for a full clean start.
- **`syncAll` returns `{ local: SyncResult, peers: SyncResult[] }` where each `SyncResult` has `trackCount` (not `tracks`)** — the admin `POST /admin/sync` response shape is `{ local: { instanceId, artistCount, albumCount, trackCount, errors }, peers: [...] }`. Scripts that poll for a non-zero local library must check `local.trackCount`.
- **Federation test uses committed ed25519 keypairs in `test/federation/keys/`** — private keys are PKCS8 PEM (`pkcs8` type, `pem` format from Node crypto). Public key spec in `peers.yaml` is `ed25519:<base64>` where base64 encodes the raw 32-byte key (last 32 bytes of SPKI DER). See `hub/src/federation/signing.ts::loadOrCreatePrivateKey` for the canonical encoding.
- **Three-hub federation test: same `docker-compose.yml`, three projects** — `pnpm test:federation` runs `test/federation/run.sh`, which starts hub-a (3011), hub-b (3012), and hub-c (3013) as separate Compose projects (`-p poutine-fed-a/b/c`) from the same `docker-compose.yml`, each with its own `--env-file` (`test/federation/a.env` / `b.env` / `c.env`). A shared external Docker network (`poutine-federation-test`) is created by the script and each hub container is connected to it with a stable DNS alias (`hub-a` / `hub-b` / `hub-c`) matching the peer URLs in `test/federation/peers-{a,b,c}.yaml`. The committed test keypairs (one per instance, in `test/federation/keys/`) are seeded into each project's `hub-data` volume via a throwaway `alpine` container before `up`, so each hub boots with a known identity. All three instances are fully-connected peers. The test verifies hub-a sees albums from all three instances and can stream tracks federated from both hub-b and hub-c. Ports 3011–3013 were chosen to avoid conflicting with live instances that occupy 3001–3003.
- **Navidrome scans on startup regardless of `ND_SCANSCHEDULE`** — the schedule controls repeat scans; the initial scan at startup always runs. The federation test driver polls `POST /admin/sync` in a retry loop until `local.trackCount > 0` rather than using a fixed sleep.
- **SQLite `datetime('now')` produces timestamps without a timezone marker** — the format is `"2026-04-10 03:54:22"` (space separator, no `Z`). JavaScript's `new Date()` parses date-time strings without a timezone as local time, not UTC, so users west of UTC will see times that appear to be in the future — causing `formatTimeAgo` to always return `"just now"`. Always use `strftime('%Y-%m-%dT%H:%M:%SZ', col)` in SQL SELECTs that return timestamps to the frontend to emit proper UTC ISO 8601.
- **Navidrome exposes `getScanStatus` and `startScan` via the standard Subsonic API** — these are standard Subsonic v1.16.1 endpoints (not Navidrome-only extensions), callable via `SubsonicClient` without any extra auth. Navidrome adds two extra fields to the `scanStatus` object: `lastScan` (ISO timestamp of last completed scan) and `folderCount` (number of watched music folders). `startScan` accepts a `fullScan=true` param (Navidrome extension) to force a full rescan. Both return the same `scanStatus` object shape.
- **Navidrome also has a native REST API at `/api/*`** — separate from the Subsonic API, requires Navidrome JWT auth (POST to `/auth/login` with username+password, then `X-Nd-Authorization: Bearer <token>`). Key endpoints: `/api/library` (music folder CRUD, admin-only), `/api/user` (user CRUD), `/api/transcoding`, `/api/player`. The scan endpoints are on the Subsonic API, not the native API. Poutine currently only uses the Subsonic API — the native API is not used anywhere.
- **`AutoSyncService` polls Navidrome every 30s and syncs when a new scan has completed** — `hub/src/services/auto-sync.ts` compares Navidrome's `lastScan` (from `getScanStatus`) against the `instances.last_synced_at` for the `'local'` row. If `lastScan > last_synced_at` (or never synced), it runs `syncLocal` + `mergeLibraries`. Skips if already running (boolean lock) or if Navidrome is currently scanning. Started via `onReady` hook in `server.ts`, stopped via `onClose`.
- **`syncPeer` must update `instances` table — only on success** — on a successful peer sync, set `status = 'online'`, update `last_seen`, `last_synced_at`, and `track_count`. On any error, set `status = 'offline'` only — do not update `last_seen`. Updating `last_seen` on a failed sync gives a false "Last seen just now" in the UI.
- **`GET /admin/peers` does live health checks** — parallel `fetch` to each peer's `/api/health` with a 5-second `AbortController` timeout, rather than reading stale status from the DB. Returns `status: "online" | "offline"` based on live reachability; `lastSeen` still comes from the DB (last successful sync time).
- **Frontend sync mutations must invalidate library queries** — after `POST /admin/sync` succeeds, invalidate `["albumList2"]` and `["artists"]` in addition to `["admin-instance"]` and `["admin-peers"]`. Without this, the library page shows stale data until React Query's 60s `staleTime` expires.
- **Shared `peers.yaml` works across all cluster nodes** — `peers.ts` skips any entry whose `id` matches `POUTINE_INSTANCE_ID`, so all instances can use the same file. The local-cluster setup (`local-cluster/local-peers.yaml`) and federation test (`test/federation/peers.yaml`) both rely on this — the same file is mounted into every hub container.
- **Local cluster setup mirrors federation test pattern** — `local-cluster/local-run.sh` starts three Compose projects (`cd-rips`, `digital-purchases`, `other`) from the same `docker-compose.yml`, creates a shared Docker network `poutine-local-cluster`, and connects hubs with DNS aliases `hub-a/hub-b/hub-c`. The test keypairs from `test/federation/keys/` are reused. If containers are started manually without the script, the shared network must be created and containers connected manually: `docker network create poutine-local-cluster && docker network connect --alias hub-a poutine-local-cluster cd-rips-hub-1` etc.
- **JWT refresh flow: access token 15m, refresh token 7d** — `POST /admin/login` issues both an `access_token` cookie (httpOnly, 15m) and a `refresh_token` cookie (httpOnly, path `/admin/refresh`, 7d). `POST /admin/refresh` verifies the refresh token (checks `type: "refresh"` claim), rotates both tokens, and returns the new `accessToken` in the body. `hub/src/auth/jwt.ts::verifyRefreshToken` enforces the type claim separately from `verifyToken`. On the frontend, `apiFetch` and `subsonicFetch` both silently attempt refresh on 401 (via `attemptRefresh()` in `api.ts`) and retry the original request before redirecting to `/login`. A module-level `refreshPromise` deduplicate concurrent refresh attempts.
- **`POST /admin/refresh` has no auth requirement** — it reads only the `refresh_token` cookie. The cookie's `path: "/admin/refresh"` means browsers only send it to that exact endpoint, limiting exposure. No `requireOwner` preHandler on this route.

## Docker architecture

- `hub/Dockerfile` — multi-stage: deps → build (tsc + copy sql) → slim runtime with prod deps
- `frontend/Dockerfile` — multi-stage: deps → vite build → nginx serving static files
- `frontend/nginx.conf` — proxies `/api/`, `/admin/`, `/rest/`, and `/federation/` to the `hub` service, SPA fallback via `try_files`
- `docker-compose.yml` — hub (port `${HUB_HOST_PORT:-3000}`) + navidrome (internal-only, no published ports) + frontend (port 8080), persistent volume for SQLite. `PEERS_CONFIG_HOST_PATH` overrides the peers.yaml bind-mount source (default `./peers.yaml`).
- Navidrome is on an internal Docker network; only the hub can reach it. No credentials are stored for it in the DB — they live in env vars.

## Task tracking

This project uses Yaks. The Yaks skill has the full workflow.

1. Never start coding without a shaving yak. No exceptions.
2. Shorn immediately after committing, before anything else.
3. Check existing yaks before creating new ones.
4. Append progress notes to yak descriptions as you work.
5. When unsure what's next, run `/yaks:next` — don't freelance.
