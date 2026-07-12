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

Peers report both versions through `/api/health`, which `GET /api/admin/hub/peers` reads and surfaces as `appVersion` and `apiVersion` per peer.

**Current versions**

| Field                              | Value                                          |
|------------------------------------|------------------------------------------------|
| Protocol (`Poutine-Api-Version`)   | `7`                                            |
| Application (`User-Agent`)         | `Poutine/<APP_VERSION>` — see `hub/src/version.ts` |

The minimum accepted protocol version is **5**. Peers below the floor are
rejected with `403`. v0.4.x peers (api version 3) cannot join a v5 cluster
— they lack the signed-invitation provenance v5 requires.

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

| Method | Path                       | Auth          | Purpose                                                                                                                                                                                                                                                                                                                          |
|--------|----------------------------|---------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `POST` | `/federation/handshake`    | invitation    | Invitee→inviter peer admission. Body: `{ invitation: <base64>, invitee: { id, url, public_key, proof_signature } }`. Inserts the invitee into the inviter's `instances` and marks the invitation consumed. See **Invitations & handshake** below.                                                                                |
| `GET`  | `/federation/peers`        | peer-signed   | Gossip endpoint. Returns the receiver's known peers (minus `local`, the caller, and any peer without invitation provenance). Each entry carries the original signed invitation that admitted that peer to the cluster, so receivers can verify provenance against the named inviter's public key without prior trust (issue #147). Since v7, also returns a sibling `tombstones` array — see **Tombstone gossip (v7)** below. |
| `POST` | `/federation/peers/announce` | peer-signed | Immediate-discovery push (issue #163). Body: `application/octet-stream` containing UTF-8 JSON `{ "peer": <GossipPeerEntry> }`. Fired by an inviter right after `POST /handshake` admits a new peer, so the rest of the cluster doesn't wait for the next gossip cycle. The announcer is just a transport; the embedded signed invitation is the only basis for accepting the new peer (same trust model as `GET /peers`). Responses: `200 {ok:true,added:true}` on insert, `200 {ok:true,added:false}` if already known, `400` on rejected entry. v5 peers return `404`; callers swallow that and fall back to gossip. |
| `GET`  | `/federation/stream/:id`   | peer-signed   | Stream audio from the receiver's local Navidrome to a peer (`:id` is the receiver's Navidrome track ID). Forwards Subsonic transcode params (`format`, `maxBitRate`, `timeOffset`, `estimateContentLength`) and `Range`. The receiver records each successful stream in its own activity log as `kind='proxy'` (issue #121).      |

Library metadata and cover art travel through `/proxy/*`, which reuses the same Ed25519 signing scheme. See `docs/hub-internals.md` for the `/proxy/*` contract (Phase 1).

---

## Invitations & handshake (v5)

Peers join a cluster via signed invitations rather than shared config files. The protocol has three steps:

1. **Issue.** An admin on hub *A* posts to `POST /api/admin/hub/peers/invite`:

   ```
   { "ourUrl": "https://a.example", "inviteeUrl": "https://b.example", "expiresInSec": 600 }
   ```

   The hub signs an invitation payload with its Ed25519 federation key, persists the nonce in the `invitations` table, and returns `{ "invitation": "<base64>" }`. `inviteeUrl` is optional — `null` means open invite (any URL).

2. **Accept.** The admin pastes the invitation into hub *B*'s `POST /api/admin/hub/peers/accept`:

   ```
   { "invitation": "<base64>", "ourUrl": "https://b.example" }
   ```

   Hub *B* signs the invitation nonce with **its** Ed25519 key (proof of pubkey ownership) and POSTs the bundle to *A*'s `/federation/handshake`.

3. **Admit.** *A* verifies (a) its own signature on the invitation, (b) *B*'s proof signature against *B*'s claimed public key, (c) the invitation row is unconsumed and unexpired, (d) `inviteeUrl` matches if specified, (e) *B*'s `/api/health` is reachable and reports `apiVersion >= 5`. On success, *A* inserts *B* into `instances` with full provenance (`invitation_payload`, `invitation_signature`, `inviter_*` columns) and marks the invitation consumed. *B* mirrors the same row locally for *A*.

### Invitation payload (canonical signing form)

Newline-joined fields, in this order:

```
poutine-invitation/v5
<inviter_id>
<inviter_url>
<inviter_public_key>
<invitee_url-or-empty>
<nonce>
<issued_at>
<expires_at>
```

Wire format: `base64(JSON({ payload, signature }))`.

### Gossip

After each library sync, hubs call peers' `GET /federation/peers` and ingest entries they don't yet know. Each gossiped entry carries its full invitation provenance — receivers verify the embedded signature against the named inviter's public key (no expiry check at gossip time; expiry only applies at redemption). This makes cluster membership transitive: once any single hub admits a new peer, the rest discover it on their next sync.

### Immediate announce (v6)

Cycle-based gossip can leave a freshly admitted peer C unable to reach an existing peer B for up to one sync interval (~5 min): C learns of B from A immediately, but B doesn't learn of C until B next polls A (#163). To close the gap, A fans out `POST /federation/peers/announce` to every existing peer right after the handshake completes. The fan-out is detached from the handshake response (so a slow B can't delay C) and best-effort: any failure — network error, `400`, or `404` from a pre-v6 peer — leaves recovery to the next gossip cycle. The announce ingest path reuses the gossip validation function and the same transitive-trust rules; the announcer is just a transport.

Why only on handshake, not on gossip-driven discovery? Transitive announce would re-introduce gossip storms. The handshake path is the one with a measurable timing gap; the gossip path already converges.

### Tombstone gossip (v7)

Peer eviction (issue #244) is a local admin action first: `DELETE /api/admin/hub/peers/:id` sets `instances.lifecycle = 'tombstoned'` on the evicting hub and writes a signed row to that hub's `peer_tombstones` table (Phase 2). v7 propagates that eviction cluster-wide by piggybacking on the existing gossip cycle rather than adding a new endpoint.

**Wire shape.** `GET /federation/peers` gains a sibling array, additive to the existing `peers` array:

```json
{
  "peers": [ ... ],
  "tombstones": [
    {
      "instance_id": "hub-c",
      "removed_by": "hub-a",
      "reason": "spam",
      "created_at": "2026-07-10T12:00:00.000Z",
      "signature": "<base64 Ed25519 signature>"
    }
  ]
}
```

`reason` is nullable. A v5/v6 responder simply omits `tombstones`; a v7 client treats an absent field as an empty list — no version negotiation needed.

**Canonical signing payload** (newline-joined, mirrors the invitation/request signing convention):

```
TOMBSTONE\n<instance_id>\n<removed_by>\n<created_at>
```

`created_at` must be the exact string stored in the row — never re-derive it, the signature covers the literal value. Implemented in `hub/src/federation/tombstones.ts` (`tombstonePayload`, `createTombstone`, `verifyTombstone`).

**Verification (receiver side, `ingestGossipTombstone` in `hub/src/federation/gossip.ts`).** For each gossiped tombstone entry:

1. Reject if it names the receiver's own instance id — a peer cannot evict the local hub from its own instance.
2. Reject if it is **stale**: the receiver's locally stored invitation for the named instance has an `issued_at` later than the tombstone's `created_at`. This is what makes the mesh converge after a re-admission — a lagging hub relaying the pre-re-invitation tombstone must not re-evict the peer.
3. Resolve `removed_by`'s pinned public key: either the receiver itself, or a peer present in its registry snapshot (disabled peers included — see trust model below). An unresolvable remover (never invited/gossiped to this hub) is rejected rather than trusted blindly.
4. Reject if `removed_by` is *itself* locally tombstoned by the receiver (see trust model).
5. Verify the signature against the resolved public key (`verifyTombstone`).
6. If valid and not already on file, insert verbatim — the original `removed_by`/`created_at`/`signature` are relayed, never re-signed — and flip the named instance's `lifecycle` to `tombstoned` locally if a row exists for it and isn't already tombstoned.

Deliberately does **not** run the merge pipeline on ingest — gossip fires every sync cycle and merging on every cycle is too heavy. The evicted instance's content drops out at the next merge, which the same sync call runs immediately after gossip.

**Trust model.** Any hub whose pinned public key the receiver can resolve — including a *disabled* peer, since disabled is local-only policy, not a trust revocation — may evict any other known instance id. This is deliberately permissive: the mesh is small (4–12 hubs) and mutually trusted, so eviction doesn't require unanimous consent or a quorum. The one exception is transitive: a hub the receiver has *already tombstoned* cannot vouch for evicting anyone else (mirrors the existing gossip inviter-trust rule — an evicted hub cannot grow or prune the mesh).

**Re-admission.** A locally tombstoned instance id can rejoin if the invitation that re-admits it was issued *after* the tombstone's `created_at` — proof the instance was genuinely re-invited post-eviction, not just replaying an old, still-unconsumed invitation:

- **Handshake** (`POST /federation/handshake`): if the invitee id is locally tombstoned, the inviter compares the invitation's `issued_at` against the tombstone's `created_at`. Postdated → the tombstone row is deleted and the instance is admitted as `active` (an `ON CONFLICT(id) DO UPDATE ... WHERE instances.lifecycle = 'tombstoned'` upsert, since the row was kept, not deleted, through eviction). Not postdated, or no tombstone row on file to compare against → `403 {"error": "Instance is tombstoned by this hub"}`.
- **Gossip** (`ingestGossipEntry`): the same postdating check runs against the gossiped peer entry's embedded `invitation_payload.issued_at` before the existing tombstone-suppression check rejects it. The tombstone is only actually cleared **after** the entry's invitation signature verifies against the pinned inviter key — a forged `issued_at` on an otherwise-invalid entry cannot un-evict anyone. Clearing also flips the local `instances` row back to `active` via the same upsert pattern, so a previously-evicted-then-re-invited peer can be re-discovered through gossip, not just direct handshake.

Both paths require a genuine `peer_tombstones` row to compare timestamps against — an instance with `lifecycle = 'tombstoned'` but no tombstone row (only possible via direct DB manipulation or pre-v7 data) has no provenance to clear and stays permanently blocked.

---

## Changelog

### Version 7 (current)

- **Added** a `tombstones` sibling array to `GET /federation/peers` — gossiped peer evictions (issue #244 Phase 3). Each entry is a signed `peer_tombstones` row (`instance_id`, `removed_by`, `reason`, `created_at`, `signature`) relayed verbatim, never re-signed.
- **Added** re-admission semantics: an invitation issued after a tombstone's `created_at` clears the tombstone and re-admits the instance as `active`, at both the handshake and gossip ingest paths.
- **Additive, fully backward-compatible:** v5/v6 peers read only `body.peers` and never notice the new field; a v7 client reading from a v5/v6 responder treats an absent `tombstones` field as an empty list. No existing field's shape changed. **Floor unchanged:** `MIN_FEDERATION_API_VERSION = 5`.
- Phase 1 (schema + local enforcement gates) and Phase 2 (admin lifecycle API, local tombstone creation) are prerequisite issue #244 work; see `docs/system-architecture.md` for the full lifecycle model (`active` / `disabled` / `tombstoned`).

### Version 6

- **Added** `POST /federation/peers/announce` — immediate post-handshake fan-out so existing peers learn about a new admission without waiting for the next gossip cycle (issue #163). Additive; v5 peers reject with `404` and the inviter falls back to gossip.
- **Floor unchanged:** `MIN_FEDERATION_API_VERSION = 5`. v5 and v6 peers interoperate; only the timing of new-peer propagation differs.

### Version 5

- **Added** `POST /federation/handshake` — signed-invitation admission protocol (issue #147). Replaces filesystem-based peer admission (`peers.yaml`).
- **Added** `GET /federation/peers` — gossip endpoint. Each entry carries the signed invitation that admitted that peer; receivers verify against the named inviter's pubkey.
- **Removed** `peers.yaml` loader. The `instances` table is authoritative; legacy peer rows without invitation provenance are pruned by the upgrade migration.
- **Schema:** new `invitations` table; `instances` gains `public_key`, `invitation_payload`, `invitation_signature`, `inviter_id`, `inviter_url`, `inviter_public_key`.
- **Floor:** `MIN_FEDERATION_API_VERSION = 5`. v3 peers cannot join a v5 cluster (lack the provenance fields).
- v4 was skipped — the protocol jumped directly from 3 to 5 to mark the discontinuity.

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
- Peer registry: `hub/src/federation/peers.ts` (DB-backed, reads `instances`; SIGHUP triggers a snapshot refresh).
- Invitations: `hub/src/federation/invitations.ts` — sign/verify/encode helpers; `hub/test/invitations.test.ts` covers signature, expiry, replay.
- Handshake: `hub/src/routes/federation.ts` (`POST /handshake`); `hub/src/routes/admin.ts` (`POST /peers/invite`, `POST /peers/accept`); `hub/test/handshake.test.ts` covers the e2e flow.
- Gossip: `hub/src/federation/gossip.ts`; ingested via `syncAll` (hub/src/library/sync.ts) and `AutoSyncService.pollPeers` (hub/src/services/auto-sync.ts); `hub/test/gossip.test.ts` covers transitive discovery + tampered-signature rejection.
- Tombstones: `hub/src/federation/tombstones.ts` (signing/verification), `ingestGossipTombstone` in `hub/src/federation/gossip.ts` (gossip ingest + trust/re-admission rules); `hub/test/peer-lifecycle.test.ts` covers propagation, rejection paths, and re-admission.
