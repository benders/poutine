import { describe, it, expect } from "vitest";
import { normalizeName } from "../src/library/normalize.js";

describe("normalizeName", () => {
  it("should lowercase the name", () => {
    expect(normalizeName("RADIOHEAD")).toBe("radiohead");
  });

  it("should strip leading 'The '", () => {
    expect(normalizeName("The Beatles")).toBe("beatles");
  });

  it("should strip leading 'the ' case-insensitively", () => {
    expect(normalizeName("the Rolling Stones")).toBe("rolling stones");
  });

  it("should not strip 'The' in the middle of a name", () => {
    expect(normalizeName("Beyond The Pale")).toBe("beyond the pale");
  });

  it("should transliterate common unicode (Björk)", () => {
    expect(normalizeName("Björk")).toBe("bjork");
  });

  it("should transliterate umlauts (Motörhead)", () => {
    expect(normalizeName("Motörhead")).toBe("motorhead");
  });

  it("should transliterate accented characters (Café)", () => {
    expect(normalizeName("Café")).toBe("cafe");
  });

  it("should transliterate ü to u", () => {
    expect(normalizeName("Über")).toBe("uber");
  });

  it("should transliterate é to e", () => {
    expect(normalizeName("Beyoncé")).toBe("beyonce");
  });

  it("should strip punctuation", () => {
    expect(normalizeName("AC/DC")).toBe("acdc");
  });

  it("should strip dots and hyphens", () => {
    expect(normalizeName("R.E.M.")).toBe("rem");
  });

  it("should collapse whitespace", () => {
    expect(normalizeName("Pink   Floyd")).toBe("pink floyd");
  });

  it("should trim whitespace", () => {
    expect(normalizeName("  Led Zeppelin  ")).toBe("led zeppelin");
  });

  it("should handle combined transformations", () => {
    expect(normalizeName("The Smashing Pumpkins!")).toBe("smashing pumpkins");
  });

  it("should handle empty string", () => {
    expect(normalizeName("")).toBe("");
  });

  it("should handle string that is just 'The'", () => {
    expect(normalizeName("The")).toBe("");
  });

  it("should transliterate ß to ss", () => {
    expect(normalizeName("Straße")).toBe("strasse");
  });

  it("should transliterate ñ to n", () => {
    expect(normalizeName("Señor")).toBe("senor");
  });
});
