# Poutine: System Architecture

## Overview

Poutine is a federated music player that presents multiple personal music collections as a single merged library. It consists of three layers:

```
┌─────────────────────────────────────────────────────┐
│                   Web Frontend                       │
│              (React SPA, desktop-first)               │
├─────────────────────────────────────────────────────┤
│                Poutine Hub (API Server)               │
│   ┌───────────┬──────────┬───────────┬────────────┐  │
│   │ Federation│ Metadata │  Stream   │    Auth     │  │
│   │  Manager  │  Merger  │  Proxy    │   Service   │  │
│   └───────────┴──────────┴───────────┴────────────┘  │
├─────────────────────────────────────────────────────┤
│              Instance Adapters                        │
│   ┌──────────────────┐  ┌──────────────────┐         │
│   │ Subsonic Adapter  │  │ Jellyfin Adapter │         │
│   │  (primary)        │  │  (future)        │         │
│   └──────────────────┘  └──────────────────┘         │
├─────────────────────────────────────────────────────┤
│              Remote Navidrome Instances               │
│   ┌──────┐ ┌──────┐ ┌──────┐      ┌──────┐          │
│   │ NAS  │ │ RPi  │ │ Mini │ ...  │ NAS  │          │
│   │ Inst1│ │ Inst2│ │ Inst3│      │InstN │          │
│   └──────┘ └──────┘ └──────┘      └──────┘          │
└─────────────────────────────────────────────────────┘
```

## Components

### 1. Navidrome Instances (Per-User)

Each participant runs a Navidrome instance on their own hardware, serving their personal music library.

**Responsibilities:**
- Music file storage and scanning
- ID3/FLAC tag parsing and indexing
- On-the-fly transcoding (FLAC → Opus/AAC via FFmpeg)
- Subsonic API endpoint for remote queries and streaming
- Local user management

**Deployment:**
```yaml
# docker-compose.yml (per instance)
services:
  navidrome:
    image: deluan/navidrome:latest
    ports:
      - "4533:4533"
    environment:
      ND_SCANSCHEDULE: "1h"
      ND_LOGLEVEL: "info"
      ND_ENABLETRANSCODINGCONFIG: "true"
      ND_DEFAULTTHEME: "dark"
    volumes:
      - ./data:/data
      - /path/to/music:/music:ro
```

**Network requirements:** Each instance must be reachable from the Poutine Hub over HTTPS. This can be achieved via:
- Port forwarding + dynamic DNS
- VPN (Tailscale, WireGuard)
- Reverse proxy (Caddy, nginx)

### 2. Poutine Hub (Central Coordination Server)

The Hub is the core of Poutine. It aggregates multiple Navidrome instances into a single unified library. It runs as a Docker container alongside a database.

**Technology choices:**
- **Language:** TypeScript (Node.js)
- **Framework:** Fastify (high performance, schema validation, good TypeScript support)
- **Database:** SQLite via better-sqlite3 (simple, zero-config, sufficient for metadata cache at this scale)
- **Cache:** In-process LRU cache for hot paths; SQLite for persistent metadata cache

**Rationale for TypeScript:** The primary concern stated is maintainability. TypeScript offers: strong typing, large ecosystem, shared language with the React frontend, straightforward async I/O for fan-out queries, and a large pool of developers who can contribute. For a coordination/aggregation service (not CPU-bound), Node.js performance is more than adequate.

#### 2a. Federation Manager

Manages the registry of known instances and their health.

**Instance Registry:**
```typescript
interface PoutineInstance {
  id: string;                    // UUID
  name: string;                  // Human-readable (e.g., "Alex's Library")
  url: string;                   // Base URL (e.g., "https://music.alex.home:4533")
  adapterType: "subsonic";       // Future: "jellyfin"
  credentials: EncryptedCredentials; // Subsonic user/token for this instance
  owner: string;                 // User ID of the instance owner
  lastSeen: Date;
  lastSyncedAt: Date;
  status: "online" | "offline" | "degraded";
  trackCount: number;
  version: string;               // Navidrome version
}
```

**Discovery model:** Static registration via the Hub's admin UI. An instance owner adds their server URL and credentials. The Hub periodically pings each instance (`/rest/ping`) to track health. This is appropriate for 4-12 trusted instances managed by technical users.

**Future enhancement:** An invite-link system where instance owners can share a join URL that auto-registers their instance.

#### 2b. Metadata Merger

The most complex component. Responsible for presenting N separate libraries as one coherent collection.

**Data model:**

