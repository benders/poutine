@AGENTS.md

## Claude Code

Everything else — task tracking, branching, commits, the PR flow, the verify gate — lives in `AGENTS.md`.

### Posting to GitHub

When posting comments, ALWAYS prefix comments with `FROM @claude:` and use blockquote style

### Tool gotchas

* **A `\uXXXX` escape in a tool argument is decoded before the tool sees it.** Every tool argument arrives as a JSON string, so documenting a C0 control character (U+0000–U+001F) — in a regex character class, say — puts the *real* control byte in the file instead of the six characters you meant. It is invisible in a terminal, and a later Edit `old_string` carrying the visible form then never matches. Double the backslash (`\\uXXXX`) to emit literal text. Not Write-specific: Write, Edit and Bash all decode, though Bash is rejected outright with "command contains control characters" — the cheap way to find out. Repair bytes already on disk with `perl -i -pe`: its regex matches raw bytes, which an Edit `old_string` cannot express. (Hit three times.)

**DO NOT** put any rules in here unless it is unique to Claude Code. All other updates **MUST** go into either `AGENTS.md` or the relevant file in `docs/`.
