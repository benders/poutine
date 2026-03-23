import type { FastifyPluginAsync } from "fastify";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import {
  registerInstance,
  listInstances,
  getInstance,
  removeInstance,
  getInstanceCredentials,
} from "../federation/registry.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { syncInstance, syncAllInstances } from "../library/sync.js";
import { mergeLibraries } from "../library/merge.js";

export const instanceRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/instances - requires admin
  app.post<{
    Body: { name: string; url: string; username: string; password: string };
  }>("/", { preHandler: requireAdmin }, async (request, reply) => {
    const { name, url, username, password } = request.body;

    if (!name || !url || !username || !password) {
      return reply
        .code(400)
        .send({ error: "name, url, username, and password are required" });
    }

    // Test connection via ping before saving
    try {
      const pingUrl = new URL("/rest/ping", url);
      pingUrl.searchParams.set("u", username);
      pingUrl.searchParams.set("p", password);
      pingUrl.searchParams.set("v", "1.16.1");
      pingUrl.searchParams.set("c", "poutine");
      pingUrl.searchParams.set("f", "json");

      const response = await fetch(pingUrl.toString(), {
        signal: AbortSignal.timeout(app.config.instanceTimeoutMs),
      });

      if (!response.ok) {
        return reply
          .code(502)
          .send({ error: "Failed to connect to instance" });
      }

      const data = (await response.json()) as {
        "subsonic-response"?: { status?: string };
      };
      if (data["subsonic-response"]?.status !== "ok") {
        return reply
          .code(502)
          .send({ error: "Instance returned an error status" });
      }
    } catch {
      return reply
        .code(502)
        .send({ error: "Failed to connect to instance" });
    }

    const instance = registerInstance(
      app.db,
      { name, url, username, password, ownerId: request.userId },
      app.config.encryptionKey
    );

    // Mark as online since ping succeeded
    app.db
      .prepare(
        "UPDATE instances SET status = 'online', last_seen = datetime('now') WHERE id = ?",
      )
      .run(instance.id);

    return reply.code(201).send({ ...instance, status: "online" });
  });

  // GET /api/instances - requires auth
  app.get("/", { preHandler: requireAuth }, async () => {
    return listInstances(app.db);
  });

  // GET /api/instances/:id - requires auth
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const instance = getInstance(app.db, request.params.id);
      if (!instance) {
        return reply.code(404).send({ error: "Instance not found" });
      }
      return instance;
    }
  );

  // DELETE /api/instances/:id - requires admin
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const removed = removeInstance(app.db, request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: "Instance not found" });
      }
      return { success: true };
    }
  );

  // POST /api/instances/:id/sync - requires admin, syncs a single instance then merges
  app.post<{ Params: { id: string } }>(
    "/:id/sync",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const instance = getInstance(app.db, request.params.id);
      if (!instance) {
        return reply.code(404).send({ error: "Instance not found" });
      }

      const creds = getInstanceCredentials(
        app.db,
        instance.id,
        app.config.encryptionKey,
      );
      if (!creds) {
        return reply
          .code(500)
          .send({ error: "Could not decrypt instance credentials" });
      }

      const client = new SubsonicClient({
        url: instance.url,
        username: creds.username,
        password: creds.password,
      });

      const result = await syncInstance(app.db, instance, client, {
        concurrency: app.config.instanceConcurrency,
      });

      mergeLibraries(app.db);

      return result;
    }
  );

  // POST /api/instances/sync-all - requires admin, syncs all instances then merges
  app.post(
    "/sync-all",
    { preHandler: requireAdmin },
    async () => {
      const results = await syncAllInstances(app.db, app.config);
      mergeLibraries(app.db);
      return { results };
    }
  );
};
