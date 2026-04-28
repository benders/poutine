import { describe, it, expect } from "vitest";
import {
  generateDeterministicId,
  generateArtistId,
  generateReleaseGroupId,
  generateReleaseId,
  generateTrackId,
  generateTrackSourceId,
} from "../src/library/id-generator.js";

describe("generateDeterministicId", () => {
  it("should produce consistent IDs for the same input", () => {
    const id1 = generateDeterministicId("test", "input");
    const id2 = generateDeterministicId("test", "input");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should produce different IDs for different inputs", () => {
    const id1 = generateDeterministicId("test", "input1");
    const id2 = generateDeterministicId("test", "input2");
    expect(id1).not.toBe(id2);
  });

  it("should produce different IDs when order changes", () => {
    const id1 = generateDeterministicId("a", "b");
    const id2 = generateDeterministicId("b", "a");
    expect(id1).not.toBe(id2);
  });
});

describe("generateArtistId", () => {
  it("should use MBID when available", () => {
    const id1 = generateArtistId("Radiohead", "abc123-mbid");
    const id2 = generateArtistId("Radiohead", "abc123-mbid");
    expect(id1).toBe(id2);
  });

  it("should use name when no MBID", () => {
    const id1 = generateArtistId("radiohead", null);
    const id2 = generateArtistId("radiohead", null);
    expect(id1).toBe(id2);
  });

  it("should produce same ID for same name regardless of display name variants", () => {
    const id1 = generateArtistId("beatles", null);
    const id2 = generateArtistId("beatles", null);
    expect(id1).toBe(id2);
  });

  it("should differentiate artists with and without MBID", () => {
    const idWithMbid = generateArtistId("Radiohead", "abc123-mbid");
    const idWithoutMbid = generateArtistId("Radiohead", null);
    expect(idWithMbid).not.toBe(idWithoutMbid);
  });
});

describe("generateReleaseGroupId", () => {
  it("should use release group MBID when available", () => {
    const id1 = generateReleaseGroupId("OK Computer", "artist-id-123", "rg-mbid-456");
    const id2 = generateReleaseGroupId("OK Computer", "artist-id-123", "rg-mbid-456");
    expect(id1).toBe(id2);
  });

  it("should use artist ID + name when no MBID", () => {
    const id1 = generateReleaseGroupId("ok computer", "artist-id-123", null);
    const id2 = generateReleaseGroupId("ok computer", "artist-id-123", null);
    expect(id1).toBe(id2);
  });

  it("should produce different IDs for different artists with same album name", () => {
    const id1 = generateReleaseGroupId("Album", "artist-1", null);
    const id2 = generateReleaseGroupId("Album", "artist-2", null);
    expect(id1).not.toBe(id2);
  });
});

describe("generateReleaseId", () => {
  it("should use release MBID when available", () => {
    const id1 = generateReleaseId("OK Computer", "rg-id-123", "release-mbid-456");
    const id2 = generateReleaseId("OK Computer", "rg-id-123", "release-mbid-456");
    expect(id1).toBe(id2);
  });

  it("should use release group ID + name when no MBID", () => {
    const id1 = generateReleaseId("ok computer", "rg-id-123", null);
    const id2 = generateReleaseId("ok computer", "rg-id-123", null);
    expect(id1).toBe(id2);
  });

  it("should produce different IDs for different releases in same release group", () => {
    const id1 = generateReleaseId("OK Computer", "rg-id-123", null);
    const id2 = generateReleaseId("OK Computer (Deluxe)", "rg-id-123", null);
    expect(id1).not.toBe(id2);
  });

  it("should distinguish non-MBID releases that share name+RG but differ in track count", () => {
    const id1 = generateReleaseId("old ideas", "rg-id-123", null, 1);
    const id2 = generateReleaseId("old ideas", "rg-id-123", null, 8);
    expect(id1).not.toBe(id2);
  });

  it("should be stable for non-MBID releases with same name+RG+trackCount", () => {
    const id1 = generateReleaseId("old ideas", "rg-id-123", null, 8);
    const id2 = generateReleaseId("old ideas", "rg-id-123", null, 8);
    expect(id1).toBe(id2);
  });
});

