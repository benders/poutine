# AGENTS.md

Agent rules for this project. Technical reference lives in `docs/`; operational reference lives in `README.md`. No architecture, API, env vars, or gotchas belong in this file.

## Project (one line)

Poutine: federated music player. Hub (Fastify + SQLite) bundles an internal Navidrome, serves a Subsonic API + React SPA on one port, and federates with peer hubs via Ed25519-signed HTTP.

## Task tracking (GitHub Issues)

1. Never start coding without an open GitHub Issue. No exceptions. Create one if none exists.
2. Close the issue immediately after committing, before anything else.
3. Check existing issues before creating new ones: `gh issue list --repo benders/poutine`
4. Post progress updates as comments on the issue as you work. Agent comments must include the agent name prefix (e.g. `@claude:`), and the rest of the message should be a block-quote `> `.
5. When unsure what's next, check open issues — don't freelance.
6. Reference the issue number in the commit message (e.g. `closes #42`)
7. Assign the issue to self when work starts

## Per-task checklist

1. **Start every task by reading `docs/system-architecture.md` and skimming `docs/pitfalls.md`.** Both are short by design. No exceptions.
2. Open or assign a GitHub Issue.
3. Read the relevant doc(s):
   - Touching auth, JWT, login, tokens, or Subsonic credentials: read `docs/authentication.md` FIRST.
   - Touching `/federation/*`: read `docs/federation-api.md` FIRST. Update it AND bump `FEDERATION_API_VERSION` in `hub/src/version.ts` on any contract change.
   - Touching hub internals, conventions, or anything with a known gotcha: check `docs/hub-internals.md`.
   - Touching Player code (Sonos, DLNA, cast, player-admin): obey the **Hub/Player boundary** (section below) and run `pnpm lint:boundary`.
   - Architectural changes: update `docs/system-architecture.md` as part of the work.
4. Write tests alongside code. Run `pnpm verify` (typecheck + test) before declaring done.
   - When querying the live database: check `hub/src/db/schema.sql` for the schema, then use `scripts/db-query.sh "SQL"`. Never exec into the container and try to import `better-sqlite3` manually.
   - Run `pnpm lint` and resolve **all** errors AND warnings before declaring done — including pre-existing ones in files you didn't author. Zero lint output is the bar. If a warning is a deliberate false-positive, suppress it inline with a one-line rationale rather than leaving it noisy.
5. Update documentation and check for any outdated or inconsistent information.
6. Commit work in phases, when all tests are passing.
7. Push branch to origin.
8. When work is completed, open a Pull Request in the Draft state.

## Hub/Player boundary

The backend is split into two bounded contexts inside one process — **Hub** (library, catalog, federation, users, hub-admin) and **Player** (Sonos cast, DLNA, player-admin) — so Player can later be lifted into its own process as a wiring change, not a rewrite (#212/#225). The split is real and machine-enforced. Do not erode it.

- **Player-side code** = `hub/src/routes/{sonos,dlna}.ts`, `hub/src/services/{sonos-*,dlna-*,cast-tokens,didl,soap,ssdp-advertiser,player-settings}.ts`, and frontend `features/player-admin/` + `features/player/`.
- **Player code reaches Hub state only through `HubSubsonicCaller`** (`hub/src/services/hub-subsonic-caller.ts`) over `app.inject()`. It must NOT import `better-sqlite3` at runtime (type-only `import type Database` is fine), the in-process `SubsonicClient` (`adapters/subsonic`), `app.db`, or any `hub/src/db/*` module. Player-owned storage is `player.db` via a capability-injected handle (`app.playerDb` / `PlayerSettings` / `app.sonosSettings`), never `hub.db`.
- **Frontend bounded dirs may not cross-import.** `features/hub-admin/`, `features/player-admin/`, and `features/player/` are isolated; shared pure-UI helpers go in `features/shared/`.
- **Backend admin mounts are partitioned** (#226): `/api/admin/hub/*` (Hub) and `/api/admin/player/*` (Player); `/admin/*` is auth-only. Handlers mount only in their namespace — cross-namespace requests 404.
- **Adding a Player route/service?** Add the file to the `playerFiles` glob in `hub/eslint.config.js` (and the frontend equivalent for UI), then extend the negative tests so the rule is proven to fire: `hub/test/boundary-lint.test.ts`, `frontend/src/features/boundary-lint.test.ts`. If an exception is unavoidable, document the carve-out inline in the config — never silently relax the rule.
- **Test it:** run `pnpm lint:boundary` (also bundled into `pnpm verify` and CI). Zero output is the bar — a boundary violation is a build failure, not a warning.

Full rationale and enforcement matrix: `docs/system-architecture.md` ("Hub/Player boundary enforcement", "SPA admin split", "Data model" dual-DB). Recurring traps: `docs/pitfalls.md` ("Hub/Player boundary", "Sonos cast"). Boundary test patterns: `docs/frontend-testing.md`. The trusted in-process auth path Player uses to call Hub Subsonic as the SPA user: `docs/authentication.md` ("Trusted in-process auth").

## Documentation rules

- **AGENTS.md holds agent rules only.** No architecture, no API, no gotchas, no env vars, no lessons learned. If you find yourself adding one of those, it belongs in `docs/` instead.
- **`README.md`** is for operators: project description, setup, commands, testing, operational tasks (update, restart, reset).
- **`docs/`** is for coding agents and senior engineers: architecture, API contracts, conventions, gotchas, lessons learned, Docker internals.
- **Condense, don't duplicate.** If something is documented once, reference it by path — do not copy it.
- **Terse, technical language.** Fragments OK. Audience: coding agents and experienced engineers, not newcomers.
- **Markdown tables:** pad headers and rows so columns align vertically in source.
- **When you learn a new gotcha:** add it to `docs/pitfalls.md` (or the relevant section of `docs/` if it's narrow), not AGENTS.md.

## Pointers

| File                                 | Purpose                                                          |
|--------------------------------------|------------------------------------------------------------------|
| `README.md`                          | Setup, commands, testing, operations                             |
| `docs/authentication.md`             | **Auth reference** — JWT, Subsonic dual-auth, token refresh      |
| `docs/federation-api.md`             | **Federation protocol contract** — read before `/federation/*`   |
| `docs/hub-internals.md`              | Conventions, env vars, lessons learned, Docker                   |
| `docs/pitfalls.md`                   | **Recurring traps** — check before touching merge, SQLite, auth, federation, external fetches, Hub/Player boundary |
| `docs/opensubsonic.md`               | OpenSubsonic endpoint compatibility table and caveats            |
| `hub/src/db/schema.sql`              | Canonical DB schema — source of truth; read before writing DB queries |
| `scripts/db-query.sh`               | Run ad-hoc SQL against the live hub DB via `docker compose`       |
| `docs/system-architecture.md`        | Current system architecture — incl. **Hub/Player boundary** enforcement |
| `docs/frontend-testing.md`           | Vitest + RTL setup, patterns, gotchas (incl. bounded-dir tests)  |
| `docs/fanarttv-integration.md`       | fanart.tv artist image / album cover source (primary, MBID-keyed) |
| `docs/lastfm-integration.md`         | Last.fm fallback for artists without an MBID                     |
| `docs/sonos.md`                      | Sonos casting — protocol, components, libraries, testing         |
| `docs/dlna.md`                       | DLNA MediaServer — protocol, object hierarchy, LAN gate, testing |
