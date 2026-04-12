#!/usr/bin/env bash
# reset-password.sh — Reset a Poutine hub user's password directly in SQLite.
# Usage: ./reset-password.sh <container> <username>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <container> <username>" >&2
  exit 1
fi
CONTAINER="$1"
USERNAME="$2"

# ---------------------------------------------------------------------------
# Verify container is running
# ---------------------------------------------------------------------------
if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "ERROR: Container '$CONTAINER' is not running." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Read password interactively
# ---------------------------------------------------------------------------
read -r -s -p "New password for '$USERNAME': " PASSWORD
echo
if [[ -z "$PASSWORD" ]]; then
  echo "ERROR: Password cannot be empty." >&2
  exit 1
fi
read -r -s -p "Confirm password: " PASSWORD2
echo
if [[ "$PASSWORD" != "$PASSWORD2" ]]; then
  echo "ERROR: Passwords do not match." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Hash + update inside the container
# ---------------------------------------------------------------------------
RESULT=$(docker exec "$CONTAINER" node -e "
const { hashPassword } = require('/app/hub/dist/auth/passwords.js');
const { execSync } = require('child_process');
const bsqDir = execSync(
  'find /app/node_modules/.pnpm -maxdepth 3 -name better-sqlite3 -type d 2>/dev/null | head -1'
).toString().trim();
if (!bsqDir) { console.log('NO_BSQ'); process.exit(0); }
const bsq = require(bsqDir);
const db  = new bsq('/app/data/poutine.db');

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  console.log('NO_USERS');
  process.exit(0);
}

const user = db.prepare('SELECT id FROM users WHERE username = ?').get(process.argv[1]);
if (!user) {
  console.log('NOT_FOUND');
  process.exit(0);
}

hashPassword(process.argv[2]).then(hash => {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?').run(hash, process.argv[1]);
  console.log('OK');
});
" -- "$USERNAME" "$PASSWORD")

case "$RESULT" in
  OK)
    echo "Password updated for '$USERNAME'."
    ;;
  NO_USERS)
    echo "ERROR: No users exist in the database. The hub has not been seeded yet." >&2
    echo "       Set POUTINE_OWNER_USERNAME / POUTINE_OWNER_PASSWORD in .env and restart the hub." >&2
    exit 2
    ;;
  NOT_FOUND)
    echo "ERROR: User '$USERNAME' not found." >&2
    exit 3
    ;;
  *)
    echo "ERROR: Unexpected output from container:" >&2
    echo "$RESULT" >&2
    exit 1
    ;;
esac
