import { describe, it, expect } from "vitest";
import { effectiveArtSize } from "../src/routes/subsonic/art-size.js";

describe("effectiveArtSize", () => {
  it.each([
    [undefined, 1024],
    ["", 1024],
    ["abc", 1024],
    ["0", 1024],
    ["-5", 1024],
    ["48", 48],
    ["1024", 1024],
    ["4096", 1024],
  ])("effectiveArtSize(%s) === %i", (input, expected) => {
    expect(effectiveArtSize(input)).toBe(expected);
  });
});
