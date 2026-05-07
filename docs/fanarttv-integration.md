# fanart.tv Integration

## Overview

fanart.tv is the **primary** source for artist images and a fallback for album covers when the local library lacks one. Lookups are MusicBrainz-keyed: artists by artist MBID, albums by release-group MBID. Artists without an MBID are not queried.

Poutine ships with a bundled project API key, so the integration is enabled by default. No setup is required.

## Behavior

| Scope   | Triggered when                                                            | Lookup key                |
|---------|---------------------------------------------------------------------------|---------------------------|
| Artist  | Artist has an MBID.                                                       | Artist MBID               |
| Album   | Album has a release-group MBID **and** Navidrome has no `coverArt`.       | Release-group MBID        |

For artists, fanart.tv wins over a Navidrome-provided cover when both exist. This is intentional — fanart.tv typically has higher-quality artist art (HD logos, banners, backgrounds) than what Navidrome surfaces.

If fanart.tv has nothing for an artist (404 or empty image lists), Poutine falls back to Navidrome's `coverArt`. If that's also missing **and** the artist has no MBID and `LASTFM_API_KEY` is configured, Last.fm is consulted as a last resort. See [`lastfm-integration.md`](./lastfm-integration.md).

Failure modes (network errors, non-OK statuses) are logged and treated as "no result" — they never fail a sync.

## Image selection

| Field                | Preference for…  | Notes                                          |
|----------------------|------------------|------------------------------------------------|
| `artistthumb`        | Artist image     | Square, ~1000×1000 — best for grid views.      |
| `artistbackground`   | Artist fallback  | Wide background art if no thumb is available.  |
| `albumcover`         | Album cover      | 1000×1000 release-group cover.                 |

Within a list, the entry with the highest `likes` count wins.

## Configuration

| Env var                | Default                                        | Purpose                                                                                       |
|------------------------|------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `FANARTTV_API_KEY`     | `dd4c8d4d423b6bae65169cd5a6339d3f` (bundled)   | Project API key. Override only if you have your own.                                          |
| `FANARTTV_CLIENT_KEY`  | _(unset)_                                       | Personal API key — drops the new-image delay from 7 days to 2.                                |
| `FANARTTV_API_URL`     | `https://webservice.fanart.tv/v3.2`            | Base URL. Override for tests or self-hosted mirrors.                                          |

To disable fanart.tv entirely, set `FANARTTV_API_KEY=""`.

### Tier behavior

| Tier               | Image freshness  |
|--------------------|------------------|
| Project (bundled)  | 7-day delay      |
| Project + personal | 2-day delay      |
| VIP membership     | Real-time        |

Poutine caches results in `unified_artists.image_url` and `instance_albums.cover_art_id`, so the delay only affects newly-added artwork on the fanart.tv side.

## Data storage

- Artist images: stored as a URL in `unified_artists.image_url` and `instance_artists.image_url`. Frontend `artUrl()` short-circuits absolute URLs and the browser fetches them directly, so artist images do not go through `/rest/getCoverArt`.
- Album covers: when supplied by fanart.tv, stored as a URL in `instance_albums.cover_art_id`. After merge, `unified_release_groups.image_url` holds the encoded `instanceId:https://...` form; `decodeCoverArtId` splits at the first colon so the URL survives. The Subsonic `getCoverArt` handler detects the leading `https://` and fetches it directly rather than reverse-proxying Navidrome.

### SSRF allowlist

External URLs reached via `/rest/getCoverArt` are validated by `hub/src/routes/external-art.ts` before fetching:

- https only (http rejected).
- Hostname must be `fanart.tv` or end in `.fanart.tv`.
- All other hosts → 400 "Disallowed external art URL".

This prevents a malicious peer from federating a `cover_art_id` pointing at intranet endpoints. If new external image sources are added later, extend the allowlist there — not at the call site.

## API reference

### `FanartTvClient`

Located at `hub/src/services/fanarttv.ts`.

| Method                                     | Description                                                                |
|--------------------------------------------|----------------------------------------------------------------------------|
| `isEnabled()`                              | True if a project key is configured.                                       |
| `getArtist(mbid)`                          | Fetches `/music/{mbid}`. Returns `null` on 404 or any error.               |
| `getAlbum(releaseGroupMbid)`               | Fetches `/music/albums/{rg-mbid}`. Returns `null` on 404 or any error.     |
| `static bestArtistImage(resp)`             | Picks `artistthumb` → `artistbackground`. Highest-liked entry wins.        |
| `static bestAlbumCover(resp, rgMbid)`      | Picks the best `albumcover` for the given release-group MBID.              |

## Troubleshooting

### Verify the integration is enabled

Server log line on startup:

```
fanart.tv integration enabled — using bundled Poutine project key
```

(Or `using overridden project key` if `FANARTTV_API_KEY` is set.)

### Test the API directly

```bash
curl "https://webservice.fanart.tv/v3.2/music/a74b1b7f-71a5-4011-9441-d0b5e4122711?api_key=$FANARTTV_API_KEY"
```

### An artist has no image

- Confirm the artist has an MBID in `unified_artists.musicbrainz_id`. Without one, fanart.tv is skipped.
- Verify fanart.tv has artwork for that MBID via the curl test above.
- Newly-added artwork is delayed 7 days for project-key access. Set `FANARTTV_CLIENT_KEY` to drop that to 2 days.
