import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { APP_VERSION, FEDERATION_API_VERSION } from "./version.js";
import { createDatabase } from "./db/client.js";
import { adminRoutes } from "./routes/admin.js";
import { subsonicRoutes } from "./routes/subsonic.js";
import { proxyRoutes } from "./routes/proxy.js";
import { ArtCache } from "./services/art-cache.js";
import { loadOrCreatePrivateKey } from "./federation/signing.js";
import { loadPeerRegistry } from "./federation/peers.js";
import { createFederationFetcher } from "./federation/sign-request.js";
import { seedSyntheticInstances } from "./library/seed-instances.js";
import { hashPassword } from "./auth/passwords.js";
import { AutoSyncService } from "./services/auto-sync.js";
import { SyncOperationService } from "./services/sync-operations.js";
import { StreamTrackingService } from "./services/stream-tracking.js";
import type { Config } from "./config.js";
import type Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";
import type { PeerRegistry } from "./federation/peers.js";
import type { createFederationFetcher as FetcherFactory } from "./federation/sign-request.js";

// Extend Fastify instance type
declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database.Database;
    artCache: ArtCache;
  peerRegistry: PeerRegistry;
  privateKey: KeyObject;
  publicKeySpec: string;
  federatedFetch: ReturnType<typeof FetcherFactory>;
  syncOpService: SyncOperationService;
  streamTracking: StreamTrackingService;
}
}

/**
 * Seed the owner user on first boot.
 * If the users table is empty and POUTINE_OWNER_USERNAME / POUTINE_OWNER_PASSWORD
 * are configured, creates the owner with is_admin=1. Idempotent: no-op if any
 * user already exists.
 */
async function seedOwner(
  db: Database.Database,
  config: Config,
): Promise<void> {
  if (!config.poutineOwnerUsername || !config.poutineOwnerPassword) return;

  const existing = db
    .prepare("SELECT COUNT(*) as count FROM users")
    .get() as { count: number };
  if (existing.count > 0) return;

  const passwordHash = await hashPassword(config.poutineOwnerPassword);
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)",
  ).run(id, config.poutineOwnerUsername, passwordHash);
}

export async function buildApp(configOverrides?: Partial<Config>) {
  const config = { ...loadConfig(), ...configOverrides };

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // Decorate with config and db
  const db = createDatabase(config.databasePath);
  app.decorate("config", config);
  app.decorate("db", db);

  // Art cache — store cached images alongside the database
  const { dirname, join } = await import("node:path");
  const cacheDir = join(dirname(config.databasePath), "cache", "art");
  const artCache = new ArtCache(db, cacheDir);
  app.decorate("artCache", artCache);

  // Federation keys and peer registry
  const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(
    config.poutinePrivateKeyPath,
  );
  app.log.info(
    { publicKey: `ed25519:${publicKeyBase64}` },
    "Poutine instance public key — share with peers",
  );

  const peerRegistry = loadPeerRegistry(
    config.poutinePeersConfig,
    config.poutineInstanceId,
  );
  app.log.info(
    { instanceId: peerRegistry.instanceId, peerCount: peerRegistry.peers.size },
    "Loaded peer registry",
  );

  app.decorate("peerRegistry", peerRegistry);
  app.decorate("privateKey", privateKey);
  app.decorate("publicKeySpec", `ed25519:${publicKeyBase64}`);
  app.decorate(
    "federatedFetch",
    createFederationFetcher({
      privateKey,
      instanceId: peerRegistry.instanceId,
    }),
  );

  // Seed owner user on first boot if configured
  await seedOwner(db, config);

  // Seed synthetic instance rows (local Navidrome + known peers) — idempotent
  seedSyntheticInstances(db, config, peerRegistry);

  // Auto-sync: polls Navidrome every 30s and syncs when a new scan has completed
  const syncOpService = new SyncOperationService(db);
  const streamTracking = new StreamTrackingService(db);
  app.decorate("syncOpService", syncOpService);
  app.decorate("streamTracking", streamTracking);

  const autoSync = new AutoSyncService(db, config, {
    info: (msg) => app.log.info(msg),
    error: (msg) => app.log.error(msg),
  }, syncOpService);

  // SIGHUP handler to reload peer registry without restart
  const sighupHandler = () => {
    peerRegistry.reload();
    app.log.info(
      { peerCount: peerRegistry.peers.size },
      "Peer registry reloaded via SIGHUP",
    );
  };
  process.on("SIGHUP", sighupHandler);

  // Plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie);

  // Routes
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(subsonicRoutes, { prefix: "/rest" });

  await app.register(proxyRoutes, {
    prefix: "/proxy",
    registry: peerRegistry,
  });

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    appVersion: APP_VERSION,
    apiVersion: FEDERATION_API_VERSION,
  }));

  // Static file serving + SPA fallback (production only; skipped in dev)
  if (config.staticDir) {
    const { resolve } = await import("node:path");
    const root = resolve(config.staticDir);
    await app.register(fastifyStatic, { root, wildcard: false });

    // SPA fallback: serve index.html for any unmatched non-API route.
    // /admin and /admin/ are SPA routes (the React admin page); only sub-paths
    // like /admin/login are API. /rest/*, /api/*, /proxy/* are always API.
    app.setNotFoundHandler(async (req, reply) => {
      const urlPath = req.url.split("?")[0];
      const isApiRoute =
        (urlPath.startsWith("/admin/") && urlPath !== "/admin/") ||
        urlPath.startsWith("/rest") ||
        urlPath.startsWith("/api") ||
        urlPath.startsWith("/proxy");
      if (isApiRoute) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  // Start auto-sync after routes are registered
  app.addHook("onReady", () => {
    autoSync.start();
  });

  // Cleanup on close
  app.addHook("onClose", () => {
    autoSync.stop();
    process.off("SIGHUP", sighupHandler);
    db.close();
  });

  return app;
}

// Start server if run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (isMain) {
  const app = await buildApp();
  const config = app.config;

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Poutine Hub listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
