import { describe, it, expect } from "vitest";
import { isAllowedExternalArtUrl } from "../src/routes/external-art.js";

describe("isAllowedExternalArtUrl", () => {
  it("allows assets.fanart.tv", () => {
    expect(
      isAllowedExternalArtUrl("https://assets.fanart.tv/fanart/music/x.jpg"),
    ).toBe(true);
  });

  it("allows the bare fanart.tv host", () => {
    expect(isAllowedExternalArtUrl("https://fanart.tv/some/path.jpg")).toBe(true);
  });

  it("allows other fanart.tv subdomains", () => {
    expect(isAllowedExternalArtUrl("https://images.fanart.tv/x.jpg")).toBe(true);
  });

  it("rejects http (https only)", () => {
    expect(isAllowedExternalArtUrl("http://assets.fanart.tv/x.jpg")).toBe(false);
  });

  it("allows the Last.fm image CDN", () => {
    expect(
      isAllowedExternalArtUrl("https://lastfm.freetls.fastly.net/i/u/x.jpg"),
    ).toBe(true);
  });

  it("rejects unrelated hostnames", () => {
    expect(isAllowedExternalArtUrl("https://evil.example.com/x.jpg")).toBe(false);
    expect(isAllowedExternalArtUrl("https://other.fastly.net/x.jpg")).toBe(false);
  });

  it("rejects hostnames that merely contain 'fanart.tv' as a substring", () => {
    expect(isAllowedExternalArtUrl("https://fanart.tv.evil.com/x.jpg")).toBe(false);
    expect(isAllowedExternalArtUrl("https://notfanart.tv/x.jpg")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowedExternalArtUrl("https://")).toBe(false);
    expect(isAllowedExternalArtUrl("not a url")).toBe(false);
  });

  it("rejects internal/private hostnames", () => {
    expect(isAllowedExternalArtUrl("https://localhost/x.jpg")).toBe(false);
    expect(isAllowedExternalArtUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("is case-insensitive on the hostname", () => {
    expect(isAllowedExternalArtUrl("https://ASSETS.FANART.TV/x.jpg")).toBe(true);
  });
});
