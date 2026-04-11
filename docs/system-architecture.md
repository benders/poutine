# System architecture

Poutine is a federated music player: a small mesh of independently-operated hubs, each of which bundles an internal Navidrome and exposes a merged view of the whole federation to its users. For the federation protocol contract, see [federation-api.md](federation-api.md). For hub engineering details (conventions, env vars, gotchas), see [hub-internals.md](hub-internals.md).

## Deployment model

Every participant runs their own hub. Each hub is a single Docker Compose stack with two services: the hub itself (Fastify + SQLite, serving the SPA on the same port) and an internal Navidrome (music files, transcoder).

```
┌──────────────────────────────────────────┐
│  Poutine Hub (one container)             │
│    ├─ React SPA (static files)           │
│    ├─ Subsonic API     /rest/*           │
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

The React SPA (served by the hub) or any third-party Subsonic-compatible app. Both speak to `/rest/*`. Auth is JWT (header, cookie, or query) for the SPA; third-party clients can also use the legacy Subsonic `u`+`p` query-param auth.

### Hub

Fastify + better-sqlite3. Four concerns:

| Concern            | Responsibility                                                                                                     |
|--------------------|---------------------------------------------------------------------------------------------------------------------|
| Client API         | Serve the SPA and the Subsonic `/rest/*` surface over a unified library view                                        |
| Sync + merge       | Pull from local Navidrome (`syncLocal`) and each peer's `/federation/library/export`; merge into unified tables; dedup across instances |
| Stream / art proxy | Route stream and cover-art requests to the correct source (local Navidrome vs. peer federation)                     |
| Admin              | Owner-only management: sync trigger, peer list, cache stats, instance identity                                      |

Engineering details (directory layout, service classes, env vars) live in [hub-internals.md](hub-internals.md).

### Navidrome

Per-hub private music server. Bundled in Docker Compose, reachable only over the internal network. The hub drives it entirely via the Subsonic API (`getArtists`, `getAlbum`, `stream`, `getCoverArt`, `getScanStatus`, `startScan`). Navidrome's native `/api/*` REST API is not used.

## Federation model

Hubs are peers listed in each other's `peers.yaml`, authenticated by Ed25519 public keys. Every `/federation/*` request is signed by the sender. Peer-to-peer means:

- No central registry or directory.
- Small, trusted networks (4–12 participants).
- Each hub has a stable instance ID and a long-lived Ed25519 keypair.
- Adding a peer is a two-sided manual config change (both hubs edit their `peers.yaml`).

The federation surface has exactly three routes:

| Route                             | Purpose                                                        |
|-----------------------------------|----------------------------------------------------------------|
| `GET /federation/library/export`  | Paginated library dump. Importing peers call this to sync.     |
| `GET /federation/stream/:trackId` | Audio proxy for a local track, by the peer's unified track ID. |
| `GET /federation/art/:encodedId`  | Cover-art proxy (disk-cached) for local art.                   |

Contract details (headers, signing payload, error codes, pagination): [federation-api.md](federation-api.md).

## Data model

Two tables per entity — one "raw" (per-instance), one "unified" (deduped across instances):

```
instance_artists    ─┐
instance_albums     ─┼─ merge.ts ─> unified_artists
instance_tracks     ─┘              unified_release_groups
                                    unified_releases
                                    unified_tracks
                                    track_sources   (source_kind = 'local' | 'peer')
```

`track_sources` is the branching point for streaming: each row records where a copy of a unified track physically lives (local Navidrome or a specific peer). `selectBestSource()` scores sources by format quality → bitrate → local tie-break. Deduplication rules, encoding conventions, and the two-hop remote-id indirection used for peer streams are documented in [hub-internals.md#federation](hub-internals.md#federation).

## Play flow (source selection)

```
1. Client POSTs play for unified track ID <uuid>
2. Hub looks up track_sources for the unified track
3. selectBestSource picks the winning source
4. If source_kind = 'local':
     proxy /rest/stream from the bundled Navidrome
   If source_kind = 'peer':
     sign & GET /federation/stream/<peer-unified-id> on the chosen peer
5. Response is piped to the client (no buffering in the hub)
```

Transcoding happens on whichever Navidrome owns the bytes, never on the hub.

## Auth model

| Concern         | Approach                                                             |
|-----------------|----------------------------------------------------------------------|
| User passwords  | Argon2id                                                             |
| Session tokens  | JWT: 15 min access (cookie + header) + 7 d refresh (cookie, path-scoped) |
| Peer auth       | Ed25519 signature on every `/federation/*` request                   |
| Navidrome auth  | Env-var creds, never in DB; internal network only                    |
| Transport       | HTTPS required in prod for peer-to-peer reachability                 |

Flow details: [hub-internals.md#auth-flow](hub-internals.md#auth-flow).

## Scale envelope

Small by design. The merge algorithm, fan-out sync, and unified SQLite tables are tuned for the 4–12 hub range.

| Dimension                  | Target                                             |
|----------------------------|----------------------------------------------------|
| Peer hubs                  | 4–12                                               |
| Concurrent users per hub   | ~20–50                                             |
| Per-hub library            | ~50k tracks                                        |
| Merged library             | ~200k–600k tracks                                  |
| Sync cadence               | On Navidrome scan completion (auto) or on demand  |
