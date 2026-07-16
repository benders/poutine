/**
 * Tests for the auto-update player snapshot (issue #196): serialize the
 * player store to sessionStorage before a reload, restore on boot only when
 * fresh, and hand PlayerBar a one-shot signal for a restored Sonos sink.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { usePlayer } from "@/stores/player";
import type { SubsonicSong } from "@/lib/subsonic";
import {
  savePlayerSnapshot,
  restorePlayerSnapshot,
  consumeRestoredSonosTrackId,
  SNAPSHOT_MAX_AGE_MS,
} from "./player-snapshot";

const SNAPSHOT_KEY = "playerSnapshot";

function track(id: string): SubsonicSong {
  return {
    id,
    title: "T",
    album: "A",
    albumId: "al-1",
    artist: "Ar",
    artistId: "ar-1",
    durationMs: 180_000,
  };
}

function resetStore() {
  usePlayer.setState({
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    shuffle: false,
    repeat: "none",
    sink: "local",
  });
}

beforeEach(() => {
  sessionStorage.clear();
  resetStore();
  // Drain any one-shot flag left over from a previous test.
  consumeRestoredSonosTrackId();
});

describe("savePlayerSnapshot / restorePlayerSnapshot", () => {
  it("round-trips queue, position, and playback flags", () => {
    usePlayer.setState({
      queue: [track("t1"), track("t2")],
      currentIndex: 1,
      isPlaying: true,
      currentTime: 42.5,
      shuffle: true,
      repeat: "all",
      sink: "local",
    });
    savePlayerSnapshot();
    resetStore();

    expect(restorePlayerSnapshot()).toBe(true);
    const s = usePlayer.getState();
    expect(s.queue.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.currentIndex).toBe(1);
    expect(s.isPlaying).toBe(true);
    expect(s.currentTime).toBe(42.5);
    expect(s.shuffle).toBe(true);
    expect(s.repeat).toBe("all");
    expect(s.sink).toBe("local");
    // Local sink: no Sonos skip signal.
    expect(consumeRestoredSonosTrackId()).toBeNull();
  });

  it("consumes the snapshot — a second restore is a no-op", () => {
    usePlayer.setState({ queue: [track("t1")], currentIndex: 0 });
    savePlayerSnapshot();
    expect(restorePlayerSnapshot()).toBe(true);
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(restorePlayerSnapshot()).toBe(false);
  });

  it("ignores a stale snapshot", () => {
    usePlayer.setState({ queue: [track("t1")], currentIndex: 0, currentTime: 10 });
    savePlayerSnapshot();
    resetStore();

    const later = Date.now() + SNAPSHOT_MAX_AGE_MS + 1;
    expect(restorePlayerSnapshot(later)).toBe(false);
    expect(usePlayer.getState().currentIndex).toBe(-1);
  });

  it("ignores corrupt or malformed payloads without throwing", () => {
    sessionStorage.setItem(SNAPSHOT_KEY, "not json{");
    expect(restorePlayerSnapshot()).toBe(false);

    sessionStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ savedAt: Date.now(), queue: "nope", currentIndex: 0 }),
    );
    expect(restorePlayerSnapshot()).toBe(false);
    expect(usePlayer.getState().queue).toEqual([]);
  });

  it("rejects an out-of-range currentIndex", () => {
    sessionStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        queue: [track("t1")],
        currentIndex: 5,
        isPlaying: false,
        currentTime: 0,
        shuffle: false,
        repeat: "none",
        sink: "local",
      }),
    );
    expect(restorePlayerSnapshot()).toBe(false);
  });

  it("restores a Sonos sink and exposes the track id exactly once", () => {
    usePlayer.setState({
      queue: [track("t1"), track("t2")],
      currentIndex: 0,
      isPlaying: true,
      sink: { type: "sonos", deviceId: "dev-1", deviceName: "Kitchen" },
    });
    savePlayerSnapshot();
    resetStore();

    expect(restorePlayerSnapshot()).toBe(true);
    const s = usePlayer.getState();
    expect(s.sink).toEqual({ type: "sonos", deviceId: "dev-1", deviceName: "Kitchen" });
    // One-shot: PlayerBar consumes it on mount to skip the play re-issue.
    expect(consumeRestoredSonosTrackId()).toBe("t1");
    expect(consumeRestoredSonosTrackId()).toBeNull();
  });

  it("falls back to the local sink on an unrecognized sink shape", () => {
    sessionStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        queue: [track("t1")],
        currentIndex: 0,
        isPlaying: false,
        currentTime: 0,
        shuffle: false,
        repeat: "none",
        sink: { type: "chromecast", deviceId: "x" },
      }),
    );
    expect(restorePlayerSnapshot()).toBe(true);
    expect(usePlayer.getState().sink).toBe("local");
    expect(consumeRestoredSonosTrackId()).toBeNull();
  });
});
