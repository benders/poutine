@AGENTS.md

## Claude Code

Everything else — task tracking, branching, commits, the PR flow, the verify gate — lives in `AGENTS.md`.

### Posting to GitHub

When posting comments, ALWAYS prefix comments with `FROM @claude:` and use blockquote style

### Tool gotchas

* The Write tool can emit literal control characters for `\u0000`–`\u001f` escapes inside regex character classes; a later Edit `old_string` then never matches. Repair the bytes with `perl -i -pe`. (Hit twice.)

**DO NOT** put any rules in here unless it is unique to Claude Code. All other updates **MUST** go into either `AGENTS.md` or the relevant file in `docs/`.