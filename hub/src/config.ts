export interface Config {
  port: number;
  host: string;
  databasePath: string;
  jwtSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  syncIntervalMs: number;
  instanceTimeoutMs: number;
  instanceConcurrency: number;
  // Phase 1: bundled Navidrome + peer federation config.
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
  poutineInstanceId: string;
  poutinePrivateKeyPath: string;
  poutinePasswordKeyPath: string;
  poutineOwnerUsername: string;
  poutineOwnerPassword: string;
  // Optional: path to a directory of static frontend files to serve.
  // When set, the hub serves the SPA at / in addition to all API routes.
  // Leave unset in dev — the Vite dev server handles the frontend instead.
  staticDir: string | undefined;
  // Optional: Last.fm API key for artist images and metadata
  lastFmApiKey: string | undefined;
  // fanart.tv: project API key (defaults to bundled Poutine key) + optional
  // personal client_key for faster image updates. Base URL is overridable for
  // tests.
  fanartTvProjectKey: string;
  fanartTvPersonalKey: string | undefined;
  fanartTvBaseUrl: string;
  // Optional: overrides the persisted art_cache_max_bytes setting on every
  // boot. Useful for test clusters where you want a tiny cap regardless of
  // what's stored in the DB.
  artCacheMaxBytes: number | undefined;
  // Sonos casting (issue #108). Opt-in. Requires network_mode: host so SSDP
  // multicast works. POUTINE_LAN_URL is the absolute base URL that Sonos
  // devices use to fetch streams — must be reachable from the LAN.
  sonosEnabled: boolean;
  poutineLanUrl: string | undefined;
  sonosDiscoveryIntervalMs: number;
  // DLNA MediaServer (issue #175). Off by default. Shares POUTINE_LAN_URL
  // with Sonos casting and requires the same host networking override.
  // Stream endpoint is open on the LAN — gate by network reachability, not
  // by user identity (DLNA has no notion of one).
  dlnaEnabled: boolean;
  dlnaFriendlyName: string;
  /** Username streams get attributed to. Defaults to the owner. */
  dlnaPseudoUser: string | undefined;
}

function requireInProd(name: string, value: string | undefined): string {
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`${name} environment variable is required in production`);
  }
  return value || "";
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
    databasePath: process.env.DATABASE_PATH || "./data/poutine.db",
    jwtSecret: "",
    jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    syncIntervalMs: parseInt(
      process.env.SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000),
      10
    ),
    instanceTimeoutMs: parseInt(
      process.env.INSTANCE_TIMEOUT_MS || "10000",
      10
    ),
    instanceConcurrency: parseInt(
      process.env.INSTANCE_CONCURRENCY || "3",
      10
    ),
    navidromeUrl: process.env.NAVIDROME_URL || "http://navidrome:4533",
    navidromeUsername: requireInProd(
      "NAVIDROME_USERNAME",
      process.env.NAVIDROME_USERNAME
    ),
    navidromePassword: requireInProd(
      "NAVIDROME_PASSWORD",
      process.env.NAVIDROME_PASSWORD
    ),
    poutineInstanceId: requireInProd(
      "POUTINE_INSTANCE_ID",
      process.env.POUTINE_INSTANCE_ID
    ),
    poutinePrivateKeyPath:
      process.env.POUTINE_PRIVATE_KEY_PATH || "./data/poutine_ed25519.pem",
    poutinePasswordKeyPath:
      process.env.POUTINE_PASSWORD_KEY_PATH || "./data/poutine_password_key",
    poutineOwnerUsername: requireInProd(
      "POUTINE_OWNER_USERNAME",
      process.env.POUTINE_OWNER_USERNAME
    ),
    poutineOwnerPassword: requireInProd(
      "POUTINE_OWNER_PASSWORD",
      process.env.POUTINE_OWNER_PASSWORD
    ),
    staticDir: process.env.PUBLIC_DIR || undefined,
    lastFmApiKey: process.env.LASTFM_API_KEY || undefined,
    fanartTvProjectKey:
      process.env.FANARTTV_API_KEY || "dd4c8d4d423b6bae65169cd5a6339d3f",
    fanartTvPersonalKey: process.env.FANARTTV_CLIENT_KEY || undefined,
    fanartTvBaseUrl:
      process.env.FANARTTV_API_URL || "https://webservice.fanart.tv/v3.2",
    artCacheMaxBytes: process.env.ART_CACHE_MAX_BYTES
      ? parseInt(process.env.ART_CACHE_MAX_BYTES, 10)
      : undefined,
    sonosEnabled: process.env.SONOS_ENABLED === "true",
    poutineLanUrl: process.env.POUTINE_LAN_URL || undefined,
    sonosDiscoveryIntervalMs: parseInt(
      process.env.SONOS_DISCOVERY_INTERVAL_MS || "30000",
      10,
    ),
    dlnaEnabled: process.env.DLNA_ENABLED === "true",
    dlnaFriendlyName: process.env.DLNA_FRIENDLY_NAME || "Poutine",
    dlnaPseudoUser: process.env.DLNA_PSEUDO_USER || undefined,
  };
}
