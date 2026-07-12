#!/usr/bin/env bash
# db-query.sh — Run a SQL query against the Poutine hub SQLite database.
#
# Usage:
#   ./db-query.sh [COMPOSE_OPTS --] SQL
#   echo "SQL" | ./db-query.sh [COMPOSE_OPTS --]
#
# All arguments before "--" are forwarded to `docker compose` (e.g. -f, --env-file,
# --project-name). Everything after "--" (or the sole argument when no "--" is present)
# is the SQL query. SQL may also be supplied via stdin.
#
# Examples:
#   ./db-query.sh "SELECT * FROM users LIMIT 5"
#   ./db-query.sh -f local-cluster/hub.yml -- "SELECT COUNT(*) FROM instance_albums"
#   ./db-query.sh --project-name poutine-test -- "SELECT * FROM unified_artists LIMIT 3"
#   echo "SELECT id, title FROM instance_albums WHERE title LIKE '%jazz%'" | ./db-query.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Parse: split on "--" into COMPOSE_OPTS and SQL
# ---------------------------------------------------------------------------
COMPOSE_OPTS=()
SQL_ARGS=()
found_sep=0
for arg in "$@"; do
  if [[ "$found_sep" -eq 1 ]]; then
    SQL_ARGS+=("$arg")
  elif [[ "$arg" == "--" ]]; then
    found_sep=1
  else
    COMPOSE_OPTS+=("$arg")
  fi
done

# If no "--" was used, everything is SQL (no compose overrides)
if [[ "$found_sep" -eq 0 ]]; then
  SQL_ARGS=("${COMPOSE_OPTS[@]+"${COMPOSE_OPTS[@]}"}")
  COMPOSE_OPTS=()
fi

# Resolve SQL: join SQL_ARGS, or fall back to stdin
if [[ "${#SQL_ARGS[@]}" -gt 0 ]]; then
  SQL="${SQL_ARGS[*]}"
elif [[ ! -t 0 ]]; then
  SQL="$(cat)"
else
  echo "Usage: $0 [COMPOSE_OPTS --] SQL" >&2
  echo "  or:  echo SQL | $0 [COMPOSE_OPTS --]" >&2
  exit 1
fi

if [[ -z "${SQL// }" ]]; then
  echo "ERROR: SQL query is empty." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify hub container is running
# ---------------------------------------------------------------------------
if ! docker compose ${COMPOSE_OPTS[@]+"${COMPOSE_OPTS[@]}"} ps --format '{{.Service}}' 2>/dev/null | grep -q '^hub$'; then
  echo "ERROR: hub container is not running." >&2
  echo "       Start it with: docker compose ${COMPOSE_OPTS[*]+"${COMPOSE_OPTS[*]}"} up -d hub" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run query inside the hub container via Node + better-sqlite3
# ---------------------------------------------------------------------------
docker compose ${COMPOSE_OPTS[@]+"${COMPOSE_OPTS[@]}"} exec -T hub node -e "
const { execSync } = require('child_process');
const bsqDir = execSync(
  'find /app/node_modules/.pnpm -maxdepth 3 -name better-sqlite3 -type d 2>/dev/null | head -1'
).toString().trim();
if (!bsqDir) { console.error('ERROR: better-sqlite3 not found in container'); process.exit(1); }
const Database = require(bsqDir);
const db = new Database('/app/data/poutine.db', { readonly: true });
const sql = process.argv[1];
let stmt;
try {
  stmt = db.prepare(sql);
} catch (e) {
  console.error('SQL error:', e.message);
  process.exit(1);
}
const rows = stmt.all();
if (rows.length === 0) {
  console.log('(no rows)');
} else if (typeof rows[0] !== 'object') {
  rows.forEach(r => console.log(r));
} else {
  console.table(rows);
}
" -- "$SQL"
