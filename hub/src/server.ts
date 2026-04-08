import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { instanceRoutes } from "./routes/instances.js";
import { libraryRoutes } from "./routes/library.js";
import { streamRoutes } from "./routes/stream.js";
import { queueRoutes } from "./routes/queue.js";
import { settingsRoutes } from "./routes/settings.js";
import { subsonicRoutes } from "./routes/subsonic.js";
import { federationRoutes } from "./routes/federation.js";
import { ArtCache } from "./services/art-cache.js";
import { loadOrCreatePrivateKey } from "./federation/signing.js";
import { loadPeerRegistry } from "./federation/peers.js";
import { createRequirePeerAuth } from "./federation/peer-auth.js";
import { createFederationFetcher } from "./federation/sign-request.js";
import { seedSyntheticInstances } from "./library/seed-instances.js";
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
    federatedFetch: ReturnType<typeof FetcherFactory>;
  }
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
  app.decorate(
    "federatedFetch",
    createFederationFetcher({
      privateKey,
      instanceId: peerRegistry.instanceId,
    }),
  );

  // Seed synthetic instance rows (local Navidrome + known peers) — idempotent
  seedSyntheticInstances(db, config, peerRegistry);

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
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(instanceRoutes, { prefix: "/api/instances" });
  await app.register(libraryRoutes, { prefix: "/api/library" });
  await app.register(streamRoutes, { prefix: "/api" });
  await app.register(queueRoutes, { prefix: "/api/queue" });
  await app.register(settingsRoutes, { prefix: "/api/settings" });
  await app.register(subsonicRoutes, { prefix: "/rest" });

  const requirePeerAuth = createRequirePeerAuth({ registry: peerRegistry });
  await app.register(federationRoutes, {
    prefix: "/federation",
    requirePeerAuth,
  });

  // Health check
  app.get("/api/health", async () => ({ status: "ok" }));

  // Cleanup on close
  app.addHook("onClose", () => {
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
