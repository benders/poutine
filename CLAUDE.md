@AGENTS.md

## Claude Code

### Posting to GitHub

When posting comments, ALWAYS prefix comments with `FROM @claude:` and use blockquote style

### Workflow

Default flow should be to use Pull Requests.

* Create a feature branch before starting work
* Work in phases
* Check documentation and tests after implementation to make sure they cover new behavior
* Commit when tests pass and push branch to origin
* Create a PR when it is ready for the user to review it. PR should be created in "Draft" state
* DO NOT create "stacked" PRs. If new work is identified during review, it must be made directly onto the same feature branch

At user's explicit direction, minor changes can be made directly to `main` branch
* Never automatically commit when working on `main`

**DO NOT** put any rules in here unless it is unique to Claude Code. All other updates **MUST** go into either `AGENTS.md` or the relevant file in `docs/`.