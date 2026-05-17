# Sonos casting (issue #108)

Optional sink for the bottom-of-screen player. When `SONOS_ENABLED=true`,
playback can route to a discovered Sonos zone on the LAN instead of the
browser. Off by default; requires host networking and a LAN-reachable
hub URL.

## Protocol

Sonos is UPnP under the hood with a few vendor extensions, all over plain HTTP
on port `1400` per device.

| Layer       | Spec                                      | Used for                                              |
|-------------|-------------------------------------------|-------------------------------------------------------|
| Discovery   | SSDP M-SEARCH, ST `ZonePlayer:1`          | Find zones; fetch `/xml/device_description.xml`       |
| Control     | UPnP SOAP                                  | `AVTransport:1` + `RenderingControl:1`                |
| Metadata    | DIDL-Lite (`urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/`) | `CurrentURIMetaData` argument to `SetAVTransportURI` |
| Streaming   | Plain HTTP GET (Range)                     | Sonos fetches `/cast/stream/:trackId` from the hub    |
| Stream auth | HMAC token in query string                 | Sonos can't compute Subsonic auth; see below          |

Sonos only supports `InstanceID=0` and `Channel="Master"` on AVTransport /
RenderingControl. The control client hardcodes both.

## Components

- `services/sonos-discovery.ts` — SSDP M-SEARCH on UDP `239.255.255.250:1900` for `urn:schemas-upnp-org:device:ZonePlayer:1`. Stale-evicts devices not seen recently. After discovery, calls `ZoneGroupTopology:1#GetZoneGroupState` and drops bonded satellites so each zone group surfaces as a single logical device (the coordinator). See "Bonded / stereo pairs" below.
- `services/sonos-control.ts` — SOAP client. AVTransport (`SetAVTransportURI`, `Play`, `Pause`, `Stop`, `Seek`, `GetPositionInfo`, `GetTransportInfo`) + RenderingControl (`SetVolume`, `GetVolume`).
- `services/didl.ts` — `buildDidlLiteTrack()` produces the inline single-item metadata Sonos expects in `CurrentURIMetaData`.
- `services/soap.ts` — shared SOAP envelope + XML helpers (used by both Sonos and DLNA).
- `services/cast-tokens.ts` — HMAC-signed short-lived tokens for unauthenticated stream URLs. Secret derived from the instance Ed25519 key via `deriveCastSecret`. Token wire format `<sig>.<exp>.<base64url(username)>`; the username travels in the token so `/cast/stream` can attribute the stream and route federated peer fetches under the originating user.
- `routes/cast.ts` — `GET /cast/stream/:trackId?token=…`. Token-verified; reuses the local/peer source-selection + transcoding pipeline. Recovered username is used for stream-tracking and federated `asUser`.
- `routes/sonos.ts` — `GET /api/sonos/devices`, `POST /api/sonos/devices/:id/{play,pause,resume,stop,seek,volume}`, `GET /api/sonos/devices/:id/state`. **JWT-authenticated via `requireAuth` preHandler** — Sonos control is operator-functional, not public. Play handler appends `?format=mp3` to the cast URL so the stream byte content-type matches the hardcoded `audio/mpeg` DIDL metadata; without this, FLAC/OGG sources are rejected by Sonos and silently land in STOPPED. Lossless pass-through is a follow-up (#180).
- `/api/capabilities` — frontend probe; returns `{ sonos: boolean, dlna: boolean }`.

## Networking gotcha — host mode required

SSDP needs UDP multicast which Docker's bridge networking blocks. Run with the
Sonos compose override:

```bash
docker compose -f docker-compose.yml -f docker-compose.sonos.yml up -d
```

The override puts **both** services on `network_mode: host`. Hub needs host net
for multicast. Navidrome also needs host net because Docker Desktop host-net
containers cannot reach the host's bridge-published loopback ports — without it
the hub can't reach Navidrome at all. Navidrome binds to `ND_ADDRESS=127.0.0.1`
so the admin UI is not exposed on the LAN. `POUTINE_LAN_URL` must be the
address Sonos can reach the hub at (e.g. `http://192.168.1.10:3000`).

**macOS limitation — Sonos discovery does not work in Docker Desktop.** Docker
Desktop's "host networking" on macOS is implemented as a userspace VPN, not a
true network-namespace share. UDP multicast does not traverse it (empirically
verified: M-SEARCH from inside the container returns 0 Sonos replies even on a
LAN where the Mac host sees 4). On Linux hosts the override works as designed.
For Mac dev, run the hub natively (`pnpm --filter hub build && node
hub/dist/server.js`) against Dockerized Navidrome instead. Production targets
Linux where host networking behaves correctly.

## Queue model

App-managed, one track at a time. The frontend pushes the current track via
`sonosPlay`, polls `/state` every 1.5 s for position + duration, and calls
`next()` from the store when the device transitions `PLAYING → STOPPED`.
Shuffle/repeat live in the store, not on the device.

## Device picker

`frontend/src/components/player/DevicePicker.tsx`. Cast icon in `PlayerBar`
next to the volume slider — only rendered if `/api/capabilities` reports
`sonos: true`. Device selection is not persisted across sessions (always
defaults to local browser playback).

## Bonded / stereo pairs (resolved — issue #177)

Sonos stereo pairs and home-theater bonded zones advertise each RINCON
separately via SSDP. Only the **coordinator** of a bonded zone accepts
`AVTransport:1` commands — targeting a satellite silently no-ops.

After at least one device lands, discovery calls
`ZoneGroupTopology:1#GetZoneGroupState` on any one device and parses the
returned `<ZoneGroupState>` payload. For each `<ZoneGroup Coordinator="…">`
it drops every non-coordinator UUID (including nested `<Satellite>`
entries) from the in-memory device map. The collapse runs once shortly
after the first discovery and again on every periodic re-scan tick, so
late-joining satellites get pruned within one interval.

Satellite UUIDs only appear in the full `GetZoneGroupState` XML as
`<Satellite>` children of the bonded coordinator's `<ZoneGroupMember>` —
`GetZoneGroupAttributes` hides them and is not sufficient. Empirical
satellite symptoms (kept here for posterity / debugging):

- empty `CurrentZoneGroupName` / `CurrentZoneGroupID` /
  `CurrentZonePlayerUUIDsInGroup` from `ZoneGroupTopology#GetZoneGroupAttributes`
- `TrackURI=x-rincon:<coordinator-UDN>` from `AVTransport#GetPositionInfo`
- empty `Actions` from `AVTransport#GetCurrentTransportActions`
- UPnP 701 errors from `GroupRenderingControl#GetGroupVolume`/`GetGroupMute`

If the topology fetch fails, discovery keeps the un-collapsed view rather
than hiding everything — a transient SOAP error must not blank out the
device list.

## Auth

| Surface              | Auth                                                                  |
|----------------------|-----------------------------------------------------------------------|
| `/api/sonos/*`       | JWT (`requireAuth` preHandler) — only logged-in users can control     |
| `/cast/stream/:id`   | HMAC token, bound to `(trackId, username, exp)`, 1 h TTL              |

The HMAC secret derives from the federation Ed25519 private key so no extra
on-disk secret is needed. Trade-off: compromise of the federation key also
compromises cast tokens.

## Testing

### Unit tests

| File                              | Covers                                                   |
|-----------------------------------|----------------------------------------------------------|
| `test/sonos-discovery.test.ts`    | SSDP response parsing, device-description XML parsing, `ZoneGroupState` parsing + bonded-zone collapse |
| `test/sonos-control.test.ts`      | SOAP envelope + DIDL-Lite shape (now thin — most of the helpers moved to `test/soap.test.ts` and the new DLNA suites) |
| `test/cast-tokens.test.ts`        | HMAC token sign/verify, expiry, cross-track rejection, username unicode |

Run via `pnpm --filter hub test`.

### Manual smoke test (real Sonos zone)

1. Boot the hub with the Sonos override and a LAN-reachable `POUTINE_LAN_URL`:
   ```bash
   SONOS_ENABLED=true POUTINE_LAN_URL=http://<lan-ip>:3000 \
     docker compose -f docker-compose.yml -f docker-compose.sonos.yml up
   ```
2. Boot log should print `Sonos discovery started` and `Sonos casting enabled`.
3. `curl http://<lan-ip>:3000/api/sonos/devices` (with a JWT) lists at least one device with a `room` field.
4. In the SPA: click the cast icon in `PlayerBar`, select a device, press play. Verify audio plays from the Sonos.
5. Pause / resume / seek / volume each reflect on the device.
6. End-of-track auto-advances.

### Driving a Sonos zone from the test process

Sonos zones speak the same UPnP profile other LAN servers do, so the same
control-point library used for the DLNA tests (`node-upnp`) drives Sonos
just as well. There are no integration tests committed for this because the
Sonos casting *direction* (hub → device) is sufficiently covered by:

- The HMAC token tests proving `/cast/stream` is reachable.
- A manual smoke test against a real zone.

If you ever need to script a real-zone interaction (e.g. for an interactive
probe), the same approach as the DLNA browse probe in `docs/dlna.md` works —
substitute `ZonePlayer:1` for the SSDP ST and use the right control URL
(`http://<ip>:1400/MediaRenderer/AVTransport/Control`).

### Diagnostic helper — `scripts/sonos-dump.mjs`

Read-only probe for a single Sonos device. Fetches `/xml/device_description.xml`,
enumerates every SCPD action list, and runs ~30 curated `Get*` SOAP probes
(transport state, position, group attrs, volume, alarms, music services,
etc.). Useful for inspecting bonded-pair state, comparing firmware
capabilities, and reverse-engineering new actions.

```bash
node scripts/sonos-dump.mjs 192.168.1.42        # human-readable
node scripts/sonos-dump.mjs 192.168.1.42 --json # machine-readable
```

Issues no state-changing actions; safe to run against active zones.

**Be careful when issuing probes on a network with active Sonos zones**:
sending `SetAVTransportURI` + `Play` to a zone interrupts whatever's
currently playing, with no confirmation. Discovery and `GetTransportInfo`
are read-only and safe; anything under AVTransport that changes state is
not.

## Volume model (#181)

Two distinct volume scales live in the system and must not be conflated:

| Scope      | Field             | Range            | Curve     | Persists?         |
|------------|-------------------|------------------|-----------|-------------------|
| Local SPA  | `volume`          | `0..1`           | quadratic | `localStorage`    |
| Cast/Sonos | `castVolume`      | `0..volumeCap`   | linear    | session-only      |

- **Cap.** `SONOS_VOLUME_CAP` in `hub/src/services/sonos-control.ts` (currently `50`). Re-clamped inside `SonosControl.setVolume()` so every code path — `/api/sonos/devices/:id/volume`, `/play` preflight, future schedulers — is uniformly safe. Surfaced to the SPA via `volumeCap` in `GET /api/sonos/devices/:id/state`. Making this user-configurable is tracked in #184.
- **Cast-start preflight.** `/play` calls `getVolume` before `SetAVTransportURI`; if the device is above the cap (left blasting from the Sonos app), drops it to the cap. Below-cap settings are preserved.
- **Slider sync while casting.** The 1.5s `/state` poll feeds `castVolume` into the SPA store. A drag-guard ref in `PlayerBar` suppresses poll-driven updates for ~1.5s after the user touches the slider, so an in-flight response can't snap the thumb back mid-drag.
- **POST /volume.** Route validates `0..100` (request shape only); the real ceiling is the service-layer cap. Sending `80` succeeds and is silently clamped — the SPA's notion of the cap is allowed to lag a server change.
- **Local audio is unaffected.** The local `<audio>` `volume` is never piped into a Sonos device. The previous behavior (mirror `volume * 100` to `setVolume`) caused #181's "device at 80" surprise; that effect is gone.

## See also

- [hub-internals.md](hub-internals.md) for general conventions and gotchas.
- [authentication.md](authentication.md) for the JWT flow `/api/sonos/*` relies on.
- [dlna.md](dlna.md) — shares the DIDL-Lite + SOAP primitives in `services/didl.ts` and `services/soap.ts`.