```
UnifiedArtist
  ├── name: string
  ├── musicBrainzId?: string          // Artist MBID
  ├── sources: InstanceArtistRef[]    // Which instances have this artist
  └── imageUrl?: string

UnifiedReleaseGroup
  ├── name: string
  ├── musicBrainzId?: string          // Release Group MBID
  ├── artist: UnifiedArtist
  ├── year?: number
  ├── versions: UnifiedRelease[]      // Different releases under this group
  └── imageUrl?: string

UnifiedRelease
  ├── name: string                    // e.g., "OK Computer (Japan Edition)"
  ├── musicBrainzId?: string          // Release MBID
  ├── releaseGroup: UnifiedReleaseGroup
  ├── sources: InstanceAlbumRef[]     // Which instances have this release
  ├── tracks: UnifiedTrack[]
  └── edition?: string               // "Deluxe", "Japan", "Remaster", etc.

UnifiedTrack
  ├── title: string
  ├── musicBrainzId?: string          // Recording MBID
  ├── trackNumber: number
  ├── discNumber: number
  ├── durationMs: number
  ├── artist: UnifiedArtist
  ├── release: UnifiedRelease
  └── sources: InstanceTrackRef[]     // All copies across instances

InstanceTrackRef
  ├── instanceId: string
  ├── remoteId: string               // Subsonic track ID on that instance
  ├── format: string                 // "flac", "mp3", "aac"
  ├── bitRate?: number
  ├── size?: number
  └── available: boolean             // Based on instance health
```

**Merging strategy:**

1. **With MusicBrainz IDs (preferred path):** When tracks/albums have MBIDs in their tags, merging is deterministic. Two tracks with the same Recording MBID are the same performance. Two albums with the same Release Group MBID are versions of the same work.

2. **Without MusicBrainz IDs (fuzzy fallback):** When MBIDs are absent, use fuzzy matching:
   - Normalize artist/album/track names (lowercase, strip punctuation, transliterate unicode)
   - Match artists by normalized name
   - Match albums by normalized name + artist + year (±1 year tolerance)
   - Match tracks by normalized title + artist + duration (±3 second tolerance)
   - Confidence scoring: matches above threshold auto-merge; below threshold are flagged for manual review

3. **Release Group detection:** When multiple releases share a Release Group MBID, they appear as "versions" under one entry. Without MBIDs, heuristics detect variants:
   - Same artist + similar album name + different track count → likely different editions
   - Same artist + same album name + same track count + different source → likely same release

**Sync process:**
- On initial registration and periodically (configurable, default: every 6 hours), the Hub queries each instance's full library via `getArtists`, `getAlbumList2`, and `getAlbum` (for track details).
- Responses are diffed against the cached state; only changes trigger re-merging.
- The merged unified library is stored in SQLite for fast queries.
- A full re-sync can be triggered manually.

#### 2c. Stream Proxy

Handles audio playback by proxying streams from the originating instance.

**Flow:**
```
Browser → Hub API → Select best source → Proxy stream from instance → Browser
```

**Source selection logic:**
When a unified track has multiple sources (copies on different instances):
1. Filter to online instances only
2. Prefer the instance with lowest latency (tracked via ping times)
3. If the client requests transcoding, prefer instances that already have the target format (avoids transcoding overhead)
4. If equal, prefer higher quality source (FLAC > 320kbps MP3 > lower bitrates)

**Streaming implementation:**
- The Hub calls the Subsonic `stream` endpoint on the selected instance with appropriate `format` and `maxBitRate` parameters
- The response is piped directly to the client (the Hub does not buffer the full file)
- Transcoding happens on the originating Navidrome instance, not on the Hub
- For seeking, the Subsonic API supports `timeOffset` parameter

**Why proxy instead of direct connection:**
- Users don't need credentials for every instance
- The Hub controls source selection and failover
- Simplifies CORS and authentication for the web frontend
- Enables future features like cross-instance gapless playback

#### 2d. Auth Service

Manages Poutine user accounts and access control.

**Design:**
- Users register on the Hub with username/password
- Passwords hashed with Argon2id (no plaintext storage)
- JWT tokens for API authentication (short-lived access tokens + refresh tokens)
- Each Hub user can be linked to zero or more instance owners
- All users can browse and play from the merged library (access is all-or-nothing for v1)

**Future:** Role-based access, per-instance permissions, OAuth2 for third-party clients.

### 3. Web Frontend

A React single-page application providing the unified library browsing and playback experience.

**Technology choices:**
- **Framework:** React 19 with TypeScript
- **Build tool:** Vite
- **UI library:** Tailwind CSS + shadcn/ui components
- **State management:** Zustand (lightweight, minimal boilerplate)
- **Audio:** HTML5 Audio API with a custom player component
- **Data fetching:** TanStack Query (caching, background refetching)

**Key views:**

