# Poutine: Implementation Plan

This document breaks the project into phases with concrete tasks suitable for execution by a team of coding agents. Each phase produces a working increment.

## Prerequisites

Before development begins:

1. **Set up the monorepo** with two packages: `hub` (TypeScript/Fastify) and `frontend` (React/Vite).
2. **Set up at least 2 Navidrome test instances** via Docker Compose, each with a small music library (10-20 albums). Tag at least some albums with MusicBrainz Picard to test MBID-based merging.
3. **Establish CI:** Linting (ESLint + Prettier), type checking (tsc --noEmit), and tests (Vitest).

## Phase 1: Hub Foundation & Instance Connectivity

**Goal:** A running Hub server that can connect to Navidrome instances, authenticate, and fetch library data.

### Tasks

#### 1.1 Project Scaffolding
- Initialize the monorepo structure with npm/pnpm workspaces.
- Set up `hub/` package: TypeScript, Fastify, better-sqlite3, Vitest.
- Set up `frontend/` package: React 19, Vite, TypeScript, Tailwind CSS, shadcn/ui.
- Create root `docker-compose.yml` for the Hub.
- Create a `docker-compose.dev.yml` that also spins up 2 Navidrome instances with sample music.

```
poutine/
├── docs/
├── hub/
│   ├── src/
│   │   ├── server.ts            # Fastify app entry
│   │   ├── config.ts            # Environment/config loading
│   │   ├── db/
│   │   │   ├── schema.sql       # SQLite schema
│   │   │   └── client.ts        # Database connection
│   │   ├── adapters/
│   │   │   └── subsonic.ts      # Subsonic API client
│   │   ├── federation/
│   │   │   ├── registry.ts      # Instance registry
│   │   │   └── health.ts        # Health checking
│   │   ├── auth/
│   │   │   ├── passwords.ts     # Argon2id hashing
│   │   │   ├── jwt.ts           # Token creation/validation
│   │   │   └── middleware.ts    # Auth middleware
│   │   └── routes/
│   │       ├── auth.ts
│   │       ├── instances.ts
│   │       ├── library.ts
│   │       └── stream.ts
│   ├── test/
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── docker-compose.yml
├── docker-compose.dev.yml
└── package.json
```

#### 1.2 Subsonic API Client
- Implement a TypeScript client for the Subsonic REST API.
- Methods needed for Phase 1:
  - `ping()` — Verify connectivity and auth.
  - `getArtists()` — List all artists.
  - `getArtist(id)` — Get artist details with albums.
  - `getAlbumList2(type, size, offset)` — Paginated album listing.
  - `getAlbum(id)` — Get album details with tracks.
  - `search3(query)` — Full-text search.
  - `stream(id, format?, maxBitRate?)` — Returns a readable stream.
  - `getCoverArt(id, size?)` — Album/artist artwork.
- Handle Subsonic auth: `u`, `t` (md5(password + salt)), `s` (salt), `v`, `c` parameters.
- Return typed responses. Parse the Subsonic XML/JSON response format.
- Tests: mock HTTP responses, verify parameter construction and response parsing.

#### 1.3 Instance Registry
- SQLite table for registered instances (id, name, url, encrypted credentials, status, last_seen, last_synced_at).
- CRUD API routes: `POST /api/instances`, `GET /api/instances`, `DELETE /api/instances/:id`.
- Credential encryption: use AES-256-GCM with a key derived from a server secret.
- Background health check: ping each instance every 60 seconds, update status.
- Tests: registry operations, health state transitions.

#### 1.4 Auth Service
- SQLite table for users (id, username, password_hash, created_at).
- `POST /api/auth/register` — Create account (Argon2id hash).
- `POST /api/auth/login` — Verify credentials, return JWT access + refresh tokens.
- `POST /api/auth/refresh` — Refresh access token.
- Auth middleware: validate JWT on protected routes.
- First registered user becomes admin (can add instances).
- Tests: registration, login, token refresh, middleware rejection.

### Deliverable
A Hub server that can register Navidrome instances, verify connectivity, and list raw library data from each instance via API. User registration and JWT auth working.

---

## Phase 2: Metadata Merging & Unified Library

**Goal:** Fetch library data from all instances and merge it into a unified collection, properly handling duplicates and release group variants.

### Tasks

#### 2.1 Library Sync Engine
- Implement a sync worker that, for each registered instance:
  1. Calls `getArtists()` to get all artists.
  2. For each artist, calls `getArtist(id)` to get albums.
  3. For each album, calls `getAlbum(id)` to get tracks with full metadata.
  4. Stores raw instance data in SQLite (instance_artists, instance_albums, instance_tracks tables).
- Respect rate limiting: add configurable concurrency (default: 3 parallel requests per instance).
- Incremental sync: track a sync timestamp; on subsequent syncs, compare and update only changes.
- Trigger sync on instance registration and on a configurable schedule (default: every 6 hours).
- Manual trigger via `POST /api/sync` (admin only).

