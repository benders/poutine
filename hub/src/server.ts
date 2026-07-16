import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { APP_VERSION, FEDERATION_API_VERSION } from "./version.js";
import { createDatabase } from "./db/client.js";
import { shutdownMergeWorker } from "./library/merge-pipeline.js";
import { createPlayerDatabase, defaultPlayerDbPath } from "./db/player-db.js";
import {
  createPlayerSettings,
  type PlayerSettings,
} from "./services/player-settings.js";
import { authRoutes, hubAdminRoutes, playerAdminRoutes } from "./routes/admin.js";
import { subsonicRoutes } from "./routes/subsonic/index.js";
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
import { ensureRealPathPlayers } from "./services/navidrome-native.js";
import { SyncOperationService } from "./services/sync-operations.js";
import { StreamTrackingService } from "./services/stream-tracking.js";
import { PlayEventService } from "./services/play-events.js";
import { NowPlayingService } from "./services/now-playing.js";
import { LastFmClient } from "./services/lastfm.js";
import { FanartTvClient } from "./services/fanarttv.js";
import { SonosDiscoveryService } from "./services/sonos-discovery.js";
import { SonosControl } from "./services/sonos-control.js";
import { createSonosSettings } from "./services/sonos-settings.js";
import { deriveCastSecret } from "./services/cast-tokens.js";
import { sonosRoutes } from "./routes/sonos.js";
import { SubsonicClient } from "./adapters/subsonic.js";
import { SsdpAdvertiser } from "./services/ssdp-advertiser.js";
import { DlnaObjectService } from "./services/dlna-objects.js";
import { dlnaRoutes } from "./routes/dlna.js";
import { createHubSubsonicCaller } from "./services/hub-subsonic-caller.js";
import { createSpaBuildIdReader } from "./services/spa-build-id.js";
import { createHash, randomBytes } from "node:crypto";
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
    /**
     * Player-owned SQLite database (`player.db`). Hub code MUST NOT read or
     * write this — it is exposed only so Player BE modules (routes/dlna,
     * routes/cast, services/player-settings) can be wired via capability
     * injection. See issue #215 and `docs/system-architecture.md`.
     */
    playerDb: Database.Database;
    playerSettings: PlayerSettings;
    artCache: ArtCache;
  peerRegistry: PeerRegistry;
  privateKey: KeyObject;
  publicKeySpec: string;
  passwordKey: Buffer;
  federatedFetch: ReturnType<typeof FetcherFactory>;
  syncOpService: SyncOperationService;
  streamTracking: StreamTrackingService;
  playEvents: PlayEventService;
  nowPlaying: NowPlayingService;
  lastFmClient: LastFmClient | null;
  fanartTvClient: FanartTvClient | null;
  navidromeClient: SubsonicClient;
  /**
   * Random 32-byte secret minted at boot. Used only for in-process trusted
   * auth: requests carrying `x-poutine-internal: <secret>` + `x-poutine-as-
   * user: <username>` bypass password verification on the Subsonic auth
   * middleware. Never crosses the wire — `HubSubsonicCaller` (`asUser` mode)
   * is the only producer; both ends read this same decorator. See
   * `docs/authentication.md` and issue #224.
   */
  internalAuthSecret: string;
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

  // Player BE owns a separate SQLite file (`player.db`). Opened here so the
  // entry point holds the capability and hands each owner (Hub vs Player)
  // only the handle it needs. No ATTACH, no cross-joins. See issue #215.
  const playerDbPath =
    config.playerDatabasePath || defaultPlayerDbPath(config.databasePath);
  const playerDb = createPlayerDatabase(playerDbPath);
  const playerSettings = createPlayerSettings(playerDb);
  app.decorate("playerDb", playerDb);
  app.decorate("playerSettings", playerSettings);

  // Phase 3 (#217): copy any Player-owned rows that still live in
  // hub.db's `settings` table over to player.db. Idempotent — only
  // fills the gap, never overwrites. After this runs, player.db is the
  // source of truth for sonos/dlna runtime config.
  const migrated = playerSettings.migrateFromHubSettings(db);
  if (migrated.length > 0) {
    app.log.info(
      { keys: migrated },
      "Player settings migrated from hub.db into player.db (#217)",
    );
  }
  app.addHook("onClose", async () => {
    try {
      playerDb.close();
    } catch {
      // already closed — fine
    }
  });

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
  const playEvents = new PlayEventService(db);
  const streamTracking = new StreamTrackingService(db);
  app.decorate("syncOpService", syncOpService);
  app.decorate("playEvents", playEvents);
  app.decorate("streamTracking", streamTracking);
  app.decorate("nowPlaying", new NowPlayingService());

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
  //
  // Admin API namespaces (#220 / #226, Phase 6 of #212). Three prefixes,
  // each partitioned to the handlers that belong to its namespace:
  //
  //   /admin/*               — historical path; auth only. Kept because the
  //                            refresh-token cookie is bound to
  //                            `/admin/refresh` (so existing browser
  //                            sessions keep working across the upgrade).
  //   /api/admin/hub/*       — auth + Hub-owned admin (users, peers, sync,
  //                            cache, activity, activity-retention).
  //   /api/admin/player/*    — auth + Player-owned admin (Sonos / DLNA /
  //                            LAN URL settings).
  //
  // Cross-namespace requests (e.g. POST /api/admin/player/users) return
  // 404 — the handler isn't mounted there. This finishes the Hub/Player
  // boundary at the request level so a future deploy-split is a wiring
  // change, not a route audit (#226).
  await app.register(authRoutes, { prefix: "/admin" });
  await app.register(authRoutes, { prefix: "/api/admin/hub" });
  await app.register(hubAdminRoutes, { prefix: "/api/admin/hub" });
  await app.register(authRoutes, { prefix: "/api/admin/player" });
  await app.register(playerAdminRoutes, { prefix: "/api/admin/player" });
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
  // #217: backed by player.db via the PlayerSettings KV. env vars supply
  // first-boot seeds only — operator changes persist in player.db.
  const sonosSettings = createSonosSettings(playerSettings, {
    initialEnabled: config.sonosEnabled,
    initialLanUrl: config.initialLanUrl,
    initialDlnaEnabled: config.dlnaEnabled,
    initialDlnaFriendlyName: config.dlnaFriendlyName,
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
  // HMAC secret for cast tokens. Phase 1 of #212 persists this in player.db
  // (#215) so it survives federation-key rotations. The fallback derives
  // the previous value (HMAC over the Ed25519 private key) so existing
  // deployments keep the same secret across this upgrade — first boot
  // under the new code path migrates by writing the derived value into
  // player.db.
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const castSecret = playerSettings.getCastSecret(() => deriveCastSecret(privDer));
  app.decorate("castSecret", castSecret);

  // In-process Subsonic trusted-auth secret (#224). Random per-boot — the
  // value never crosses the wire and there are no cross-restart consumers
  // (HubSubsonicCaller reads it from the live app instance at call time).
  app.decorate("internalAuthSecret", randomBytes(32).toString("base64url"));

  // #220: Sonos play planner reads track metadata + preferred-source info
  // via the Hub Subsonic API over in-process loopback — no `SubsonicClient`
  // adapter import, no direct `app.db` access. See
  // `services/hub-subsonic-caller.ts` and `routes/sonos.ts`.
  app.decorate(
    "hubSubsonicSonos",
    createHubSubsonicCaller(app, { client: "poutine-sonos" }),
  );

  await app.register(sonosRoutes, { prefix: "/api/sonos" });
  // #218: /cast/stream was deleted. Sonos devices now fetch directly from
  // /rest/stream.view with an embedded cast token (see cast-tokens.ts).

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
  //
  // SSDP advertiser lifecycle (#209):
  // The advertiser bakes `locationUrl` at construction, so a runtime
  // `lan_url` change means tearing down the old advertiser and building a
  // fresh one. `rebuildSsdp` is called once at boot via the onReady hook,
  // and again from the sonosSettings.onChange listener whenever `lan_url`
  // flips. Empty URL → no advertiser (clients will see byebye on stop).
  let ssdpAdvertiser: SsdpAdvertiser | null = null;
  let ssdpStarted = false;
  let lastAdvertisedLanUrl = "";
  const rebuildSsdp = async () => {
    if (!config.dlnaEnabled || config.dlnaSkipSsdp) return;
    const lan = sonosSettings.getLanUrl();
    if (lan === lastAdvertisedLanUrl) return; // no-op when nothing changed
    if (ssdpAdvertiser) {
      const old = ssdpAdvertiser;
      ssdpAdvertiser = null;
      try {
        await old.stop();
      } catch (err) {
        app.log.warn({ err }, "DLNA: SSDP advertiser stop failed during rebuild");
      }
    }
    lastAdvertisedLanUrl = lan;
    if (!lan) {
      app.log.info("DLNA: lan_url cleared — SSDP advertiser stopped");
      return;
    }
    ssdpAdvertiser = new SsdpAdvertiser({
      uuid: app.dlnaUuid,
      locationUrl: `${lan}/dlna/device.xml`,
      serverString: `Node/${process.versions.node} UPnP/1.0 Poutine/${APP_VERSION}`,
      log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
    });
    // Only auto-start once we've already passed the initial onReady gate.
    // Boot-time creation defers .start() to the onReady hook below; runtime
    // rebuilds need to fire immediately.
    if (ssdpStarted) ssdpAdvertiser.start();
  };

  if (config.dlnaEnabled) {
    if (!sonosSettings.getLanUrl()) {
      app.log.error(
        "DLNA_ENABLED=true but the LAN URL setting is empty — clients cannot fetch the device description or streams. Set it from Admin → Sonos.",
      );
    }
    // Stable per-instance UUID for the DLNA UDN. Phase 1 of #212 persists
    // this in player.db so it survives across restarts AND across changes
    // to POUTINE_INSTANCE_ID (#215). The fallback preserves the historical
    // derivation (SHA1 of poutine/dlna/<instance-id>), so existing
    // deployments migrate transparently on first boot under the new code.
    const uuid = playerSettings.getDlnaUuid(() =>
      uuidFromInstanceId(config.poutineInstanceId || "poutine"),
    );
    app.decorate("dlnaUuid", uuid);

    // #219: DLNA ContentDirectory talks to the Hub Subsonic API over
    // in-process loopback (`app.inject`) — no direct DB access from the
    // DLNA service. Auth is the owner's u+p; the Subsonic `f=json` path is
    // the only one DLNA browses, and the owner is the only user guaranteed
    // to exist at boot. A future split-deploy swaps the caller for a real
    // loopback fetch without touching the service itself.
    // #220: the caller is the shared `HubSubsonicCaller` — same instance
    // used by sonos.ts so both Player-side consumers go through one HTTP-
    // shaped surface.
    const dlnaSubsonicCaller = createHubSubsonicCaller(app, {
      client: "poutine-dlna",
    });
    app.decorate("dlnaObjects", new DlnaObjectService(dlnaSubsonicCaller));

    await app.register(dlnaRoutes, { prefix: "/dlna" });

    await rebuildSsdp();
    app.log.info(
      `DLNA MediaServer enabled (friendly name: ${sonosSettings.getDlnaFriendlyName()})`,
    );
  }

  // Pick up runtime lan_url changes (#209): rebuild SSDP, log nothing else.
  // The Sonos enable listener is wired separately above; this one only
  // cares about lan_url. Run it async-fire-and-forget — the setter is
  // synchronous and we don't want admin PUTs blocked on a SOAP teardown.
  sonosSettings.onChange(() => {
    void rebuildSsdp();
  });

  // Capabilities probe used by the frontend to decide which UI affordances
  // to render (e.g. the device picker in PlayerBar). Sonos reads from the
  // live `sonos_enabled` setting (#184) so the picker hides/appears
  // immediately after an admin toggle without needing a full page reload.
  app.get("/api/capabilities", async () => ({
    sonos: sonosSettings.getEnabled(),
    dlna: config.dlnaEnabled,
    // #232: when false, the SPA hides the device picker for non-admin users
    // (the API also enforces the rule independently).
    sonosAllowNonAdmin: sonosSettings.getAllowNonAdmin(),
  }));

  // Version signal for SPA auto-update polling (issue #196). Deliberately
  // separate from /api/health, whose per-call Navidrome ping (1s timeout
  // budget) is too expensive for one poll per open tab. `buildId` hashes the
  // on-disk SPA index.html so a rebuild is detected even when APP_VERSION
  // didn't change and the hub wasn't restarted; "dev" without a staticDir.
  const readSpaBuildId = createSpaBuildIdReader(config.staticDir);
  app.get("/api/version", async () => ({
    appVersion: APP_VERSION,
    buildId: await readSpaBuildId(),
  }));

  // Player health probe (issue #216). The SPA hits this to decide whether
  // to render the /admin/player route. Today the Player code runs in-process
  // with the Hub so this is always 200; once Phase 5 (#220) lifts Player
  // into a separate plugin/process, an absent or 404 response will turn the
  // Player admin destination into a "not deployed on this host" placeholder.
  app.get("/player/health", async () => ({
    status: "ok",
    appVersion: APP_VERSION,
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
    // SPA admin destinations: bare /admin and /admin/, plus the two
    // post-#216 split destinations /admin/hub and /admin/player. Everything
    // else under /admin/ (login, refresh, users, peers, sync, cache,
    // activity, settings, …) is API. /rest/*, /api/*, /proxy/* are always
    // API.
    const SPA_ADMIN_PATHS = new Set(["/admin/", "/admin/hub", "/admin/player"]);
    app.setNotFoundHandler(async (req, reply) => {
      const urlPath = req.url.split("?")[0];
      const isApiRoute =
        (urlPath.startsWith("/admin/") && !SPA_ADMIN_PATHS.has(urlPath)) ||
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
    // Flip the gate so subsequent rebuilds (#209) auto-start their fresh
    // advertiser immediately instead of waiting on another onReady.
    ssdpStarted = true;
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    autoSync.stop();
    sonosDiscovery.stop();
    // Await so byebye packets actually leave the socket before close().
    if (ssdpAdvertiser) await ssdpAdvertiser.stop();
    process.off("SIGHUP", sighupHandler);
    // Terminate any in-flight merge worker (#242 Phase 3) before closing the
    // main connection — the worker holds its own handle to the same file.
    await shutdownMergeWorker();
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

    // Best-effort: provision reportRealPath on the poutine-proxy player record
    // at boot so peers' first sync against us gets real paths without waiting
    // for our own next local sync run. Fire-and-forget; ensureRealPathPlayers
    // swallows every failure. Lives in the isMain entrypoint (not buildApp) so
    // the test harness — which builds the app against no live Navidrome — never
    // makes this network call.
    //
    // Accepted window: a peer's very first sync against a freshly-reset
    // Navidrome can create poutine-proxy with reportRealPath=false and receive
    // virtual paths once, before this boot pass (or the next local sync's
    // provisioning pass) flips it. The next sync run self-corrects.
    void ensureRealPathPlayers({
      navidromeUrl: config.navidromeUrl,
      navidromeUsername: config.navidromeUsername,
      navidromePassword: config.navidromePassword,
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg) => app.log.warn(msg),
      },
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
