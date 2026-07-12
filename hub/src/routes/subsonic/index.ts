import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import { requireSubsonicAuth, requireSubsonicAuthBinary } from "../../auth/subsonic-auth.js";
import { sendSubsonicOk, OPENSUBSONIC_EXTENSIONS } from "../subsonic-response.js";
import type { StreamTrackingService } from "../../services/stream-tracking.js";
import { createSubsonicQueries } from "../../db/queries/subsonic-queries.js";
import type { SubsonicRouteContext } from "./types.js";
import { registerBrowsing } from "./browsing.js";
import { registerSearch } from "./search.js";
import { registerPlaylists } from "./playlists.js";
import { registerAnnotations } from "./annotations.js";
import { registerStream } from "./stream.js";

// Extend Fastify app type for stream tracking
declare module "fastify" {
  interface FastifyInstance {
    streamTracking: StreamTrackingService;
  }
}

// ── Registration order (#243 phase 3 — recorded from the pre-split monolith,
// top to bottom, so the split preserves it exactly) ──────────────────────────
// ping, getLicense, getOpenSubsonicExtensions (public), getUser,
// getMusicFolders, getGenres, getArtists, getIndexes, getArtist,
// getArtistInfo2, getAlbumList2, getAlbum, getSong, search3, getCoverArt
// (binary), stream (binary), download (binary alias), star, unstar,
// getStarred2, getStarred, getPlaylists, getPlaylist, createPlaylist,
// updatePlaylist, deletePlaylist, scrobble, getNowPlaying.

export const subsonicRoutes: FastifyPluginAsync = async (app) => {
  const preHandler = requireSubsonicAuth;

  /**
   * Register a handler for both GET and POST, with and without the .view suffix.
   * All Subsonic endpoints accept both methods and the optional .view suffix.
   */
  function route(path: string, handler: RouteHandlerMethod): void {
    app.get(path, { preHandler }, handler);
    app.get(`${path}.view`, { preHandler }, handler);
    app.post(path, { preHandler }, handler);
    app.post(`${path}.view`, { preHandler }, handler);
  }

  /**
   * Register an UNAUTHENTICATED handler (GET+POST, with/without `.view`).
   * Only for endpoints the OpenSubsonic spec marks as callable without
   * credentials — currently just `getOpenSubsonicExtensions`, which clients
   * probe before login to negotiate capabilities. Do not use this for anything
   * that reads user state or library data.
   */
  function publicRoute(path: string, handler: RouteHandlerMethod): void {
    app.get(path, handler);
    app.get(`${path}.view`, handler);
    app.post(path, handler);
    app.post(`${path}.view`, handler);
  }

  /**
   * Register a binary handler (GET+POST, with/without `.view`) via
   * requireSubsonicAuthBinary — auth failures return real HTTP error codes
   * instead of a 200+JSON Subsonic envelope. Cast tokens are accepted only
   * on the paths this is used for (#218) — see docs/pitfalls.md "Auth".
   */
  function binaryRoute(path: string, handler: RouteHandlerMethod): void {
    const binaryPreHandler = requireSubsonicAuthBinary;
    app.get(path, { preHandler: binaryPreHandler }, handler);
    app.get(`${path}.view`, { preHandler: binaryPreHandler }, handler);
    app.post(path, { preHandler: binaryPreHandler }, handler);
    app.post(`${path}.view`, { preHandler: binaryPreHandler }, handler);
  }

  // ── Prepared statements (#130, factored out to a query module in #243) ──────
  // Prepared once at plugin init, via createSubsonicQueries, rather than per-
  // request or inline — avoids allocation churn on hot endpoints and catches
  // SQL/schema drift at init instead of first request.
  const queries = createSubsonicQueries(app.db);

  // ── getOpenSubsonicExtensions ─────────────────────────────────────────────
  // Capability negotiation. Per spec this endpoint is callable WITHOUT auth so
  // clients can feature-detect before login — hence publicRoute. Returns the
  // static OPENSUBSONIC_EXTENSIONS list (source of truth in subsonic-response).

  publicRoute("/getOpenSubsonicExtensions", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, {
      openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS.map((e) => ({
        name: e.name,
        versions: e.versions,
      })),
    });
  });

  const ctx: SubsonicRouteContext = { app, queries, route, publicRoute, binaryRoute };

  registerBrowsing(ctx);
  registerSearch(ctx);
  registerStream(ctx);
  registerAnnotations(ctx);
  registerPlaylists(ctx);
};
