#!/usr/bin/env bash
# Dump the live Poutine database schema to docs/schema.sql.
#
# Any extra arguments are forwarded to `docker compose`, so you can target
# a specific project or compose file:
#
#   ./update-schema.sh                  # default compose project
#   ./update-schema.sh -p cd-rips       # local-cluster cd-rips instance
#   ./update-schema.sh -f my-compose.yml
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DB=$(mktemp /tmp/poutine-schema-XXXXXX.db)

cleanup() { rm -f "$TMP_DB"; }
trap cleanup EXIT

docker compose "$@" cp hub:/app/data/poutine.db "$TMP_DB"
sqlite3 "$TMP_DB" .schema > "$SCRIPT_DIR/docs/schema.sql"
echo "Schema written to docs/schema.sql"