#### 2.2 Metadata Normalization
- Extract MusicBrainz IDs from Subsonic API responses:
  - Recording MBID → from track metadata (Navidrome exposes this if present in tags).
  - Release MBID → from album metadata.
  - Release Group MBID → from album metadata.
  - Artist MBID → from artist metadata.
- Implement name normalization utilities:
  - Lowercase, strip leading "The ", collapse whitespace, strip punctuation.
  - Transliterate common unicode variants (e.g., ö → o).
  - Generate a "normalized key" for fuzzy matching.

#### 2.3 Merge Algorithm
- Implement the merge pipeline:
  1. **Artists:** Group by Artist MBID if available, else by normalized name. Create `unified_artists` records.
  2. **Albums → Release Groups:** Group by Release Group MBID if available. Without MBID, group by (normalized artist + normalized album name). Within a group, each distinct Release MBID (or distinct track listing) becomes a separate `unified_release`.
  3. **Tracks:** Within a release, match by Recording MBID or by (normalized title + track number + duration ±3s). Each match creates a `unified_track` with one or more `track_sources`.
- Store merged data in SQLite tables: `unified_artists`, `unified_release_groups`, `unified_releases`, `unified_tracks`, `track_sources`.
- Handle edge cases:
  - Tracks with no MBID and no close fuzzy match → create as unique entries.
  - Albums appearing under slightly different artist names → resolved by Artist MBID or normalized name.
  - Compilation albums → treated as a single release group per the Subsonic data.

#### 2.4 Unified Library API
- `GET /api/library/artists` — Paginated list of unified artists. Supports search, sort (name, track count).
- `GET /api/library/artists/:id` — Artist detail with release groups.
- `GET /api/library/release-groups` — Paginated list. Supports filter by artist, genre, year range. Sort by name, year, recently added.
- `GET /api/library/release-groups/:id` — Release group detail with all versions (releases) and their tracks. Includes source instance info for each track.
- `GET /api/library/tracks` — Paginated track list. Supports search.
- `GET /api/library/search?q=...` — Unified search returning artists, release groups, and tracks.
- All endpoints require auth. Responses include cover art URLs (proxied through Hub).

### Deliverable
A fully merged unified library accessible via REST API. Browsing artists, release groups, releases, and tracks across all instances with proper deduplication.

---

## Phase 3: Audio Streaming & Playback

**Goal:** Stream audio from any instance through the Hub, with transcoding and source selection.

### Tasks

#### 3.1 Stream Proxy
- `GET /api/stream/:trackId` — Streams audio for a unified track.
- Query parameters: `format` (opus, aac, mp3, raw), `maxBitRate` (64, 128, 192, 256, 320).
- Source selection algorithm:
  1. Get all `track_sources` for the unified track.
  2. Filter to sources on online instances.
  3. Score by: instance latency (lower = better) + format preference (lossless preferred if transcoding, matching format preferred if not).
  4. Select highest-scoring source.
- Proxy the Subsonic `stream` response to the client. Set appropriate `Content-Type` headers.
- If selected instance fails mid-stream, log the error (do not attempt failover mid-stream for v1).

#### 3.2 Cover Art Proxy
- `GET /api/art/:type/:id` — Proxy cover art from the originating instance.
- Cache cover art in a local directory (filesystem cache) with TTL (30 days).
- Resize on the fly using sharp if requested (query param `size`).

#### 3.3 Playback Queue API
- `GET /api/queue` — Get current user's queue.
- `POST /api/queue` — Set queue (array of unified track IDs).
- `PATCH /api/queue` — Modify queue (add, remove, reorder).
- Queue stored server-side in SQLite per user.
- `GET /api/queue/next` — Returns stream URL for next track (enables pre-buffering).

### Deliverable
Working audio streaming through the Hub with automatic source selection and transcoding. Cover art serving. Queue management.

---

## Phase 4: Web Frontend

**Goal:** A desktop web interface for browsing and playing the merged library.

### Tasks

#### 4.1 App Shell & Auth
- Set up React app with Vite, Tailwind, shadcn/ui.
- Login/register pages.
- Auth context: store JWT, handle refresh, redirect on expiry.
- App shell layout: sidebar navigation, main content area, persistent bottom player bar.

#### 4.2 Library Browser
- **Artist list view:** Alphabetical grid with artist images. Click to navigate to artist page.
- **Release group grid:** Album cover art grid, default view. Filter sidebar: genre, year range, source instance. Sort: name, year, recently added.
- **Release group detail page:** Shows album art, metadata, list of versions (releases). Each version expandable to show track listing with play buttons. "Play all" button per version.
- **Artist detail page:** Artist image, bio placeholder, discography as release group cards.

