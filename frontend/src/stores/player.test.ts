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
