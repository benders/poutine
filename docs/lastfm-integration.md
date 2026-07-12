# Artist & Album Image Integration

## Overview

Poutine fetches artist images from two sources, picked per-artist by what's available:

| Source         | Used when                                                  | Lookup key  |
|----------------|------------------------------------------------------------|-------------|
| **fanart.tv**  | Artist has a MusicBrainz ID. Always enabled (bundled key). | Artist MBID |
| **Last.fm**    | Artist has **no** MBID **and** `LASTFM_API_KEY` is set.    | Artist name |

Album covers come from Navidrome; fanart.tv is a fallback when an album has a release-group MBID but Navidrome has no cover. See [fanarttv-integration.md](fanarttv-integration.md) for the fanart.tv path.

Last.fm covers only the long tail of artists missing an MBID. Set `LASTFM_API_KEY` to enable (key from https://www.last.fm/api/account/create). Env var detail: [hub-internals.md#environment-variables](hub-internals.md#environment-variables).

## How it works

**During sync**, per artist, in order:

1. Has MBID → fanart.tv. Result wins over Navidrome's cover.
2. Else → Navidrome's `coverArt`.
3. Still no image, no MBID, and `LASTFM_API_KEY` set → Last.fm by artist name.

Artists with an MBID never trigger Last.fm.

**On-demand** via `/rest/getArtistInfo2`: returns the cached image URL, or fetches from Last.fm (when enabled) and caches it.

Last.fm returns multiple sizes; preference order: `extralarge` (500²) → `large` (300²) → `medium` (100²) → `small` (64²).

## Storage & degradation

- Cached in `unified_artists.image_url` and `instance_artists.image_url`; repeat syncs don't re-fetch.
- Failed/unreachable Last.fm lookups are logged and skipped — image stays `null`, sync never blocks.
- To backfill artists synced before enabling Last.fm: set `LASTFM_API_KEY`, restart, trigger a full sync (or just view the artist page, which fires an on-demand lookup).

## Implementation

| Concern         | Location                          |
|-----------------|-----------------------------------|
| Client + fetch  | `hub/src/services/lastfm.ts`      |
| Wired into sync | `hub/src/library/sync.ts`         |
| Env / config    | `hub/src/config.ts`               |
