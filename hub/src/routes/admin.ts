import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword, hashPassword } from "../auth/passwords.js";
import { createAccessToken, verifyToken } from "../auth/jwt.js";
import { syncAll } from "../library/sync.js";
import { SubsonicClient } from "../adapters/subsonic.js";

declare module "fastify" {
  interface FastifyRequest {
    adminUsername: string;
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
          "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?",
        )
        .get(username) as
        | { id: string; username: string; password_hash: string; is_admin: number }
        | undefined;

      if (!user) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      if (user.is_admin !== 1) {
        return reply.code(403).send({ error: "Admin access required" });
      }

      const accessToken = await createAccessToken(user.id, app.config);

      reply.setCookie("access_token", accessToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 8 * 60 * 60,
      });

      return {
        user: { id: user.id, username: user.username, isAdmin: true },
        accessToken,
      };
    },
  );

  // POST /admin/logout
  app.post("/logout", async (_request, reply) => {
    reply.clearCookie("access_token", { path: "/" });
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

      const passwordHash = await hashPassword(password);
      const id = crypto.randomUUID();
      app.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)",
        )
        .run(id, username, passwordHash);

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
      .prepare(`SELECT status, track_count,
          strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_at) as last_synced_at,
          strftime('%Y-%m-%dT%H:%M:%SZ', last_seen) as last_seen
        FROM instances WHERE id = 'local'`)
      .get() as { status: string; track_count: number; last_synced_at: string | null; last_seen: string | null } | undefined;

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

    return {
      instanceId: app.config.poutineInstanceId,
      publicKey: app.publicKeySpec,
      navidrome: {
        reachable: scanStatus !== null,
        scanning: scanStatus?.scanning ?? false,
        folderCount: scanStatus?.folderCount ?? null,
        lastScan: scanStatus?.lastScan ?? null,
        status: local?.status ?? "unknown",
        trackCount: local?.track_count ?? 0,
        lastSynced: local?.last_synced_at ?? null,
        lastSeen: local?.last_seen ?? null,
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

  // GET /admin/peers
  app.get("/peers", { preHandler: requireOwner }, async () => {
    return Array.from(app.peerRegistry.peers.values()).map((peer) => {
      const row = app.db
        .prepare("SELECT status, last_seen FROM instances WHERE id = ?")
        .get(peer.id) as { status: string; last_seen: string | null } | undefined;
      return {
        id: peer.id,
        url: peer.url,
        publicKey: peer.publicKeySpec,
        status: row?.status ?? "unknown",
        lastSeen: row?.last_seen ?? null,
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
    );
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
};
