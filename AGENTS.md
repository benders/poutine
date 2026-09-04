# AGENTS.md

Agent rules for this project. Technical reference lives in `docs/`; operational reference lives in `README.md`. No architecture, API, env vars, or gotchas belong in this file.

## Project (one line)

Poutine: federated music player. Hub (Fastify + SQLite) bundles an internal Navidrome, serves a Subsonic API + React SPA on one port, and federates with peer hubs via Ed25519-signed HTTP.

## Task tracking (GitHub Issues)

1. Never start coding without an open GitHub Issue. No exceptions. Create one if none exists.
2. Check existing issues before creating new ones: `gh issue list --repo benders/poutine`
3. Assign the issue to self when work starts.
4. Reference the issue in the commit message (e.g. `closes #42`). **The issue closes when the PR merges** — never close it by hand at commit time. Work isn't done until it is reviewed and merged.
5. Post progress updates as comments on the issue as you work. Agent comments must include the agent name prefix (e.g. `@claude:`), and the rest of the message should be a block-quote `> `.
6. When unsure what's next, check open issues — don't freelance.

## Branching and commits

- **Work on a feature branch.** Branch before the first edit. Never commit to `main` unless the user explicitly asks for that in this session.
- Direct-to-`main` work, when the user does ask for it: make the change and run the gate, then stop. Committing and pushing on `main` need their own explicit ask — never do either automatically.
- Commit in phases, as each phase's tests pass — not one lump at the end.
- Push the branch to origin, then open a Pull Request in **Draft** state when the work is ready for the user to review.
- **No stacked PRs.** Work identified during review lands on the same feature branch.

## Per-task checklist

1. **Start every task by reading `docs/system-architecture.md` and skimming `docs/pitfalls.md`.** Both are short by design. No exceptions.
2. Open or assign a GitHub Issue; create the feature branch.
3. Read the relevant doc(s):
   - Touching auth, JWT, login, tokens, or Subsonic credentials: read `docs/authentication.md` FIRST.
   - Touching `/federation/*`: read `docs/federation-api.md` FIRST. Update it AND bump `FEDERATION_API_VERSION` in `hub/src/version.ts` on any contract change.
   - Touching hub internals, conventions, or anything with a known gotcha: check `docs/hub-internals.md`.
   - Touching Player code (Sonos, DLNA, cast, player-admin): obey the **Hub/Player boundary** (section below).
   - Architectural changes: update `docs/system-architecture.md` as part of the work.
4. Write tests alongside code. Run `pnpm verify` before declaring done — it is the full local gate (typecheck + lint + unit tests + hub integration tests) and matches CI's `unit` job. Resolve **all** lint errors AND warnings, including pre-existing ones in files you didn't author; zero lint output is the bar. If a warning is a deliberate false-positive, suppress it inline with a one-line rationale rather than leaving it noisy.
   - **Touching the Subsonic API (`/rest/*`, `getAlbumList2`, scrobble/play-counts, search, stream), `/federation/*`, auth, or the merged-catalog shape? `pnpm verify` is NOT enough** — it does not run the Python `subsonic-compat` suite. Run `pnpm test:federation` (Docker; spins up hub-a/b/c) and get a green run before declaring done. `pnpm verify:full` runs both. CI gates every PR on the `federation` job regardless, so a skip here only delays the failure to post-push.
   - When querying the live database: check `hub/src/db/schema.sql` for the schema, then use `scripts/db-query.sh "SQL"`. Never exec into the container and try to import `better-sqlite3` manually.
5. Update documentation and check for any outdated or inconsistent information.
6. Commit, push, and open a Draft PR — see **Branching and commits** above.

## Hub/Player boundary

The backend is two bounded contexts inside one process — **Hub** (library, catalog, federation, users, hub-admin) and **Player** (Sonos cast, DLNA, player-admin) — so Player can later be lifted into its own process as a wiring change, not a rewrite (#212/#225). The split is machine-enforced. Do not erode it.

Rules:

- **Player code reaches Hub state only through `HubSubsonicCaller`** (`hub/src/services/hub-subsonic-caller.ts`). Never widen that door.
- **Neither side touches the other's SQLite file.** Player-owned storage is `player.db` via the capability-injected handle (`app.playerDb` / `PlayerSettings` / `app.sonosSettings`); Hub-owned storage is `hub.db`.
- **Bounded directories may not cross-import** — backend Player files, and frontend `features/hub-admin/`, `features/player-admin/`, `features/player/`. Shared pure-UI helpers go in `features/shared/`.
- **Handlers mount only in their own admin namespace** — `/api/admin/hub/*` (Hub), `/api/admin/player/*` (Player), `/admin/*` auth-only.
- **Adding a Player route or service?** Add the file to the `playerFiles` glob in `hub/eslint.config.js` (and the frontend equivalent for UI), then extend the negative tests so the rule is proven to fire: `hub/test/boundary-lint.test.ts`, `frontend/src/features/boundary-lint.test.ts`.
- **An unavoidable exception is documented inline in the eslint config** — never silently relaxed.
- **Test it:** `pnpm lint:boundary` isolates just these rules (`pnpm verify` and CI run them too). Zero output is the bar — a boundary violation is a build failure, not a warning.

Architecture, the full file lists, and the enforcement matrix: `docs/system-architecture.md` ("Hub/Player boundary enforcement", "SPA admin split", "Data model" dual-DB). Recurring traps: `docs/pitfalls.md` ("Hub/Player boundary", "Sonos cast"). Boundary test patterns: `docs/frontend-testing.md`. The trusted in-process auth path Player uses to call Hub Subsonic as the SPA user: `docs/authentication.md` ("Trusted in-process auth").

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
| `docs/migration.md`                  | **Relocate an instance** to another machine — volumes, keys, music |
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
