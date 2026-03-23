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
import { ArtCache } from "./services/art-cache.js";
import type { Config } from "./config.js";
import type Database from "better-sqlite3";

// Extend Fastify instance type
declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database.Database;
    artCache: ArtCache;
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

  // Health check
  app.get("/api/health", async () => ({ status: "ok" }));

  // Cleanup on close
  app.addHook("onClose", () => {
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
