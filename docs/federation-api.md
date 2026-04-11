# Poutine Federation API

Peer-to-peer protocol used by Poutine instances to share library metadata and proxy audio streams. All federation endpoints require Ed25519 request signing.

---

## Versioning

Two version identifiers are carried on every federation response:

| Header                | Type    | Description                                                                       |
|-----------------------|---------|-----------------------------------------------------------------------------------|
| `Poutine-Api-Version` | Integer | Protocol version. Incremented on breaking changes to request/response contracts.  |

The protocol version is also embedded in `/library/export` response bodies as `apiVersion`.

All outgoing HTTP requests from the hub carry:

| Header       | Value               | Description                                                                                                              |
|--------------|---------------------|--------------------------------------------------------------------------------------------------------------------------|
| `User-Agent` | `Poutine/<semver>`  | Application version of the sending hub. Sent on federation requests, Navidrome Subsonic calls, and peer health checks.   |

Peers report both versions through `/api/health`, which `GET /admin/peers` reads and surfaces as `appVersion` and `apiVersion` per peer.

**Current versions**

| Field                              | Value            |
|------------------------------------|------------------|
| Protocol (`Poutine-Api-Version`)   | `1`              |
| Application (`User-Agent`)         | `Poutine/0.1.0`  |

---

## Authentication

Every request to a `/federation/*` endpoint must be signed with the sender's Ed25519 private key.

### Signing headers

| Header                | Description                                                   |
|-----------------------|---------------------------------------------------------------|
| `x-poutine-instance`  | Sender's instance ID (must match a registered peer)           |
| `x-poutine-user`      | Username the sender is acting on behalf of                    |
| `x-poutine-timestamp` | Unix epoch milliseconds as a decimal string                   |
| `x-poutine-signature` | Base64-encoded Ed25519 signature over the canonical payload   |

### Canonical signing payload

```
METHOD\nPATH\nBODY_HASH\nTIMESTAMP\nINSTANCE_ID\nUSER_ASSERTION
```

Fields joined by `\n` (newline). `BODY_HASH` is the lowercase hex SHA-256 of the request body, or `-` for requests without a body. `PATH` is the full URL path including query string.

### Timestamp validation

The receiver rejects requests whose `x-poutine-timestamp` differs from the server clock by more than **5 minutes**.

### Error responses

| Status | Condition                               |
|--------|-----------------------------------------|
| `401`  | Missing or malformed signing headers    |
| `401`  | Timestamp outside the 5-minute window   |
| `401`  | Unknown peer instance ID                |
| `401`  | Signature verification failure          |

All errors return `{ "error": "<message>" }`. The `Poutine-Api-Version` header is present even on 401 responses.

---

## Endpoints

### GET /federation/library/export

Exports the instance's local library as paginated JSON. Importing peers call this to sync metadata.

**Query parameters**

| Parameter | Default | Max    | Description                                            |
|-----------|---------|--------|--------------------------------------------------------|
| `limit`   | `500`   | `2000` | Tracks per page                                        |
| `offset`  | `0`     | —      | Zero-based track offset                                |
| `since`   | —       | —      | Reserved for incremental sync (not yet implemented)    |

**Response `200 OK`**

```json
{
  "instanceId": "poutine-alice",
  "apiVersion": 1,
  "page": {
    "limit": 500,
    "offset": 0,
    "total": 1234
  },
  "artists": [
    {
      "id": "<uuid>",
      "name": "Artist Name",
      "musicbrainzId": "<mbid or null>",
      "imageUrl": "<url or null>"
    }
  ],
  "releaseGroups": [
    {
      "id": "<uuid>",
      "name": "Album Title",
      "artistId": "<uuid>",
      "musicbrainzId": "<mbid or null>",
      "year": 2001,
      "genre": "Rock",
      "coverArtId": "<navidrome cover art id or null>"
    }
  ],
  "releases": [
    {
      "id": "<uuid>",
      "releaseGroupId": "<uuid>",
      "name": "Album Title",
      "musicbrainzId": "<mbid or null>",
      "edition": null,
      "trackCount": 12
    }
  ],
  "tracks": [
    {
      "id": "<uuid>",
      "releaseId": "<uuid>",
      "artistId": "<uuid>",
      "title": "Track Title",
      "musicbrainzId": "<mbid or null>",
      "trackNumber": 1,
      "discNumber": 1,
      "durationMs": 245000,
      "genre": "Rock",
      "sources": [
        {
          "remoteId": "<navidrome song id>",
          "format": "flac",
          "bitrate": 900,
          "size": 38000000
        }
      ]
    }
  ]
}
```

**Notes**

- `coverArtId` in `releaseGroups` is the raw Navidrome cover art ID — **no peer prefix**. Importing peers must encode it as `{peerId}:{coverArtId}` before storing or serving it.
- `sources` contains only local sources. Peer-imported sources are never re-exported to prevent fan-out loops.
- Pagination is over tracks. `artists`, `releaseGroups`, and `releases` contain only rows referenced by the current page of tracks.

---

### GET /federation/stream/:trackId

Proxies audio from the local Navidrome for the given unified track ID.

**Path parameters**

| Parameter | Description                                       |
|-----------|---------------------------------------------------|
| `trackId` | The sender's `unified_track_id` (no `t` prefix)   |

**Response `200 OK`**

Raw audio bytes. `Content-Type` and `Content-Length` are forwarded from the upstream Navidrome response.

**Error responses**

| Status | Condition                                           |
|--------|-----------------------------------------------------|
| `404`  | Track not found or has no local source              |
| `502`  | Upstream Navidrome stream error or empty response   |

---

### GET /federation/art/:encodedId

Serves local cover art. Fetches from Navidrome and caches on disk.

**Path parameters**

| Parameter   | Description                                                                            |
|-------------|----------------------------------------------------------------------------------------|
| `encodedId` | Cover art ID in `{instanceId}:{coverArtId}` format. `instanceId` must be `"local"`.    |

**Query parameters**

| Parameter | Description                          |
|-----------|--------------------------------------|
| `size`    | Optional thumbnail width in pixels   |

**Response `200 OK`**

Raw image bytes. `Content-Type` is forwarded from Navidrome. `Cache-Control: public, max-age=2592000` is set. `X-Cache: HIT` or `X-Cache: MISS` indicates whether the disk cache was used.

**Error responses**

| Status | Condition                                              |
|--------|--------------------------------------------------------|
| `404`  | `encodedId` has no `:` separator                       |
| `404`  | `instanceId` is not `"local"`                          |
| `502`  | Upstream Navidrome art fetch error or empty response   |

---

## Changelog

### Version 1 (current)

Initial protocol version.

- `GET /federation/library/export` — paginated library export
- `GET /federation/stream/:trackId` — audio proxy
- `GET /federation/art/:encodedId` — cover art proxy
- `Poutine-Api-Version` response header on all federation responses
- `apiVersion` field in `/library/export` response body
- `User-Agent: Poutine/<semver>` on all outgoing federation requests

---

## Implementation notes

- **Do not modify federation routes without updating this document and incrementing `FEDERATION_API_VERSION`** in `hub/src/version.ts`.
- Contract tests live in `hub/test/federation-routes.test.ts`.
- Signing helpers: `hub/src/federation/signing.ts`, `hub/src/federation/sign-request.ts`.
- Peer registry: `hub/src/federation/peers.ts` (loaded from `peers.yaml`, reloaded on SIGHUP).
