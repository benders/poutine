#!/usr/bin/env bash
# Subsonic client compatibility harness — runs pytest via py-sonic against a
# live Poutine instance. Defaults target the dev instance on :3001.
#
# Override:
#   POUTINE_URL   (default http://localhost:3001)
#   POUTINE_USER  (default nic)
#   POUTINE_PASS  (default local)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV" ]; then
  echo "==> Creating venv"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r requirements.txt
fi

exec "$VENV/bin/pytest" -v "$@"
