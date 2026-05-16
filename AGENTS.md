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
   - Architectural changes: update `docs/system-architecture.md` as part of the work.
4. Write tests alongside code. Run `pnpm verify` (typecheck + test) before declaring done.
   - When querying the live database: check `hub/src/db/schema.sql` for the schema, then use `scripts/db-query.sh "SQL"`. Never exec into the container and try to import `better-sqlite3` manually.
5. Update documentation and check for any outdated or inconsistent information.
6. Commit work in phases, when all tests are passing.
7. Push branch to origin.
8. When work is completed, open a Pull Request in the Draft state.

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
| `docs/pitfalls.md`                   | **Recurring traps** — check before touching merge, SQLite, auth, federation, external fetches |
| `docs/opensubsonic.md`               | OpenSubsonic endpoint compatibility table and caveats            |
| `hub/src/db/schema.sql`              | Canonical DB schema — source of truth; read before writing DB queries |
| `scripts/db-query.sh`               | Run ad-hoc SQL against the live hub DB via `docker compose`       |
| `docs/system-architecture.md`        | Current system architecture                                      |
| `docs/frontend-testing.md`           | Vitest + RTL setup, patterns, gotchas                            |
| `docs/fanarttv-integration.md`       | fanart.tv artist image / album cover source (primary, MBID-keyed) |
| `docs/lastfm-integration.md`         | Last.fm fallback for artists without an MBID                     |
