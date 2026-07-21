#!/bin/sh
# Hub container entrypoint. Boots the hub, optionally under the New Relic
# Node APM agent (issue #3).
#
# The agent activates only when NEW_RELIC_LICENSE_KEY is set (operator's
# .env — the key must never be committed). Without the key this is a plain
# `node hub/dist/server.js`, zero agent overhead.
#
# The hub is an ESM app, so the agent needs both the ESM loader hook and the
# CJS preload (per the newrelic README, "ES Modules" section).
set -e

if [ -n "${NEW_RELIC_LICENSE_KEY:-}" ]; then
  # Default app name: poutine-hub-<instance id>, so federated hubs reporting
  # to one New Relic account show up as separate APM entities.
  if [ -z "${NEW_RELIC_APP_NAME:-}" ]; then
    NEW_RELIC_APP_NAME="poutine-hub${POUTINE_INSTANCE_ID:+-$POUTINE_INSTANCE_ID}"
  fi
  export NEW_RELIC_APP_NAME
  # Configure entirely from env vars; no newrelic.cjs in the image.
  export NEW_RELIC_NO_CONFIG_FILE="${NEW_RELIC_NO_CONFIG_FILE:-true}"
  # Agent's own log goes to stdout with the app's pino stream — no log file
  # accumulating inside the container.
  export NEW_RELIC_LOG="${NEW_RELIC_LOG:-stdout}"
  # Path-based specifiers: newrelic lives in hub/node_modules (pnpm workspace
  # layout), and both flags resolve bare names from the cwd (/app), where no
  # node_modules/newrelic exists. cwd must stay /app — default data paths
  # (e.g. POUTINE_PASSWORD_KEY_PATH) resolve relative to it.
  exec node --import ./hub/node_modules/newrelic/esm-loader.mjs \
    -r ./hub/node_modules/newrelic hub/dist/server.js
fi

exec node hub/dist/server.js
