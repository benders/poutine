# Hub internals

Engineering reference for working on the hub (`hub/`) and frontend (`frontend/`). Audience: coding agents and senior engineers. For the federation protocol contract, see [federation-api.md](federation-api.md). For the high-level architecture, see [02-system-architecture.md](02-system-architecture.md).

## Repo structure

pnpm workspace. Two packages:

- `hub/`      — Fastify + better-sqlite3 backend
- `frontend/` — React 19 + Vite SPA

Root `package.json` scripts fan out to both: `dev`, `build`, `test`, `lint`, `typecheck`. See `README.md` for the command list.

## Conventions

- **Hub uses ESM** (`"type": "module"`). Local imports must use `.js` extensions in source (e.g. `./config.js`).
- **Frontend has `erasableSyntaxOnly` enabled.** No parameter properties in constructors, no enums, no other non-erasable TS syntax in `frontend/`. Hub has no such restriction.
- **Runtime settings go in the `settings` SQLite table,** not env vars, when admins should be able to change them without a restart. See `hub/src/services/art-cache.ts` for the read-with-fallback pattern.

## Environment variables

| Variable                     | Required | Default                      | Description                                                     |
|------------------------------|----------|------------------------------|-----------------------------------------------------------------|
| `JWT_SECRET`                 | prod     | —                            | Signs admin session tokens                                      |
| `DATABASE_PATH`              | no       | `./data/poutine.db`          | SQLite file path                                                |
| `PORT` / `HOST`              | no       | `3000` / `0.0.0.0`           | Hub bind                                                        |
| `NAVIDROME_URL`              | no       | `http://navidrome:4533`      | Internal Navidrome URL                                          |
| `NAVIDROME_USERNAME`         | prod     | —                            | Navidrome admin user                                            |
| `NAVIDROME_PASSWORD`         | prod     | —                            | Navidrome admin password                                        |
| `POUTINE_INSTANCE_ID`        | prod     | —                            | Unique instance ID (e.g. `poutine-alice`)                       |
| `POUTINE_OWNER_USERNAME`     | no       | —                            | Seeds owner on first boot if `users` is empty                   |
| `POUTINE_OWNER_PASSWORD`     | no       | —                            | Seeds owner on first boot if `users` is empty                   |
| `POUTINE_PRIVATE_KEY_PATH`   | no       | `./data/poutine_ed25519.pem` | Auto-generated if absent                                        |
| `POUTINE_PEERS_CONFIG`       | no       | `./config/peers.yaml`        | Peer registry file                                              |
| `PUBLIC_DIR`                 | no       | —                            | Compiled frontend `dist/`. Baked into Docker image. Unset in dev |
| `NEW_RELIC_LICENSE_KEY`      | no       | —                            | APM ingest key. Agent disabled (zero overhead) when absent        |
| `NEW_RELIC_APP_NAME`         | no       | `poutine-hub`                | Display name in New Relic APM UI                                  |

Frontend-only (build-time, baked into bundle):

| Variable                     | Required | Default | Description                                              |
|------------------------------|----------|---------|----------------------------------------------------------|
| `VITE_NEW_RELIC_LICENSE_KEY` | no       | —       | Browser license key (`NRJS-…`). Agent omitted when absent |
| `VITE_NEW_RELIC_APP_ID`      | no       | —       | Numeric Browser application ID from New Relic UI          |

`hub/src/config.ts` is the authoritative list for hub env vars.

## API surface

| Surface           | Prefix          | Auth                                                             | Purpose                                   |
|-------------------|-----------------|------------------------------------------------------------------|--------------------------------------------|
| Subsonic          | `/rest/*`       | JWT or Subsonic `u`+`p` (see [authentication.md](authentication.md)) | Primary client API: browse, stream, art   |
| Federation        | `/federation/*` | Ed25519-signed (see [federation-api.md](federation-api.md))      | Peer-to-peer only                         |
| Admin             | `/admin/*`      | JWT (see [authentication.md](authentication.md))                 | Users CRUD, peers, sync, cache, instance  |
| Health            | `/api/health`   | None                                                             | `{ status, appVersion, apiVersion }`      |

## Auth

See [authentication.md](authentication.md) for the full auth reference: JWT flow, Subsonic dual-auth, token refresh, owner seeding, frontend token management.

## Album art

