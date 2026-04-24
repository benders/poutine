# poutine

Federated music player. Each instance bundles a [Navidrome](https://www.navidrome.org/) (internal-only) and exposes a native Subsonic API for web and mobile clients. Instances federate with each other via signed peer-to-peer requests, merging multiple personal libraries into one browsable, searchable, streamable collection.

Designed for small groups (4–12 people) who want to share music without giving up ownership of their collections.

## Architecture (one glance)

```
┌────────────────────────────────────────────┐
│  Web Frontend (React SPA, served by hub)   │
├────────────────────────────────────────────┤
│  Poutine Hub (Fastify + SQLite)            │
│    /rest/*         — Subsonic API          │
│    /proxy/*        — auth proxy to Navidrome (Ed25519 / JWT / u+p) │
│    /federation/*   — peer identity (Ed25519)│
│    /admin/*        — owner management      │
├────────────────────────────────────────────┤
│  Bundled Navidrome (internal network only) │
└────────────────────────────────────────────┘
         ▲                     ▲
         │ Subsonic clients    │ Ed25519-signed /proxy/* + /federation/*
         ▼                     ▼
   Web / mobile            Other hubs (peers)
```

See [docs/system-architecture.md](docs/system-architecture.md) for the system overview, [docs/federation-api.md](docs/federation-api.md) for the federation contract, and [docs/hub-internals.md](docs/hub-internals.md) for engineering internals.

## First-time setup

Serves on `http://localhost:3000` (frontend and API on one port). SQLite and cover-art cache persist in the `hub-data` Docker volume. Override the host port with `POUTINE_HOST_PORT` in `.env`.

1. Edit `.env` to set owner credentials and instance ID:
   ```
   POUTINE_INSTANCE_ID=poutine-yourname
   POUTINE_OWNER_USERNAME=owner
   POUTINE_OWNER_PASSWORD=<password>
   NAVIDROME_USERNAME=admin
   NAVIDROME_PASSWORD=<password>
   ```
2. Put your music on disk and bind-mount it into the `navidrome` service in `docker-compose.yml`.
3. `docker compose up --build`. Navidrome scans on startup; the hub's `AutoSyncService` picks up the scan and populates the unified library.
4. Log in to `http://localhost:3000/admin` with the owner credentials.
5. To federate with peers, edit `peers.yaml` on both sides — each peer entry needs `id`, `url`, `public_key`, and `proxy_url` (the reachable base URL for `/proxy/*`) — then reload (`docker compose kill -s HUP hub`).

Full env var list: [docs/hub-internals.md#environment-variables](docs/hub-internals.md#environment-variables).

## Local development

```bash
pnpm install
pnpm dev                        # Hub on :3000 (tsx watch)
cd frontend && pnpm dev         # Vite on :5173, proxies to :3000
```

Leave `PUBLIC_DIR` unset in dev so the hub does not attempt to serve static files — Vite handles the SPA.

## Commands

| Command                     | Effect                                          |
|-----------------------------|-------------------------------------------------|
| `pnpm dev`                  | Start hub in watch mode                         |
| `pnpm build`                | Build hub + frontend                            |
| `pnpm test`                 | Run hub unit tests (vitest)                     |
| `pnpm test:federation`      | Three-hub federation integration test           |
| `pnpm lint`                 | Lint both packages                              |
| `pnpm typecheck`            | Typecheck both packages                         |
| `docker compose up --build` | Full stack via Docker                           |

## Testing

- `pnpm test` — fast unit tests (vitest). CI runs this.
- `pnpm test:federation` — three-hub federation integration test. Boots three Compose projects, verifies cross-instance dedup and federated streaming. Not run in CI.
- `*.integration.test.ts` — excluded from CI; hit real external servers. Run manually.

See [docs/hub-internals.md#testing-notes](docs/hub-internals.md#testing-notes) for test patterns and gotchas.

## Sharing albums and artists

Each Album and Artist detail page has a **Share** button that copies a Poutine sharing ID to your clipboard. Paste that value into the Search box on a friend's hub to pull up the same entity there. The lookup works whenever both hubs sync the same underlying library (your Navidrome, your friend's, or any mutual peer); if the receiving hub doesn't sync an instance that has the item, search returns no results.

## Operations

### Updating a running instance

```bash
git pull
docker compose build hub
docker compose up -d hub
```

The hub serves the frontend as static files, so only the `hub` service needs rebuilding. Running containers use the compiled image, not live source — rebuild is required after any code change.

### Resetting the owner password

Owner seeding only runs on first boot (when `users` is empty). To reset a password while the hub is running:

```bash
./reset-password.sh <container> <username>
```

Reads the new password interactively. Errors if the user does not exist or the database is empty.

### Cutting a release

Releases are tag-triggered. A `vX.Y.Z` tag push builds a multi-arch Docker image to `ghcr.io/benders/poutine` and creates a GitHub Release with auto-generated notes.

```bash
pnpm version patch          # or minor / major — syncs hub, frontend, version.ts
git push --follow-tags
```

The `.github/workflows/release.yml` workflow verifies the tag matches `package.json`, builds `linux/amd64` + `linux/arm64`, and tags the image `:X.Y.Z`, `:X.Y`, `:X`, and `:latest` (non-prerelease only). Pre-release tags (e.g. `v0.3.1-rc.0`) publish without `:latest` and are marked pre-release on GitHub.

Operators can pull a pinned image instead of rebuilding from source:

```bash
docker pull ghcr.io/benders/poutine:latest
```

Or replace the `build:` block in `docker-compose.yml` with `image: ghcr.io/benders/poutine:X.Y.Z` to pin.

### Wiping the Navidrome volume

Navidrome's admin-bootstrap env vars only run on a fresh volume. To force a reset, use:

```bash
./clean-wipe.sh
```

## Tech stack

| Layer     | Tech                                                      |
|-----------|-----------------------------------------------------------|
| Hub       | TypeScript, Fastify, better-sqlite3, jose (JWT), argon2   |
| Frontend  | React 19, Vite, Tailwind CSS, Zustand, TanStack Query     |
| Per-peer  | Navidrome (Subsonic / OpenSubsonic API)                   |
| Transcode | FFmpeg (via Navidrome, never on the hub)                  |

## Docs

| File                                                             | Purpose                                             |
|------------------------------------------------------------------|-----------------------------------------------------|
| [docs/system-architecture.md](docs/system-architecture.md) | System architecture                                 |
| [docs/federation-api.md](docs/federation-api.md)                 | Federation protocol contract                        |
| [docs/hub-internals.md](docs/hub-internals.md)                   | Engineering conventions, gotchas, lessons learned   |
