# Poutine Federation API

Peer-to-peer protocol used by Poutine instances for hub authentication and future federation surfaces. All federation endpoints require Ed25519 request signing.

---

## Versioning

Two version identifiers are carried on every federation response:

| Header                | Type    | Description                                                                       |
|-----------------------|---------|-----------------------------------------------------------------------------------|
| `Poutine-Api-Version` | Integer | Protocol version. Incremented on breaking changes to request/response contracts.  |

All outgoing HTTP requests from the hub carry:

| Header       | Value               | Description                                                                                                              |
|--------------|---------------------|--------------------------------------------------------------------------------------------------------------------------|
| `User-Agent` | `Poutine/<semver>`  | Application version of the sending hub. Sent on federation requests, Navidrome Subsonic calls, and peer health checks.   |

Peers report both versions through `/api/health`, which `GET /admin/peers` reads and surfaces as `appVersion` and `apiVersion` per peer.

**Current versions**

| Field                              | Value            |
|------------------------------------|------------------|
| Protocol (`Poutine-Api-Version`)   | `3`              |
| Application (`User-Agent`)         | `Poutine/0.2.0`  |

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

| Method | Path                       | Purpose                                                                       |
|--------|----------------------------|-------------------------------------------------------------------------------|
| `GET`  | `/federation/stream/:id`   | Stream audio from the receiver's local Navidrome to a peer (`:id` is the receiver's Navidrome track ID). Forwards Subsonic transcode params (`format`, `maxBitRate`, `timeOffset`, `estimateContentLength`) and `Range`. The receiver records each successful stream in its own activity log as `kind='proxy'` (issue #121). |
| `GET`  | `/api/health`              | Health check endpoint (no auth required). Returns instance status, versions, and last Navidrome sync timestamp. Used by peers for health monitoring and automatic sync decisions. |

Library metadata and cover art travel through `/proxy/*`, which reuses the same Ed25519 signing scheme. See `docs/hub-internals.md` for the `/proxy/*` contract (Phase 1).

---

## GET /api/health

Health check endpoint that returns instance status and metadata. No authentication required.

### Response

```json
{
  "status": "ok",
  "appVersion": "0.4.3",
  "apiVersion": 4,
  "lastNavidromeSync": "2026-01-15T10:30:00Z"
}
```

| Field               | Type     | Description                                                                 |
|---------------------|----------|-----------------------------------------------------------------------------|
| `status`            | string   | Health status (`"ok"` on success)                                          |
| `appVersion`        | string   | Poutine application version (from `User-Agent`)                            |
| `apiVersion`        | integer  | Federation protocol version (from `Poutine-Api-Version`)                   |
| `lastNavidromeSync` | string   | ISO 8601 timestamp of last successful Navidrome sync, or `null` if never synced |

---

## Changelog

### Version 4 (current)

- **Added** `GET /api/health` endpoint — returns instance health status, versions, and `lastNavidromeSync` timestamp.
- **Added** `lastNavidromeSync` field to `/api/health` response — used by peers for automatic sync decisions (issue #14).

**Rationale:** Automatic peer synchronization requires peers to know when their library was last synced with Navidrome. The health endpoint provides this information without requiring authentication, enabling efficient sync scheduling.

### Version 3

- **Removed** `GET /federation/library/export` — library metadata sync is superseded by the `/proxy/*` tier.
- **Removed** `GET /federation/art/:encodedId` — cover art proxying now handled by `/proxy/*`.
- `GET /federation/stream/:id` is retained: cross-peer audio streaming continues to flow through this route. Cover art and metadata moved to `/proxy/*`, but stream payloads stayed put.
- Ed25519 signing scheme, `Poutine-Api-Version` response header, and peer registry (`peers.yaml`) are all retained and reused by `/proxy/*`.

**Rationale:** The old federation content routes created a tight coupling between the exporting hub's Navidrome and the importing peer. The `/proxy/*` architecture (issue #49) decouples content delivery from library metadata, allows token-scoped access, and removes fan-out re-export risk. See issue #49 for full design rationale.

### Version 2

- **`/library/export`**: Only locally-sourced tracks are exported. Peer-imported tracks are excluded to prevent fan-out re-export loops. The `total` field in `page` and the tracks array reflect this filtered set. Sources are also filtered to `source_kind = 'local'` only.

### Version 1

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
- Ed25519 signing is exercised in `hub/test/federation-signing.test.ts` and `hub/test/proxy.test.ts`.
- Signing helpers: `hub/src/federation/signing.ts`, `hub/src/federation/sign-request.ts`.
- Peer auth middleware: `hub/src/federation/peer-auth.ts`.
- Peer registry: `hub/src/federation/peers.ts` (loaded from `peers.yaml`, reloaded on SIGHUP).
