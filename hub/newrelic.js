'use strict';

// New Relic agent configuration.
// All settings can be overridden with NEW_RELIC_* environment variables.
// The agent is disabled when NEW_RELIC_LICENSE_KEY is not set — safe to ship
// in all environments without a key.

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'Poutine'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY || '',
  enabled: !!process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: 'info',
  },
  allow_all_headers: true,
  distributed_tracing: {
    enabled: true,
  },
  browser_monitoring: {
    // Disabled — injected manually into index.html at request time so the
    // SPA gets proper page-load timing tied to the server transaction.
    enable_auto_instrument: false,
  },
};
