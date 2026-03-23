import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  jwtSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  encryptionKey: string;
  syncIntervalMs: number;
  healthCheckIntervalMs: number;
  instanceTimeoutMs: number;
  instanceConcurrency: number;
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
    encryptionKey: process.env.ENCRYPTION_KEY || jwtSecret,
    syncIntervalMs: parseInt(
      process.env.SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000),
      10
    ),
    healthCheckIntervalMs: parseInt(
      process.env.HEALTH_CHECK_INTERVAL_MS || "60000",
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
  };
}
