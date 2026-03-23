import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../auth/middleware.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface QueueTrackRow {
  position: number;
  track_id: string;
  title: string;
  artist_name: string;
  album_name: string;
  duration_ms: number | null;
  added_at: string;
}

interface QueueStateRow {
  current_position: number;
  shuffle: number;
  repeat_mode: string;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export const queueRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/queue - Get current user's queue
  app.get("/", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;

    const tracks = app.db
      .prepare(
        `SELECT
          uq.position,
          uq.track_id,
          ut.title,
          ua.name AS artist_name,
          ur.name AS album_name,
          ut.duration_ms,
          uq.added_at
        FROM user_queue uq
        JOIN unified_tracks ut ON uq.track_id = ut.id
        JOIN unified_artists ua ON ut.artist_id = ua.id
        JOIN unified_releases ur ON ut.release_id = ur.id
        WHERE uq.user_id = ?
        ORDER BY uq.position ASC`,
      )
      .all(userId) as QueueTrackRow[];

    return reply.send({
      tracks: tracks.map((t) => ({
        position: t.position,
        trackId: t.track_id,
        title: t.title,
        artistName: t.artist_name,
        albumName: t.album_name,
        durationMs: t.duration_ms,
        addedAt: t.added_at,
      })),
    });
  });

  // POST /api/queue - Replace entire queue
  app.post<{
    Body: { trackIds: string[] };
  }>("/", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    const { trackIds } = request.body;

    if (!Array.isArray(trackIds)) {
      return reply.code(400).send({ error: "trackIds must be an array" });
    }

    const db = app.db;

    const replaceQueue = db.transaction(() => {
      // Delete existing queue
      db.prepare("DELETE FROM user_queue WHERE user_id = ?").run(userId);

      // Insert new entries
      const insert = db.prepare(
        "INSERT INTO user_queue (user_id, position, track_id) VALUES (?, ?, ?)",
      );
      for (let i = 0; i < trackIds.length; i++) {
        insert.run(userId, i, trackIds[i]);
      }

      // Ensure queue state exists
      db.prepare(
        `INSERT OR IGNORE INTO user_queue_state (user_id, current_position, shuffle, repeat_mode)
         VALUES (?, 0, 0, 'none')`,
      ).run(userId);
    });

    replaceQueue();

    return reply.code(200).send({ ok: true, count: trackIds.length });
  });

  // PATCH /api/queue - Modify queue (add, remove, clear)
  app.patch<{
    Body: {
      action: "add" | "remove" | "clear";
      trackId?: string;
      position?: number;
    };
  }>("/", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    const { action, trackId, position } = request.body;

    const db = app.db;

    if (action === "clear") {
      db.prepare("DELETE FROM user_queue WHERE user_id = ?").run(userId);
      return reply.send({ ok: true });
    }

    if (action === "add") {
      if (!trackId) {
        return reply.code(400).send({ error: "trackId required for add" });
      }

      // Get max position
      const maxRow = db
        .prepare(
          "SELECT MAX(position) AS max_pos FROM user_queue WHERE user_id = ?",
        )
        .get(userId) as { max_pos: number | null } | undefined;

      const nextPos = (maxRow?.max_pos ?? -1) + 1;

      db.prepare(
        "INSERT INTO user_queue (user_id, position, track_id) VALUES (?, ?, ?)",
      ).run(userId, nextPos, trackId);

      // Ensure queue state exists
      db.prepare(
        `INSERT OR IGNORE INTO user_queue_state (user_id, current_position, shuffle, repeat_mode)
         VALUES (?, 0, 0, 'none')`,
      ).run(userId);

      return reply.send({ ok: true, position: nextPos });
    }

    if (action === "remove") {
      if (position === undefined || position === null) {
        return reply
          .code(400)
          .send({ error: "position required for remove" });
      }

      const removeAndReorder = db.transaction(() => {
        // Delete the entry at the given position
        db.prepare(
          "DELETE FROM user_queue WHERE user_id = ? AND position = ?",
        ).run(userId, position);

        // Reorder: shift positions down for entries after the removed one
        db.prepare(
          `UPDATE user_queue SET position = position - 1
           WHERE user_id = ? AND position > ?`,
        ).run(userId, position);
      });

      removeAndReorder();

      return reply.send({ ok: true });
    }

    return reply.code(400).send({ error: "Invalid action" });
  });

  // GET /api/queue/current - Get current track info + stream URL
  app.get("/current", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;

    // Get queue state
    const state = app.db
      .prepare(
        "SELECT current_position, shuffle, repeat_mode FROM user_queue_state WHERE user_id = ?",
      )
      .get(userId) as QueueStateRow | undefined;

    if (!state) {
      return reply.send({
        currentTrack: null,
        state: { currentPosition: 0, shuffle: false, repeatMode: "none" },
      });
    }

    // Get the track at the current position
    const track = app.db
      .prepare(
        `SELECT
          uq.position,
          uq.track_id,
          ut.title,
          ua.name AS artist_name,
          ur.name AS album_name,
          ut.duration_ms,
          uq.added_at
        FROM user_queue uq
        JOIN unified_tracks ut ON uq.track_id = ut.id
        JOIN unified_artists ua ON ut.artist_id = ua.id
        JOIN unified_releases ur ON ut.release_id = ur.id
        WHERE uq.user_id = ? AND uq.position = ?`,
      )
      .get(userId, state.current_position) as QueueTrackRow | undefined;

    return reply.send({
      currentTrack: track
        ? {
            position: track.position,
            trackId: track.track_id,
            title: track.title,
            artistName: track.artist_name,
            albumName: track.album_name,
            durationMs: track.duration_ms,
            streamUrl: `/api/stream/${track.track_id}`,
          }
        : null,
      state: {
        currentPosition: state.current_position,
        shuffle: state.shuffle === 1,
        repeatMode: state.repeat_mode,
      },
    });
  });

  // PATCH /api/queue/state - Update playback state
  app.patch<{
    Body: {
      currentPosition?: number;
      shuffle?: boolean;
      repeatMode?: "none" | "one" | "all";
    };
  }>("/state", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId;
    const { currentPosition, shuffle, repeatMode } = request.body;

    const db = app.db;

    // Ensure state row exists
    db.prepare(
      `INSERT OR IGNORE INTO user_queue_state (user_id, current_position, shuffle, repeat_mode)
       VALUES (?, 0, 0, 'none')`,
    ).run(userId);

    // Build update dynamically
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (currentPosition !== undefined) {
      updates.push("current_position = ?");
      values.push(currentPosition);
    }
    if (shuffle !== undefined) {
      updates.push("shuffle = ?");
      values.push(shuffle ? 1 : 0);
    }
    if (repeatMode !== undefined) {
      updates.push("repeat_mode = ?");
      values.push(repeatMode);
    }

    if (updates.length > 0) {
      values.push(userId);
      db.prepare(
        `UPDATE user_queue_state SET ${updates.join(", ")} WHERE user_id = ?`,
      ).run(...values);
    }

    // Return updated state
    const state = db
      .prepare(
        "SELECT current_position, shuffle, repeat_mode FROM user_queue_state WHERE user_id = ?",
      )
      .get(userId) as QueueStateRow;

    return reply.send({
      currentPosition: state.current_position,
      shuffle: state.shuffle === 1,
      repeatMode: state.repeat_mode,
    });
  });
};