describe("generateTrackId", () => {
  it("should use recording MBID when available", () => {
    const id1 = generateTrackId("Paranoid Android", "artist-id", "release-id", "recording-mbid", 1, 1);
    const id2 = generateTrackId("Paranoid Android", "artist-id", "release-id", "recording-mbid", 1, 1);
    expect(id1).toBe(id2);
  });

  it("should use artist + release + title + position when no MBID", () => {
    const id1 = generateTrackId("paranoid android", "artist-id", "release-id", null, 1, 1, 384000);
    const id2 = generateTrackId("paranoid android", "artist-id", "release-id", null, 1, 1, 384000);
    expect(id1).toBe(id2);
  });

  it("should produce different IDs for different track numbers", () => {
    const id1 = generateTrackId("track", "artist-id", "release-id", null, 1, 1, 384000);
    const id2 = generateTrackId("track", "artist-id", "release-id", null, 2, 1, 384000);
    expect(id1).not.toBe(id2);
  });

  it("should produce different IDs for different disc numbers", () => {
    const id1 = generateTrackId("track", "artist-id", "release-id", null, 1, 1, 384000);
    const id2 = generateTrackId("track", "artist-id", "release-id", null, 1, 2, 384000);
    expect(id1).not.toBe(id2);
  });

  it("should handle null track numbers", () => {
    const id1 = generateTrackId("track", "artist-id", "release-id", null, null, null, null);
    const id2 = generateTrackId("track", "artist-id", "release-id", null, null, null, null);
    expect(id1).toBe(id2);
  });

  it("should distinguish the same recording MBID across different releases", () => {
    // MusicBrainz recordings can legitimately appear on multiple releases
    // (single + album + compilation). Each should resolve to its own
    // unified_track scoped by releaseId.
    const mbid = "7a7d7fb7-075b-4fdc-8c5e-9b5e03ee00b3";
    const idSingle = generateTrackId("setting sun", "artist", "release-single", mbid, 1, 1, 322000);
    const idAlbum = generateTrackId("setting sun", "artist", "release-album", mbid, 5, 1, 329000);
    expect(idSingle).not.toBe(idAlbum);
  });

  it("should be stable for the same MBID on the same release", () => {
    const mbid = "rec-mbid";
    const id1 = generateTrackId("song", "artist", "release-1", mbid, 1, 1, 200000);
    const id2 = generateTrackId("different title", "artist", "release-1", mbid, 7, 2, 999999);
    expect(id1).toBe(id2);
  });
});

describe("generateTrackSourceId", () => {
  it("should produce consistent IDs for same track and instance", () => {
    const id1 = generateTrackSourceId("track-id-123", "instance-1");
    const id2 = generateTrackSourceId("track-id-123", "instance-1");
    expect(id1).toBe(id2);
  });

  it("should produce different IDs for different instances", () => {
    const id1 = generateTrackSourceId("track-id-123", "instance-1");
    const id2 = generateTrackSourceId("track-id-123", "instance-2");
    expect(id1).not.toBe(id2);
  });

  it("should produce different IDs for different tracks", () => {
    const id1 = generateTrackSourceId("track-id-1", "instance-1");
    const id2 = generateTrackSourceId("track-id-2", "instance-1");
    expect(id1).not.toBe(id2);
  });
});

describe("Cross-peer ID stability", () => {
  it("should produce identical artist IDs across peers for same MBID", () => {
    // Simulating two peers generating IDs for the same artist
    const peer1Id = generateArtistId("Radiohead", "7oPftvlwr6VrsViSDV5f");
    const peer2Id = generateArtistId("Radiohead", "7oPftvlwr6VrsViSDV5f");
    expect(peer1Id).toBe(peer2Id);
  });

  it("should produce identical track IDs across peers for same recording MBID", () => {
    const peer1Id = generateTrackId(
      "Paranoid Android",
      "artist-id-from-mbid",
      "release-id-from-mbid",
      "b1392451-e5e6-4dc7-b74d-7c4c6c0e5c0e",
      1,
      1,
    );
    const peer2Id = generateTrackId(
      "Paranoid Android",
      "artist-id-from-mbid",
      "release-id-from-mbid",
      "b1392451-e5e6-4dc7-b74d-7c4c6c0e5c0e",
      1,
      1,
    );
    expect(peer1Id).toBe(peer2Id);
  });

  it("should produce identical IDs for fallback matching across peers", () => {
    const peer1Id = generateTrackId(
      "comfortably numb",
      "pink-floyd-id",
      "the-wall-id",
      null,
      6,
      1,
      384000,
    );
    const peer2Id = generateTrackId(
      "comfortably numb",
      "pink-floyd-id",
      "the-wall-id",
      null,
      6,
      1,
      384000,
    );
    expect(peer1Id).toBe(peer2Id);
  });
});
