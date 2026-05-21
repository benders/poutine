import { describe, it, expect, beforeEach } from "vitest";
import { usePlayer } from "./player";
import type { SubsonicSong } from "@/lib/subsonic";

const song = (id: string): SubsonicSong =>
  ({ id, title: `t${id}`, durationMs: 1000 } as unknown as SubsonicSong);

beforeEach(() => {
  usePlayer.setState({ queue: [], currentIndex: -1, isPlaying: false, currentTime: 0 });
});

describe("player store play/pause toggle", () => {
  it("playTrack on a new track starts playing", () => {
    usePlayer.getState().playTrack(song("1"));
    const s = usePlayer.getState();
    expect(s.queue.map((q) => q.id)).toEqual(["1"]);
    expect(s.currentIndex).toBe(0);
    expect(s.isPlaying).toBe(true);
  });

  it("playTrack on the currently playing track pauses it", () => {
    usePlayer.getState().playTrack(song("1"));
    usePlayer.getState().playTrack(song("1"));
    expect(usePlayer.getState().isPlaying).toBe(false);
  });

  it("playTrack on the current (paused) track resumes playback", () => {
    usePlayer.getState().playTrack(song("1"));
    usePlayer.setState({ isPlaying: false });
    usePlayer.getState().playTrack(song("1"));
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("playTrack on a different track replaces the queue", () => {
    usePlayer.getState().playTrack(song("1"));
    usePlayer.getState().playTrack(song("2"));
    const s = usePlayer.getState();
    expect(s.queue.map((q) => q.id)).toEqual(["2"]);
    expect(s.isPlaying).toBe(true);
  });

  it("playTracks toggles pause when start track matches currently playing", () => {
    const tracks = [song("1"), song("2"), song("3")];
    usePlayer.getState().playTracks(tracks, 1);
    expect(usePlayer.getState().currentIndex).toBe(1);
    expect(usePlayer.getState().isPlaying).toBe(true);
    usePlayer.getState().playTracks(tracks, 1);
    expect(usePlayer.getState().isPlaying).toBe(false);
  });

  it("playTracks starting on a different index replaces queue", () => {
    const tracks = [song("1"), song("2")];
    usePlayer.getState().playTracks(tracks, 0);
    usePlayer.getState().playTracks(tracks, 1);
    expect(usePlayer.getState().currentIndex).toBe(1);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });
});

describe("player store peekNext + jumpTo (#202)", () => {
  it("peekNext returns the next queue entry under default sequential play", () => {
    usePlayer.getState().playTracks([song("a"), song("b"), song("c")], 0);
    const peek = usePlayer.getState().peekNext();
    expect(peek?.track.id).toBe("b");
    expect(peek?.index).toBe(1);
  });

  it("peekNext returns null at end of queue when repeat is off", () => {
    usePlayer.getState().playTracks([song("a"), song("b")], 1);
    expect(usePlayer.getState().peekNext()).toBeNull();
  });

  it("peekNext wraps to start when repeat is all", () => {
    usePlayer.getState().playTracks([song("a"), song("b")], 1);
    usePlayer.setState({ repeat: "all" });
    const peek = usePlayer.getState().peekNext();
    expect(peek?.track.id).toBe("a");
    expect(peek?.index).toBe(0);
  });

  it("peekNext returns the current track when repeat is one", () => {
    usePlayer.getState().playTracks([song("a"), song("b")], 0);
    usePlayer.setState({ repeat: "one" });
    const peek = usePlayer.getState().peekNext();
    expect(peek?.track.id).toBe("a");
    expect(peek?.index).toBe(0);
  });

  it("peekNext returns null on an empty queue", () => {
    expect(usePlayer.getState().peekNext()).toBeNull();
  });

  it("peekNext does NOT mutate state", () => {
    usePlayer.getState().playTracks([song("a"), song("b")], 0);
    const before = usePlayer.getState();
    usePlayer.getState().peekNext();
    const after = usePlayer.getState();
    expect(after.currentIndex).toBe(before.currentIndex);
    expect(after.isPlaying).toBe(before.isPlaying);
  });

  it("jumpTo advances to the given index and resets currentTime", () => {
    usePlayer.getState().playTracks([song("a"), song("b"), song("c")], 0);
    usePlayer.setState({ currentTime: 42 });
    usePlayer.getState().jumpTo(2);
    expect(usePlayer.getState().currentIndex).toBe(2);
    expect(usePlayer.getState().currentTime).toBe(0);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("jumpTo ignores out-of-range indices", () => {
    usePlayer.getState().playTracks([song("a"), song("b")], 0);
    usePlayer.getState().jumpTo(99);
    expect(usePlayer.getState().currentIndex).toBe(0);
    usePlayer.getState().jumpTo(-1);
    expect(usePlayer.getState().currentIndex).toBe(0);
  });
});

describe("player store castVolume", () => {
  it("setCastVolume clamps to the current cap", () => {
    usePlayer.setState({ castVolumeCap: 50 });
    usePlayer.getState().setCastVolume(75);
    expect(usePlayer.getState().castVolume).toBe(50);
  });

  it("setCastVolume clamps negatives to 0", () => {
    usePlayer.getState().setCastVolume(-5);
    expect(usePlayer.getState().castVolume).toBe(0);
  });

  it("setCastVolume rounds fractional values", () => {
    usePlayer.setState({ castVolumeCap: 50 });
    usePlayer.getState().setCastVolume(23.6);
    expect(usePlayer.getState().castVolume).toBe(24);
  });

  it("setCastVolumeCap re-clamps the current value if it would exceed the new cap", () => {
    usePlayer.setState({ castVolume: 45, castVolumeCap: 50 });
    usePlayer.getState().setCastVolumeCap(30);
    expect(usePlayer.getState().castVolumeCap).toBe(30);
    expect(usePlayer.getState().castVolume).toBe(30);
  });

  it("setCastVolumeCap leaves a value below the new cap untouched", () => {
    usePlayer.setState({ castVolume: 20, castVolumeCap: 50 });
    usePlayer.getState().setCastVolumeCap(40);
    expect(usePlayer.getState().castVolume).toBe(20);
  });
});