#### 4.3 Search
- Search bar in the top navigation.
- Debounced search (300ms) hitting `/api/library/search`.
- Results grouped into sections: Artists, Albums, Tracks.
- Click-through navigation to detail pages.

#### 4.4 Audio Player
- Persistent player bar at bottom of viewport.
- Controls: play/pause, next, previous, seek bar, volume, shuffle, repeat.
- Display: current track title, artist, album art thumbnail.
- Queue drawer: slide-up panel showing upcoming tracks, drag-to-reorder.
- Implementation: HTML5 `<audio>` element controlled via React refs.
- Format selection: detect browser codec support, prefer Opus, fall back to AAC.
- Gapless playback: pre-create next `<audio>` element and crossfade at track boundary.

#### 4.5 Instance Management (Admin)
- Admin page to add/remove Navidrome instances.
- Instance health dashboard: list of instances with status indicators, last sync time, track count.
- Manual sync trigger button.
- Add instance form: URL, username, password. Test connection before saving.

### Deliverable
A fully functional web app for browsing the merged library, searching, and playing music with a polished player experience.

---

## Phase 5: Polish & Operational Readiness

**Goal:** Production-quality deployment, error handling, and documentation.

### Tasks

#### 5.1 Error Handling & Resilience
- Graceful degradation when instances go offline (UI shows which tracks are unavailable).
- Retry logic for transient network failures in sync and streaming.
- Request timeout configuration for instance API calls.
- Structured logging (pino via Fastify) with log levels.

#### 5.2 Production Docker Compose
- Multi-stage Dockerfile for Hub (build + slim runtime).
- Nginx container serving frontend static files + reverse proxying to Hub API.
- HTTPS termination via Caddy or user-provided certs.
- Health check endpoints for Docker health monitoring.
- Volume management for SQLite database and cover art cache.
- Environment variable documentation.

```yaml
# docker-compose.yml (production)
services:
  hub:
    build:
      context: ./hub
      target: production
    environment:
      DATABASE_PATH: /data/poutine.db
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
    volumes:
      - hub-data:/data
      - art-cache:/cache
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - ./frontend/dist:/srv
    restart: unless-stopped

volumes:
  hub-data:
  art-cache:
  caddy-data:
```

#### 5.3 User Documentation
- README with project overview, quickstart, and architecture diagram.
- Instance owner guide: how to set up Navidrome, tag with MusicBrainz Picard, and register with Hub.
- Hub operator guide: deployment, configuration, backup, troubleshooting.

#### 5.4 Testing
- Unit tests for: Subsonic client, merge algorithm, auth service, name normalization.
- Integration tests: spin up test Navidrome instances via Docker, register them, sync, verify merged library.
- Frontend: component tests with Vitest + Testing Library for critical flows (login, search, playback).
- End-to-end smoke test: Playwright test that logs in, browses, and plays a track.

### Deliverable
Production-ready system with documentation, tests, and operational tooling.

---

## Future Phases (Out of Scope for v1)

### Phase 6: Mobile Support
- Responsive web design for mobile browsers.
- Progressive Web App (PWA) with offline queue.
- Native mobile app (React Native or Flutter) if PWA is insufficient.

### Phase 7: MCP Interface
- Model Context Protocol server exposing the library for AI assistant integration.
- Tools: search library, play track, queue management, get recommendations.

### Phase 8: Advanced Features
- Collaborative playlists across the federation.
- Play history and listening statistics.
- Last.fm / ListenBrainz scrobbling.
- Lyrics display (via LRCLIB or embedded lyrics).
- Smart shuffle weighted by listening habits.
- Jellyfin adapter for mixed-backend federations.

---

## Estimated Complexity by Phase

| Phase | Scope | Key Risk |
|-------|-------|----------|
| Phase 1 | Scaffolding + connectivity + auth | Low risk. Standard patterns. |
| Phase 2 | Metadata merging | **Highest risk.** Fuzzy matching edge cases, data model complexity. Allocate extra time for testing with real messy libraries. |
| Phase 3 | Streaming proxy | Medium risk. Stream piping and error handling need care. |
| Phase 4 | Web frontend | Medium risk. Audio player cross-browser quirks. |
| Phase 5 | Polish | Low risk. Standard DevOps. |

## Agent Execution Notes

When implementing these phases, agents should:

1. **Start each phase by reading this plan and the architecture document** to understand context.
2. **Write tests alongside implementation**, not as a separate step.
3. **Use the dev Docker Compose** to test against real Navidrome instances.
4. **For Phase 2**, build the merge algorithm incrementally: first MBID-only merging, then add fuzzy fallback. Test with intentionally messy metadata.
5. **For the frontend**, start with the player and library browser simultaneously — they can be developed in parallel by different agents.
6. **Commit frequently** with descriptive messages. Each task should be 1-3 commits.
