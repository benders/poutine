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
import { federationRoutes } from "./routes/federation.js";
import { ArtCache } from "./services/art-cache.js";
import { loadOrCreatePrivateKey } from "./federation/signing.js";
import { loadPeerRegistry } from "./federation/peers.js";
import { createFederationFetcher } from "./federation/sign-request.js";
import { seedSyntheticInstances } from "./library/seed-instances.js";
import { setPassword } from "./auth/passwords.js";
import { ensureJwtSecret } from "./auth/jwt-secret.js";
import { loadOrCreatePasswordKey } from "./auth/password-crypto.js";
import { AutoSyncService } from "./services/auto-sync.js";
import { SyncOperationService } from "./services/sync-operations.js";
import { StreamTrackingService } from "./services/stream-tracking.js";
import { LastFmClient } from "./services/lastfm.js";
import { FanartTvClient } from "./services/fanarttv.js";
import { SonosDiscoveryService } from "./services/sonos-discovery.js";
import { SonosControl } from "./services/sonos-control.js";
import { createSonosSettings } from "./services/sonos-settings.js";
import { deriveCastSecret } from "./services/cast-tokens.js";
import { sonosRoutes } from "./routes/sonos.js";
import { castRoutes } from "./routes/cast.js";
import { SubsonicClient } from "./adapters/subsonic.js";
import { SsdpAdvertiser } from "./services/ssdp-advertiser.js";
import { DlnaObjectService } from "./services/dlna-objects.js";
import { dlnaRoutes } from "./routes/dlna.js";
import { createHash } from "node:crypto";
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
  passwordKey: Buffer;
  federatedFetch: ReturnType<typeof FetcherFactory>;
  syncOpService: SyncOperationService;
  streamTracking: StreamTrackingService;
  lastFmClient: LastFmClient | null;
  fanartTvClient: FanartTvClient | null;
  navidromeClient: SubsonicClient;
}
}

// Sonos / cast decorators are declared on FastifyInstance in their own
// route modules (services/cast-tokens.ts, routes/sonos.ts, routes/cast.ts)
// via `declare module "fastify"`.

/**
 * Seed the owner user on first boot.
 * If the users table is empty and POUTINE_OWNER_USERNAME / POUTINE_OWNER_PASSWORD
 * are configured, creates the owner with is_admin=1. Idempotent: no-op if any
 * user already exists.
 */
/**
 * Seed (or recover) the owner user.
 *
 * - First boot (users table effectively empty): inserts the owner row.
 * - Post-migration (owner row exists but password_enc is empty): re-sets
 *   the encrypted password from POUTINE_OWNER_PASSWORD. This is the
 *   recovery path for issue #106 — the Argon2id → AES-256-GCM migration
 *   wipes all stored passwords.
 */
function seedOwner(
  db: Database.Database,
  config: Config,
  passwordKey: Buffer,
): void {
  if (!config.poutineOwnerUsername || !config.poutineOwnerPassword) return;

  const existingByName = db
    .prepare("SELECT id, password_enc FROM users WHERE username = ?")
    .get(config.poutineOwnerUsername) as
    | { id: string; password_enc: string }
    | undefined;

  if (existingByName) {
    if (!existingByName.password_enc) {
      const enc = setPassword(config.poutineOwnerPassword, passwordKey);
      db.prepare(
        "UPDATE users SET password_enc = ?, is_admin = 1, updated_at = datetime('now') WHERE id = ?",
      ).run(enc, existingByName.id);
    }
    return;
  }

  // Treat a single __system__ placeholder as "no real users yet".
  const realUsers = db
    .prepare(
      "SELECT COUNT(*) as count FROM users WHERE username != '__system__'",
    )
    .get() as { count: number };
  if (realUsers.count > 0) return;

  const enc = setPassword(config.poutineOwnerPassword, passwordKey);
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
  ).run(id, config.poutineOwnerUsername, enc);
}

/**
 * Derive a stable UUID for the DLNA UDN from a string seed (typically
 * `POUTINE_INSTANCE_ID`). Deterministic across restarts so DLNA control
 * points (notably Windows Media Player) don't re-add the server.
 */