| View | Description |
|------|------------|
| **Library Browser** | Grid/list of release groups with cover art, filterable by artist, genre, year. Default view. |
| **Release Group Detail** | Shows all versions (releases) of an album. Each version lists its tracks. Play buttons per-version and per-track. |
| **Artist Page** | Artist bio (if available), discography as release groups, top tracks aggregated across instances. |
| **Now Playing** | Full-screen player with album art, track info, playback controls, volume. Queue management. |
| **Search** | Unified search across all instances. Results grouped by artists, albums, tracks. |
| **Instance Admin** | Add/remove/configure instances. View instance health and sync status. |
| **User Settings** | Account management, playback preferences (preferred transcode format/bitrate). |

**Playback:**
- Audio streams via `<audio>` element pointed at the Hub's stream proxy endpoint
- Gapless playback via Web Audio API (pre-buffering next track)
- Transcode format preference: Opus 128kbps for modern browsers, AAC 256kbps as fallback
- Queue persisted in local storage

## Deployment Architecture

The Hub and frontend are deployed together as a Docker Compose stack:

```yaml
# docker-compose.yml (Poutine Hub)
services:
  hub:
    build: ./hub
    ports:
      - "3000:3000"
    environment:
      DATABASE_PATH: /data/poutine.db
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
    volumes:
      - hub-data:/data

  frontend:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - hub

volumes:
  hub-data:
```

**Operational costs:** Near zero. The Hub runs on any machine the operator already has. No cloud services required. The only external dependency is network connectivity between the Hub and instances.

**Where does the Hub run?** On one participant's server, or on a small VPS. It's lightweight (Node.js + SQLite). A $5/month VPS could handle it, or it can run on the same hardware as one of the Navidrome instances.

## Security Model

| Concern | Approach |
|---------|----------|
| Passwords | Argon2id hashing. No plaintext storage anywhere. |
| API auth | JWT access tokens (15 min) + refresh tokens (7 days). Tokens stored in httpOnly cookies. |
| Instance credentials | Encrypted at rest in SQLite using a server-side key derived from JWT_SECRET. |
| Transport | HTTPS required for all instance connections. Hub enforces TLS verification. |
| Instance trust | Instances are explicitly registered by an admin. No auto-discovery from untrusted sources. |
| CORS | Frontend origin whitelisted. Stream proxy avoids CORS issues for audio. |

## Data Flow: Playing a Track

```
1. User clicks play on "Paranoid Android" in the web UI
2. Frontend sends POST /api/queue/play { trackId: "unified-track-xyz" }
3. Hub looks up UnifiedTrack "unified-track-xyz"
4. Hub finds 3 sources:
   - Instance A: FLAC, 44.1kHz (online, 45ms latency)
   - Instance B: MP3 320kbps (online, 120ms latency)
   - Instance C: FLAC, 96kHz (offline)
5. Hub selects Instance A (online, lowest latency, highest quality)
6. Hub calls Instance A's Subsonic API:
   GET /rest/stream?id=remote-id-123&format=opus&maxBitRate=128&u=poutine&t=token&s=salt&v=1.16.1&c=poutine
7. Instance A transcodes FLAC → Opus 128kbps via FFmpeg
8. Hub pipes the audio stream to the browser
9. Browser plays via <audio> element
10. On track end, Hub pre-fetches next track URL for gapless transition
```

## Scalability Considerations

This system is designed for 4-12 instances and does not need to scale beyond that.

| Dimension | Capacity | Notes |
|-----------|----------|-------|
| Instances | 4-12 | Fan-out queries are parallel; 12 is fine |
| Concurrent users | ~20-50 | Limited by stream proxy bandwidth |
| Library size per instance | ~50,000 tracks | SQLite handles this easily |
| Total unified library | ~200,000-600,000 tracks | SQLite with proper indexes handles this |
| Sync frequency | Every 6 hours | Incremental diffs keep it fast |

## Technology Stack Summary

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Per-instance server | Navidrome | Lightweight, Subsonic API, trivial Docker |
| Hub language | TypeScript (Node.js) | Maintainability, shared with frontend, async I/O |
| Hub framework | Fastify | Performance, schema validation, TypeScript |
| Hub database | SQLite (better-sqlite3) | Zero-config, sufficient scale, single-file backup |
| Frontend framework | React 19 | Ecosystem, developer pool, component model |
| Frontend build | Vite | Fast builds, good DX |
| Frontend styling | Tailwind + shadcn/ui | Rapid UI development, consistent design |
| State management | Zustand | Simple, lightweight, TypeScript-native |
| Data fetching | TanStack Query | Caching, deduplication, background refresh |
| Auth | JWT + Argon2id | Standard, stateless, secure |
| Containerization | Docker Compose | Simple multi-container orchestration |
| Audio transcoding | FFmpeg (via Navidrome) | Industry standard, all codec support |
