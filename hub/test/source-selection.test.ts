import { describe, it, expect } from "vitest";
import {
  selectBestSource,
  type SelectableSource,
} from "../src/library/source-selection.js";

function src(
  overrides: Partial<SelectableSource> & { remoteId?: string },
): SelectableSource {
  return {
    remoteId: overrides.remoteId ?? "track-1",
    format: overrides.format ?? null,
    bitrate: overrides.bitrate ?? null,
    instanceId: overrides.instanceId ?? "local",
  };
}

describe("selectBestSource", () => {
  it("returns null for empty array", () => {
    expect(selectBestSource([])).toBeNull();
  });

  it("returns the only source when array has one element", () => {
    const s = src({ remoteId: "only", format: "mp3", bitrate: 320 });
    expect(selectBestSource([s])).toBe(s);
  });

  it("local FLAC vs peer FLAC at equal bitrate → local wins", () => {
    const local = src({ remoteId: "local-flac", format: "flac", bitrate: 1000, instanceId: "local" });
    const peer = src({ remoteId: "peer-flac", format: "flac", bitrate: 1000, instanceId: "peer-a" });
    expect(selectBestSource([local, peer])).toBe(local);
    // Also check reverse order
    expect(selectBestSource([peer, local])).toBe(local);
  });

  it("local MP3 320 vs peer FLAC 1000 → peer wins (format quality dominates)", () => {
    const local = src({ remoteId: "local-mp3", format: "mp3", bitrate: 320, instanceId: "local" });
    const peer = src({ remoteId: "peer-flac", format: "flac", bitrate: 1000, instanceId: "peer-a" });
    expect(selectBestSource([local, peer])).toBe(peer);
  });

  it("requestedFormat exact match wins over higher-quality non-match", () => {
    const flac = src({ remoteId: "flac", format: "flac", bitrate: 1000, instanceId: "local" });
    const mp3 = src({ remoteId: "mp3", format: "mp3", bitrate: 320, instanceId: "local" });
    // Requesting mp3 → mp3 source wins despite flac being higher quality
    expect(selectBestSource([flac, mp3], "mp3")).toBe(mp3);
  });

  it("higher bitrate wins when format is the same", () => {
    const low = src({ remoteId: "low", format: "mp3", bitrate: 128, instanceId: "local" });
    const high = src({ remoteId: "high", format: "mp3", bitrate: 320, instanceId: "local" });
    expect(selectBestSource([low, high])).toBe(high);
  });

  it("null format sources still rank (below known formats)", () => {
    const known = src({ remoteId: "mp3", format: "mp3", bitrate: 128, instanceId: "local" });
    const unknown = src({ remoteId: "unk", format: null, bitrate: 500, instanceId: "local" });
    // mp3 score: 50 + 12.8 + 5 = 67.8; unknown: 30 + 50 + 5 = 85 → unknown wins on high bitrate
    expect(selectBestSource([known, unknown])).toBe(unknown);
  });
});
