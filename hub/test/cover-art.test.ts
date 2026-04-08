import { describe, it, expect } from "vitest";
import {
  encodeCoverArtId,
  decodeCoverArtId,
} from "../src/library/cover-art.js";

describe("Cover art ID encoding/decoding", () => {
  it("should encode and decode correctly", () => {
    const encoded = encodeCoverArtId("inst-123", "al-456");
    expect(encoded).toBe("inst-123:al-456");

    const decoded = decodeCoverArtId(encoded);
    expect(decoded.instanceId).toBe("inst-123");
    expect(decoded.coverArtId).toBe("al-456");
  });

  it("should handle cover art IDs that contain colons", () => {
    const encoded = encodeCoverArtId("inst-1", "al:art:789");
    const decoded = decodeCoverArtId(encoded);
    expect(decoded.instanceId).toBe("inst-1");
    expect(decoded.coverArtId).toBe("al:art:789");
  });

  it("should throw on invalid format", () => {
    expect(() => decodeCoverArtId("nocolon")).toThrow(
      "Invalid cover art ID format",
    );
  });
});
