# System architecture

Federated music player. Mesh of independently-operated hubs; each bundles a private Navidrome and exposes a merged view of the federation. Protocol: [federation-api.md](federation-api.md). Engineering details: [hub-internals.md](hub-internals.md).

## Deployment

One Docker Compose stack per participant. Two services: hub (Fastify + SQLite, serves SPA on same port) and internal Navidrome (music files + transcoder, never exposed).

```
┌──────────────────────────────────────────┐
│  Poutine Hub (one container)             │
│    ├─ React SPA (static)                 │
│    ├─ /rest/*         Subsonic API       │
│    ├─ /proxy/*        Proxy tier         │
│    ├─ /federation/*   Federation API     │
│    ├─ /admin/*        Admin API          │
│    ├─ /external-art/* fanart.tv/Last.fm  │
│    ├─ SQLite hub.db    (data + art cache)│
│    └─ SQLite player.db (DLNA UUID, cast) │
├──────────────────────────────────────────┤
│  Internal Docker network (not exposed)   │
│    └─ Navidrome                          │
└──────────────────────────────────────────┘
       ▲                       ▲
       │ Subsonic              │ Ed25519-signed
       ▼                       ▼
  Web/mobile clients      Peer hubs
```

Navidrome credentials live in env vars, not the DB. SPA + API on one port.

## Layers

**Clients** — React SPA or any Subsonic-compatible app. Both speak `/rest/*` via `u+p` or `u+t+s` (MD5 token+salt). SPA logs in at `/admin/login`; see [authentication.md](authentication.md).

**Hub** — Fastify + better-sqlite3:

| Concern        | Responsibility                                                                            |
|----------------|-------------------------------------------------------------------------------------------|
| Client API     | SPA + Subsonic `/rest/*` over unified library                                             |
| Sync + merge   | `syncLocal` from local Navidrome; `/proxy/rest/*` from peers; merge into unified tables   |
| Auto-sync      | `AutoSyncService`: trigger on Navidrome scan complete; fan out to peers per `SYNC_INTERVAL_MS` |
| Stream/art     | Route to source's Navidrome via `/proxy/*` (local or peer)                                |
| External art   | `/external-art/*`: fanart.tv (MBID) → Last.fm fallback → `art_cache`                      |
| Admin          | `/admin/*` (owner-only): sync, peers, invitations, users, cache, identity                 |

**Navidrome** — private per hub. Driven entirely through Subsonic (`getArtists`, `getAlbum`, `stream`, `getCoverArt`, `getScanStatus`, `startScan`). Its native `/api/*` is unused.

## SPA admin split (issue #216, Phase 2 of #212)

The admin SPA exposes **two distinct top-level destinations** that never co-exist on the same page:

