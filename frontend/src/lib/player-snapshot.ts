/**
 * Player state snapshot across an auto-update reload (issue #196).
 *
 * When the SPA reloads itself to pick up a new build, the queue, position,
 * and playback flags are serialized to sessionStorage just before
 * `location.reload()` and restored at boot — but only if the snapshot is
 * fresh (< SNAPSHOT_MAX_AGE_MS). A stale snapshot means the reload never
 * happened (or happened long ago) and restoring it would resurrect a dead
 * session.
 *
 * The `sink` field is a deliberate, scoped exception to the player store's
 * "sink is never persisted" rule (stores/player.ts): a reload mid-cast must
 * reattach to the Sonos device that is still playing, and the freshness
 * window keeps this from becoming cross-session persistence.
 */

import { usePlayer, type PlayerSink } from "@/stores/player";
import type { SubsonicSong } from "@/lib/subsonic";

const SNAPSHOT_KEY = "playerSnapshot";
export const SNAPSHOT_MAX_AGE_MS = 30_000;

interface PlayerSnapshot {
  savedAt: number;
  queue: SubsonicSong[];
  currentIndex: number;
  isPlaying: boolean;
  currentTime: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  sink: PlayerSink;
}

/**
 * Track id restored onto a Sonos sink, consumable exactly once. PlayerBar
 * reads this to seed its skip-next-play ref: the device is *already*
 * playing this track, so the mount-time track-change effect must not
 * re-issue SetAVTransportURI (which would restart the stream mid-listen —
 * the whole point of #196 is that casting survives the reload untouched).
 */
let restoredSonosTrackId: string | null = null;

export function consumeRestoredSonosTrackId(): string | null {
  const id = restoredSonosTrackId;
  restoredSonosTrackId = null;
  return id;
}

/** Serialize the current player state. Called immediately before reload. */
export function savePlayerSnapshot(): void {
  const s = usePlayer.getState();
  const snapshot: PlayerSnapshot = {
    savedAt: Date.now(),
    queue: s.queue,
    currentIndex: s.currentIndex,
    isPlaying: s.isPlaying,
    currentTime: s.currentTime,
    shuffle: s.shuffle,
    repeat: s.repeat,
    sink: s.sink,
  };
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota/serialization failure — reload proceeds without restore.
  }
}

/**
 * Restore a fresh snapshot into the player store. Runs once at boot, before
 * React renders, so PlayerBar mounts with the restored state. Consumes the
 * snapshot either way. Returns true if state was applied.
 *
 * Volume is intentionally absent: it already persists via localStorage.
 */
export function restorePlayerSnapshot(now: number = Date.now()): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (raw !== null) sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;

  let snap: PlayerSnapshot;
  try {
    snap = JSON.parse(raw) as PlayerSnapshot;
  } catch {
    return false;
  }
  if (
    typeof snap !== "object" ||
    snap === null ||
    typeof snap.savedAt !== "number" ||
    !Array.isArray(snap.queue) ||
    typeof snap.currentIndex !== "number"
  ) {
    return false;
  }
  if (now - snap.savedAt > SNAPSHOT_MAX_AGE_MS) return false;
  if (snap.currentIndex < 0 || snap.currentIndex >= snap.queue.length) {
    return false;
  }

  const sink: PlayerSink =
    typeof snap.sink === "object" && snap.sink?.type === "sonos"
      ? snap.sink
      : "local";

  usePlayer.setState({
    queue: snap.queue,
    currentIndex: snap.currentIndex,
    isPlaying: snap.isPlaying === true,
    currentTime: typeof snap.currentTime === "number" ? snap.currentTime : 0,
    shuffle: snap.shuffle === true,
    repeat: snap.repeat === "one" || snap.repeat === "all" ? snap.repeat : "none",
    sink,
  });

  if (sink !== "local") {
    restoredSonosTrackId = snap.queue[snap.currentIndex]?.id ?? null;
  }
  return true;
}