function uuidFromInstanceId(seed: string): string {
  const h = createHash("sha1").update(`poutine/dlna/${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
  if (!config.jwtSecret) {
    config.jwtSecret = ensureJwtSecret(db);
  }
  app.decorate("config", config);
  app.decorate("db", db);

  // Art cache — store cached images alongside the database
  const { dirname, join } = await import("node:path");
  const cacheDir = join(dirname(config.databasePath), "cache", "art");
  const artCache = new ArtCache(db, cacheDir);
  if (config.artCacheMaxBytes !== undefined && Number.isFinite(config.artCacheMaxBytes) && config.artCacheMaxBytes > 0) {
    artCache.setMaxBytes(config.artCacheMaxBytes);
    app.log.info(`Art cache cap set from ART_CACHE_MAX_BYTES env: ${config.artCacheMaxBytes} bytes`);
  }
  app.decorate("artCache", artCache);

  // Last.fm client — optional, only if API key is configured
  const lastFmClient = config.lastFmApiKey
    ? new LastFmClient(config.lastFmApiKey)
    : null;
  if (lastFmClient) {
    app.log.info("Last.fm integration enabled — artist images will be fetched from Last.fm");
  } else {
    app.log.info("Last.fm integration disabled — set LASTFM_API_KEY env var to enable");
  }
  app.decorate("lastFmClient", lastFmClient);

  // fanart.tv client — primary source for artist images when MBID is known,
  // and an album-cover fallback when an album has an MBID but no cover.
  // Always enabled; the bundled Poutine project key is used by default.
  const fanartTvClient = config.fanartTvProjectKey
    ? new FanartTvClient({
        projectKey: config.fanartTvProjectKey,
        personalKey: config.fanartTvPersonalKey,
        baseUrl: config.fanartTvBaseUrl,
        log: app.log,
      })
    : null;
  if (fanartTvClient) {
    const usingDefault =
      config.fanartTvProjectKey === "dd4c8d4d423b6bae65169cd5a6339d3f";
    app.log.info(
      `fanart.tv integration enabled — ${usingDefault ? "using bundled Poutine project key" : "using overridden project key"}${config.fanartTvPersonalKey ? " + personal client_key" : ""}`,
    );
  } else {
    app.log.info("fanart.tv integration disabled — no project key configured");
  }
  app.decorate("fanartTvClient", fanartTvClient);

  // Shared Subsonic client for the local Navidrome (admin creds). Used by
  // the `/api/health` probe; route handlers that need user-scoped Subsonic
  // calls construct their own per-request client.
  app.decorate(
    "navidromeClient",
    new SubsonicClient({
      url: config.navidromeUrl,
      username: config.navidromeUsername,
      password: config.navidromePassword,
    }),
  );

  // Password encryption key (AES-256-GCM, on disk beside the federation key)
  const passwordKey = loadOrCreatePasswordKey(config.poutinePasswordKeyPath);
  app.decorate("passwordKey", passwordKey);

  // Federation keys and peer registry
  const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(
    config.poutinePrivateKeyPath,
  );
  app.log.info(
    { publicKey: `ed25519:${publicKeyBase64}` },
    "Poutine instance public key — share with peers",
  );

  // Seed (or recover) owner user before the registry — the synthetic 'local'
  // instance row needs a user FK target, and seedSyntheticInstances runs next.
  seedOwner(db, config, passwordKey);

  // Seed only the synthetic 'local' instance row. Peers are admitted via the
  // signed-invitation flow (federation v5) and live in `instances` directly.
  seedSyntheticInstances(db, config);

  const peerRegistry = loadPeerRegistry(
    db,
    config.poutineInstanceId,
    `ed25519:${publicKeyBase64}`,
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

  // Auto-sync: polls Navidrome every 30s and syncs when a new scan has completed
  const syncOpService = new SyncOperationService(db);
  const streamTracking = new StreamTrackingService(db);
  app.decorate("syncOpService", syncOpService);
  app.decorate("streamTracking", streamTracking);

  // Load activity history retention from settings (issue #121)
  const activityRow = db
    .prepare("SELECT value FROM settings WHERE key = 'activity_history_max_events'")
    .get() as { value: string } | undefined;
  const activityMax = activityRow ? parseInt(activityRow.value, 10) : 10000;
  if (Number.isFinite(activityMax) && activityMax >= 0) {
    streamTracking.setMaxRows(activityMax);
    syncOpService.setMaxRows(activityMax);
  }

  // Clean up any sync rows left in 'running' state by a previous process crash
  // or by the pre-fix auto-sync that recorded no-op poll ticks.
  const orphanCount = syncOpService.failStaleRunning(600);
  if (orphanCount > 0) {
    app.log.info(`Marked ${orphanCount} orphaned sync_operations row(s) as failed at startup`);
  }

  const autoSync = new AutoSyncService(
    db,
    config,
    {
      info: (msg) => app.log.info(msg),
      error: (msg) => app.log.error(msg),
    },
    syncOpService,
    lastFmClient,
    fanartTvClient,
    {
      peerRegistry,
      federatedFetch: app.federatedFetch,
      // Owner username may be empty in tests; fall back to a stable label.
      asUser: config.poutineOwnerUsername || "auto-sync",
    },
  );

  // SIGHUP refreshes the peer registry snapshot from the `instances` table
  // (useful after manual DB edits; admin/handshake/gossip paths reload
  // automatically).
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
  await app.register(federationRoutes, { prefix: "/federation" });

  await app.register(proxyRoutes, {
    prefix: "/proxy",
    registry: peerRegistry,
  });

  // Sonos casting (issue #108, #184). Infra is built unconditionally so the
  // admin can flip the runtime `sonos_enabled` setting without a restart;
  // SSDP discovery only runs while enabled. Requires network_mode: host on
  // the docker compose side for multicast.
  const sonosSettings = createSonosSettings(db, {
    initialEnabled: config.sonosEnabled,
    initialLanUrl: config.initialLanUrl,
  });
  const sonosControl = new SonosControl();
  const sonosDiscovery = new SonosDiscoveryService({
    intervalMs: config.sonosDiscoveryIntervalMs,
    log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
    control: sonosControl,
  });
  app.decorate("sonosSettings", sonosSettings);
  app.decorate("sonosDiscovery", sonosDiscovery);
  app.decorate("sonosControl", sonosControl);
  // HMAC secret for cast tokens, derived from the federation key.
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  app.decorate("castSecret", deriveCastSecret(privDer));
  await app.register(sonosRoutes, { prefix: "/api/sonos" });
  await app.register(castRoutes, { prefix: "/cast" });

  if (sonosSettings.getEnabled() && !sonosSettings.getLanUrl()) {
    app.log.error(
      "Sonos is enabled but the LAN URL setting is empty — set it from Admin → Sonos before casting",
    );
  }
  app.log.info(
    `Sonos casting ${sonosSettings.getEnabled() ? "enabled" : "disabled"} (admin-toggleable, #184)`,
  );

  // Toggle handler: start/stop SSDP when the admin flips `sonos_enabled`.
  // On disable we also Stop every known device so a track in flight goes
  // quiet immediately — see #184 disable behavior decision.
  sonosSettings.onChange(({ enabled }) => {
    if (enabled) {
      sonosDiscovery.start();
      app.log.info("Sonos enabled at runtime — SSDP discovery started");
    } else {
      const known = sonosDiscovery.list();
      sonosDiscovery.stop();
      app.log.info(
        `Sonos disabled at runtime — SSDP stopped, stopping ${known.length} active device(s)`,
      );
      // Best-effort: each Stop is independent so don't let one failure
      // block the rest. Errors are logged but not surfaced — the admin
      // already saw the toggle succeed.
      for (const dev of known) {
        sonosControl
          .stop(dev)
          .catch((err) =>
            app.log.warn(
              { err, deviceId: dev.id },
              "Sonos: Stop on disable failed",
            ),
          );
      }
    }
  });

  // DLNA MediaServer (issue #175) — opt-in, requires network_mode: host
  // (same as Sonos) so SSDP multicast works.
  let ssdpAdvertiser: SsdpAdvertiser | null = null;
  if (config.dlnaEnabled) {
    const dlnaLanUrl = sonosSettings.getLanUrl();
    if (!dlnaLanUrl) {
      app.log.error(
        "DLNA_ENABLED=true but the LAN URL setting is empty — clients cannot fetch the device description or streams. Set it from Admin → Sonos.",
      );
    }
    // Stable per-instance UUID v5-ish — deterministic across restarts so
    // WMP doesn't re-add the server every boot.
    const uuid = uuidFromInstanceId(config.poutineInstanceId || "poutine");
    app.decorate("dlnaUuid", uuid);
    app.decorate("dlnaObjects", new DlnaObjectService(db));

    await app.register(dlnaRoutes, { prefix: "/dlna" });

    if (dlnaLanUrl) {
      ssdpAdvertiser = new SsdpAdvertiser({
        uuid,
        locationUrl: `${dlnaLanUrl}/dlna/device.xml`,
        serverString: `Node/${process.versions.node} UPnP/1.0 Poutine/${APP_VERSION}`,
        log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
      });
    }
    app.log.info(`DLNA MediaServer enabled (friendly name: ${config.dlnaFriendlyName})`);
  }

  // Capabilities probe used by the frontend to decide which UI affordances
  // to render (e.g. the device picker in PlayerBar). Sonos reads from the
  // live `sonos_enabled` setting (#184) so the picker hides/appears
  // immediately after an admin toggle without needing a full page reload.
  app.get("/api/capabilities", async () => ({
    sonos: sonosSettings.getEnabled(),
    dlna: config.dlnaEnabled,
  }));

  // Health check (issue #178). Always HTTP 200 so the federation handshake
  // can read peer versions even when Navidrome is briefly down; consumers
  // key on `body.status`. See docs/hub-internals.md route table.
  app.get("/api/health", async () => {
    let navidrome: "ok" | "unreachable" = "unreachable";
    try {
      // ~1s budget: Navidrome on the internal Docker network normally
      // responds in tens of ms. AbortSignal.timeout cancels the underlying
      // fetch so the request doesn't dangle past the response.
      await app.navidromeClient.ping({ signal: AbortSignal.timeout(1000) });
      navidrome = "ok";
    } catch (err) {
      app.log.warn({ err }, "Local Navidrome ping failed");
    }

    return {
      status: navidrome === "ok" ? "ok" : "degraded",
      appVersion: APP_VERSION,
      apiVersion: FEDERATION_API_VERSION,
      navidrome,
    };
  });

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
    if (sonosSettings.getEnabled()) sonosDiscovery.start();
    if (ssdpAdvertiser) ssdpAdvertiser.start();
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    autoSync.stop();
    sonosDiscovery.stop();
    // Await so byebye packets actually leave the socket before close().
    if (ssdpAdvertiser) await ssdpAdvertiser.stop();
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
