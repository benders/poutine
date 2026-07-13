# Pitfalls

Recurring traps that have caused bugs and follow-up PRs. Read before touching the relevant area. New traps go here, not in commit messages or PR comments.

## Merge / unified IDs

| Trap                                                                                                                                                   | Caught by | Rule                                                                                                                                |
|--------------------------------------------------------------------------------------------------------------------------------------------------------|-----------|-------------------------------------------------------------------------------------------------------------------------------------|
| `unified_releases.id` collision when two non-MBID releases share a name in the same release group                                                      | #117      | Dedup keys must include enough discriminator (track count, year, format) to survive upstreams that omit MBIDs                       |
| Same recording MBID appearing on distinct releases collapsed into one `unified_tracks` row                                                             | #118      | A recording MBID is not unique across releases — key tracks by (release_id, mbid) not mbid alone                                    |
| Per-track artist collapsed into album artist during unification                                                                                        | #142      | Resolve track artist from `instance_tracks.artist_name`, never from the album row                                                   |
| Letting `unified_release_groups.created_at` default to `datetime('now')` at merge time                                                                 | #186      | Source it from `MAX(instance_albums.created_at)` so the SPA's "Recently Added" sort reflects Navidrome's actual added time         |
| Changing a dedup key (or just editing metadata) without the id-remap step orphans `user_stars` / `playlist_tracks` / `play_events`                     | #242      | `runMergePipeline()` / `runMergePipelineAsync()` (`merge-pipeline.ts`) snapshot identity, call `mergeLibraries`, then `applyRemap` before auditing — never call `mergeLibraries()` directly outside tests, or user data silently strands on the next merge |
| Merge running on the worker (#242 Phase 3) doesn't block WAL readers, but a main-connection WRITE started while the merge holds its write lock waits up to the 5s busy timeout, then throws SQLITE_BUSY | #242 | Keep main-thread write transactions short; don't hold one open across an `await runMergePipelineAsync(...)` |
| Renaming/moving `merge-worker.ts`                                                                                                                       | #242      | `runMergePipelineAsync` resolves both a dev/test `.ts` path and a prod compiled `.js` path from `import.meta.url` — check both branches when the file moves |

Every `unified_*` insert in `merge.ts` logs the offending row + prior `existingRow` + source IDs on PK conflict. Preserve that — it is the first thing you read when a collision regresses.

## SQLite quirks

| Trap                                                                       | Caught by | Rule                                                                                       |
|----------------------------------------------------------------------------|-----------|--------------------------------------------------------------------------------------------|
| `ALTER TABLE … ADD COLUMN … UNIQUE` fails on SQLite                       | #123      | Add the column unconstrained, then create a `UNIQUE INDEX` in a separate migration step    |
| Forgetting to read `hub/src/db/schema.sql` before writing queries          | recurring | Schema is authoritative — check it, then use `scripts/db-query.sh` for ad-hoc reads        |
| `exec`-ing into the container to import `better-sqlite3` manually          | recurring | Always go through `scripts/db-query.sh`                                                    |
| Reading Player settings (`sonos_enabled`, `sonos_volume_cap`, `lan_url`, `dlna_*`) from `hub.db.settings` | #217 | Source of truth is `player.db.player_settings` since #217. Pre-#217 rows in `hub.db.settings` are leftover dead data — go through `app.sonosSettings` (or `PlayerSettings.getRaw` for keys without a typed accessor). |

## Subsonic API compatibility

| Trap                                                                                                              | Caught by | Rule                                                                                                |
|-------------------------------------------------------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------------|
| Defaulting response format to JSON                                                                                | #164      | Per spec, default is XML. JSON is opt-in (`f=json`). 3rd-party clients surface JSON as auth failure |
| Stream params (`format`, `maxBitRate`) dropped on peer-routed streams                                             | #77, #91  | `buildStreamParams` is the only allowlist — both local and peer paths go through it                 |
| Treating any `https?://…` ID as a coverArt key                                                                    | #140      | Star/getCoverArt classifiers must be UUID-shaped; non-UUID IDs are external URLs                    |
| Caching Navidrome's "missing cover" XML envelope as if it were an image                                           | recurring | Validate content-type + magic bytes before writing to `art_cache`                                   |
| Not honoring caller transcode params when recording proxy stream activity                                         | recurring | Use the resolved params (after `buildStreamParams`), not the raw request                            |
| Assuming Subsonic `timeOffset` works on raw pass-through streams                                                  | #204      | `timeOffset` is only applied when transcoding — on raw streams it's silently ignored. Seek raw streams via HTTP Range / SOAP Seek instead |
| Recording a play anywhere other than `/rest/scrobble`                                                             | #197      | There is exactly one recording path: the client scrobbles when *it* crosses the threshold. `StreamTrackingService.finish()` records nothing. Don't infer plays from stream lifetime — a new surface reports its own position and scrobbles, it does not get a server-side estimate. |
| Reading play counts from the backing Navidrome instead of `play_events`                                            | #197      | Navidrome's counts are siloed per-hub and miss peer media. `play_events` is the canonical, federation-wide, per-user source of truth — go through `PlayEventService`. |
| Trusting a green `pnpm verify` for Subsonic API / federation changes                                              | #197      | `verify` does NOT run the Python `subsonic-compat` suite — only `pnpm test:federation` (or `verify:full`) does. A `/rest/*` semantics change (e.g. `type=recent` becoming play-history-only) passes `verify` but breaks compat. Run the federation suite for any Subsonic/federation surface change; CI gates it regardless. |

Endpoint coverage detail: [opensubsonic.md](opensubsonic.md).

## External fetches (cover art, fanart.tv, Last.fm)

| Trap                                                                          | Caught by | Rule                                                                                                       |
|-------------------------------------------------------------------------------|-----------|------------------------------------------------------------------------------------------------------------|
| SSRF via 3rd-party-client `getCoverArt` URLs                                  | #139      | Allowlist on scheme + host; reject anything resolving to private/loopback ranges                          |
| Echoing raw `String(err)` in the 502 response                                 | #139      | Internal error detail never leaves the hub — log it, return a generic message                              |
| No request timeout on external HTTP                                           | #139      | All `undici` calls take an explicit `bodyTimeout` / `headersTimeout`                                       |
| Calling Navidrome `getArtistInfo2`                                            | recurring | Navidrome doesn't implement it. Fetch from Last.fm/fanart.tv directly                                       |
| `import type` for a runtime value (e.g. `FanartTvClient`)                     | recurring | If you call `new X()`, import it as a value, not a type                                                    |

## Federation

| Trap                                                                                                                              | Caught by | Rule                                                                                                                 |
|-----------------------------------------------------------------------------------------------------------------------------------|-----------|----------------------------------------------------------------------------------------------------------------------|
| TOCTOU between "SELECT invitation WHERE consumed_at IS NULL" and the admit transaction                                            | #156      | Nonce consumption must be a single atomic `UPDATE … WHERE consumed_at IS NULL RETURNING …`                           |
| Auto-sync `setInterval` / `setTimeout` blocking graceful shutdown                                                                 | #156      | `.unref()` every long-lived timer                                                                                    |
| Gossip pinning the inviter pubkey to whatever the gossip claims                                                                   | #156      | Trust is transitive only via the invitation chain — only pin from known inviters; verify embedded signature          |
| Trusting `String(remoteErr)` from a peer in a 502                                                                                 | #156      | Same as external fetches — never echo upstream error text                                                            |
| Changing a `/federation/*` contract without bumping `FEDERATION_API_VERSION` in `hub/src/version.ts` and updating federation-api.md | recurring | Contract is the doc; the doc is the contract. Bump both together                                                     |
| Adding a peer-facing gate to `federation/peer-auth.ts` and assuming `/proxy/*` is covered                                          | #244      | `/proxy/*` has its own auth path (`proxy/auth.ts`); every peer-level policy must land in BOTH. Only the federation suite catches the gap |
| Version-gating peers against `FEDERATION_API_VERSION` instead of the floor                                                        | #244      | Compare against `MIN_FEDERATION_API_VERSION` — the current version silently cuts supported older peers off at every bump |

Full protocol: [federation-api.md](federation-api.md).

## Auth

| Trap                                                                                  | Caught by | Rule                                                                                                          |
|---------------------------------------------------------------------------------------|-----------|---------------------------------------------------------------------------------------------------------------|
| Hashing passwords (bcrypt/argon2)                                                     | design    | Subsonic `u+t+s` requires the cleartext — passwords are AES-256-GCM-encrypted, not hashed                     |
| `reset-password.sh` calling a hash helper                                             | #114      | Reset must go through the AES path, same as user creation                                                     |
| SPA `/login` route firing authenticated API calls before login completes              | memory    | Login page must not call any endpoint requiring a session — causes 401-self-redirect loops                    |
| Missing salt validation on `u+t+s`                                                    | #112      | Salt is required, must be ≥ 6 hex chars; reject otherwise                                                     |
| Accepting `castToken=` on Subsonic endpoints other than `/rest/stream(.view)`         | #218      | Cast tokens grant *single-track stream access only*. `requireSubsonicAuthBinary` path-gates the token branch — never widen it (especially not to `/rest/getCoverArt` or any JSON endpoint) |
| Player code importing `SubsonicClient` from `hub/src/adapters/subsonic.js`            | #220      | Player BE (sonos / dlna / cast routes + services) must reach Hub Subsonic via HTTP only — use the shared `HubSubsonicCaller` (`services/hub-subsonic-caller.ts`). In-process `SubsonicClient` is Hub→Navidrome only (admin.ts, routes/subsonic/stream.ts, auto-sync.ts) |
| Player code touching `app.db` directly                                                | #220      | Same boundary. `routes/sonos.ts` reads track metadata + source format via Hub `/rest/getSong` over `app.inject`; never re-add `app.db.prepare(...)` to Player files. `app.playerDb` (the player-owned SQLite file) is allowed via the typed `PlayerSettings` wrapper |
| Logging or echoing `app.internalAuthSecret` (or the `x-poutine-internal` header value) | #224      | The trusted-header secret is in-process only — never log it, never put it in a JWT/cookie/response body. Only `HubSubsonicCaller` is allowed to read it; the auth middleware does a `timingSafeEqual` and discards |
| Adding a new internal caller for Hub Subsonic that bypasses `HubSubsonicCaller`        | #224      | All in-process Subsonic calls must go through `services/hub-subsonic-caller.ts`. New routes use `{ asUser: req.username }` when running under `requireAuth`; only paths with no user context (DLNA browse) may omit `asUser` and fall back to owner u+p |

Full flow: [authentication.md](authentication.md).

## Concurrency

| Trap                                                                                          | Caught by | Rule                                                                                                |
|-----------------------------------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------------|
| TOCTOU between `artCache.get()` and concurrent eviction                                       | recurring | `get()` returns content + holds a ref; eviction can't delete an in-flight stream                    |
| Hoisting prepared statements rebuilt per-request                                              | #130      | Hot-path SQL goes through prepared statements built once at module load                             |

## Navidrome ops

| Trap                                                                                                | Caught by | Rule                                                                                                                              |
|-----------------------------------------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------------------------------------------|
| Transient FS unmount → Navidrome marks rows `missing=1` → federated index shrinks permanently       | #159      | `ND_SCANNER_PURGEMISSING=always` so the next scan re-discovers files; trade-off documented in `docker-compose.yml`                |
| Using `ND_INITIALADMINPASSWORD` to seed the admin user                                              | memory    | No-op in Navidrome 0.52+. Use `ND_DEVAUTOCREATEADMINPASSWORD`                                                                     |
| Forgetting to log a warning when local `instance_tracks` count drops materially between syncs       | #159      | Early signal that the music volume disappeared — keep the warning if you touch sync metrics                                       |
| Wiring k8s / LB probes to `/api/health` HTTP status                                                  | #178      | Always returns 200 (so federation handshake survives a Navidrome blip). Key probes on `body.status === "ok"` instead              |
| Expecting `song.path` in Subsonic responses to be the on-disk path                                   | #252      | Default is a tag-derived **virtual** path (`Artist/Album/Title.ext`) — zero folder signal. Real paths need `ND_SUBSONIC_DEFAULTREPORTREALPATH=true`, and that default is **pinned per player record** (keyed user+client+UA) at creation — flipping the flag never reaches existing players. BOTH Poutine client names are versioned for this (`poutine-sync-rp` for local sync, `poutine-proxy-rp` in `routes/proxy.ts` for the identity peers' syncs hit — the proxy overwrites `c` and drops the caller's UA); bump both again if the flag semantics ever change |

## Sonos cast

| Trap                                                                                                       | Caught by | Rule                                                                                             |
|------------------------------------------------------------------------------------------------------------|-----------|--------------------------------------------------------------------------------------------------|
| Re-adding a runtime Navidrome `getSong` call from Player to detect hi-res FLAC                             | #220      | Player BE cannot reach Navidrome — boundary set by #212. Restore the hi-res guard via Hub Subsonic (#199 adds `track_sources.sampling_rate` / `bit_depth` columns + projects them into `/rest/getSong`) |
| Assuming the SPA can send a bare Navidrome `remote_id` to `/api/sonos/devices/:id/play`                    | #220      | SPA has always sent `t<uuid>` (the Subsonic id). The remote_id fallback was dead defensive code and is removed |
| Routing Sonos cast's internal `/rest/getSong` through `POUTINE_OWNER_USERNAME` / `POUTINE_OWNER_PASSWORD`  | #224      | The cast hot-path now authenticates as the calling SPA user via `HubSubsonicCaller`'s trusted-header mode (`{ asUser: req.username }`). Owner u+p was a hidden coupling — a hub deployed with mismatched owner creds silently 404'd every cast attempt because Subsonic returned `status:failed` and the route interpreted that as "track not found". See `docs/authentication.md#trusted-in-process-auth` |

## Frontend

| Trap                                                              | Caught by | Rule                                                                                          |
|-------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------|
| StarButton updating only after the server roundtrip               | #126      | Optimistic update first; reconcile on response; revert on failure                             |
| Play button missing on the current track / no pause-on-hover      | #99       | Current track always shows the play control; toggle to pause on click                         |
| Mirroring local `volume` (0..1) into a Sonos device                | #181      | Local `volume` and `castVolume` are separate stores by design — see `docs/sonos.md`           |
| Calling `next()` on Sonos `PLAYING → STOPPED` as the EOT signal     | #202      | Gapless pre-load means the device auto-advances; use `TrackURI` change + cached `pendingNextRef` index. STOPPED-after-PLAYING is only the end-of-queue fallback. |
| Calling `peekNext()` twice with shuffle on (returns different songs)| #202      | Cache the first result; reuse for both the `/next` POST and the post-advance `jumpTo`         |

## Hub/Player boundary

| Trap                                                                                            | Caught by | Rule                                                                                          |
|-------------------------------------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------|
| Player-side route/service grabbing `better-sqlite3`, `app.db`, the in-process `SubsonicClient`, or any `db/preferred-source*` / `db/client*` module | #213–#220 audit; #221 lint | Player code accesses Hub state only through `services/hub-subsonic-caller.ts` (HTTP-shaped `app.inject()` against `/rest/*`). Take a Database handle via capability injection for `player.db`; type-only `import type Database from "better-sqlite3"` is allowed. |
| Adding a new Player route or service without extending the boundary lint glob                   | #221      | `playerFiles` lives in `hub/eslint.config.js`. Add the new file there. Negative tests live in `hub/test/boundary-lint.test.ts`. |
| Cross-importing between `features/hub-admin/`, `features/player-admin/`, and `features/player/` | #221      | `frontend/eslint.config.js` blocks it. Lift shared helpers into `features/shared/` instead.  |

## Process

| Trap                                                                | Caught by | Rule                                                                                          |
|---------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------|
| Broken tests landed on green CI                                     | #116      | CI runs `pnpm verify` (typecheck + lint:boundary + test) on every PR                          |
| Stacked PRs                                                         | CLAUDE.md | Follow-ups go on the same feature branch — never branch off a draft PR                        |
| Working without a GitHub issue                                      | AGENTS.md | No issue, no work. Reference the issue in the commit and close on merge                       |
