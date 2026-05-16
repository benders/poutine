# Pitfalls

Recurring traps that have caused bugs and follow-up PRs. Read before touching the relevant area. New traps go here, not in commit messages or PR comments.

## Merge / unified IDs

| Trap                                                                                                                                                   | Caught by | Rule                                                                                                                                |
|--------------------------------------------------------------------------------------------------------------------------------------------------------|-----------|-------------------------------------------------------------------------------------------------------------------------------------|
| `unified_releases.id` collision when two non-MBID releases share a name in the same release group                                                      | #117      | Dedup keys must include enough discriminator (track count, year, format) to survive upstreams that omit MBIDs                       |
| Same recording MBID appearing on distinct releases collapsed into one `unified_tracks` row                                                             | #118      | A recording MBID is not unique across releases — key tracks by (release_id, mbid) not mbid alone                                    |
| Per-track artist collapsed into album artist during unification                                                                                        | #142      | Resolve track artist from `instance_tracks.artist_name`, never from the album row                                                   |

Every `unified_*` insert in `merge.ts` logs the offending row + prior `existingRow` + source IDs on PK conflict. Preserve that — it is the first thing you read when a collision regresses.

## SQLite quirks

| Trap                                                                       | Caught by | Rule                                                                                       |
|----------------------------------------------------------------------------|-----------|--------------------------------------------------------------------------------------------|
| `ALTER TABLE … ADD COLUMN … UNIQUE` fails on SQLite                       | #123      | Add the column unconstrained, then create a `UNIQUE INDEX` in a separate migration step    |
| Forgetting to read `hub/src/db/schema.sql` before writing queries          | recurring | Schema is authoritative — check it, then use `scripts/db-query.sh` for ad-hoc reads        |
| `exec`-ing into the container to import `better-sqlite3` manually          | recurring | Always go through `scripts/db-query.sh`                                                    |

## Subsonic API compatibility

| Trap                                                                                                              | Caught by | Rule                                                                                                |
|-------------------------------------------------------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------------|
| Defaulting response format to JSON                                                                                | #164      | Per spec, default is XML. JSON is opt-in (`f=json`). 3rd-party clients surface JSON as auth failure |
| Stream params (`format`, `maxBitRate`) dropped on peer-routed streams                                             | #77, #91  | `buildStreamParams` is the only allowlist — both local and peer paths go through it                 |
| Treating any `https?://…` ID as a coverArt key                                                                    | #140      | Star/getCoverArt classifiers must be UUID-shaped; non-UUID IDs are external URLs                    |
| Caching Navidrome's "missing cover" XML envelope as if it were an image                                           | recurring | Validate content-type + magic bytes before writing to `art_cache`                                   |
| Not honoring caller transcode params when recording proxy stream activity                                         | recurring | Use the resolved params (after `buildStreamParams`), not the raw request                            |

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

Full protocol: [federation-api.md](federation-api.md).

## Auth

| Trap                                                                                  | Caught by | Rule                                                                                                          |
|---------------------------------------------------------------------------------------|-----------|---------------------------------------------------------------------------------------------------------------|
| Hashing passwords (bcrypt/argon2)                                                     | design    | Subsonic `u+t+s` requires the cleartext — passwords are AES-256-GCM-encrypted, not hashed                     |
| `reset-password.sh` calling a hash helper                                             | #114      | Reset must go through the AES path, same as user creation                                                     |
| SPA `/login` route firing authenticated API calls before login completes              | memory    | Login page must not call any endpoint requiring a session — causes 401-self-redirect loops                    |
| Missing salt validation on `u+t+s`                                                    | #112      | Salt is required, must be ≥ 6 hex chars; reject otherwise                                                     |

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

## Frontend

| Trap                                                              | Caught by | Rule                                                                                          |
|-------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------|
| StarButton updating only after the server roundtrip               | #126      | Optimistic update first; reconcile on response; revert on failure                             |
| Play button missing on the current track / no pause-on-hover      | #99       | Current track always shows the play control; toggle to pause on click                         |

## Process

| Trap                                                                | Caught by | Rule                                                                                          |
|---------------------------------------------------------------------|-----------|-----------------------------------------------------------------------------------------------|
| Broken tests landed on green CI                                     | #116      | CI runs `pnpm verify` (typecheck + test) on every PR                                          |
| Stacked PRs                                                         | CLAUDE.md | Follow-ups go on the same feature branch — never branch off a draft PR                        |
| Working without a GitHub issue                                      | AGENTS.md | No issue, no work. Reference the issue in the commit and close on merge                       |
