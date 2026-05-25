# Sonos casting (issue #108)

Optional sink for the bottom-of-screen player. Playback can route to a
discovered Sonos zone on the LAN instead of the browser. Off by default;
runtime-toggleable from the Admin page (#184). Requires host networking
and a LAN-reachable hub URL.

## Runtime toggle (#184)

Enabled state and volume cap live in the `settings` table (keys
`sonos_enabled`, `sonos_volume_cap`), not in env.

- `GET /admin/settings/sonos` → `{ enabled, volumeCap }`
- `PUT /admin/settings/sonos` with `{ enabled?, volumeCap? }` (owner-only)
- `/api/capabilities` reads the live flag — the SPA's device picker
  shows/hides on the next render.
- `/api/sonos/*` returns `503` when disabled. (Pre-#218 there was also a `/cast/stream/*` relay gated on the same flag; it's been deleted — devices now stream through Hub's Subsonic endpoint with a cast token.)
- On disable: SSDP discovery stops AND the hub issues `Stop` to every
  known device — in-flight casts go silent immediately.
- On enable: SSDP starts; devices appear after one SSDP round
  (~`SONOS_DISCOVERY_INTERVAL_MS`).
- Volume cap is enforced in `SonosControl.setVolume(device, level, cap)`
  on every SOAP write, and surfaced via `volumeCap` in
  `/api/sonos/devices/:id/state` so the SPA's slider can clamp too.

No env var controls this — `Config.sonosEnabled` exists only as a
first-boot seed for tests / programmatic builds; the seed uses
`INSERT OR IGNORE` so an operator-set value survives redeploy. The
same is true of `lan_url` (#209) — `Config.initialLanUrl` is seed-only.

## Protocol

Sonos is UPnP under the hood with a few vendor extensions, all over plain HTTP
on port `1400` per device.

| Layer       | Spec                                      | Used for                                              |
|-------------|-------------------------------------------|-------------------------------------------------------|
| Discovery   | SSDP M-SEARCH, ST `ZonePlayer:1`          | Find zones; fetch `/xml/device_description.xml`       |
| Control     | UPnP SOAP                                  | `AVTransport:1` + `RenderingControl:1`                |
| Metadata    | DIDL-Lite (`urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/`) | `CurrentURIMetaData` argument to `SetAVTransportURI` |
| Streaming   | Plain HTTP GET (Range)                     | Sonos fetches `${lan_url}/rest/stream.view?id=t<uuid>&castToken=…` from the hub Subsonic endpoint (#218) |
| Stream auth | HMAC cast token in query string            | Sonos can't compute Subsonic `u+t+s`; cast token replaces it on the stream endpoint — see below          |

Sonos only supports `InstanceID=0` and `Channel="Master"` on AVTransport /
RenderingControl. The control client hardcodes both.

## Components

- `services/sonos-discovery.ts` — SSDP M-SEARCH on UDP `239.255.255.250:1900` for `urn:schemas-upnp-org:device:ZonePlayer:1`. Stale-evicts devices not seen recently. After discovery, calls `ZoneGroupTopology:1#GetZoneGroupState` and drops bonded satellites so each zone group surfaces as a single logical device (the coordinator). See "Bonded / stereo pairs" below. Also calls `ConnectionManager:1#GetProtocolInfo` once per device to populate `SonosDevice.supportedMimes` — the cast route uses that set to decide pass-through vs MP3 transcode (#180).
- `services/sonos-control.ts` — SOAP client. AVTransport (`SetAVTransportURI`, `SetNextAVTransportURI`, `Play`, `Pause`, `Stop`, `Seek`, `GetPositionInfo`, `GetTransportInfo`) + RenderingControl (`SetVolume`, `GetVolume`) + ConnectionManager (`GetProtocolInfo`). Exports `chooseSonosCastFormat()` for the play route's format-vs-capability decision. `getState()` includes the current `TrackURI` so the poller can detect Sonos auto-advancing onto a pre-loaded next track (#202).
- `services/didl.ts` — `buildDidlLiteTrack()` produces the inline single-item metadata Sonos expects in `CurrentURIMetaData`.
- `services/soap.ts` — shared SOAP envelope + XML helpers (used by both Sonos and DLNA).
- `services/cast-tokens.ts` — HMAC-signed short-lived tokens for stream-only auth at `/rest/stream.view?castToken=…`. Secret persisted in `player.db.player_settings.cast_signing_key`, with a derive-from-Ed25519 fallback for pre-#215 instances. Token wire format `<sig>.<exp>.<base64url(username)>`; the username travels in the token so the stream handler can attribute activity and route federated peer fetches as the originating user. Also exports `buildStreamUrl()` — single source-of-truth helper used by both Sonos (`routes/sonos.ts`) and DLNA (`services/dlna-objects.ts`) cast URL builders.
- **(#218: deleted `routes/cast.ts`.)** Cast-token auth is now an alternate mode of `requireSubsonicAuthBinary` for `/rest/stream(.view)` — see [authentication.md](authentication.md#cast-tokens-reststreamviewcasttoken).
- `routes/sonos.ts` — `GET /api/sonos/devices`, `POST /api/sonos/devices/:id/{play,next,pause,resume,stop,seek,volume}`, `GET /api/sonos/devices/:id/state`. The shared cast-URL + DIDL builder (`buildCast`) is used by both `/play` and `/next` so format selection and token mint stay identical across the current/next paths. **JWT-authenticated via `requireAuth` preHandler** — Sonos control is operator-functional, not public. Play handler picks the cast format via `chooseSonosCastFormat(getSong.suffix, device.supportedMimes)`: FLAC/MP3/AAC/ALAC/WAV pass through byte-for-byte when the device advertises the matching MIME; OGG/Opus/unknown formats and devices with no probed sink set fall back to `?format=mp3` + `audio/mpeg` DIDL. Byte content-type must match DIDL mime — mismatch sends Sonos straight to STOPPED. Hi-res bit-depth / sample-rate gating tracked separately (#199) — see "Hi-res FLAC guard" below.
- `services/hub-subsonic-caller.ts` — in-process Hub Subsonic HTTP client used by `routes/sonos.ts` (and `services/dlna-objects.ts`). Wraps `app.inject()` with the owner's u+p; future deploy-split swaps this for a real loopback `fetch()` without touching the callers. See [hub-internals.md](hub-internals.md).
- `/api/capabilities` — frontend probe; returns `{ sonos: boolean, dlna: boolean }`.

## Hi-res FLAC guard (regression pending #199, #220)

Pre-#220 the cast planner called `SubsonicClient.getSong` directly
against Navidrome to read `samplingRate` + `bitDepth` and forced an MP3
transcode for 24-bit / 96 kHz FLAC sources on Sonos S2 zones. #220
removed Player code's ability to reach Navidrome in-process; Hub
Subsonic `getSong` does not surface those fields today, so the probe
is dropped. Behavior change: 24-bit / 96 kHz FLAC sources now pass
through verbatim on FLAC-capable Sonos zones — older S2 zones may
silently STOPPED at the cast moment.

Workarounds until #199 lands:

- Force MP3 transcode via the source instance's Navidrome admin
  (raise `ND_TRANSCODING_*` settings to make FLAC opt-in).
- Manually verify hi-res tracks before adding to playlists destined
  for casting.

#199 plan: add `sampling_rate` + `bit_depth` columns to
`track_sources`, populate them from `instance_tracks` during sync,
project them into the Hub `/rest/getSong` response, then restore the
guard inside `routes/sonos.ts#buildCast` using
`HubSubsonicCaller` — no Player→Navidrome regression.

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
so the admin UI is not exposed on the LAN. The **LAN URL** setting (Admin →
Sonos, key `lan_url`, #209) must be the address Sonos can reach the hub at
(e.g. `http://192.168.1.10:3000`). DLNA (#175) reads the same setting.

**macOS limitation — Sonos discovery does not work in Docker Desktop.** Docker
Desktop's "host networking" on macOS is implemented as a userspace VPN, not a
true network-namespace share. UDP multicast does not traverse it (empirically
verified: M-SEARCH from inside the container returns 0 Sonos replies even on a
LAN where the Mac host sees 4). On Linux hosts the override works as designed.
For Mac dev, run the hub natively (`pnpm --filter hub build && node
hub/dist/server.js`) against Dockerized Navidrome instead. Production targets
Linux where host networking behaves correctly.

## Queue model

App-managed, but with a single-slot pre-load for gapless auto-advance (#202).
The frontend pushes the current track via `sonosPlay` (SOAP
`SetAVTransportURI`), then immediately hands the device the *next* track's
URI via `sonosSetNext` (SOAP `SetNextAVTransportURI`). Sonos pre-buffers the
queued stream and transitions to it at EOT with no audible gap — the
SPA-driven `STOPPED → next() → SetAVTransportURI` round-trip that the old
model produced is gone. Shuffle/repeat still live in the store, not on the
device; only one "next" slot is loaded ahead.

**Auto-advance detection.** The 1.5 s `/state` poll watches `TrackURI` from
`GetPositionInfo`. When it changes between two non-empty values outside the
2.5 s `lastSonosPlayAtRef` guard window, that's Sonos auto-advancing onto
the pre-loaded URI; the SPA calls `jumpTo(pendingNextRef.index)` (not
`next()`) to keep the store deterministically on the same track Sonos
actually picked — important under shuffle, where calling `peekNext()` twice
would return different songs. `pendingNextRef` captures the queue index at
the moment the SPA POSTs `/next`, so the URI-change handler advances to
exactly that index.

**Pre-load TTL.** The SPA sizes the cast token's TTL as
`remaining(current) + duration(next) + 600s`. The 10-minute buffer covers a
long pause across the boundary so the queued stream doesn't expire while
the user is making coffee.

**Re-sync triggers.** Any change to `currentIndex`, `queue`, `shuffle`, or
`repeat` re-fires the next-URI effect. End-of-queue (peek returns null)
posts `trackId: null` to clear the slot — Sonos then stops naturally at
EOT, and the STOPPED-after-PLAYING fallback fires `next()` which is a
no-op past the end.

**Destination switch.** When the active `deviceId` changes (Sonos → local,
Sonos → DLNA, Sonos A → Sonos B), `PlayerBar` fires `Stop` on the previous
device. Without it the old zone keeps playing through to end-of-track and
auto-advances on its own queue — see #198. Stop, not pause, so the next
cast to that room starts clean.

**Position handling depends on whether the stream is transcoded.** Pass-through
streams (FLAC/MP3 pass-through, Range-capable) seek via SOAP `Seek REL_TIME`:
Sonos translates time → byte offset from streaminfo and pulls a fresh
`Range: bytes=<offset>-` GET, which the Subsonic stream handler's
`isRaw` path forwards to Navidrome (#218 — same source-selection +
transcoding pipeline previously inside the `/cast/stream` relay). Transcoded MP3 has no Range, so SOAP Seek
past the buffer drives the device to STOPPED and the SPA's poller
misreads that as end-of-track and fires `next()` (#182). For transcoded
casts only, `/api/sonos/devices/:id/play` instead embeds Subsonic
`timeOffset=<sec>` in the cast URL and re-issues `SetAVTransportURI` —
stream byte 0 = track-time `startAt`. The `/play` response returns
`transcoded: boolean` so the SPA can pick the right path; `castTranscodedRef`
remembers it for the next seek (#204). Subsonic's `timeOffset` is
**only honored when transcoding** — passing it on a raw stream is a
silent no-op, hence the branch (#204 was that exact regression after
the lossless pass-through change in #180).

Mid-track sink switches (#194) and the SPA's initial play with a
non-zero position both re-use the transcoded path's `timeOffset` URL
(safe in both modes, decisive in the transcoded one). `castBaseOffsetRef`
adds the offset back into polled positions, and `lastSonosPlayAtRef`
suppresses `next()` for ~2.5 s after any re-cast so the brief
PLAYING → STOPPED transition during `SetAVTransportURI` doesn't advance
the queue. `next()`/`previous()` zero `currentTime`, so normal
track-changes pass no offset.

For the reverse direction (Sonos → local mid-track), the `<audio>`
element reload uses Subsonic `timeOffset` the same way handleSeek's
past-buffer path does — see `pendingBaseOffsetRef`.

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
| `/rest/stream.view?castToken=…` | HMAC cast token, bound to `(trackId, username, exp)`, 1 h TTL — see [authentication.md](authentication.md#cast-tokens-reststreamviewcasttoken) |

Cast-secret persisted in `player.db.player_settings.cast_signing_key` (#215);
the pre-#215 derive-from-Ed25519 fallback is still used on first boot when
that key is absent. Cast tokens grant *single-track stream access only* —
they cannot be used against any other Subsonic endpoint.

## Testing

### Unit tests

| File                              | Covers                                                   |
|-----------------------------------|----------------------------------------------------------|
| `test/sonos-discovery.test.ts`    | SSDP response parsing, device-description XML parsing, `ZoneGroupState` parsing + bonded-zone collapse |
| `test/sonos-control.test.ts`      | SOAP envelope + DIDL-Lite shape (now thin — most of the helpers moved to `test/soap.test.ts` and the new DLNA suites) |
| `test/cast-tokens.test.ts`        | HMAC token sign/verify, expiry, cross-track rejection, username unicode |

Run via `pnpm --filter hub test`.

### Manual smoke test (real Sonos zone)

1. Boot the hub with the Sonos override:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.sonos.yml up
   ```
   Then in Admin → Sonos set the **LAN URL** to `http://<lan-ip>:3000` and
   toggle Sonos on.
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

- The HMAC token tests + `cast-token-stream.integration.test.ts` proving the cast-token handoff at `/rest/stream.view` actually streams bytes (#218).
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
