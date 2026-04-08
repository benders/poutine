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
- Subsonic credentials (username + password) are stored in `localStorage` under `subsonicUser`/`subsonicPass` and loaded at module init — no re-login needed after page refresh
- `artUrl(coverArtId, size?)` and `streamUrl(songId, format, maxBitRate)` build authenticated Subsonic URLs using the stored credentials — safe to use in `<img src>` and `<audio src>` since Subsonic auth is query-param-based
- `setCredentials()` is called by `login()` in `api.ts`; `clearCredentials()` is called by both `logout()` and `checkAuth()` on JWT expiry
- Subsonic song IDs are prefixed (`t<uuid>`), album IDs are `al<uuid>`, artist IDs are `ar<uuid>` — these prefixed IDs appear in URL routes (e.g. `/albums/al<uuid>`) and are passed directly to `getAlbum(id)` / `getArtist(id)`
- `SubsonicSong.durationMs` is computed from the Subsonic `duration` field (seconds × 1000) — the rest of the frontend uses milliseconds

## API surface (Phase 2–7)

- **Subsonic API** (`/rest/*`) is the primary client-facing API — browse library, stream, cover art, playlists. Auth via Subsonic `u`+`p` (cleartext) or `u`+`t`+`s` (token+salt MD5) query params.
- **Federation API** (`/federation/*`) is peer-to-peer only — requires Ed25519 signature. Routes: `/federation/library/export`, `/federation/stream/:trackId`, `/federation/art/:encodedId`
- **Admin API** (`/admin/*`) — owner-only management: login, users CRUD, peer list, sync trigger, cache stats/control. Auth via JWT cookie set by `POST /admin/login`.
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

- **Subsonic auth uses query params** — `<audio>`, `<img>`, and `<video>` tags can't set headers. Subsonic auth naturally fits: `u`, `t`, `s` (or `p`) are passed as query params, so media elements work without special handling.
- **Cover art IDs must be encoded with instance context** — Subsonic cover art IDs are instance-local. The merge process must encode them as `{instanceId}:{coverArtId}` so the hub knows which upstream to query. Bare cover art IDs are not usable. Helpers in `hub/src/library/cover-art.ts`.
- **After a schema or merge logic change, a resync is required** — changes to how data is stored in unified tables only take effect after `syncAll()` + merge runs.
- **Runtime settings live in the `settings` table** — use this key-value table (not env vars) for settings that admins should be able to change without restarting the server. The `hub/src/services/art-cache.ts` pattern shows how to read from it with a fallback default.
- **`federatedFetch` paths need the full route prefix** — federation routes are under `/federation`, so all `federatedFetch` calls must use `/federation/...` paths, not just the route suffix.
- **Owner seeding is async** — argon2 hashing requires an async call, so owner seeding must happen in `buildApp()` (not in the synchronous `createDatabase()`). Pattern established in `hub/src/server.ts::seedOwner()`.
- **Admin login sets a JWT cookie AND returns the token** — the cookie enables future admin API calls; the token in the response body is stored in localStorage for the Authorization header on admin endpoints. Subsonic credentials (username + password) are also stored in localStorage by `login()` so `artUrl`/`streamUrl` helpers can build authenticated URLs without extra state.
- **Subsonic `coverArt` field IS the encoded art ID** — in the hub's `buildAlbum`/`buildSong`, `coverArt` is set to `row.image_url` which already holds the `{instanceId}:{coverArtId}` encoded form. Pass it directly to `artUrl()` on the frontend; no further encoding needed.
- **`getAlbumList2` replaces the old release-group list** — Subsonic has no "release group" concept; albums are flat. The frontend's Library page now fetches 500 albums client-side and sorts/filters locally, same as before.

## Docker architecture

- `hub/Dockerfile` — multi-stage: deps → build (tsc + copy sql) → slim runtime with prod deps
- `frontend/Dockerfile` — multi-stage: deps → vite build → nginx serving static files
- `frontend/nginx.conf` — proxies `/api/`, `/admin/`, `/rest/`, and `/federation/` to the `hub` service, SPA fallback via `try_files`
- `docker-compose.yml` — hub (port 3000) + navidrome (internal-only, no published ports) + frontend (port 8080), persistent volume for SQLite
- Navidrome is on an internal Docker network; only the hub can reach it. No credentials are stored for it in the DB — they live in env vars.
