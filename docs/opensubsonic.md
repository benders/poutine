# OpenSubsonic Compatibility

Poutine implements the [OpenSubsonic API](https://opensubsonic.netlify.app/) — a superset of the Subsonic REST API — at `/rest/*`. Third-party Subsonic/OpenSubsonic clients (DSub, Symfonium, etc.) connect here.

## Version claims

| Field           | Value     | Source                                       |
|-----------------|-----------|----------------------------------------------|
| `version`       | `1.16.1`  | `hub/src/routes/subsonic-response.ts`        |
| `openSubsonic`  | `true`    | Present in every response envelope           |
| `type`          | `poutine` | Server type field (OpenSubsonic extension)   |
| `serverVersion` | `0.2.0`   | Tracks `APP_VERSION` in `hub/src/version.ts` |

## Response formats

Both JSON (`f=json`, default) and XML (`f=xml`) supported. Default is JSON.

## Auth

`/rest/*` accepts standard Subsonic credential params:

1. **`u+p`** — username + password. Supports `enc:<hex>` prefix (hex-encoded password).
2. **`u+t+s`** — username + `md5(password + salt)` + salt.

Both forms are fully supported as of 0.4.0. Earlier versions (which stored Argon2id hashes) accepted only `u+p`. There is no JWT auth on `/rest/*` — the bundled SPA also uses `u+t+s`.

### Auth-related error codes

The SPA's `subsonicFetch` (`frontend/src/lib/subsonic.ts`) clears local creds and redirects to `/login` on any **credential-related** error code. Code 50 is authorization (insufficient privilege), not authentication, and must surface as a normal error without redirecting.

| Code | Meaning                                          | SPA redirect to /login? |
|------|--------------------------------------------------|-------------------------|
| 10   | Required parameter missing                       | Yes (implies creds absent) |
| 20   | Incompatible client (must upgrade)               | No                      |
| 30   | Incompatible server (must upgrade)               | No                      |
| 40   | Wrong username or password                       | **Yes**                 |
| 41   | Token auth not supported (LDAP user)             | **Yes**                 |
| 42   | Provided auth mechanism not supported            | **Yes**                 |
| 43   | Multiple conflicting auth mechanisms             | **Yes**                 |
| 44   | Invalid API key                                  | **Yes**                 |
| 50   | User not authorized for operation                | No (authz, not authn)   |
| 60   | Trial period over                                | No                      |
| 70   | Data not found                                   | No                      |

See [authentication.md](authentication.md) for the full auth reference.

## Endpoint compatibility

All endpoints support both GET and POST, with and without the `.view` suffix (e.g. `/rest/ping` and `/rest/ping.view` are equivalent). Implementation lives in `hub/src/routes/subsonic.ts`.

### System

| Endpoint                    | Status          | Notes                        |
|-----------------------------|-----------------|------------------------------|
| `ping`                      | Implemented     |                              |
| `getLicense`                | Implemented     | Always returns `valid: true` |
| `getOpenSubsonicExtensions` | NOT IMPLEMENTED |                              |

### Browsing

| Endpoint            | Status          | Notes                                                              |
|---------------------|-----------------|--------------------------------------------------------------------|
| `getMusicFolders`   | Implemented     | One folder per known instance (local + active peers); `id` is the stable `instances.musicfolder_id` (issue #123) |
| `getIndexes`        | Implemented     | Returns artist index from unified library; ignores `musicFolderId` |
| `getMusicDirectory` | NOT IMPLEMENTED |                                                                    |
| `getGenres`         | Implemented     | Aggregated from `unified_release_groups` + `unified_tracks`        |
| `getArtists`        | Implemented     | Alphabetical index from unified library; ignores `musicFolderId`   |
| `getArtist`         | Implemented     | Returns artist + album list                                        |
| `getAlbum`          | Implemented     | Returns album + track list; album ID prefix `al<uuid>`             |
| `getSong`           | Implemented     | Track ID prefix `t<uuid>`                                          |
| `getVideos`         | NOT IMPLEMENTED |                                                                    |
| `getVideoInfo`      | NOT IMPLEMENTED |                                                                    |
| `getArtistInfo`     | NOT IMPLEMENTED |                                                                    |
| `getArtistInfo2`    | Implemented     | Returns artist info with image URLs; supports `musicBrainzId`, `count`, `includeNotYetReleased` |
| `getAlbumInfo`      | NOT IMPLEMENTED |                                                                    |
| `getAlbumInfo2`     | NOT IMPLEMENTED |                                                                    |
| `getSimilarSongs`   | NOT IMPLEMENTED |                                                                    |
| `getSimilarSongs2`  | NOT IMPLEMENTED |                                                                    |
| `getTopSongs`       | NOT IMPLEMENTED |                                                                    |

### Album/song lists

| Endpoint          | Status          | Notes                                                                                          |
|-------------------|-----------------|------------------------------------------------------------------------------------------------|
| `getAlbumList`    | NOT IMPLEMENTED |                                                                                                |
| `getAlbumList2`   | Implemented     | Supports `newest`, `alphabeticalByName`, `alphabeticalByArtist`, `byYear`, `byGenre`, `random`. Honors standard `musicFolderId` (resolved via `instances.musicfolder_id`). Legacy alias: `instanceId=<local\|peerId>` filters by raw instance UUID. Unknown `musicFolderId` returns an empty list. |
| `getRandomSongs`  | NOT IMPLEMENTED |                                                                                                |
| `getSongsByGenre` | NOT IMPLEMENTED |                                                                                                |
| `getNowPlaying`   | Stub            | Always returns an empty list                                                                   |
| `getStarred`      | NOT IMPLEMENTED |                                                                                                |
| `getStarred2`     | NOT IMPLEMENTED |                                                                                                |

### Searching

| Endpoint  | Status          | Notes                               |
|-----------|-----------------|-------------------------------------|
| `search`  | NOT IMPLEMENTED | Legacy v1 endpoint                  |
| `search2` | NOT IMPLEMENTED |                                     |
| `search3` | Implemented     | Name LIKE match; also matches internal IDs (with or without `ar`/`al`/`t` prefix), MusicBrainz IDs, and Poutine share IDs (upstream Navidrome `remote_id`; see [hub-internals.md](hub-internals.md#share-ids)) on artists, albums, and songs |

### Playlists

| Endpoint         | Status | Notes                                               |
|------------------|--------|-----------------------------------------------------|
| `getPlaylists`   | Stub   | Always returns an empty list (Phase 3+)             |
| `getPlaylist`    | Stub   | Always returns error 70 (not found) (Phase 3+)      |
| `createPlaylist` | Stub   | Always returns error 0 (not implemented) (Phase 3+) |
| `updatePlaylist` | Stub   | Always returns error 0 (not implemented) (Phase 3+) |
| `deletePlaylist` | Stub   | Always returns error 0 (not implemented) (Phase 3+) |

### Media retrieval

| Endpoint            | Status          | Notes                                                                          |
|---------------------|-----------------|--------------------------------------------------------------------------------|
| `stream`            | Implemented     | Supports `format`, `maxBitRate`, and `timeOffset`; selects best source across federated peers. HTTP `Range` forwarded for raw passthrough (206 + `Content-Range`); dropped when transcoding (#97). Frontend uses `timeOffset` to seek inside transcoded streams (#109) |
| `download`          | Implemented     | Alias for `stream`; clients use them interchangeably                           |
| `hls`               | NOT IMPLEMENTED |                                                                                |
| `getCaptions`       | NOT IMPLEMENTED |                                                                                |
| `getCoverArt`       | Implemented     | Disk-cached with LRU eviction; ID format `{instanceId}:{coverArtId}`           |
| `getLyrics`         | NOT IMPLEMENTED |                                                                                |
| `getLyricsBySongId` | NOT IMPLEMENTED | OpenSubsonic extension                                                         |
| `getAvatar`         | NOT IMPLEMENTED |                                                                                |

### Media annotation

| Endpoint    | Status          | Notes                         |
|-------------|-----------------|-------------------------------|
| `star`      | NOT IMPLEMENTED |                               |
| `unstar`    | NOT IMPLEMENTED |                               |
| `setRating` | NOT IMPLEMENTED |                               |
| `scrobble`  | Stub            | No-op; always returns success |

### Sharing

| Endpoint      | Status          | Notes |
|---------------|-----------------|-------|
| `getShares`   | NOT IMPLEMENTED |       |
| `createShare` | NOT IMPLEMENTED |       |
| `updateShare` | NOT IMPLEMENTED |       |
| `deleteShare` | NOT IMPLEMENTED |       |

### Podcast

| Endpoint                 | Status          | Notes |
|--------------------------|-----------------|-------|
| `getPodcasts`            | NOT IMPLEMENTED |       |
| `getNewestPodcasts`      | NOT IMPLEMENTED |       |
| `refreshPodcasts`        | NOT IMPLEMENTED |       |
| `createPodcastChannel`   | NOT IMPLEMENTED |       |
| `deletePodcastChannel`   | NOT IMPLEMENTED |       |
| `deletePodcastEpisode`   | NOT IMPLEMENTED |       |
| `downloadPodcastEpisode` | NOT IMPLEMENTED |       |

### Jukebox

| Endpoint         | Status          | Notes |
|------------------|-----------------|-------|
| `jukeboxControl` | NOT IMPLEMENTED |       |

### Internet radio

| Endpoint                     | Status          | Notes |
|------------------------------|-----------------|-------|
| `getInternetRadioStations`   | NOT IMPLEMENTED |       |
| `createInternetRadioStation` | NOT IMPLEMENTED |       |
| `updateInternetRadioStation` | NOT IMPLEMENTED |       |
| `deleteInternetRadioStation` | NOT IMPLEMENTED |       |

### Chat

| Endpoint          | Status          | Notes |
|-------------------|-----------------|-------|
| `getChatMessages` | NOT IMPLEMENTED |       |
| `addChatMessage`  | NOT IMPLEMENTED |       |

### User management

| Endpoint         | Status          | Notes |
|------------------|-----------------|-------|
| `getUser`        | NOT IMPLEMENTED |       |
| `getUsers`       | NOT IMPLEMENTED |       |
| `createUser`     | NOT IMPLEMENTED |       |
| `updateUser`     | NOT IMPLEMENTED |       |
| `deleteUser`     | NOT IMPLEMENTED |       |
| `changePassword` | NOT IMPLEMENTED |       |

### Bookmarks

| Endpoint         | Status          | Notes |
|------------------|-----------------|-------|
| `getBookmarks`   | NOT IMPLEMENTED |       |
| `createBookmark` | NOT IMPLEMENTED |       |
| `deleteBookmark` | NOT IMPLEMENTED |       |
| `getPlayQueue`   | NOT IMPLEMENTED |       |
| `savePlayQueue`  | NOT IMPLEMENTED |       |

### Media library scanning

| Endpoint        | Status          | Notes                                                     |
|-----------------|-----------------|-----------------------------------------------------------|
| `getScanStatus` | NOT IMPLEMENTED | Used internally (hub → Navidrome); not exposed to clients |
| `startScan`     | NOT IMPLEMENTED | Used internally (hub → Navidrome); not exposed to clients |

## ID encoding

All Subsonic IDs are prefixed to support federated sources:

| Prefix     | Entity |
|------------|--------|
| `ar<uuid>` | Artist |
| `al<uuid>` | Album  |
| `t<uuid>`  | Track  |

`coverArt` IDs are encoded as `{instanceId}:{coverArtId}` — the hub needs to know which upstream to query. Pass directly to `artUrl()` on the frontend; do not re-encode.