| Route          | Bounded dir              | Owns                                                       |
|----------------|--------------------------|------------------------------------------------------------|
| `/admin/hub`   | `frontend/src/features/hub-admin/`   | Instance, peers, invitations, users, art cache, activity retention |
| `/admin/player`| `frontend/src/features/player-admin/`| LAN URL, Sonos casting, DLNA (#217), cast device settings  |

`/admin/player` is gated on a `GET /player/health` probe (added in #216). When that probe is absent or non-200, the route renders a "Player not deployed on this host" placeholder and the sidebar destination hides — making the Hub/Player split visible to operators well before #220 lifts Player into its own plugin/process.

Bounded directories may not cross-import. ESLint-level enforcement landed in #221 (`frontend/eslint.config.js` — `no-restricted-imports` between `features/hub-admin/`, `features/player-admin/`, and `features/player/`). The earlier tactical test in `frontend/src/features/feature-boundaries.test.ts` is kept as a belt-and-braces guard. Shared pure-UI helpers live in `features/shared/`.

Backend endpoint paths exposed under three mounts since #220:

| Mount                | Owner    | What lives here                                                                                |
|----------------------|----------|-----------------------------------------------------------------------------------------------|
| `/admin/*`           | shared   | Backward-compat alias. Auth (`/admin/login`, `/admin/refresh`, `/admin/logout`, `/admin/me`) stays here permanently — the refresh cookie path is bound to `/admin/refresh`. |
| `/api/admin/hub/*`   | Hub      | Users, peers, invitations, sync, cache, activity, instance, art-cache settings, activity retention. SPA's `features/hub-admin/` is the only frontend consumer. |
| `/api/admin/player/*`| Player   | Sonos enable/volume-cap, LAN URL, future DLNA toggles. SPA's `features/player-admin/` is the only frontend consumer. |

Today all three mounts serve identical handlers (one `adminRoutes` plugin registered three times). Namespace-level handler partition is a future cleanup (the SPA already only calls the matching namespace per [hub-internals.md](hub-internals.md)).

## Hub/Player boundary enforcement (#221)

The directory boundary is mechanically enforced by ESLint, so a future PR cannot accidentally reintroduce the violations that phases #213–#220 removed.

| Boundary                                                                                                                                          | Enforced by                                                                            |
|---------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| Player BE files (`hub/src/routes/{sonos,dlna}.ts`, `hub/src/services/{sonos-*,dlna-*,cast-tokens,didl,soap,ssdp-advertiser,player-settings}.ts`) may not runtime-import `better-sqlite3`, the in-process `adapters/subsonic`, or hub DB modules (`db/preferred-source*`, `db/client*`, `db/schema*`). | `hub/eslint.config.js` (`no-restricted-imports`).                                      |
| `hub/src/db/player-db.ts` carve-out: the Player DB opener is allowed to import `better-sqlite3`. Type-only imports (`import type Database from "better-sqlite3"`) are allowed everywhere because they erase at compile time. | Same config — `allowTypeImports: true` + per-file ignore.                              |
| Frontend `features/hub-admin/**`, `features/player-admin/**`, and `features/player/**` may not cross-import. `features/shared/` is importable from any side. | `frontend/eslint.config.js` (`no-restricted-imports`).                                 |
| CI: `pnpm lint:boundary` runs both configs (stripped down to just the boundary rules so unrelated lint noise can't drown out a regression). Also wired into `pnpm verify` and the GitHub Actions `unit` job. | `package.json` + `.github/workflows/ci.yml`.                                           |
| Belt-and-braces: programmatic tests (`hub/test/boundary-lint.test.ts`, `frontend/src/features/boundary-lint.test.ts`) prove the rules fire on stub violating sources. | Vitest (`pnpm test`).                                                                  |

If a new Player file is added (e.g. another route or service), extend the `playerFiles` glob in `hub/eslint.config.js`. If a new exception is unavoidable, document the carve-out inline in the config — do not silently relax the rule.

## Federation

Peers stored in `instances` (DB-authoritative since v0.5.0 / federation v5), authenticated by Ed25519 pubkey. Every `/federation/*` and `/proxy/*` request is signed.

- No central registry; small trusted networks (4–12).
- Stable instance ID + long-lived Ed25519 keypair per hub.
- Admission: one signed invitation (issue → accept → gossip propagates).

| Route                    | Purpose                                                                |
|--------------------------|------------------------------------------------------------------------|
| `/federation/handshake`  | Signed-invitation peer admission                                       |
| `/federation/peers`      | Gossip — verify embedded invitation against named inviter's pubkey     |
| `/federation/stream/:id` | Cross-peer audio stream                                                |
| `/proxy/rest/*`          | Authenticated proxy to local Navidrome (clients and peers both use it) |

Contract: [federation-api.md](federation-api.md). Share IDs resolve locally against synced `instance_*` tables — no RPC. See [hub-internals.md#share-ids](hub-internals.md#share-ids).

## Data model

Catalog tables come in pairs: `instance_*` (raw per-instance) and `unified_*` (deduped by MBID, then normalized name).

```
instance_artists  ─┐
instance_albums   ─┼─ merge.ts ─> unified_artists         ◀── unified_artist_sources
instance_tracks   ─┘              unified_release_groups
                                  unified_releases        ◀── unified_release_sources
                                  unified_tracks
                                  track_sources           (keyed by instance_id)
```

`track_sources` is the streaming branch point. `selectBestSource()` ranks by format → bitrate → local tie-break. Merge rules: [hub-internals.md#federation](hub-internals.md#federation).

`unified_*_sources` join tables back the "which peers own this" UI and the Subsonic MusicFolders mapping (one folder per peer).

**Dual-DB split (issue #212, Phases 1+3 in #215, #217).** Two SQLite files open side-by-side, no `ATTACH`, no cross-joins:

| File         | Owner   | Path (default)            | Holds                                                                                                      |
|--------------|---------|---------------------------|------------------------------------------------------------------------------------------------------------|
| `hub.db`     | Hub BE  | `DATABASE_PATH`           | Users, peers, catalog (`instance_*`/`unified_*`), `settings` (Hub-only: activity retention, art-cache cap, JWT secret), activity, cache |
| `player.db`  | Player  | sibling of `hub.db`       | `player_settings` (key/value): DLNA UDN, cast token HMAC key, `sonos_enabled`, `sonos_volume_cap`, `lan_url`, `dlna_enabled`, `dlna_friendly_name` |

Both handles are opened at entry-point boot (`buildApp` in `hub/src/server.ts`) and capability-injected into the owning code paths. Hub code holds zero references to `player.db`; Player code holds zero references to `hub.db`. Override `player.db` location via `PLAYER_DATABASE_PATH` env (default: `dirname(DATABASE_PATH)/player.db`).

Phase 3 (#217) migrates Player-owned rows out of `hub.db.settings` into `player.db.player_settings` on first boot under the new code (idempotent gap-fill — never overwrites an existing player.db value). Legacy `sonos_*`/`lan_url` rows in `hub.db.settings` are left in place but are no longer the source of truth; cleanup of those rows lands in a later admin-SPA phase.

| Table                                  | Purpose                                                         |
|----------------------------------------|------------------------------------------------------------------|
| `users`                                | Local accounts; AES-256-GCM password (reversible for `u+t+s`)    |
| `instances`                            | Peer registry: id, pubkey, proxy URL, version, last-seen/sync    |
| `invitations`                          | Nonce-tracked signed invitations (consumed once)                 |
| `settings`                             | Singleton key/value (instance metadata, JWT secret ref)          |
| `playlists`, `playlist_tracks`         | User playlists over unified track IDs                            |
| `user_stars`                           | Per-user stars (artist/album/track unified IDs)                  |
| `art_cache`                            | LRU on-disk cache for cover art + external artwork               |
| `sync_operations`, `stream_operations` | Per-peer sync state + recent stream activity                     |

## Play flow

```
1. Client requests unified track ID
2. Hub reads track_sources, selectBestSource picks winner
3. Local source  → /proxy/rest/stream on local Navidrome (JWT auth)
   Peer source   → signed GET /proxy/rest/stream on peer (Ed25519)
4. Response piped to client (no hub buffering)
```

Transcoding happens on the Navidrome that owns the bytes.

**Sonos casting sink (issue #108):** optional alternative to local browser playback. Off by default; toggled at runtime from the Admin page (`sonos_enabled` setting, #184). When enabled, the player route mints a short-lived HMAC cast token bound to the unified track id + originating user, builds `${lan_url}/rest/stream.view?id=t<uuid>&castToken=…` (LAN URL is an admin setting, #209), and issues SOAP `SetAVTransportURI + Play` on the device. The Sonos device fetches the stream from the hub's Subsonic endpoint directly (no Player relay since #218), reusing the same source-selection + transcoding pipeline. Since #220, the cast planner resolves track metadata + source format via Hub Subsonic over an in-process loopback `app.inject()` call (the shared `HubSubsonicCaller` in `services/hub-subsonic-caller.ts`) — `routes/sonos.ts` no longer imports the in-process `SubsonicClient` adapter or queries `app.db` directly. See [hub-internals.md](hub-internals.md#sonos-integration-issue-108).

**DLNA MediaServer (issue #175):** optional. When `DLNA_ENABLED=true`, Poutine advertises itself as a UPnP `MediaServer:1` on the LAN (SSDP + SOAP/ContentDirectory). Clients like Windows Media Player, Xbox, Kodi, VLC, and BubbleUPnP can browse the merged library. Since #218, DIDL `res@uri` points at `${lan_url}/rest/stream.view?id=t<uuid>&castToken=…&dlna=1`; renderers fetch bytes directly from the Hub Subsonic stream endpoint. Since #219, the ContentDirectory service reads via Subsonic HTTP only (in-process `app.inject()` to the hub's own `/rest/*`) — no direct DB access in `services/dlna-objects.ts`, so the Player side of the boundary is one step closer to splitting into its own process. DLNA has no user identity, so the embedded cast token is bound to a configurable pseudo-user — see [hub-internals.md](hub-internals.md#dlna-mediaserver-issue-175).

## Auth model

| Concern        | Approach                                                          |
|----------------|-------------------------------------------------------------------|
| User passwords | AES-256-GCM, on-disk key                                          |
| Session tokens | JWT for `/admin/*`: 15 min access + 7 d refresh                   |
| Subsonic       | `u+p` or `u+t+s`                                                  |
| Peer           | Ed25519 signature on every `/federation/*` and `/proxy/*`         |
| Proxy          | Ed25519 (peers) → JWT (admin) → Subsonic `u+p`/`u+t+s`           |
| Navidrome      | Env-var creds, internal network only                              |
| Transport      | HTTPS required in prod                                            |

Detail: [authentication.md](authentication.md), [hub-internals.md#proxy](hub-internals.md#proxy).

## Scale envelope

| Dimension         | Target                                  |
|-------------------|------------------------------------------|
| Peer hubs         | 4–12                                    |
| Users per hub     | ~20–50                                  |
| Per-hub library   | ~50k tracks                             |
| Merged library    | ~200k–600k tracks                       |
| Sync cadence      | On Navidrome scan complete or on demand |
