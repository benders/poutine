/**
 * Sonos capability gate — #199 unit matrix.
 *
 * Source ceilings (from issue #199):
 *   S2: 24-bit / 48 kHz / 2-ch
 *   S1: 16-bit / 48 kHz / 2-ch
 *   Unknown: treat as S1 (conservative — false MP3 fallback is safer than
 *            firmware STOP).
 *   Lossy (bitDepth=0): no bit-depth ceiling applies.
 */
import { describe, it, expect } from "vitest";
import {
  classifyModel,
  capabilityFor,
  shouldForceMp3,
} from "../src/services/sonos-capabilities.js";

describe("classifyModel", () => {
  it.each([
    ["Sonos Era 100", "s2"],
    ["Sonos Era 300", "s2"],
    ["Sonos Arc", "s2"],
    ["Sonos Beam (Gen 2)", "s2"],
    ["Sonos Move", "s2"],
    ["Sonos Roam", "s2"],
    ["Sonos Five", "s2"],
    ["Sonos Ray", "s2"],
    ["Sonos Sub Mini", "s2"],
    ["Sonos One SL", "s2"],
    ["Symfonisk Bookshelf (Gen 2)", "s2"],
    ["Sonos PLAY:1", "s1"],
    ["Sonos PLAY:3", "s1"],
    ["Sonos PLAY:5", "s1"],
    ["Sonos PLAYBAR", "s1"],
    ["Sonos PLAYBASE", "s1"],
    ["Sonos CONNECT", "s1"],
    ["Sonos CONNECT:AMP", "s1"],
    ["Sonos Mystery 9000", "unknown"],
    ["", "unknown"],
  ] as const)("classifies %s → %s", (model, line) => {
    expect(classifyModel(model || undefined)).toBe(line);
  });

  it("returns unknown for undefined model", () => {
    expect(classifyModel(undefined)).toBe("unknown");
  });
});

describe("capabilityFor", () => {
  it("S2 line → 24/48/2", () => {
    expect(capabilityFor("Sonos Era 100")).toEqual({
      maxBitDepth: 24,
      maxSampleRate: 48000,
      maxChannels: 2,
    });
  });

  it("S1 line → 16/48/2", () => {
    expect(capabilityFor("Sonos PLAY:1")).toEqual({
      maxBitDepth: 16,
      maxSampleRate: 48000,
      maxChannels: 2,
    });
  });

  it("unknown line → S1 (conservative)", () => {
    expect(capabilityFor("Sonos Mystery 9000")).toEqual({
      maxBitDepth: 16,
      maxSampleRate: 48000,
      maxChannels: 2,
    });
  });
});

describe("shouldForceMp3", () => {
  // S2 cases — 24/48/2 ceiling
  it("S2 + 16/44.1 stereo FLAC → pass-through", () => {
    expect(shouldForceMp3("Sonos Era 100", 44100, 16, 2)).toBe(false);
  });

  it("S2 + 24/48 stereo FLAC → pass-through (at ceiling)", () => {
    expect(shouldForceMp3("Sonos Era 100", 48000, 24, 2)).toBe(false);
  });

  it("S2 + 24/96 stereo FLAC → MP3 (over sample-rate ceiling)", () => {
    expect(shouldForceMp3("Sonos Era 100", 96000, 24, 2)).toBe(true);
  });

  it("S2 + 24/192 stereo FLAC → MP3", () => {
    expect(shouldForceMp3("Sonos Era 100", 192000, 24, 2)).toBe(true);
  });

  it("S2 + 24/88.2 stereo FLAC → MP3", () => {
    expect(shouldForceMp3("Sonos Era 100", 88200, 24, 2)).toBe(true);
  });

  it("S2 + 16/48 6-channel FLAC → MP3 (multi-channel)", () => {
    expect(shouldForceMp3("Sonos Era 100", 48000, 16, 6)).toBe(true);
  });

  // S1 cases — 16/48/2 ceiling
  it("S1 + 16/44.1 stereo FLAC → pass-through", () => {
    expect(shouldForceMp3("Sonos PLAY:1", 44100, 16, 2)).toBe(false);
  });

  it("S1 + 24/44.1 stereo FLAC → MP3 (over bit-depth ceiling)", () => {
    expect(shouldForceMp3("Sonos PLAY:1", 44100, 24, 2)).toBe(true);
  });

  it("S1 + 24/48 stereo FLAC → MP3 (over bit-depth)", () => {
    expect(shouldForceMp3("Sonos PLAY:1", 48000, 24, 2)).toBe(true);
  });

  it("S1 + 16/96 stereo FLAC → MP3 (over sample-rate)", () => {
    expect(shouldForceMp3("Sonos PLAY:1", 96000, 16, 2)).toBe(true);
  });

  // Lossy source — bitDepth=0 from Navidrome for MP3/AAC
  it("S2 + MP3 (bitDepth=0) at 44.1 → pass-through", () => {
    expect(shouldForceMp3("Sonos Era 100", 44100, 0, 2)).toBe(false);
  });

  it("S1 + MP3 (bitDepth=0) at 44.1 → pass-through", () => {
    expect(shouldForceMp3("Sonos PLAY:1", 44100, 0, 2)).toBe(false);
  });

  it("S2 + lossy at 96k → still MP3 (sample-rate gate)", () => {
    // Hypothetical lossy hi-res — sample-rate gate still applies.
    expect(shouldForceMp3("Sonos Era 100", 96000, 0, 2)).toBe(true);
  });

  // Unknown model — treated as S1
  it("unknown model + 24/48 → MP3 (conservative S1 ceiling)", () => {
    expect(shouldForceMp3("Sonos Mystery 9000", 48000, 24, 2)).toBe(true);
  });

  it("unknown model + 16/44.1 → pass-through", () => {
    expect(shouldForceMp3("Sonos Mystery 9000", 44100, 16, 2)).toBe(false);
  });

  it("undefined model + 24/96 → MP3", () => {
    expect(shouldForceMp3(undefined, 96000, 24, 2)).toBe(true);
  });

  // Missing metadata — fail-safe to MP3 (#199). Pre-migration rows and peer
  // tracks not yet re-synced may have null sampling_rate / bit_depth /
  // channel_count; without all three we cannot prove the source fits the
  // line's ceiling, so transcode.
  it("missing samplingRate + missing bitDepth → MP3 (fail-safe)", () => {
    expect(shouldForceMp3("Sonos Era 100", undefined, undefined, 2)).toBe(true);
  });

  it("missing samplingRate alone → MP3 (fail-safe)", () => {
    expect(shouldForceMp3("Sonos Era 100", undefined, 24, 2)).toBe(true);
  });

  it("missing bitDepth alone → MP3 (fail-safe)", () => {
    expect(shouldForceMp3("Sonos Era 100", 44100, undefined, 2)).toBe(true);
  });

  it("missing channelCount alone → MP3 (fail-safe)", () => {
    expect(shouldForceMp3("Sonos Era 100", 44100, 16, undefined)).toBe(true);
  });

  it("all three missing → MP3 (fail-safe)", () => {
    expect(shouldForceMp3("Sonos Era 100", undefined, undefined, undefined)).toBe(
      true,
    );
  });
});
