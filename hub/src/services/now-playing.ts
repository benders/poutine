// ── Now-playing registry (#237) ─────────────────────────────────────────────
//
// Ephemeral, in-memory only. Fed by `scrobble?submission=false` pings (the
// OpenSubsonic "now playing notification"); read back by `getNowPlaying` and
// the admin Activity page. Deliberately NOT conflated with the durable
// `play_events` store (#197) — a now-playing ping is a liveness signal, not a
// play. Nothing here survives a restart, and that's fine: clients re-ping.
//
// One entry per (user, client) — a listener with the SPA and a phone app open
// shows twice; a new ping from the same player replaces its previous entry.
// Entries expire NOW_PLAYING_TTL_MS after the last ping. The SPA re-pings
// every 2 minutes while playing (frontend PlayerBar), so live SPA playback
// never ages out; third-party clients typically ping once per track start,
// which per Subsonic convention surfaces them for the next few minutes.

export const NOW_PLAYING_TTL_MS = 5 * 60_000;

export interface NowPlayingRecordInput {
  userId: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  /** unified_release_groups.id — SPA album link on the Activity page. */
  albumId: string | null;
  clientName: string | null;
  // Preferred-source snapshot (what a stream of this track would serve),
  // resolved at ping time. What the client *actually* receives may differ
  // (transcode params are per-request), so these describe the source file.
  sourceKind: "local" | "peer" | null;
  sourcePeerId: string | null;
  format: string | null;
  bitrate: number | null;
}

export interface NowPlayingEntry extends NowPlayingRecordInput {
  /** Small stable integer identifying the (user, client) player slot. */
  playerId: number;
  /** First ping for this track on this player (ISO). */
  startedAt: string;
  /** Most recent ping (ISO) — TTL and minutesAgo are measured from here. */
  updatedAt: string;
}

interface Slot {
  playerId: number;
  entry: NowPlayingEntry;
  updatedAtMs: number;
}

export class NowPlayingService {
  private slots = new Map<string, Slot>();
  private nextPlayerId = 1;

  // Injectable clock so tests can drive TTL expiry deterministically.
  constructor(private readonly now: () => number = Date.now) {}

  record(input: NowPlayingRecordInput): void {
    const key = `${input.userId}\u0000${input.clientName ?? ""}`;
    const nowMs = this.now();
    const prev = this.slots.get(key);
    const playerId = prev?.playerId ?? this.nextPlayerId++;
    // Same track re-pinged on the same player keeps its original start time
    // (unless the previous entry already expired — then it's a fresh listen).
    const startedAt =
      prev &&
      prev.entry.trackId === input.trackId &&
      nowMs - prev.updatedAtMs < NOW_PLAYING_TTL_MS
        ? prev.entry.startedAt
        : new Date(nowMs).toISOString();
    this.slots.set(key, {
      playerId,
      updatedAtMs: nowMs,
      entry: {
        ...input,
        playerId,
        startedAt,
        updatedAt: new Date(nowMs).toISOString(),
      },
    });
  }

  getForUser(userId: string): NowPlayingEntry[] {
    return this.getAll().filter((e) => e.userId === userId);
  }

  getAll(): NowPlayingEntry[] {
    this.prune();
    return Array.from(this.slots.values())
      .map((s) => s.entry)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** Minutes since the last ping for an entry (what Subsonic calls minutesAgo). */
  minutesAgo(entry: NowPlayingEntry): number {
    return Math.max(0, Math.floor((this.now() - Date.parse(entry.updatedAt)) / 60_000));
  }

  private prune(): void {
    const cutoff = this.now() - NOW_PLAYING_TTL_MS;
    for (const [key, slot] of this.slots) {
      if (slot.updatedAtMs < cutoff) this.slots.delete(key);
    }
  }
}
