import { describe, it, expect, beforeEach } from "vitest";
import { usePlayer, DEFAULT_SONOS_VOLUME_CAP } from "./player";
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

describe("player store mute/unmute (#207)", () => {
  beforeEach(() => {
    usePlayer.setState({
      volume: 0.8,
      prevVolume: null,
      castVolume: DEFAULT_SONOS_VOLUME_CAP,
      castVolumeCap: DEFAULT_SONOS_VOLUME_CAP,
      prevCastVolume: null,
    });
  });

  it("toggleMute remembers the current volume and mutes to 0", () => {
    usePlayer.getState().toggleMute();
    const s = usePlayer.getState();
    expect(s.volume).toBe(0);
    expect(s.prevVolume).toBe(0.8);
  });

  it("toggleMute then toggleMute again restores the previous volume", () => {
    usePlayer.getState().toggleMute();
    usePlayer.getState().toggleMute();
    const s = usePlayer.getState();
    expect(s.volume).toBe(0.8);
    expect(s.prevVolume).toBeNull();
  });

  it("unmuting with no remembered value falls back to slider-halfway (0.25)", () => {
    usePlayer.setState({ volume: 0, prevVolume: null });
    usePlayer.getState().toggleMute();
    expect(usePlayer.getState().volume).toBe(0.25);
  });

  it("unmuting never lands on 0 even if the remembered value was 0", () => {
    usePlayer.setState({ volume: 0, prevVolume: 0 });
    usePlayer.getState().toggleMute();
    expect(usePlayer.getState().volume).toBe(0.25);
  });

  it("toggleCastMute remembers the current cast volume and mutes to 0", () => {
    usePlayer.setState({ castVolume: 35 });
    const result = usePlayer.getState().toggleCastMute();
    expect(result).toBe(0);
    const s = usePlayer.getState();
    expect(s.castVolume).toBe(0);
    expect(s.prevCastVolume).toBe(35);
  });

  it("toggleCastMute then toggleCastMute again restores the previous cast volume", () => {
    usePlayer.setState({ castVolume: 35 });
    usePlayer.getState().toggleCastMute();
    const result = usePlayer.getState().toggleCastMute();
    expect(result).toBe(35);
    expect(usePlayer.getState().castVolume).toBe(35);
    expect(usePlayer.getState().prevCastVolume).toBeNull();
  });

  it("unmuting cast with no remembered value falls back to min(20, cap)", () => {
    usePlayer.setState({ castVolume: 0, prevCastVolume: null, castVolumeCap: 50 });
    const result = usePlayer.getState().toggleCastMute();
    expect(result).toBe(20);
    expect(usePlayer.getState().castVolume).toBe(20);
  });

  it("unmuting cast falls back to the cap when it is below 20", () => {
    usePlayer.setState({ castVolume: 0, prevCastVolume: null, castVolumeCap: 10 });
    const result = usePlayer.getState().toggleCastMute();
    expect(result).toBe(10);
  });

  it("restored cast volume clamps to a lowered cap", () => {
    usePlayer.setState({ castVolume: 35, castVolumeCap: 50 });
    usePlayer.getState().toggleCastMute();
    usePlayer.setState({ castVolumeCap: 20 });
    const result = usePlayer.getState().toggleCastMute();
    expect(result).toBe(20);
    expect(usePlayer.getState().castVolume).toBe(20);
  });
});
