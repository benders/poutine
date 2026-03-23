# CLAUDE.md

## Project overview

Poutine is a federated music player. A Fastify hub aggregates Navidrome instances via the Subsonic API. A React SPA frontend proxies through nginx in production.

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

- `JWT_SECRET` — required in production
- `DATABASE_PATH` — defaults to `./data/poutine.db`
- `PORT` / `HOST` — defaults to `3000` / `0.0.0.0`
- See `hub/src/config.ts` for the full list

## Album art caching

- Album art is fetched on-demand from upstream Navidrome instances via `/api/art/:id` and cached to disk
- Cache metadata lives in the `art_cache` SQLite table; files live at `{dataDir}/cache/art/`
- LRU eviction runs automatically when cache exceeds the configured max size (stored in `settings` table, default 10 MB)
- Cache size is configurable via the Admin UI or `PUT /api/settings`
- The `image_url` field in `unified_release_groups` stores encoded IDs in `{instanceId}:{coverArtId}` format — this encoding is required for the `/api/art/:id` endpoint to resolve the correct upstream instance
- Frontend uses `artUrl()` helper from `lib/api.ts` to construct authenticated image URLs (token passed as query param, same pattern as `streamUrl()`)

## Lessons learned

- **Frontend `<img>` tags can't set Authorization headers** — the hub supports `?token=` query params for this reason. Any new endpoint serving binary content to `<img>`, `<audio>`, or `<video>` tags must accept token via query param (already handled by `requireAuth` middleware).
- **Cover art IDs must be encoded with instance context** — Subsonic cover art IDs are instance-local. The merge process must encode them as `{instanceId}:{coverArtId}` so the hub knows which upstream to query. Bare cover art IDs are not usable.
- **After a schema or merge logic change, a resync is required** — changes to how data is stored in unified tables only take effect after `sync-all` + merge runs.
- **Runtime settings live in the `settings` table** — use this key-value table (not env vars) for settings that admins should be able to change without restarting the server. The `hub/src/services/art-cache.ts` pattern shows how to read from it with a fallback default.

## Docker architecture

- `hub/Dockerfile` — multi-stage: deps → build (tsc + copy sql) → slim runtime with prod deps
- `frontend/Dockerfile` — multi-stage: deps → vite build → nginx serving static files
- `frontend/nginx.conf` — proxies `/api/` to the `hub` service, SPA fallback via `try_files`
- `docker-compose.yml` — hub (port 3000) + frontend (port 8080), persistent volume for SQLite
