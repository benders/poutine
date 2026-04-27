# poutine

Federated music player. Each instance bundles a [Navidrome](https://www.navidrome.org/) (internal-only) and exposes a native Subsonic API for web and mobile clients. Instances federate with each other via signed peer-to-peer requests, merging multiple personal libraries into one browsable, searchable, streamable collection.

Designed for small groups (4–12 people) who want to share music without giving up ownership of their collections.

## First-time setup

Serves on `http://localhost:3000` (or `POUTINE_HOST_PORT`). SQLite and cover-art cache persist in the `hub-data` Docker volume.

1. Copy `example.env` to `.env` and edit it
2. Edit `.env` to set music path, owner credentials and instance ID.

   Note: These users will be automatically created on first-boot. If you want to change them later, see `Resetting the owner password` below.

3. `docker compose up`. (Use `docker compose up --build` to build from source.) Navidrome scans on startup; the hub's `AutoSyncService` picks up the scan and populates the unified library.
4. Log in to `http://localhost:3000/` with the Poutine Owner credentials that you set.
5. To federate with peers, edit `config/peers.yaml` on both sides — each peer entry needs `id`, `url`, and `public_key` — then reload (`docker compose kill -s HUP hub`). It is recommended that every peer in a cluster uses a copy of the same file.
6. Your own public key can be found on hub startup logs (`"publicKey":"ed25519:fooBARbaz==","msg":"Poutine instance public key — share with peers"`) or on the Settings page of the running app

Full env var list: [docs/hub-internals.md#environment-variables](docs/hub-internals.md#environment-variables).

## Local development (without Docker)

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

## Sharing links to albums or artists

Each Album and Artist detail page has a **Share** button that copies a Poutine sharing ID to your clipboard. Paste that value into the Search box on a friend's hub to pull up the same entity there. The lookup works whenever both hubs sync the same underlying library (your Navidrome, your friend's, or any mutual peer); if the receiving hub doesn't sync an instance that has the item, search returns no results.

## Operations

### Updating a running instance

```bash
git pull
docker compose build hub
docker compose up -d hub
```

Running containers use the compiled image, not live source — rebuild is required after any code change.

#### Upgrading to 0.4.0 — password reset required

0.4.0 changes how user passwords are stored (Argon2id → AES-256-GCM, reversible storage so Subsonic `u+t+s` works). All existing passwords are wiped on the upgrade — every user must have their password re-set.

1. Make sure `POUTINE_OWNER_USERNAME` and `POUTINE_OWNER_PASSWORD` are set in your env. On boot, the hub recovers the owner row by re-encrypting `POUTINE_OWNER_PASSWORD`.
2. After the hub starts, log in as the owner and re-create or re-set passwords for any other users via the admin UI.
3. Back up `data/poutine_password_key` (auto-generated on first boot, mode 0600) alongside your SQLite DB. **Losing the key file makes every stored password unrecoverable.** Override the path with `POUTINE_PASSWORD_KEY_PATH` if needed.

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

### Wiping the Navidrome volume

Navidrome's admin-bootstrap env vars only run on a fresh volume. To force a reset, use:

```bash
./clean-wipe.sh
```

## Tech stack

| Layer     | Tech                                                      |
|-----------|-----------------------------------------------------------|
| Hub       | TypeScript, Fastify, better-sqlite3, jose (JWT), AES-GCM  |
| Frontend  | React 19, Vite, Tailwind CSS, Zustand, TanStack Query     |
| Per-peer  | Navidrome (Subsonic / OpenSubsonic API)                   |
| Transcode | FFmpeg (via Navidrome, never on the hub)                  |

## Docs

| File                                                             | Purpose                                             |
|------------------------------------------------------------------|-----------------------------------------------------|
| [docs/system-architecture.md](docs/system-architecture.md) | System architecture                                 |
| [docs/federation-api.md](docs/federation-api.md)                 | Federation protocol contract                        |
| [docs/hub-internals.md](docs/hub-internals.md)                   | Engineering conventions, gotchas, lessons learned   |