- Served via `GET /rest/getCoverArt?id={encodedId}`. Disk cache with LRU eviction.
- Cache metadata: `art_cache` table. Files: `{dataDir}/cache/art/`.
- Max size configurable via `GET/PUT /admin/cache`; clear via `DELETE /admin/cache`. Stored in `settings` table, default 10 MB.
- **Encoded IDs:** `{instanceId}:{coverArtId}`. Subsonic art IDs are instance-local, so the hub must know which upstream to query. Helpers in `hub/src/library/cover-art.ts`.
- The Subsonic `coverArt` field IS the encoded ID — `buildAlbum`/`buildSong` set it to `row.image_url`, which already stores the encoded form. Pass directly to `artUrl()` on the frontend; no further encoding.

## Federation

Contract: [federation-api.md](federation-api.md). Read before modifying `/federation/*`. Increment `FEDERATION_API_VERSION` in `hub/src/version.ts` on any breaking change and update the doc.

- **Peers:** `peers.yaml`, loaded at boot, reloaded on SIGHUP via `hub/src/federation/peers.ts`. Entries whose `id` matches `POUTINE_INSTANCE_ID` are skipped, so all cluster nodes can share one file (used by both the federation test and the local cluster).
- **`federatedFetch(peer, path, opts)`:** `path` must include the `/federation` prefix — the fetcher concatenates `peer.url + path`.
- **`track_sources`** has `source_kind` (`'local'` | `'peer'`) and `peer_id`. Streaming and art routes branch on `source_kind`.
- **`selectBestSource()`** (`hub/src/library/source-selection.ts`) scores sources by format quality → bitrate → local tie-break. Single decision point for stream routing.
- **Cover-art encoding on import:** federation export emits raw `coverArtId` (no prefix); importing peers encode as `{peerId}:{coverArtId}` during `merge.ts`.
- **Peer `track_sources.remote_id` is the peer's `unified_track_id`,** not its Navidrome song ID. When A syncs B, A's `track_sources.remote_id` holds B's unified ID. A calls `/federation/stream/<B-unified-id>`; B looks that up in its own `track_sources` to get the real Navidrome remote_id. Two-hop indirection is intentional.
- **Track dedup across hubs** requires: (1) matching normalized title + `track_number` + duration (±3 s); AND (2) falling under the same `unified_release`, which requires their parent albums share normalized artist name, normalized album name, AND `track_count`. Mismatched `track_count` creates a separate release even within the same release group.
- **`seedSyntheticInstances()`** is idempotent — called at startup and before every `syncAll()` to ensure instance rows exist for local Navidrome and each peer.
- **`syncAll()`** (`sync.ts`) is the main entry: local Navidrome + all peers → merge. Returns `{ local: SyncResult, peers: SyncResult[] }` where `SyncResult.trackCount` (not `tracks`). The admin `POST /admin/sync` response shape matches.
- **`syncPeer`** on success sets `status = 'online'` + `last_seen` + `last_synced_at` + `track_count`. On error: `status = 'offline'` only — never update `last_seen` (false "just now" in UI). On success, also prunes stale `instance_*` rows for the peer (tracks/albums/artists no longer present in the export) using temp-table NOT IN deletes — prevents stale accumulation across syncs.
- **Federation export is local-only**: `GET /federation/library/export` only exports `unified_tracks` that have a local source (`source_kind = 'local'`), and sources are filtered the same way. This prevents fan-out re-export loops where hub A's tracks travel A→B→C→A.
- **`GET /admin/peers`** does live health checks: parallel `fetch` to each peer's `/api/health` with a 5 s `AbortController` timeout. `status` from live reachability; `lastSeen` from DB.
- **`AutoSyncService`** (`hub/src/services/auto-sync.ts`) polls Navidrome every 30 s. When Navidrome's `lastScan` > `instances.last_synced_at` for `'local'`, runs `syncLocal` + `mergeLibraries`. Skips when already running (boolean lock) or when Navidrome is scanning. Wired via `onReady`/`onClose` in `server.ts`.

### Versioning

Two separate version identifiers:

| Identifier                         | Type          | Purpose                                                     |
|------------------------------------|---------------|-------------------------------------------------------------|
| `Poutine-Api-Version` (resp header) | Integer       | Federation protocol version. No `X-` prefix (RFC 6648).     |
| `User-Agent: Poutine/<semver>`     | Semver string | Application version on ALL outgoing hub HTTP calls          |

