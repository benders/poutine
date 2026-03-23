import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "../auth/middleware.js";

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/settings — return cache settings and stats
  app.get("/", { preHandler: requireAdmin }, async () => {
    const stats = app.artCache.getStats();
    return {
      artCacheMaxBytes: stats.maxBytes,
      artCacheCurrentBytes: stats.currentBytes,
      artCacheFileCount: stats.fileCount,
    };
  });

  // PUT /api/settings — update settings
  app.put<{
    Body: { artCacheMaxBytes?: number };
  }>("/", { preHandler: requireAdmin }, async (request, reply) => {
    const { artCacheMaxBytes } = request.body as { artCacheMaxBytes?: number };

    if (artCacheMaxBytes !== undefined) {
      if (typeof artCacheMaxBytes !== "number" || artCacheMaxBytes < 0) {
        return reply.code(400).send({ error: "artCacheMaxBytes must be a non-negative number" });
      }
      app.artCache.setMaxBytes(Math.round(artCacheMaxBytes));
    }

    const stats = app.artCache.getStats();
    return {
      artCacheMaxBytes: stats.maxBytes,
      artCacheCurrentBytes: stats.currentBytes,
      artCacheFileCount: stats.fileCount,
    };
  });

  // DELETE /api/settings/art-cache — clear the image cache
  app.delete("/art-cache", { preHandler: requireAdmin }, async (_request, reply) => {
    app.artCache.clear();
    reply.code(204).send();
  });
};
