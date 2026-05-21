# DLNA MediaServer (issue #175)

Optional. When `DLNA_ENABLED=true`, Poutine advertises itself as a UPnP
`MediaServer:1` on the LAN so Windows Media Player, Xbox, Kodi, VLC,
BubbleUPnP and other UPnP control points can **browse + stream** the merged
library. Off by default; requires host networking and the `lan_url` admin
setting (Admin → Sonos, #209) — shared with Sonos casting.

DLNA has no notion of user identity. Every route under `/dlna/*` is
unauthenticated when the feature is on; the LAN gate (below) keeps that
openness off the public tunnel.

## Protocol

| Layer           | Spec                                              | Used for                                                 |
|-----------------|---------------------------------------------------|----------------------------------------------------------|
| Discovery       | SSDP (RFC draft, UPnP-DA 1.1 §1)                  | NOTIFY alive / byebye + M-SEARCH responder               |
| Description     | UPnP-DA 1.1 §2 device + service descriptions      | `/dlna/device.xml`, `/dlna/scpd/*.xml`                   |
| Control         | UPnP-DA 1.1 §3 SOAP-over-HTTP                     | ContentDirectory:1 + ConnectionManager:1                 |
| Browse payload  | UPnP CDS:1 + DIDL-Lite (`metadata-1-0/DIDL-Lite/`) | `Browse` response `Result` argument                      |
| Streaming       | Plain HTTP GET with Range + DLNA response headers | `/dlna/stream/:trackId`                                  |
| Events (GENA)   | Not implemented — clients tolerate polling.       | —                                                        |

Specs to keep open while changing this code:

- [UPnP Device Architecture 1.1](http://upnp.org/specs/arch/UPnP-arch-DeviceArchitecture-v1.1.pdf)
- [UPnP ContentDirectory:1 Service Template](http://upnp.org/specs/av/UPnP-av-ContentDirectory-v1-Service.pdf)
- [DLNA Guidelines (informal mirror)](https://www.dlna.org/) — protocolInfo flags table is the practical reference.

## Components

| Path                                 | Role                                                                                                         |
|--------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `services/ssdp-advertiser.ts`        | UDP `239.255.255.250:1900`. Periodic NOTIFY `ssdp:alive`, `ssdp:byebye` on shutdown, M-SEARCH responder.     |
| `services/dlna-objects.ts`           | Object-ID encoder/decoder + `Browse` implementation over `unified_*` tables.                                 |
| `services/didl.ts`                   | Shared with Sonos. `wrapDidl`, `buildContainer`, `buildAudioItem`, `buildDidlLiteTrack`.                     |
| `services/soap.ts`                   | Shared with Sonos. Envelope/response builders, `parseSoapAction`, `pickXmlTag`, duration helpers.            |
| `routes/dlna.ts`                     | `device.xml`, SCPDs, ContentDirectory + ConnectionManager SOAP, `/dlna/stream/:trackId`.                     |
| `auth/lan-only.ts`                   | `requireLan` preHandler — rejects requests carrying proxy-forwarding headers. Installed at the `/dlna` plugin scope. |

`server.ts` wires the advertiser to the `onReady` / `onClose` hooks and
exposes `/api/capabilities` → `{ sonos, dlna }`. The advertiser bakes
`locationUrl` at construction, so a runtime `lan_url` change (#209) tears
down the old advertiser and builds a fresh one with the new URL — wired
through `sonosSettings.onChange` in `server.ts` (`rebuildSsdp`). Setting
`lan_url` to empty stops the advertiser entirely (byebye); setting it
non-empty starts a new one. No restart needed.

## Object hierarchy

Object IDs are deterministic so DLNA clients (notably Windows Media Player)
can cache them across hub restarts.

```
0 (root)
└─ 0/music
   ├─ 0/music/artists       → 0/music/artist/<unified_artist_id>
   │                          └─ release groups for that artist
   ├─ 0/music/albums        → 0/music/album/<unified_release_group_id>
   │                          └─ tracks across all releases in the group
   └─ 0/music/tracks        → all tracks
```

Release-level (edition) browsing is not exposed — `unified_release_groups`
is the natural "album" object for DLNA clients.

### Artist list filtering

`0/music/artists` lists only artists that own at least one release group
(`EXISTS unified_release_groups urg WHERE urg.artist_id = ua.id`). Track-
only credits (featured artists, compilation contributors) are excluded
because the artist→album path filters by `urg.artist_id` — they would
otherwise appear in the browser with no playable content. Their tracks
remain reachable via the album they appear on. The Subsonic
`/getArtists` / `/getIndexes` endpoints apply the same filter so SPA and
DLNA browsers agree on the artist roster.

Compilations currently surface under whichever single `unified_artists`
row the ingest assigned to the release group (often a single contributor,
not "Various Artists"). Grouping compilations under a synthetic VA
artist is an ingest concern, not a DLNA concern.

### UDN

`sha1("poutine/dlna/<POUTINE_INSTANCE_ID>")` reshaped as a UUID. Stable
across restarts so clients don't re-add the server every boot.

## Stream endpoint

`GET /dlna/stream/:trackId` reuses the local/peer source-selection +
transcoding pipeline from `/cast/stream`. Response headers:

- `Content-Type` — from upstream (mp3 → `audio/mpeg`, flac → `audio/flac`, …)
- `Content-Length`, `Accept-Ranges`, `Content-Range` — passed through.
- `transferMode.dlna.org: Streaming` (echoes the request header if set).
- `contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000…` — required by strict clients (WMP).

Stream activity is attributed to `DLNA_PSEUDO_USER` (defaults to the
owner) in `stream_operations` with `kind='dlna'`.

## LAN gate (tunnel hardening)

The hub is typically deployed behind a public tunnel (Cloudflare Tunnel,
Caddy, nginx, Tailscale Funnel) that terminates on the same host and
forwards traffic to loopback. To keep the unauthenticated DLNA endpoints
off that tunnel, `routes/dlna.ts` installs a `requireLan` preHandler that
returns 403 if any of these proxy headers is present:

`x-forwarded-for` · `x-forwarded-host` · `x-forwarded-proto` · `x-real-ip` · `forwarded` (RFC 7239) · `cf-connecting-ip` · `cf-ray`

Real LAN clients (Sonos / WMP / Kodi / VLC) never set those. If you run a
transparent LAN-side proxy you must strip them there or leave
`DLNA_ENABLED=false`. The Subsonic API and `/cast/stream` are unaffected —
both already require authentication.

## Compatibility notes

v1 ships **pass-through** only. Response MIME mirrors the source file.
Windows Media Player Legacy reliably handles MP3/WMA only; everything else
is the client's problem. Modern DLNA clients (Kodi, VLC, BubbleUPnP) handle
FLAC and friends natively.

`protocolInfo` 4th field on each `res` element:

```
DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000
```

`OP=01` advertises Range (byte-seek). The flags matrix is the standard
streaming profile.

`ConnectionManager:GetProtocolInfo` Source list is the union of MIMEs we'd
emit:

```
http-get:*:audio/mpeg:*,http-get:*:audio/flac:*,http-get:*:audio/mp4:*,http-get:*:audio/ogg:*,http-get:*:audio/wav:*
```

Sink is empty — we don't render.

## Libraries used in tests

| Library                  | Role in tests                                  | Notes                                                                                                           |
|--------------------------|------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| `node-upnp` (devDep)     | Real UPnP control point: device description + SOAP Browse | Quirk: `parseSOAPResponse` walks `Array.from(argumentList.argument)`, which silently returns `[]` for single-argument actions because fast-xml-parser emits an object (not an array) for a single child. Single-output SOAP actions come back as `{}`. Worked around with raw fetch. |
| Node `dgram` (built-in)  | SSDP M-SEARCH + reply parsing                  | Direct and reliable. No library needed.                                                                          |
| Node `fetch` (built-in)  | Raw HTTP for stream headers + LAN-gate assertions + single-output SOAP | Already in tree.                                                                                                 |
| `better-sqlite3` (dep)   | In-memory schema seeded with fixtures          | Backs the `dlna-objects` Browse unit tests.                                                                      |

### Why not `@achingbrain/ssdp`

Evaluated and dropped. Two issues:

1. Its `discover()` async iterator only yields after fetching + parsing the
   `LOCATION` through an internal pipeline. The pipeline can fail on
   minimal stub device descriptions, producing test failures orthogonal
   to whether our advertiser responded correctly.
2. It binds UDP 1900 by default with `SO_REUSEADDR`; running it alongside
   our advertiser on the same host makes unicast M-SEARCH-reply delivery
   non-deterministic (which socket gets the packet depends on the kernel).
   Workarounds exist (bind on ephemeral port via the `sockets` option)
   but combined with #1 the value-vs-complexity tradeoff isn't there for
   our use case.

Raw `dgram` gives a packet-level assertion in a few dozen lines.

## Testing

### Unit tests (in `pnpm --filter hub test`)

| File                                | Covers                                                                          |
|-------------------------------------|---------------------------------------------------------------------------------|
| `test/soap.test.ts`                 | xmlEscape, envelope/response builders, SOAPACTION parsing, pickXmlTag, duration |
| `test/ssdp-advertiser.test.ts`      | NOTIFY alive/byebye + M-SEARCH-reply packet construction, target matching       |
| `test/dlna-objects.test.ts`         | Object-ID parse/encode, Browse against a seeded in-memory SQLite                |
| `test/lan-only.test.ts`             | `requireLan` preHandler against a synthetic Fastify app                         |
| `test/dlna-stream.test.ts`          | `/dlna/stream/:trackId` positive path against a fake Navidrome — DLNA response headers, Range forwarding, 404 unknown vs 503 no-source distinction |

### Integration tests (`pnpm --filter hub test:integration`)

Run separately; require UDP multicast and a free UDP 1900 for the advertiser.

| File                                  | Covers                                                                                                            |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `test/dlna-ssdp.integration.test.ts`  | Boots `SsdpAdvertiser`. Raw-dgram M-SEARCH for `MediaServer:1` (asserts USN/LOCATION/CACHE-CONTROL/SERVER on the unicast 200). M-SEARCH for `ssdp:all` (asserts all five advertised targets reply). Boots a second advertiser and listens for `NTS: ssdp:byebye` after `stop()` (asserts all five targets emit byebye before the socket closes). |
| `test/dlna-http.integration.test.ts`  | Boots full hub via `buildApp()` on a random loopback port. `node-upnp` drives device-description fetch + Browse + ConnectionManager:GetProtocolInfo. Raw fetch covers single-output SOAP actions, `/dlna/stream/<unknown>` 404, and LAN-gate rejecting `x-forwarded-for` / `cf-connecting-ip`. |

> **Test constraint:** `dlna-http.integration.test.ts` leaves the
> `lan_url` setting empty on purpose so its `buildApp()` does **not**
> instantiate the SSDP advertiser. The SSDP advertiser binds UDP 1900;
> running it alongside `dlna-ssdp.integration.test.ts` (which also binds
> UDP 1900 directly) makes unicast M-SEARCH-reply delivery non-deterministic
> on the kernel. If you add positive `Browse` cases that depend on
> `res@uri` being well-formed, call `app.sonosSettings.setLanUrl(...)`
> *after* `listen()` instead of passing it through `initialLanUrl` — see
> the existing file for the pattern.

### Driving a real-world DLNA server (ground truth)

To verify our DIDL-Lite shape matches what real servers emit, point the
same primitives (`dgram` + `node-upnp`) at the LAN. Recipe:

1. Send M-SEARCH with `ST: urn:schemas-upnp-org:device:MediaServer:1`.
2. For each responder, fetch the LOCATION and read `<manufacturer>` from
   the parsed device description.
3. **Filter Sonos**: Sonos ZonePlayer devices embed a MediaServer service
   for their queue and will respond to MediaServer:1 M-SEARCH. Skip any
   device where `manufacturer` contains "sonos" — sending SOAP traffic to
   a Sonos zone can change its state. Discovery + `GetTransportInfo` are
   read-only; anything that mutates AVTransport is not.
4. For the remaining device, call `client.call('ContentDirectory', 'Browse', {...})`
   with `ObjectID='0', BrowseFlag='BrowseDirectChildren'`.

Last run against the dev LAN (against Plex Media Server, Sonos zones
explicitly skipped): root → Video / Music / Photos containers, Music → 8
sub-containers (Local Music, Music, Music Channels, …). DIDL-Lite shape
matches ours; Plex uses opaque UUIDs as object IDs, same approach we take
for artists / release groups.

Probe is not committed to the tree — it's a `node` one-shot. Reproduce
from the README of this file by combining the structure of
`test/dlna-ssdp.integration.test.ts` (raw M-SEARCH) and
`test/dlna-http.integration.test.ts` (node-upnp Browse).

### CI smoke (optional)

`apt-get install gupnp-tools` in CI gives you `gssdp-discover`:

```bash
gssdp-discover --target=urn:schemas-upnp-org:device:MediaServer:1 --timeout=3
```

A real GStreamer/GNOME stack receiving + parsing our advertiser is a
useful out-of-process sanity check independent of our own SSDP code.

## See also

- [hub-internals.md](hub-internals.md) for general conventions and gotchas.
- [sonos.md](sonos.md) — shares the DIDL-Lite + SOAP primitives in `services/didl.ts` and `services/soap.ts`.
- [authentication.md](authentication.md) for the broader auth model (Subsonic, JWT, federation) the LAN gate sits alongside.
