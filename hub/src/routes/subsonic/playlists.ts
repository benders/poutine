import { sendSubsonicOk, sendSubsonicError } from "../subsonic-response.js";
import type { SubsonicRouteContext } from "./types.js";

export function registerPlaylists(ctx: SubsonicRouteContext): void {
  const { route } = ctx;

  // ── Playlist stubs ──────────────────────────────────────────────────────────
  // TODO: implement fully once playlists table is populated (Phase 3+)

  route("/getPlaylists", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, { playlists: { playlist: [] } });
  });

  route("/getPlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 70, "Playlist not found", q);
  });

  route("/createPlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });

  route("/updatePlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });

  route("/deletePlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });
}
