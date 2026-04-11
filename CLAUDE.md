# CLAUDE.md

Agent rules for this project. Technical reference lives in `docs/`; operational reference lives in `README.md`. No architecture, API, env vars, or gotchas belong in this file.

## Project (one line)

Poutine: federated music player. Hub (Fastify + SQLite) bundles an internal Navidrome, serves a Subsonic API + React SPA on one port, and federates with peer hubs via Ed25519-signed HTTP.

## Task tracking (Yaks)

1. Never start coding without a shaving yak. No exceptions.
2. Shorn immediately after committing, before anything else.
3. Check existing yaks before creating new ones.
4. Append progress notes to yak descriptions as you work.
5. When unsure what's next, run `/yaks:next` — don't freelance.
6. Include the Yak ID in the commit message

## Per-task checklist

1. Shave a yak.
2. Read the relevant doc(s):
   - Touching `/federation/*`: read `docs/federation-api.md` FIRST. Update it AND bump `FEDERATION_API_VERSION` in `hub/src/version.ts` on any contract change.
   - Touching hub internals, conventions, or anything with a known gotcha: check `docs/hub-internals.md`.
   - Architectural changes: read `docs/system-architecture.md`.
3. Write tests alongside code. Run `pnpm test` + `pnpm typecheck` before declaring done.
4. Update documentation and check for any outdated or inconsitant information
5. Yak files (in `.yaks/`) should be committed along with the code
5. Commit only when the user approves
6. Shorn the yak immediately after committing.

## Documentation rules

- **CLAUDE.md holds agent rules only.** No architecture, no API, no gotchas, no env vars, no lessons learned. If you find yourself adding one of those, it belongs in `docs/` instead.
- **`README.md`** is for operators: project description, setup, commands, testing, operational tasks (update, restart, reset).
- **`docs/`** is for coding agents and senior engineers: architecture, API contracts, conventions, gotchas, lessons learned, Docker internals.
- **Condense, don't duplicate.** If something is documented once, reference it by path — do not copy it.
- **Terse, technical language.** Fragments OK. Audience: coding agents and experienced engineers, not newcomers.
- **Markdown tables:** pad headers and rows so columns align vertically in source.
- **When you learn a new gotcha:** add it to the relevant section of `docs/`, not CLAUDE.md.

## Pointers

| File                                 | Purpose                                                          |
|--------------------------------------|------------------------------------------------------------------|
| `README.md`                          | Setup, commands, testing, operations                             |
| `docs/federation-api.md`             | **Federation protocol contract** — read before `/federation/*`   |
| `docs/hub-internals.md`              | Conventions, env vars, gotchas, lessons learned, Docker          |
| `docs/system-architecture.md`        | Current system architecture                                      |
