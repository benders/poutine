# ADR-001: Backend Architecture for Federated Music Player

**Status:** Accepted
**Date:** 2026-03-21

## Context

Poutine is a federated music player that merges 4-12 personal music collections into a single unified library. Each collection runs on its own instance (NAS, Raspberry Pi, Mac Mini, etc.). We need to decide whether to:

1. **Use Jellyfin** as the per-instance music server and build a federation layer on its API
2. **Use Navidrome** (or another Subsonic-compatible server) as the per-instance server and build a federation layer on the Subsonic API
3. **Build a fully custom** music server and federation layer from scratch
4. **Adopt Funkwhale**, which already has ActivityPub-based federation

## Options Evaluated

### Option A: Jellyfin + Custom Federation Layer

Jellyfin is a mature, general-purpose media server with a REST API, FFmpeg transcoding, and MusicBrainz integration.

| Aspect | Assessment |
|--------|-----------|
| API quality | Comprehensive but poorly documented. Best learned by reading Finamp source and browser DevTools. OpenAPI spec exists but practical guidance is sparse. |
| Music support | Second-class citizen behind video. No smart playlists, limited music-specific features. |
| MusicBrainz | Built-in but buggy: UFID truncation, wrong artist tag field, incomplete metadata population. |
| Transcoding | Excellent (FFmpeg). On-the-fly FLAC to AAC/Opus/MP3. |
| Resource usage | 2-4 GB RAM per instance. Heavy for Raspberry Pi. |
| Federation | No native support. Community projects exist (Jellyswarrm, FederationPlugin) but are immature. |
| Auth | API keys for server-level access; user tokens for user-scoped ops. Auth system is in flux (legacy methods being removed in 10.12). |
| Docker | Good support but heavier image (~500 MB+). |

**Verdict:** Viable if instances already run Jellyfin. But the API instability, heavy resource usage, and music being a secondary concern make it a suboptimal choice for a music-first system.

### Option B: Navidrome + Subsonic API + Custom Federation Layer (Recommended)

Navidrome is a lightweight, music-first server written in Go that implements the Subsonic/OpenSubsonic API.

| Aspect | Assessment |
|--------|-----------|
| API quality | Subsonic API is well-documented, stable, and battle-tested across 50+ client apps. OpenSubsonic adds modern extensions (token auth, POST bodies). |
| Music support | Purpose-built for music. Smart playlists, star/rating, scrobbling, multi-valued tags. |
| MusicBrainz | Reads MBIDs from file tags. No built-in lookup, but tags written by MusicBrainz Picard are preserved. |
| Transcoding | FFmpeg on-the-fly. Subsonic API supports requesting specific formats/bitrates via `format` and `maxBitRate` parameters. |
| Resource usage | 30-50 MB RAM. Runs comfortably on Raspberry Pi Zero. |
| Federation | None built-in. Must be built. |
| Auth | Subsonic API uses username + token (salted MD5 hash). OpenSubsonic adds API key authentication. |
| Docker | Trivial: 1 container, 2 volumes, 1 port. Image ~30 MB. |

**Verdict:** Best fit. Lightweight, music-focused, well-documented standard API, trivial deployment. The Subsonic API provides all the primitives needed for federated queries (search, browse, stream by ID).

### Option C: Fully Custom Server

Build everything from scratch: file scanning, metadata parsing, transcoding, streaming, auth, API.

| Aspect | Assessment |
|--------|-----------|
| Control | Total. Can design metadata normalization and federation as first-class features. |
| Engineering effort | 6-12+ months to reach parity with Navidrome on basic features alone. |
| Transcoding | Must integrate FFmpeg (via CLI or C bindings). Well-understood but still work. |
| Metadata | Must integrate taglib or equivalent. Must build MusicBrainz lookup pipeline. |
| Maintenance | Ongoing burden for codec support, security patches, edge cases. |

**Verdict:** Not justified. Navidrome already solves the per-instance problem well. Engineering effort is better spent on the federation layer, which is the novel part of Poutine.

### Option D: Funkwhale (ActivityPub Federation)

Funkwhale is a federated music platform using ActivityPub.

| Aspect | Assessment |
|--------|-----------|
| Federation | Built-in via ActivityPub. Libraries are Actors; followers receive Create/Audio/Delete activities. |
| Maturity | 2.0 is in alpha with breaking federation changes. V1 and V2 pods cannot federate. |
| Resource usage | 2-4 GB RAM. Multiple containers (web, worker, celery, postgres, redis). |
| API | Custom API, not Subsonic-compatible. No client ecosystem. |
| Complexity | Massively over-engineered for 4-12 trusted instances. ActivityPub is designed for untrusted, internet-scale federation. |
| Docker | Complex compose file with 5+ services. |

**Verdict:** Proves music federation is possible but is the wrong tool. ActivityPub adds enormous complexity for a trusted, small-scale network. The 2.0 transition makes the platform unstable.

## Decision

**Option B: Navidrome as the per-instance server, with a custom federation layer built on top of the Subsonic/OpenSubsonic API.**

Additionally, the federation layer should be designed to also support Jellyfin instances via an adapter, since some users may already run Jellyfin. This is a secondary priority.

## Rationale

1. **Right-sized for the problem.** Navidrome is lightweight enough to run on any home server (30-50 MB RAM) while providing excellent music library management.

2. **Standard API.** The Subsonic API is the de facto standard for self-hosted music. Building on it means: (a) well-documented interface for federation queries, (b) compatibility with 50+ existing client apps as a fallback, (c) stable contract unlikely to break.

3. **Separation of concerns.** Each instance owner manages their own Navidrome server and music files. Poutine's novel contribution is the federation/aggregation layer, which is where engineering effort should focus.

4. **Transcoding is solved.** Navidrome handles FLAC-to-Opus/AAC transcoding via FFmpeg. The Subsonic API's `format` and `maxBitRate` streaming parameters give us control from the federation layer.

5. **Metadata normalization via MusicBrainz Picard.** Rather than building MusicBrainz API integration into the server, we recommend users tag their libraries with MusicBrainz Picard before joining the federation. This writes MBIDs into file tags, which Navidrome preserves and exposes via the API.

6. **Extensible.** A Jellyfin adapter can be added later by translating Jellyfin API responses into the same internal model. The federation layer doesn't need to know which backend serves a given instance.

## Consequences

- Instance owners must install and manage Navidrome (Docker makes this trivial).
- Users should tag their libraries with MusicBrainz Picard for best deduplication results. Untagged libraries will still work but may show duplicates.
- The federation layer is a new component that must be designed and built (see architecture document).
- Jellyfin support is deferred to a later phase but architecturally accommodated.
