# OpenSubsonic Extensions Survey (issue #214)

Context: parent re-architecture #212 commits to the Subsonic API as the sole
Hub↔Player wire. This survey identifies OpenSubsonic optional extensions whose
adoption would reduce friction at that boundary — particularly for DLNA
ContentDirectory, Sonos casting, transcoding choices, queue / now-playing per
device, and library browsing from Player UIs.

Source: [OpenSubsonic spec](https://opensubsonic.netlify.app/) (extensions
section), cross-referenced against the current implementation in
`hub/src/routes/subsonic.ts` and `docs/opensubsonic.md`.

## Today's surface

Hub already advertises:

- `openSubsonic: true` in every response envelope
- `type: "poutine"`, `serverVersion: APP_VERSION`
- `albumArtist` / `albumArtistId` on every Song (#138)
- `created` (ISO 8601) on every Album (#148)
- `starred` (ISO 8601) per-user on artists/albums/songs (#104)
- `musicBrainzId` on artists/albums where known

Hub does NOT advertise `getOpenSubsonicExtensions` and does not list the
extensions it supports. This is the first thing to fix — without it, Player and
external clients cannot feature-detect and must guess.

## Recommendation summary

| Priority | Extension                          | Where it helps                                                |
|----------|------------------------------------|---------------------------------------------------------------|
| **P0**   | `getOpenSubsonicExtensions`        | Capability negotiation — required to advertise everything below |
| **P0**   | `formPost`                         | Long signed peer URLs + DLNA Search query payloads            |
| **P0**   | `songLyrics` extras on Song        | DLNA + future Player lyrics view                              |
| **P1**   | `transcodeOffset` / time-offset    | Already implemented (#109); just advertise                    |
| **P1**   | OpenSubsonic Song fields (`mediaType`, `bitDepth`, `samplingRate`, `channelCount`, `genres[]`, `replayGain`, `musicBrainzId`, `bpm`, `comment`, `sortName`, `played`, `playCount`) | DLNA ContentDirectory + Sonos didl-lite + Player UI |
| **P1**   | OpenSubsonic Album fields (`isCompilation`, `discTitles`, `releaseTypes`, `recordLabels`, `moods`, `originalReleaseDate`, `releaseDate`, `sortName`, `genres[]`, `played`, `playCount`, `userRating`) | DLNA browsing + Player album header                       |
| **P1**   | OpenSubsonic Artist fields (`sortName`, `roles`, `musicBrainzId`)                | Player artist header + DLNA tree                              |
| **P1**   | `apiKeyAuthentication`             | Long-lived Player→Hub token without re-using user password    |
| **P2**   | `getPlayQueue` / `savePlayQueue`   | Per-device queue handoff (browser ↔ Sonos ↔ DLNA)             |
| **P2**   | Scrobble extension (`time`, `submission`, `duration_ms`) | Lossless activity ingest from Player → Hub      |
| **P2**   | `getLyricsBySongId` (structured lyrics) | Player lyrics view (Symfonium, SuperSonic already consume it)  |
| **P2**   | `search3` paging (`*Offset`, `*Count`) | Already partially supported; document + verify for DLNA Search |
| **P3**   | `indexBasedQueue` / multi-disc `discTitles` | Box-set rendering                                       |
| **P3**   | `getInternetRadioStations` stub    | Some clients (DSub) probe at startup; cheap empty response    |

## Detailed candidates

### P0 — `getOpenSubsonicExtensions`

**Link:** https://opensubsonic.netlify.app/docs/endpoints/getopensubsonicextensions/

**What:** Endpoint that returns the list of extension names + version numbers
the server implements. Spec'd as an array of `{name, versions: number[]}`.

**Why it helps the boundary:** Player (and external Subsonic clients like
Symfonium, Feishin, Amperfy) call this once at login and route around missing
features. Without it the Player has to either probe each endpoint or assume
worst-case Subsonic 1.16.1, defeating the point of the boundary.

**Hub today:** NOT IMPLEMENTED (per `docs/opensubsonic.md` System table).

**Effort:** **S** — single endpoint returning a static list per `version.ts`.
Wire it once and every other extension below piggybacks on it.

### P0 — `formPost`

**Link:** https://opensubsonic.netlify.app/docs/extensions/formpost/

**What:** Servers accept POST with `application/x-www-form-urlencoded` bodies
for any endpoint. Lets clients put long parameter payloads in the body instead
of URL.

**Why it helps:** Federated track IDs are long; signed peer-proxied
`coverArt` IDs (`{instanceId}:{coverArtId}`) inflate URLs. DLNA Search queries
can include arbitrarily long match strings. Sonos `SetAVTransportURI` carries
the URL inside a SOAP body, which has its own length quirks.

**Hub today:** All endpoints already accept GET and POST (per `route()`
helper). Need to verify body parsing handles form-encoded and document support.

**Effort:** **S** — verify, document, advertise.

### P0 — Lyrics-on-Song / structured lyrics

**Link:** https://opensubsonic.netlify.app/docs/endpoints/getlyricsbysongid/

**What:** `getLyricsBySongId` returns multilingual, synced or unsynced lyrics
keyed off Song ID. Older `getLyrics` (artist+title) is replaced.

**Why it helps the boundary:** Player has no other lossless lyrics channel.
Sonos `didl-lite` carries lyrics if the server provides them; DLNA does not.
Implementing this means Player has no reason to invent a private lyrics API.

**Hub today:** NOT IMPLEMENTED. Navidrome exposes lyrics via Subsonic — Hub
just needs to passthrough.

**Effort:** **M** — proxy to source instance, cache result.

### P1 — Song extension fields

**Link:** https://opensubsonic.netlify.app/docs/responses/song/

OpenSubsonic adds (beyond stock Subsonic):

| Field            | Origin (Navidrome → Hub)                  | Why it matters                                          |
|------------------|-------------------------------------------|---------------------------------------------------------|
| `mediaType`      | always `"song"` for our tracks            | DLNA UPnP class disambiguation                          |
| `bitDepth`       | Navidrome track metadata                  | Sonos/DLNA can refuse hi-res if not advertised          |
| `samplingRate`   | Navidrome track metadata                  | Same as bitDepth                                        |
| `channelCount`   | Navidrome track metadata                  | DLNA didl-lite stereo/mono flag                         |
| `bpm`            | Navidrome track metadata (if tagged)      | Player UI                                               |
| `comment`        | Navidrome track metadata                  | Player UI                                               |
| `sortName`       | Navidrome `sort_title`                    | Correct alphabetisation for "The …" titles              |
| `genres[]`       | already aggregated in unified tracks      | Multi-genre — stock Subsonic only carries first         |
| `replayGain`     | object: `trackGain`, `albumGain`, `trackPeak`, `albumPeak`, `fallbackGain` | **Critical for Sonos/DLNA stream loudness consistency** |
| `musicBrainzId`  | already in unified tracks                 | External lookups, scrobblers                            |
| `played` / `playCount` | per-user — needs activity store     | Player "recently played" + DLNA browse                  |
| `userRating`     | per-user — needs ratings (issue: not impl)| Player UI                                               |

**Why it helps:** Bulk-emitting these makes the Subsonic boundary
information-complete for both DLNA didl-lite generation (currently has to
synthesize approximations) and Sonos metadata. `replayGain` in particular
removes the only justification for inventing a private endpoint for loudness
hints.

**Hub today:** None of these emitted. Most are available in
`unified_tracks` / `track_sources` already (or trivially fetchable from the
source Navidrome via `getSong`).

**Effort:** **M** — single mapper change in `subsonic.ts`; tests for each
field. `replayGain` requires a column add and a sync-mapper pull from
Navidrome.

### P1 — Album extension fields

**Link:** https://opensubsonic.netlify.app/docs/responses/album/

| Field                       | Why                                                            |
|-----------------------------|----------------------------------------------------------------|
| `isCompilation`             | DLNA "Compilations" container; Player tag                      |
| `discTitles[]`              | Multi-disc box sets render correctly in Sonos / DLNA           |
| `releaseTypes[]`            | "Album / EP / Live" filtering — Player browse                  |
| `recordLabels[]`            | Album page detail                                              |
| `moods[]`                   | Mood-based browsing (Symfonium uses this)                      |
| `originalReleaseDate`       | `{year, month, day}` — sort + display                          |
| `releaseDate`               | Different from original on reissues                            |
| `sortName`                  | Alphabetisation                                                |
| `genres[]`                  | Already aggregated; multi-genre                                |
| `played` / `playCount`      | Recently-played row                                            |
| `userRating`                | Album rating                                                   |

**Why it helps:** ContentDirectory.Browse currently flattens box sets into one
disc and loses release-type distinction. Sonos picks the wrong artwork on
compilations because `isCompilation` is missing.

**Hub today:** Not emitted. `originalReleaseDate` partial (year only).

**Effort:** **M** — same shape as Song fields; schema additions to
`unified_release_groups`.

### P1 — Artist extension fields

`sortName`, `roles[]` (e.g. `["composer","performer"]`), `musicBrainzId` on
every Artist response.

`roles` is interesting because Hub already filters track-only-credit artists
out of `getIndexes` / `getArtists` (per `docs/opensubsonic.md` line 64). With
`roles` we could include them and let Player choose how to render.

**Effort:** **S–M**.

### P1 — `apiKeyAuthentication`

**Link:** https://opensubsonic.netlify.app/docs/extensions/apikeyauth/

**What:** Optional `apiKey` parameter replaces `u+p` / `u+t+s`. Servers return
error code 44 if the key is invalid.

**Why it helps the boundary:** Player BE (post-#212) makes Subsonic calls back
to Hub on behalf of cast targets (DLNA pseudo-user, Sonos device sessions). It
needs an auth credential it can hold without exposing the user's reversible
AES-encrypted password. A signed long-lived API key is the OpenSubsonic-blessed
mechanism, instead of inventing a private JWT shape.

**Hub today:** error code 44 already mapped (per `opensubsonic.md` line 39).
Storage + endpoint missing.

**Effort:** **M** — new `api_keys` table, key issuance via `/admin/*`, dual
auth path in `subsonic.ts`.

### P2 — `getPlayQueue` / `savePlayQueue`

**Link:** Subsonic 1.12+ but OpenSubsonic clarifies semantics.

**What:** Per-user server-side queue: list of song IDs, current index, position
in current track, change token. Lets a user resume on a different device.

**Why it helps:** Maps directly onto the Player-owned "queue / now-playing per
device" concern from #212. If Hub stores the queue, Player + Sonos + DLNA + an
external client can all read/write the same queue without inventing a private
endpoint. This is the cleanest way to do device handoff over the Subsonic wire.

**Hub today:** NOT IMPLEMENTED. Tables don't exist.

**Effort:** **M** — small schema (`play_queues` keyed by user+device).
Storage is trivial; the interesting work is reconciliation across cast
targets, which is Player's #212 problem regardless.

### P2 — Scrobble extension

**Link:** OpenSubsonic clarifies `submission=true` semantics + accepts `time`
(epoch ms) for backfilled plays.

**What:** Vanilla `scrobble` takes only `id` + `submission`; OpenSubsonic
documents `time` as epoch ms (matters for DLNA/Sonos where the play started
before the call) and many servers accept a `duration_ms`.

**Why it helps:** Activity ingest from Player → Hub goes via `scrobble` (per
#214 brief). DLNA has no concept of nowPlaying; Sonos reports completion
asynchronously. Without `time` Hub loses fidelity on when the play actually
happened. Adopting the extension means activity log is accurate without
inventing `/api/activity/log`.

**Hub today:** Stub. Receives the call but discards. No `activity` table yet.

**Effort:** **M** — `activity` table, real handling, expose in
`getNowPlaying`.

### P2 — `getLyricsBySongId` (covered under P0 lyrics)

### P2 — `search3` paging

OpenSubsonic confirms `artistOffset`/`artistCount`, `albumOffset`/`albumCount`,
`songOffset`/`songCount` are required for `search3`. Hub's `search3` already
honors limit but does not document paging behaviour. DLNA ContentDirectory.Search
needs deterministic paging.

**Effort:** **S** — verify, document.

### P3 — Internet radio stub

DSub / play:Sub probe `getInternetRadioStations` at login and emit confusing
errors when the endpoint 404s. Returning an empty list (similar to current
`getPlaylists`) silences the warning. No real implementation needed.

**Effort:** **S**.

## How this maps onto Player concerns from #212

| Player concern (#212)                                 | Extension that removes need for a private API     |
|-------------------------------------------------------|---------------------------------------------------|
| Queue, now-playing per device                         | `getPlayQueue` / `savePlayQueue`                  |
| DLNA ContentDirectory rich metadata                   | Song/Album field extensions, `formPost`, `replayGain` |
| Sonos didl-lite metadata + loudness                   | `replayGain`, Song fields, lyrics                 |
| Player BE auth back to Hub (no shared password)       | `apiKeyAuthentication`                            |
| Cast transcoding choices (`format`, `maxBitRate`)     | Already in vanilla; advertise via extensions      |
| Activity ingest from Player and devices               | Scrobble extension (`time`, `submission`)         |
| Player UI feature-detection                           | `getOpenSubsonicExtensions`                       |
| Browsing search from external Subsonic clients        | `search3` paging                                  |

## Top 3 recommendations

1. **Ship `getOpenSubsonicExtensions` immediately.** It is one endpoint
   returning a static list. It unblocks every other capability negotiation
   below and is what external clients use to decide whether to enable richer
   UI. Until we ship it, every other extension we add is invisible.

2. **Adopt the Song / Album / Artist extension field set as one chunk,
   anchored by `replayGain`.** This is the single largest source of metadata
   loss across the Hub→DLNA / Hub→Sonos boundaries. Done together it is one
   mapper change + one schema migration. Done piecemeal it is N flag days for
   Player.

3. **Implement `getPlayQueue` / `savePlayQueue` + the scrobble extension as
   the per-device-state pair.** These two together let Player keep its
   "queue / now-playing per device" responsibility entirely on the Subsonic
   wire — no private device-state endpoints required. They are also the
   pre-requisite for the Player↔Sonos↔DLNA handoff story.

Anything below P2 can wait until the boundary refactor (#212) is complete and
we know what Player actually needs.