Both defined in `hub/src/version.ts`. Protocol version also appears in `/library/export` bodies as `apiVersion`. `GET /admin/peers` surfaces `appVersion` + `apiVersion` per peer (from each peer's `/api/health`).

`USER_AGENT` is sent on every outgoing HTTP call from the hub: federation (`sign-request.ts`), Navidrome Subsonic (`adapters/subsonic.ts`), and peer health checks (`routes/admin.ts`).

## Frontend Subsonic client

`frontend/src/lib/subsonic.ts`.

- All library browsing and search calls go through the native Subsonic API: `getAlbumList2`, `getArtists`, `getArtist`, `getAlbum`, `search3`.
- Auth: JWT shared with admin API. See [authentication.md](authentication.md) for token management, refresh flow, and the "do not embed JWT in art/stream URLs" rule.
- **`streamUrl(id, format, maxBitRate)`** is the export, not `currentStreamUrl`. A local variable named `currentStreamUrl` would shadow and self-reference; use a distinct name.
- Subsonic IDs are prefixed: songs `t<uuid>`, albums `al<uuid>`, artists `ar<uuid>`. These appear in URL routes (e.g. `/albums/al<uuid>`) and pass straight to `getAlbum(id)` / `getArtist(id)`.
- `SubsonicSong.durationMs` = Subsonic `duration` × 1000. Rest of the frontend uses ms.
- **`getAlbumList2` replaces the old release-group list.** Subsonic has no "release group" concept; albums are flat. The Library page fetches 500 albums and sorts/filters client-side.
- **After `POST /admin/sync` succeeds, invalidate** `["albumList2"]`, `["artists"]`, `["admin-instance"]`, `["admin-peers"]`. Without this, the library page shows stale data until React Query's 60 s `staleTime` expires.

## SPA serving

- When `PUBLIC_DIR` is set, `buildApp()` registers `@fastify/static` with `wildcard: false` and a `setNotFoundHandler` returning `index.html` for unmatched non-API routes. API routes (`/rest/*`, `/api/*`, `/federation/*`, `/admin/*` except bare `/admin` and `/admin/`) get JSON 404 instead.
- Dev: leave `PUBLIC_DIR` unset and run Vite dev server (`pnpm dev` in `frontend/`), which proxies backend paths to `localhost:3000`.
- Docker: `hub/Dockerfile` builds the frontend and copies `frontend/dist/` into `hub/public/`; `PUBLIC_DIR=/app/hub/public` is baked in.


## Binary endpoints

`getCoverArt`, `stream`, `download` return raw bytes. `sendSubsonicError` returns HTTP 200 with a JSON envelope (correct for JSON routes), but clients of a binary endpoint interpret any 200 as image/audio, silently corrupting the result. Two rules:

1. Use `sendBinaryError(reply, httpStatus, message)` (`subsonic-response.ts`) for all error paths in the handler.
2. Register via `binaryRoute()` in `subsonic.ts` (uses `requireSubsonicAuthBinary`) so auth failures also return real HTTP codes.

Codes: `400` bad input, `401` auth, `404` not found, `502` upstream failure.

## Navidrome integration

- **Standard Subsonic API** (`/rest/*`): `getArtists`, `getAlbum`, `stream`, `getCoverArt`, `getScanStatus`, `startScan`. Navidrome adds `lastScan` and `folderCount` to `scanStatus`; `startScan` accepts `fullScan=true` (Navidrome extension). Poutine uses only the Subsonic API — Navidrome's native `/api/*` REST API is not used.
- **Navidrome scans on startup** regardless of `ND_SCANSCHEDULE` (schedule controls repeats only). Federation test driver polls `POST /admin/sync` until `local.trackCount > 0` instead of sleeping.
- **Admin bootstrap env vars:** use `ND_DEVAUTOCREATEADMINPASSWORD` (NOT `ND_INITIALADMINPASSWORD`, which is a silent no-op in 0.52+). Also set `ND_ENCRYPTIONKEY` or password storage fails silently. Both required on a fresh volume; if `navidrome-data` already has an `InitialSetup` property row, auto-create won't re-run — wipe the volume (`clean-wipe.sh`) and restart.
- **No credentials in the DB.** Navidrome creds live in env vars only. Navidrome runs on an internal Docker network; only the hub can reach it.

## SQLite notes

- **`datetime('now')` has no timezone marker.** Output: `"2026-04-10 03:54:22"` (space separator, no `Z`). JavaScript `new Date()` parses this as local time, so users west of UTC see timestamps in the future — `formatTimeAgo` returns `"just now"` forever. **Always use `strftime('%Y-%m-%dT%H:%M:%SZ', col)`** in SELECTs that return timestamps to the frontend.
- **`.sql` files are not copied by `tsc`.** The hub Dockerfile explicitly copies `hub/src/db/*.sql` → `hub/dist/db/` after `tsc`. Update the Dockerfile if new non-TS assets are added under `hub/src/`.
- **Schema or merge-logic change → resync required.** Changes to unified-table storage only take effect after `syncAll()` + merge runs.

## Docker

- **`hub/Dockerfile`** — multi-stage: `deps` (all deps) → `prod-deps` (prod-only deps, compiles native addons) → `build` (`tsc` + `vite build` + copy sql) → `runtime` (`node:22-slim`, no build tools — copies pre-built node_modules from `prod-deps`). Frontend `dist/` copied into `hub/public/`. `PUBLIC_DIR=/app/hub/public` baked in. `deps` and `prod-deps` run independently and can be parallelized by BuildKit.
- **`docker-compose.yml`** — hub (port `${POUTINE_HOST_PORT:-3000}`) + navidrome (internal-only, no published ports). Single service for both API and SPA. `PEERS_CONFIG_HOST_PATH` overrides the peers.yaml bind-mount source (default `./peers.yaml`).
- **Native deps:** `argon2` and `better-sqlite3` need `python3 make g++`. Root `package.json` has `pnpm.onlyBuiltDependencies` to allow their postinstall scripts. pnpm v10+ ignores build scripts by default — any new native dep must be added there.
- **Rebuild after source changes.** Running containers use the compiled image, not live source. `docker compose build <service> && docker compose up -d <service>` or stale routes/assets will be served.

## Three-hub federation test

- `pnpm test:federation` → `test/federation/run.sh`. Starts hub-a (3011), hub-b (3012), hub-c (3013) as separate Compose projects (`-p poutine-fed-a/b/c`) from the same `docker-compose.yml`, each with its own `--env-file`.
- Shared external Docker network `poutine-federation-test`; containers connected with DNS aliases `hub-a`/`hub-b`/`hub-c` matching peer URLs in `test/federation/peers-{a,b,c}.yaml`.
- Committed test keypairs (`test/federation/keys/`) are seeded into each project's `hub-data` volume via a throwaway `alpine` container before `up`. Each hub boots with a known identity.
- All three instances are fully-connected peers. Test verifies hub-a sees albums from all three and can stream tracks federated from both b and c. Ports 3011–3013 avoid conflicting with live instances on 3001–3003.
- **Ed25519 keys:** PKCS8 PEM for private. `peers.yaml` spec is `ed25519:<base64>` where base64 encodes the raw 32-byte key (last 32 bytes of SPKI DER). Canonical encoding: `hub/src/federation/signing.ts::loadOrCreatePrivateKey`.

## Local cluster setup

Mirrors the federation test pattern. `test/local-cluster/run.sh` starts three Compose projects (`cd-rips`, `digital-purchases`, `other`) from `docker-compose.yml`, creates a shared Docker network `poutine-local-cluster`, connects hubs with DNS aliases `hub-a`/`hub-b`/`hub-c`. Reuses `test/federation/keys/`.

Manual startup without the script requires creating the network and connecting containers:

```bash
docker network create poutine-local-cluster
docker network connect --alias hub-a poutine-local-cluster cd-rips-hub-1
# ...etc
```

## Testing notes

- **`*.integration.test.ts` excluded from CI.** `vitest.config.ts` has the exclude glob. Integration tests that hit real external servers (e.g. `subsonic.integration.test.ts`) are manual-run only.
- **Stream route tests need a real HTTP server for the fake Navidrome.** `/rest/stream` uses `reply.raw.writeHead()` + `nodeStream.pipe(reply.raw)` and `SubsonicClient.stream()` calls real `fetch()`. Fastify inject captures the piped bytes correctly, but upstream is a real HTTP request, so the fake must be `http.createServer` bound to a random port. Pattern: `hub/test/stream.test.ts`.
- **Source selection tests: use distinct byte payloads per fake Navidrome** (e.g. `FAKE_AUDIO_LOCAL` vs `FAKE_AUDIO_PEER` differing in trailing bytes) and assert `res.rawPayload` equals the expected buffer. More unambiguous than checking content-type. Two-hub setup helper: `buildSharedTrackSetup` in `hub/test/stream.test.ts`.
