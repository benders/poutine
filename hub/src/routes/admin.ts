import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword, setPassword, getStoredPassword } from "../auth/passwords.js";
import { createAccessToken, createRefreshToken, verifyRefreshToken, verifyToken } from "../auth/jwt.js";
import { syncAll } from "../library/sync.js";
import { SyncOperationService } from "../services/sync-operations.js";
import { StreamTrackingService } from "../services/stream-tracking.js";
import { mergeLibraries } from "../library/merge.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { APP_VERSION, FEDERATION_API_VERSION, USER_AGENT } from "../version.js";

declare module "fastify" {
  interface FastifyRequest {
    adminUsername: string;
    userId: string;
    isAdmin: boolean;
  }
}

async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { config, db } = request.server;

  let token: string | undefined;
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  if (!token && request.cookies?.access_token) token = request.cookies.access_token;

  if (!token) {
    return void reply.code(401).send({ error: "Authentication required" });
  }

  try {
    const { userId } = await verifyToken(token, config);
    const user = db
      .prepare("SELECT id, username, is_admin FROM users WHERE id = ?")
      .get(userId) as
      | { id: string; username: string; is_admin: number }
      | undefined;

    if (!user) return void reply.code(401).send({ error: "User not found" });
    if (user.is_admin !== 1)
      return void reply.code(403).send({ error: "Admin access required" });

    request.userId = user.id;
    request.isAdmin = true;
    request.adminUsername = user.username;
  } catch {
    return void reply.code(401).send({ error: "Invalid or expired token" });
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // POST /admin/login
  app.post<{ Body: { username?: string; password?: string } }>(
    "/login",
    async (request, reply) => {
      const { username, password } = request.body ?? {};
      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password required" });
      }

      const user = app.db
        .prepare(
          "SELECT id, username, password_enc, is_admin FROM users WHERE username = ?",
        )
        .get(username) as
        | { id: string; username: string; password_enc: string; is_admin: number }
        | undefined;

      if (!user) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const valid = verifyPassword(user.password_enc, password, app.passwordKey);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      if (user.is_admin !== 1) {
        return reply.code(403).send({ error: "Admin access required" });
      }

      const accessToken = await createAccessToken(user.id, app.config);
      const refreshToken = await createRefreshToken(user.id, app.config);

      reply.setCookie("access_token", accessToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 15 * 60,
      });
      reply.setCookie("refresh_token", refreshToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/admin/refresh",
        maxAge: 7 * 24 * 60 * 60,
      });

      // Return the plaintext password to the SPA so it can authenticate
      // /rest/* via Subsonic u+t+s. The SPA stashes these in localStorage
      // (same threat surface as the JWT). See docs/authentication.md.
      const plaintext = getStoredPassword(user.password_enc, app.passwordKey);
      return {
        user: { id: user.id, username: user.username, isAdmin: true },
        accessToken,
        subsonicCredentials: plaintext
          ? { username: user.username, password: plaintext }
          : null,
      };
    },
  );

  // POST /admin/refresh
  app.post("/refresh", async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token;
    if (!refreshToken) {
      return reply.code(401).send({ error: "No refresh token" });
    }
    try {
      const { userId } = await verifyRefreshToken(refreshToken, app.config);
      const user = app.db
        .prepare("SELECT id, is_admin FROM users WHERE id = ?")
        .get(userId) as { id: string; is_admin: number } | undefined;
      if (!user || user.is_admin !== 1) {
        return reply.code(401).send({ error: "User not found" });
      }
      const accessToken = await createAccessToken(userId, app.config);
      const newRefreshToken = await createRefreshToken(userId, app.config);
      reply.setCookie("access_token", accessToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 15 * 60,
      });
      reply.setCookie("refresh_token", newRefreshToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/admin/refresh",
        maxAge: 7 * 24 * 60 * 60,
      });
      return { accessToken };
    } catch {
      reply.clearCookie("refresh_token", { path: "/admin/refresh" });
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }
  });

  // POST /admin/logout
  app.post("/logout", async (_request, reply) => {
    reply.clearCookie("access_token", { path: "/" });
    reply.clearCookie("refresh_token", { path: "/admin/refresh" });
    return reply.code(204).send();
  });

  // GET /admin/me
  app.get("/me", { preHandler: requireOwner }, async (request) => {
    const user = app.db
      .prepare(
        "SELECT id, username, is_admin, created_at FROM users WHERE id = ?",
      )
      .get(request.userId) as {
      id: string;
      username: string;
      is_admin: number;
      created_at: string;
    };
    return {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      createdAt: user.created_at,
    };
  });

  // GET /admin/users
  app.get("/users", { preHandler: requireOwner }, async () => {
    const users = app.db
      .prepare(
        "SELECT id, username, is_admin, created_at FROM users WHERE username != '__system__' ORDER BY created_at ASC",
      )
      .all() as Array<{
      id: string;
      username: string;
      is_admin: number;
      created_at: string;
    }>;
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: u.is_admin === 1,
      createdAt: u.created_at,
    }));
  });

  // POST /admin/users — create a guest user
  app.post<{ Body: { username?: string; password?: string } }>(
    "/users",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { username, password } = request.body ?? {};
      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password required" });
      }
      if (password.length < 8) {
        return reply
          .code(400)
          .send({ error: "Password must be at least 8 characters" });
      }

      const existing = app.db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (existing) {
        return reply.code(409).send({ error: "Username already taken" });
      }

      const enc = setPassword(password, app.passwordKey);
      const id = crypto.randomUUID();
      app.db
        .prepare(
          "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
        )
        .run(id, username, enc);

      return reply.code(201).send({ id, username, isAdmin: false });
    },
  );

  // DELETE /admin/users/:id
  app.delete<{ Params: { id: string } }>(
    "/users/:id",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { id } = request.params;
      if (id === request.userId) {
        return reply.code(400).send({ error: "Cannot delete your own account" });
      }

      const user = app.db
        .prepare("SELECT id, is_admin FROM users WHERE id = ?")
        .get(id) as { id: string; is_admin: number } | undefined;
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }
      if (user.is_admin === 1) {
        return reply.code(400).send({ error: "Cannot delete admin users" });
      }

      app.db.prepare("DELETE FROM users WHERE id = ?").run(id);
      return reply.code(204).send();
    },
  );

  // GET /admin/instance — returns identity and local Navidrome status
  app.get("/instance", { preHandler: requireOwner }, async () => {
    const local = app.db
      .prepare(`SELECT status, track_count, last_sync_ok, last_sync_message,
          strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_at) as last_synced_at,
          strftime('%Y-%m-%dT%H:%M:%SZ', last_seen) as last_seen
        FROM instances WHERE id = 'local'`)
      .get() as { status: string; track_count: number; last_synced_at: string | null; last_seen: string | null; last_sync_ok: number | null; last_sync_message: string | null } | undefined;

    const naviClient = new SubsonicClient({
      url: app.config.navidromeUrl,
      username: app.config.navidromeUsername,
      password: app.config.navidromePassword,
    });

    let scanStatus: { scanning: boolean; count: number; folderCount: number; lastScan: string | null } | null = null;
    try {
      scanStatus = await naviClient.getScanStatus();
    } catch {
      // Navidrome unreachable — leave as null
    }

    const localStats = app.db
      .prepare<[], { track_count: number; artist_count: number; album_count: number }>(`
        SELECT
          COUNT(DISTINCT ts.unified_track_id) AS track_count,
          COUNT(DISTINCT ut.artist_id)        AS artist_count,
          COUNT(DISTINCT ut.release_id)       AS album_count
        FROM track_sources ts
        JOIN unified_tracks ut ON ts.unified_track_id = ut.id
        WHERE ts.instance_id = 'local'
      `)
      .get() ?? { track_count: 0, artist_count: 0, album_count: 0 };

    return {
      instanceId: app.config.poutineInstanceId,
      publicKey: app.publicKeySpec,
      appVersion: APP_VERSION,
      apiVersion: FEDERATION_API_VERSION,
      artistCount: localStats.artist_count,
      albumCount: localStats.album_count,
      trackCount: localStats.track_count,
      navidrome: {
        reachable: scanStatus !== null,
        scanning: scanStatus?.scanning ?? false,
        folderCount: scanStatus?.folderCount ?? null,
        lastScan: scanStatus?.lastScan ?? null,
        status: local?.status ?? "unknown",
        trackCount: local?.track_count ?? 0,
        lastSynced: local?.last_synced_at ?? null,
        lastSeen: local?.last_seen ?? null,
        lastSyncOk: local?.last_sync_ok != null ? local.last_sync_ok === 1 : null,
        lastSyncMessage: local?.last_sync_message ?? null,
      },
    };
  });

  // POST /admin/instance/scan — trigger a Navidrome library scan
  app.post("/instance/scan", { preHandler: requireOwner }, async (request, reply) => {
    const naviClient = new SubsonicClient({
      url: app.config.navidromeUrl,
      username: app.config.navidromeUsername,
      password: app.config.navidromePassword,
    });

    try {
      const status = await naviClient.startScan();
      return { scanning: status.scanning, count: status.count, folderCount: status.folderCount, lastScan: status.lastScan };
    } catch (err) {
      return reply.code(502).send({ error: `Navidrome unreachable: ${String(err)}` });
    }
  });

  // GET /admin/peers/summary — lightweight list for non-admin UI (sidebar).
  // Skips the per-peer health fetch; returns just enough to render nav entries.
  app.get("/peers/summary", { preHandler: requireOwner }, async () => {
    const peers = Array.from(app.peerRegistry.peers.values());
    const albumCountStmt = app.db.prepare<[string], { album_count: number }>(`
      SELECT COUNT(DISTINCT urs.unified_release_id) AS album_count
      FROM unified_release_sources urs
      WHERE urs.instance_id = ?
    `);
    const nameStmt = app.db.prepare<[string], { name: string; status: string }>(
      "SELECT name, status FROM instances WHERE id = ?",
    );
    return peers.map((peer) => {
      const inst = nameStmt.get(peer.id);
      const stats = albumCountStmt.get(peer.id) ?? { album_count: 0 };
      return {
        id: peer.id,
        name: inst?.name ?? peer.id,
        status: inst?.status ?? "offline",
        albumCount: stats.album_count,
      };
    });
  });

  // GET /admin/peers
  app.get("/peers", { preHandler: requireOwner }, async () => {
    const peers = Array.from(app.peerRegistry.peers.values());

    interface HealthPayload {
      appVersion?: string;
      apiVersion?: number;
    }

    const healthChecks = await Promise.allSettled(
      peers.map(async (peer) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(`${peer.url}/api/health`, { signal: controller.signal, headers: { "user-agent": USER_AGENT } });
          if (!res.ok) return null;
          const health = (await res.json()) as HealthPayload;
          // Update last_seen on successful health check
          app.db
            .prepare(
              "UPDATE instances SET last_seen = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            )
            .run(peer.id);
          return health;
        } catch {
          return null;
        } finally {
          clearTimeout(timeout);
        }
      }),
    );

    const peerStatsStmt = app.db.prepare<[string], { track_count: number; artist_count: number; album_count: number }>(`
      SELECT
        COUNT(DISTINCT ts.unified_track_id) AS track_count,
        COUNT(DISTINCT ut.artist_id)        AS artist_count,
        COUNT(DISTINCT ut.release_id)       AS album_count
      FROM track_sources ts
      JOIN unified_tracks ut ON ts.unified_track_id = ut.id
      WHERE ts.instance_id = ?
    `);

    return peers.map((peer, i) => {
      const row = app.db
        .prepare("SELECT last_seen, last_synced_at, last_sync_ok, last_sync_message FROM instances WHERE id = ?")
        .get(peer.id) as { last_seen: string | null; last_synced_at: string | null; last_sync_ok: number | null; last_sync_message: string | null } | undefined;
      const health = healthChecks[i].status === "fulfilled" ? healthChecks[i].value : null;
      const alive = health !== null;
      const stats = peerStatsStmt.get(peer.id) ?? { track_count: 0, artist_count: 0, album_count: 0 };
      return {
        id: peer.id,
        url: peer.url,
        publicKey: peer.publicKeySpec,
        status: alive ? "online" : "offline",
        lastSeen: row?.last_seen ?? null,
        lastSyncOk: row?.last_sync_ok != null ? row.last_sync_ok === 1 : null,
        lastSyncMessage: row?.last_sync_message ?? null,
        appVersion: health?.appVersion ?? null,
        apiVersion: health?.apiVersion ?? null,
        trackCount: stats.track_count,
        artistCount: stats.artist_count,
        albumCount: stats.album_count,
      };
    });
  });

  // POST /admin/sync — trigger a full sync (local + peers)
  app.post("/sync", { preHandler: requireOwner }, async (request) => {
   return syncAll(
      app.db,
      app.config,
      app.peerRegistry,
      app.federatedFetch,
      request.adminUsername,
      app.syncOpService,
      "manual",
      app.lastFmClient,
    );
  });

  // GET /admin/peers/:peerId/data — raw instance_* rows for a peer (debug)
  app.get<{ Params: { peerId: string } }>(
    "/peers/:peerId/data",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { peerId } = request.params;

      const instance = app.db
        .prepare("SELECT id FROM instances WHERE id = ?")
        .get(peerId) as { id: string } | undefined;
      if (!instance) {
        return reply.code(404).send({ error: "Peer not found" });
      }

      const artists = app.db
        .prepare("SELECT id, remote_id, name, musicbrainz_id, album_count, image_url FROM instance_artists WHERE instance_id = ? ORDER BY name")
        .all(peerId);
      const albums = app.db
        .prepare("SELECT id, remote_id, name, artist_name, year, genre, musicbrainz_id, release_group_mbid, track_count, cover_art_id FROM instance_albums WHERE instance_id = ? ORDER BY artist_name, name")
        .all(peerId);
      const tracks = app.db
        .prepare("SELECT id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, bitrate, format, size, musicbrainz_id FROM instance_tracks WHERE instance_id = ? ORDER BY artist_name, title")
        .all(peerId);

      return {
        peerId,
        artistCount: (artists as unknown[]).length,
        albumCount: (albums as unknown[]).length,
        trackCount: (tracks as unknown[]).length,
        artists,
        albums,
        tracks,
      };
    },
  );

  // DELETE /admin/peers/data — remove all data fetched from peers, reset sync state
  app.delete("/peers/data", { preHandler: requireOwner }, async () => {
    app.db.transaction(() => {
      app.db.prepare("DELETE FROM instance_tracks WHERE instance_id != 'local'").run();
      app.db.prepare("DELETE FROM instance_albums WHERE instance_id != 'local'").run();
      app.db.prepare("DELETE FROM instance_artists WHERE instance_id != 'local'").run();
      app.db
        .prepare(
          "UPDATE instances SET last_synced_at = NULL, track_count = 0, status = 'offline' WHERE id != 'local'",
        )
        .run();
    })();
    mergeLibraries(app.db);
    return { deleted: true };
  });

  // GET /admin/cache
  app.get("/cache", { preHandler: requireOwner }, async () => {
    const stats = app.artCache.getStats();
    return {
      artCacheMaxBytes: stats.maxBytes,
      artCacheCurrentBytes: stats.currentBytes,
      artCacheFileCount: stats.fileCount,
    };
  });

  // PUT /admin/cache
  app.put<{ Body: { artCacheMaxBytes?: number } }>(
    "/cache",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { artCacheMaxBytes } = request.body ?? {};
      if (artCacheMaxBytes !== undefined) {
        if (typeof artCacheMaxBytes !== "number" || artCacheMaxBytes < 0) {
          return reply
            .code(400)
            .send({ error: "artCacheMaxBytes must be a non-negative number" });
        }
        app.artCache.setMaxBytes(Math.round(artCacheMaxBytes));
      }
      const stats = app.artCache.getStats();
      return {
        artCacheMaxBytes: stats.maxBytes,
        artCacheCurrentBytes: stats.currentBytes,
        artCacheFileCount: stats.fileCount,
      };
    },
  );

  // DELETE /admin/cache
  app.delete("/cache", { preHandler: requireOwner }, async (_request, reply) => {
    app.artCache.clear();
    return reply.code(204).send();
  });

  // GET /admin/activity/active — combined active streams + running syncs
  app.get("/activity/active", { preHandler: requireOwner }, async () => {
    return {
      streams: app.streamTracking.getActive(),
      syncs: app.syncOpService.getRunning(),
    };
  });

  // GET /admin/activity/history?kinds=stream,sync&limit=N — combined timeline
  app.get("/activity/history", { preHandler: requireOwner }, async (request) => {
    const q = request.query as Record<string, string>;
    const limit = Math.min(parseInt(q.limit ?? "200", 10), 1000);
    const kindsParam = (q.kinds ?? "stream,sync").toLowerCase();
    const wantStreams = kindsParam.includes("stream");
    const wantSyncs = kindsParam.includes("sync");

    const streams = wantStreams ? app.streamTracking.getRecent(limit) : [];
    const syncs = wantSyncs ? app.syncOpService.getRecent(limit) : [];
    return { streams, syncs };
  });

  // DELETE /admin/activity — clear all activity history
  app.delete("/activity", { preHandler: requireOwner }, async () => {
    app.streamTracking.clearAll();
    app.syncOpService.clearAll();
    return { cleared: true };
  });

  // GET /admin/activity/summary — dashboard summary
  app.get("/activity/summary", { preHandler: requireOwner }, async () => {
    const activeStreams = app.streamTracking.getActiveCount();
    const runningSyncs = app.syncOpService.getRunning().length;
    const recentSyncs = app.syncOpService.getRecent(10);
    const recentStreams = app.streamTracking.getRecent(10);

    return {
      activeStreams,
      runningSyncs,
      recentSyncCount: recentSyncs.length,
      recentStreamCount: recentStreams.length,
      lastSync: recentSyncs[0] ?? null,
      lastStream: recentStreams[0] ?? null,
    };
  });

  // GET /admin/settings/activity — retention settings
  app.get("/settings/activity", { preHandler: requireOwner }, async () => {
    return {
      maxEvents: app.streamTracking.getMaxRows(),
    };
  });

  // PUT /admin/settings/activity
  app.put<{ Body: { maxEvents?: number } }>(
    "/settings/activity",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { maxEvents } = request.body ?? {};
      if (maxEvents !== undefined) {
        if (typeof maxEvents !== "number" || maxEvents < 0) {
          return reply
            .code(400)
            .send({ error: "maxEvents must be a non-negative number" });
        }
        const n = Math.round(maxEvents);
        app.streamTracking.setMaxRows(n);
        app.syncOpService.setMaxRows(n);
        app.db
          .prepare(
            `INSERT INTO settings (key, value) VALUES ('activity_history_max_events', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(String(n));
      }
      return { maxEvents: app.streamTracking.getMaxRows() };
    },
  );
};
