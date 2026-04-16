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

**v3 has no content endpoints under `/federation/*`.**

Content (audio streams, cover art) and library metadata now travel through `/proxy/*`, which reuses the same Ed25519 signing scheme. See `docs/hub-internals.md` for the `/proxy/*` contract (Phase 1).

---

## Changelog

### Version 3 (current)

- **Removed** `GET /federation/library/export` — library metadata sync is superseded by the `/proxy/*` tier.
- **Removed** `GET /federation/stream/:trackId` — audio proxying now handled by `/proxy/*`.
- **Removed** `GET /federation/art/:encodedId` — cover art proxying now handled by `/proxy/*`.
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
