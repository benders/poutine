---
id: poutine-046c
title: 'Reorganize docs: move tech content out of CLAUDE.md'
type: chore
priority: 2
created: '2026-04-11T14:43:06Z'
updated: '2026-04-11T15:08:11Z'
commit: 901699e
---

Move architecture/API/technical docs from CLAUDE.md into docs/ or README.md. Condense, dedupe (reference don't duplicate), terse technical language for coding agents + senior engineers. Reformat markdown tables to align columns. Final CLAUDE.md: only agent rules, tools (Yaks), per-task steps, pointers. README.md: short project description + setup/testing/operational tasks. Add these doc rules to the final CLAUDE.md.

## Done

- Created docs/hub-internals.md (171 lines): conventions, env vars, API surface, auth, album art, federation, versioning, frontend Subsonic, SPA serving, binary endpoints, Navidrome integration, SQLite notes, Docker, testing patterns, federation test, local cluster setup
- Renamed docs/02-system-architecture.md → docs/system-architecture.md (remove numbering); rewrote to reflect current federation model (three layers, federation model, data model, play flow, auth, scale)
- Condensed CLAUDE.md to 48 lines: agent rules, task checklist, doc rules, pointers only
- Expanded README.md: setup, commands, testing, operations (update/restart/reset owner password, manual sync, reload peers, wipe Navidrome)
- Aligned markdown tables across federation-api.md, system-architecture.md, and test/federation/keys/README.md
- Removed stale docs: MEMORY.md, docs/01-architecture-decision.md (historical ADR, not load-bearing), docs/03-implementation-plan.md (pre-federation, credentials-per-instance model obsolete)
- Removed stale MEMORY.md index (referenced non-existent memory/ directory)

Final state: CLAUDE.md is agent rules only; README.md covers operators' needs; docs/ is technical reference for coding agents.
