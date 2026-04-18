import { randomBytes } from "node:crypto";

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
  poutinePeersConfig: string;
  poutineOwnerUsername: string;
  poutineOwnerPassword: string;
  // Optional: path to a directory of static frontend files to serve.
  // When set, the hub serves the SPA at / in addition to all API routes.
  // Leave unset in dev — the Vite dev server handles the frontend instead.
  staticDir: string | undefined;
  // Optional: Last.fm API key for artist images and metadata
  lastFmApiKey: string | undefined;
}

function requireInProd(name: string, value: string | undefined): string {
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`${name} environment variable is required in production`);
  }
  return value || "";
}

export function loadConfig(): Config {
  const jwtSecret =
    process.env.JWT_SECRET || randomBytes(32).toString("hex");

  if (!process.env.JWT_SECRET && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }

  return {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
    databasePath: process.env.DATABASE_PATH || "./data/poutine.db",
    jwtSecret,
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
    poutinePeersConfig:
      process.env.POUTINE_PEERS_CONFIG || "./config/peers.yaml",
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
  };
}
