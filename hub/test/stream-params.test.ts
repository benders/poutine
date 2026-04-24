import { describe, it, expect } from "vitest";
import { applyTranscodeRule, buildStreamParams } from "../src/routes/stream-params.js";

function run(q: Record<string, string>, src: { format: string | null; bitrate: number | null }) {
  return Object.fromEntries(applyTranscodeRule(buildStreamParams(q), src));
}

describe("applyTranscodeRule", () => {
  it("drops format when source is lossy and fits under the cap", () => {
    // KMFDM "Light" scenario: MP3 128 with a 192 opus cap.
    expect(run({ format: "opus", maxBitRate: "192" }, { format: "mp3", bitrate: 128 }))
      .toEqual({ maxBitRate: "192" });
  });

  it("drops format when the requested format already matches the source", () => {
    expect(run({ format: "opus", maxBitRate: "192" }, { format: "opus", bitrate: 128 }))
      .toEqual({ maxBitRate: "192" });
  });

  it("keeps format when source is lossy but exceeds the cap", () => {
    expect(run({ format: "opus", maxBitRate: "128" }, { format: "mp3", bitrate: 320 }))
      .toEqual({ format: "opus", maxBitRate: "128" });
  });

  it("keeps format for lossless sources", () => {
    expect(run({ format: "opus", maxBitRate: "192" }, { format: "flac", bitrate: 900 }))
      .toEqual({ format: "opus", maxBitRate: "192" });
  });

  it("is a no-op when source format is unknown", () => {
    expect(run({ format: "opus", maxBitRate: "192" }, { format: null, bitrate: null }))
      .toEqual({ format: "opus", maxBitRate: "192" });
  });

  it("is a no-op when the request has no format (server chooses)", () => {
    expect(run({ maxBitRate: "192" }, { format: "flac", bitrate: 900 }))
      .toEqual({ maxBitRate: "192" });
  });
});
