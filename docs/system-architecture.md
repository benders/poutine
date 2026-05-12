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

Fastify + better-sqlite3. Six concerns:

| Concern            | Responsibility                                                                                                                                  |
|--------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| Client API         | Serve the SPA and the Subsonic `/rest/*` surface over a unified library view                                                                     |
| Sync + merge       | Pull from local Navidrome (`syncLocal`) and each peer's Navidrome via `/proxy/rest/*`; merge into unified tables; dedup across instances         |
| Auto-sync          | `AutoSyncService` polls Navidrome's scan status; when a scan completes, kicks a local sync, then fans out to peers on a `SYNC_INTERVAL_MS` cadence |
| Stream / art proxy | Route stream and cover-art requests to the correct source (local Navidrome via `/proxy/*`, or peer Navidrome via peer's `/proxy/*`)              |
| External art       | `/external-art/*` resolves missing artist/release-group artwork from fanart.tv (primary, MBID-keyed) then Last.fm (fallback); results land in `art_cache` |
| Admin              | Owner-only management under `/admin/*`: sync trigger, peer list, invitation issue/accept, cache stats, instance identity, user management        |

Engineering details (directory layout, service classes, env vars) live in [hub-internals.md](hub-internals.md). External-art sources: [fanarttv-integration.md](fanarttv-integration.md) and [lastfm-integration.md](lastfm-integration.md).

### Navidrome

Per-hub private music server. Bundled in Docker Compose, reachable only over the internal network. The hub drives it entirely via the Subsonic API (`getArtists`, `getAlbum`, `stream`, `getCoverArt`, `getScanStatus`, `startScan`). Navidrome's native `/api/*` REST API is not used.

## Federation model

Hubs are peers stored in each other's `instances` table (DB-authoritative since v0.5.0 / federation v5), authenticated by Ed25519 public keys. Every `/federation/*` (and `/proxy/*`) request is signed by the sender. Peer-to-peer means:

- No central registry or directory.
- Small, trusted networks (4–12 participants).
- Each hub has a stable instance ID and a long-lived Ed25519 keypair.
- Adding a peer takes one signed invitation: the inviter issues, the invitee accepts, and gossip during the next sync round propagates the new member to the rest of the cluster.

The `/federation/*` surface carries peer identity, the invitation handshake, and gossip in v5. Content (audio streams, cover art) and catalog metadata travel through `/proxy/*`:

| Route                       | Purpose                                                                                                                              |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `/federation/handshake`     | Signed-invitation peer admission (v5)                                                                                                |
| `/federation/peers`         | Gossip — receivers verify the embedded signed invitation against the named inviter's pubkey                                          |
| `/federation/stream/:id`    | Cross-peer audio stream                                                                                                              |
| `/proxy/rest/*`             | Authenticated transparent proxy to local Navidrome — used by both local clients and peers for catalog sync, art, and streaming      |

Contract details (headers, signing payload, error codes): [federation-api.md](federation-api.md). `/proxy/*` auth modes: [hub-internals.md#proxy](hub-internals.md#proxy).

Cross-hub share IDs for albums and artists are resolved entirely locally by each hub against its synced `instance_*` tables — no federation RPC. See [hub-internals.md#share-ids](hub-internals.md#share-ids).

## Data model

Catalog tables come in pairs — one "raw" (per-instance, scraped from Navidrome) and one "unified" (deduped across instances by MBID first, then normalized name):

```
instance_artists    ─┐
instance_albums     ─┼─ merge.ts ─> unified_artists           ◀── unified_artist_sources
instance_tracks     ─┘              unified_release_groups
                                    unified_releases          ◀── unified_release_sources
                                    unified_tracks
                                    track_sources   (keyed by instance_id)
```

`track_sources` is the branching point for streaming: each row records which instance (local or peer) holds a copy of a unified track. `instance_id = 'local'` means the bundled Navidrome; a peer's instance ID means that peer's Navidrome. `selectBestSource()` scores sources by format quality → bitrate → local tie-break. Deduplication rules and encoding conventions are documented in [hub-internals.md#federation](hub-internals.md#federation).

The `unified_artist_sources` / `unified_release_sources` join tables let the same unified row be backed by multiple instances at once (used for "which peers own this album" UI and the Subsonic MusicFolders mapping — each peer surfaces as its own folder; see #123).

Supporting tables:

| Table                                  | Purpose                                                                              |
|----------------------------------------|--------------------------------------------------------------------------------------|
| `users`                                | Local accounts. AES-256-GCM-encrypted password (reversible for Subsonic `u+t+s`)     |
| `instances`                            | Peer registry — id, pubkey, proxy URL, version, last-seen, last-sync state           |
| `invitations`                          | Nonce-tracked signed invitations (consumed once; backs handshake + gossip replay)    |
| `settings`                             | Singleton-style key/value (instance metadata, JWT secret reference, etc.)            |
| `playlists`, `playlist_tracks`         | User-owned playlists over unified track IDs                                          |
| `user_stars`                           | Per-user stars/favorites for artist, album, or track unified IDs                     |
| `art_cache`                            | LRU-capped on-disk cache for cover art + external (fanart.tv / Last.fm) artwork     |
| `sync_operations`, `stream_operations` | Operational logs (last sync per peer; recent stream activity for the admin UI)       |

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
