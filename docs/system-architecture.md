# System architecture

Poutine is a federated music player: a small mesh of independently-operated hubs, each of which bundles an internal Navidrome and exposes a merged view of the whole federation to its users. For the federation protocol contract, see [federation-api.md](federation-api.md). For hub engineering details (conventions, env vars, gotchas), see [hub-internals.md](hub-internals.md).

## Deployment model

Every participant runs their own hub. Each hub is a single Docker Compose stack with two services: the hub itself (Fastify + SQLite, serving the SPA on the same port) and an internal Navidrome (music files, transcoder).

```
┌──────────────────────────────────────────┐
│  Poutine Hub (one container)             │
│    ├─ React SPA (static files)           │
│    ├─ Subsonic API     /rest/*           │
│    ├─ Proxy tier       /proxy/*          │
│    ├─ Federation API   /federation/*     │
│    ├─ Admin API        /admin/*          │
│    └─ SQLite (data + art cache)          │
├──────────────────────────────────────────┤
│  Internal Docker network (not exposed)   │
│    └─ Navidrome (music files, transcoder)│
└──────────────────────────────────────────┘
         ▲                       ▲
         │ Subsonic (clients)    │ Ed25519-signed federation
         ▼                       ▼
    Web / mobile clients     Other hubs (peers)
```

Only the hub's HTTP port is exposed. Navidrome is internal-only. Navidrome credentials come from env vars — they are not stored in the hub database. The SPA and API are served from the same port; there is no separate nginx container in the default deployment.

## Three layers

### Clients

The React SPA (served by the hub) or any third-party Subsonic-compatible app. Both speak to `/rest/*` using standard Subsonic auth — `u+p` (plaintext / `enc:<hex>`) or `u+t+s` (MD5 token+salt). The SPA uses `u+t+s` after the user logs in via `/admin/login` (see [authentication.md](authentication.md)).

### Hub

Fastify + better-sqlite3. Four concerns:

| Concern            | Responsibility                                                                                                     |
|--------------------|---------------------------------------------------------------------------------------------------------------------|
| Client API         | Serve the SPA and the Subsonic `/rest/*` surface over a unified library view                                        |
| Sync + merge       | Pull from local Navidrome (`syncLocal`) and each peer's Navidrome via `/proxy/rest/*`; merge into unified tables; dedup across instances |
| Stream / art proxy | Route stream and cover-art requests to the correct source (local Navidrome via `/proxy/*`, or peer Navidrome via peer's `/proxy/*`) |
| Admin              | Owner-only management: sync trigger, peer list, cache stats, instance identity                                      |

Engineering details (directory layout, service classes, env vars) live in [hub-internals.md](hub-internals.md).

### Navidrome

Per-hub private music server. Bundled in Docker Compose, reachable only over the internal network. The hub drives it entirely via the Subsonic API (`getArtists`, `getAlbum`, `stream`, `getCoverArt`, `getScanStatus`, `startScan`). Navidrome's native `/api/*` REST API is not used.

## Federation model

Hubs are peers listed in each other's `peers.yaml`, authenticated by Ed25519 public keys. Every `/federation/*` (and `/proxy/*`) request is signed by the sender. Peer-to-peer means:

- No central registry or directory.
- Small, trusted networks (4–12 participants).
- Each hub has a stable instance ID and a long-lived Ed25519 keypair.
- Adding a peer is a two-sided manual config change (both hubs edit their `peers.yaml`, exchanging public keys and reachable `proxy_url`s).

The `/federation/*` surface carries only peer identity/auth in v3. Content (audio streams, cover art) and catalog metadata travel through `/proxy/*`:

| Route              | Purpose                                                                                   |
|--------------------|-------------------------------------------------------------------------------------------|
| `/federation/*`    | Peer identity and signing only — no content endpoints in v3 (see [federation-api.md](federation-api.md)) |
| `/proxy/rest/*`    | Authenticated transparent proxy to local Navidrome — used by both local clients and peers for catalog sync and streaming |

Contract details (headers, signing payload, error codes): [federation-api.md](federation-api.md). `/proxy/*` auth modes: [hub-internals.md#proxy](hub-internals.md#proxy).

Cross-hub share IDs for albums and artists are resolved entirely locally by each hub against its synced `instance_*` tables — no federation RPC. See [hub-internals.md#share-ids](hub-internals.md#share-ids).

## Data model

Two tables per entity — one "raw" (per-instance), one "unified" (deduped across instances):

```
instance_artists    ─┐
instance_albums     ─┼─ merge.ts ─> unified_artists
instance_tracks     ─┘              unified_release_groups
                                    unified_releases
                                    unified_tracks
                                    track_sources   (keyed by instance_id)
```

`track_sources` is the branching point for streaming: each row records which instance (local or peer) holds a copy of a unified track. `instance_id = 'local'` means the bundled Navidrome; a peer's instance ID means that peer's Navidrome. `selectBestSource()` scores sources by format quality → bitrate → local tie-break. Deduplication rules and encoding conventions are documented in [hub-internals.md#federation](hub-internals.md#federation).

## Play flow (source selection)

```
1. Client POSTs play for unified track ID <uuid>
2. Hub looks up track_sources for the unified track
3. selectBestSource picks the winning source
4. If source.instance_id === 'local':
     proxy /proxy/rest/stream from the bundled Navidrome (JWT auth)
   If source.instance_id === <peer-id>:
     sign & GET /proxy/rest/stream on the chosen peer's proxy_url (Ed25519 auth)
5. Response is piped to the client (no buffering in the hub)
```

Transcoding happens on whichever Navidrome owns the bytes, never on the hub.

## Auth model

| Concern         | Approach                                                             |
|-----------------|----------------------------------------------------------------------|
| User passwords  | AES-256-GCM (reversible — needed for Subsonic `u+t+s`). Key on disk. |
| Session tokens  | JWT for `/admin/*` only: 15 min access + 7 d refresh                 |
| Subsonic auth   | `u+p` or `u+t+s` (MD5 token+salt). SPA + 3rd-party clients use either |
| Peer auth       | Ed25519 signature on every `/federation/*` and `/proxy/*` request    |
| Proxy auth      | Unified: Ed25519 (peers) → JWT (admin) → Subsonic `u+p`/`u+t+s`     |
| Navidrome auth  | Env-var creds, never in DB; internal network only                    |
| Transport       | HTTPS required in prod for peer-to-peer reachability                 |

Flow details: [authentication.md](authentication.md). `/proxy/*` auth detail: [hub-internals.md#proxy](hub-internals.md#proxy).

## Scale envelope

Small by design. The merge algorithm, fan-out sync, and unified SQLite tables are tuned for the 4–12 hub range.

| Dimension                  | Target                                             |
|----------------------------|----------------------------------------------------|
| Peer hubs                  | 4–12                                               |
| Concurrent users per hub   | ~20–50                                             |
| Per-hub library            | ~50k tracks                                        |
| Merged library             | ~200k–600k tracks                                  |
| Sync cadence               | On Navidrome scan completion (auto) or on demand  |
