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
5. To federate with a peer, use the **invite** flow from the admin UI (`/admin` → Peers → "Generate invite"). Send the resulting blob to the other operator out-of-band; they paste it on their hub's "Accept invite" form. Once admitted, every other peer in the cluster discovers the new member automatically on the next sync round (gossip). No file edits, no SIGHUP required.
6. Your own public key can be found in hub startup logs (`"publicKey":"ed25519:fooBARbaz==","msg":"Poutine instance public key — share with peers"`) or on the Settings page of the running app.

Full env var list: [docs/hub-internals.md#environment-variables](docs/hub-internals.md#environment-variables).

## Local development (without Docker)

Requires **Node 26**, at or above the `engines` floor in `package.json`. `pnpm install` refuses anything else. Homebrew's `node` tracks the newest major, so it stops working once that moves past 26; then use `node@26` or a version manager. Dependabot keeps the Docker image's Node current ([policy](docs/hub-internals.md#nodejs-version-policy-290)); after merging one of its PRs, rebuild the hub (`pnpm hub:up`).

```bash
pnpm install
pnpm dev                        # Hub on :3000 (tsx watch)
cd frontend && pnpm dev         # Vite on :5173, proxies to :3000
```

Leave `PUBLIC_DIR` unset in dev so the hub does not attempt to serve static files — Vite handles the SPA.

## Commands

| Command                     | Effect                                                                                     |
|-----------------------------|--------------------------------------------------------------------------------------------|
| `pnpm dev`                  | Start hub in watch mode                                                                    |
| `pnpm build`                | Build hub + frontend                                                                       |
| `pnpm test`                 | Run hub + frontend unit tests (vitest)                                                     |
| `pnpm test:integration`     | Hub integration tests (merge-worker, DLNA/SSDP)                                            |
| `pnpm test:federation`      | Three-hub federation integration test                                                      |
| `pnpm lint`                 | Lint both packages (must report zero output)                                               |
| `pnpm lint:boundary`        | Boundary-only lint subset (isolated CI signal)                                             |
| `pnpm typecheck`            | Typecheck both packages                                                                    |
| `pnpm verify`               | Typecheck + lint + unit + integration tests — the pre-commit gate; matches CI's `unit` job |
| `pnpm verify:full`          | `verify` + `test:federation` (for Subsonic/federation changes)                             |
| `pnpm hub:up`               | `docker compose up -d --build`, stamping the git SHA into the image                        |
| `pnpm hub:up:fresh`         | Same, with `--force-recreate`                                                              |
| `pnpm hub:logs`             | Follow hub container logs                                                                  |
| `docker compose up --build` | Full stack via Docker                                                                      |

## Testing

- `pnpm test` — fast unit tests (vitest). CI runs this (the `unit` job).
- `pnpm test:integration` — hub `*.integration.test.ts` (merge-worker, DLNA SOAP/SSDP). Real sockets and UDP multicast, so a host without multicast (or without macOS local-network permission for the terminal) sees flakes. CI runs this in the `unit` job.
- `pnpm test:federation` — three-hub federation integration test, incl. the Python `subsonic-compat` suite. Boots three Compose projects, verifies cross-instance dedup, federated streaming, and Subsonic-client compatibility. **CI runs this on every PR** (the `federation` job), and `pnpm verify` does NOT cover it — run it locally (or `pnpm verify:full`) when changing the Subsonic API or federation surface.

See [docs/hub-internals.md#testing-notes](docs/hub-internals.md#testing-notes) for test patterns and gotchas.

## Sharing links to albums or artists

Each Album and Artist detail page has a **Share** button that copies a Poutine sharing ID to your clipboard. Paste that value into the Search box on a friend's hub to pull up the same entity there. The lookup works whenever both hubs sync the same underlying library (your Navidrome, your friend's, or any mutual peer); if the receiving hub doesn't sync an instance that has the item, search returns no results.

## Operations

### Updating a running instance

```bash
git pull
pnpm hub:up
```

Running containers use the compiled image, not live source — rebuild is required after any code change. `pnpm hub:up` passes `GIT_SHA` so `/api/health` reports the commit as `gitSha`; a bare `docker compose build` reports `gitSha: null`. Check what's deployed with `curl -s <hub-url>/api/health`.

#### Updating Navidrome

The Navidrome release is pinned in `docker-compose.yml` and bumped by Dependabot PRs. `pnpm hub:up` does not pull it. After pulling a bump:

```bash
docker run --rm -v <project>_navidrome-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/navidrome-data-$(date +%F).tgz -C /data .   # migrations are one-way
docker compose pull navidrome && docker compose up -d --no-deps navidrome
```

The hub re-syncs after Navidrome's post-upgrade scan; streams can fail until it does. Details: [docs/hub-internals.md#navidrome-integration](docs/hub-internals.md#navidrome-integration).

#### Upgrading to 0.4.0 — password reset required

0.4.0 changes how user passwords are stored (Argon2id → AES-256-GCM, reversible storage so Subsonic `u+t+s` works). All existing passwords are wiped on the upgrade — every user must have their password re-set.

1. Make sure `POUTINE_OWNER_USERNAME` and `POUTINE_OWNER_PASSWORD` are set in your env. On boot, the hub recovers the owner row by re-encrypting `POUTINE_OWNER_PASSWORD`.
2. After the hub starts, log in as the owner and re-create or re-set passwords for any other users via the admin UI.
3. Back up `data/poutine_password_key` (auto-generated on first boot, mode 0600) alongside your SQLite DB. **Losing the key file makes every stored password unrecoverable.** Override the path with `POUTINE_PASSWORD_KEY_PATH` if needed.

### Adding a user

From **Admin → Hub → Invitations**, issue an invite link (optionally suggesting a username, granting admin, and choosing an expiry — 48 h by default), then send the link to the person. They open it, pick their own username and password, and land signed in. The link works once and is shown only at issue time; the hub stores a hash of it, not the link. Revoke an unused one from the same list.

Creating an account directly (admin types both username and password) is still available under **Users**.

### Migrating to another machine

To relocate an instance (hub + Navidrome) to a new host without losing its
federation identity or stored passwords, see [docs/migration.md](docs/migration.md).
The short version: copy the two named Docker volumes (`<project>_hub-data`,
`<project>_navidrome-data`), the env file, and the music library; keep the project
name and `POUTINE_INSTANCE_ID` identical.

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

### Monitoring with New Relic (optional, issue #3)

The hub can report to [New Relic APM](https://newrelic.com) — transactions, distributed traces, event-loop/GC metrics, and logs-in-context. Off by default.

1. Add your license key to `.env` (it is a secret — never commit it):
   ```
   NEW_RELIC_LICENSE_KEY=...
   ```
2. Restart the hub: `docker compose up -d hub`

The APM entity is named `poutine-hub-<POUTINE_INSTANCE_ID>` (override with `NEW_RELIC_APP_NAME`). Remove the key and restart to disable — without it, no agent code loads at all.

With the key set, the hub also reports Navidrome faults it handles (issue #277) — things APM cannot see on its own because the hub catches them:

- **Errors:** every failed local Navidrome call that is a server fault (5xx or a transport error) arrives as an APM error with the Subsonic path, HTTP status and duration attached (capped at 5/min per path so one outage doesn't flood the error channel). 4xx responses are logged but not reported — they are request-level, not a sick server.
- **Health transitions:** a `PoutineNavidromeHealth` custom event on each `ok` ↔ `degraded` edge, plus a `Custom/Poutine/Navidrome/Degraded` gauge. A background watchdog probes every 60 s, so an outage shows up in New Relic even with no Synthetic monitor configured.

Useful alert conditions:

```sql
SELECT count(*) FROM PoutineNavidromeHealth WHERE status = 'degraded' FACET appName
```

### Health checks and Synthetic monitoring (issue #277)

Three unauthenticated URLs, for three different consumers:

| URL                 | Status code        | Use it for                                                                        |
|---------------------|--------------------|-----------------------------------------------------------------------------------|
| `/api/health/ready` | **200 ok / 503 bad** | Synthetic monitors, Kubernetes `readinessProbe`, load-balancer health, the Compose healthcheck |
| `/api/health/live`  | always 200         | Kubernetes `livenessProbe` — process liveness only                                |
| `/api/health`       | always 200         | Peer hubs (federation handshake reads the versions) and humans; key on `body.status` |

`/api/health/ready` is the one that tells you whether **audio actually works**: it reads the hub DB, pings Navidrome, and pulls a 64 KB byte range off a real track from Navidrome's stream endpoint, asserting bytes come back. That last check exists because the failure this was built for pinged perfectly healthy while streaming nothing. Results are cached for 30 s, so polling it every 10 s is fine.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health/ready   # 200 or 503
curl -sS http://localhost:3000/api/health/ready | jq
```

```json
{
  "status": "degraded",
  "checks": {
    "hubDb": { "status": "ok", "durationMs": 0 },
    "navidromePing": { "status": "ok", "durationMs": 11 },
    "navidromeStream": { "status": "failed", "detail": "3 candidate track(s) failed — Subsonic HTTP error: 500 Internal Server Error; ...", "durationMs": 42 }
  },
  "observed": { "recentFailures": 18, "consecutiveStreamFailures": 7, "lastFailure": { "path": "/rest/stream", "status": 500, "message": "...", "at": "2026-09-12T04:15:00.000Z" }, "lastSuccessAt": "2026-09-12T04:02:11.000Z" },
  "probedAt": "2026-09-12T04:15:01.000Z",
  "cached": false
}
```

A `navidromeStream` of `skipped` is not a fault — it means the ping already failed, the library has no local tracks yet, or the probe is switched off with `NAVIDROME_STREAM_PROBE=false`. An empty library is legitimately ready.

Docker Compose keys the hub container's healthcheck to this URL, so `docker compose ps` shows `unhealthy` when audio is broken. Nothing restarts automatically — a Navidrome fault should not bounce the hub and kill in-flight streams. To restart by hand:

```bash
docker compose restart navidrome   # most Navidrome faults clear here
docker compose logs --tail 200 navidrome
```

Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /api/health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /api/health/ready, port: 3000 }
  periodSeconds: 30
  failureThreshold: 2
```

### How new music gets picked up (issue #296)

Navidrome quick-scans the library every hour (`NAVIDROME_SCAN_SCHEDULE`, default `@every 1h`; robfig cron, e.g. `@every 6h` for a big library on a slow NAS). On a local disk its filesystem watcher usually catches changes within seconds; on SMB/NFS shares it can't, so the hourly scan is what finds them. The hub syncs automatically after each scan. In a hurry: Hub admin → Instance → **Scan Library**. Hub admin also shows the schedule Navidrome is actually using and warns if it is off.

### When the library suddenly shrinks (issue #297)

If the music share behind Navidrome drops (NAS reboot, SMB/NFS outage, USB drive asleep), Navidrome sees an empty or partial library. The hub refuses to apply a sync that drops a library to zero or by more than `POUTINE_SHRINK_GUARD_PERCENT` (default 20%, libraries of 100+ tracks): it keeps the catalog, shows the instance's sync as failed with a "Shrink guard" message, and reports `library: "held"` in `/api/health`.

- **Outage:** fix the mount. Navidrome's next scan restores the tracks (same ids, `ND_SCANNER_PURGEMISSING=never`) and the next sync clears the hold. Nothing else to do.
- **You really deleted that much music:** Hub admin → accept the removal (or `POST /api/admin/hub/instances/<id>/accept-shrink`). The next sync applies it.

### Casting to Sonos (optional, issue #108)

Lets the bottom-of-screen player stream to Sonos devices on the LAN. Requires host networking for SSDP multicast.

```bash
docker compose -f docker-compose.yml -f docker-compose.sonos.yml up -d
```

Then open the Admin page → Sonos and:

1. Set the **LAN URL** to `http://<your-lan-ip>:3000` (#209) — devices on the LAN fetch streams from this URL. Shared with DLNA.
2. Toggle **Sonos** on (#184). Sonos is off by default and toggleable at runtime — no env var, no restart.

Pick a device from the cast icon next to the volume slider. Selection resets to local browser on each session. Full details in [docs/sonos.md](docs/sonos.md#runtime-toggle-184).

#### macOS hosts: run the hub natively

Docker Desktop on macOS does not forward UDP multicast into containers, so Sonos discovery silently finds zero devices when the hub runs in Docker — even with the experimental host-networking toggle enabled. On Mac, run the hub directly on the Mac while keeping Navidrome in Docker (host network, bound to loopback):

```bash
# First-time only: seed data-native/ from your existing hub container
mkdir -p data-native
docker cp poutine-hub-1:/app/data/poutine.db data-native/
docker cp poutine-hub-1:/app/data/poutine_ed25519.pem data-native/
docker cp poutine-hub-1:/app/data/poutine_password_key data-native/

# Then:
pnpm hub:start         # start Navidrome container + hub native process
pnpm hub:status        # PID, /api/health, /api/health/ready, Navidrome reachability
pnpm hub:restart       # rebuild hub+frontend and bounce
pnpm hub:logs          # last 200 lines of the hub log
pnpm hub:stop          # stop hub (Navidrome stays up)
```

State lives in `data-native/`; logs at `.hub-native.log`; PID at `.hub-native.pid` (all gitignored). This script is a stopgap — proper macOS packaging with launchd is tracked in #183. Linux hosts should keep using the Docker compose override.

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

| File                                                         | Purpose                                                                |
|--------------------------------------------------------------|------------------------------------------------------------------------|
| [docs/system-architecture.md](docs/system-architecture.md)   | System architecture, Hub/Player boundary, design decisions             |
| [docs/pitfalls.md](docs/pitfalls.md)                         | Recurring traps — read before touching merge, SQLite, auth, federation |
| [docs/federation-api.md](docs/federation-api.md)             | Federation protocol contract                                           |
| [docs/authentication.md](docs/authentication.md)             | JWT, Subsonic dual-auth, token refresh                                 |
| [docs/hub-internals.md](docs/hub-internals.md)               | Engineering conventions, env vars, gotchas, Docker                     |
| [docs/opensubsonic.md](docs/opensubsonic.md)                 | OpenSubsonic endpoint compatibility                                    |
| [docs/frontend-testing.md](docs/frontend-testing.md)         | Vitest + RTL setup, patterns, gotchas                                  |
| [docs/sonos.md](docs/sonos.md)                               | Sonos casting — protocol, components, testing                          |
| [docs/dlna.md](docs/dlna.md)                                 | DLNA MediaServer — protocol, LAN gate, testing                         |
| [docs/fanarttv-integration.md](docs/fanarttv-integration.md) | fanart.tv artist/album art (primary, MBID-keyed)                       |
| [docs/lastfm-integration.md](docs/lastfm-integration.md)     | Last.fm fallback for artists without an MBID                           |
