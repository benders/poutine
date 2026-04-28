import crypto from "node:crypto";

export function generateDeterministicId(...inputs: string[]): string {
  const combined = inputs.join("\0");
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function generateArtistId(nameNormalized: string, musicbrainzId: string | null): string {
  if (musicbrainzId) {
    return generateDeterministicId("artist", musicbrainzId);
  }
  return generateDeterministicId("artist", nameNormalized);
}

export function generateReleaseGroupId(
  nameNormalized: string,
  artistId: string,
  releaseGroupMbid: string | null,
): string {
  if (releaseGroupMbid) {
    return generateDeterministicId("release_group", releaseGroupMbid);
  }
  return generateDeterministicId("release_group", artistId, nameNormalized);
}

export function generateReleaseId(
  nameNormalized: string,
  releaseGroupId: string,
  musicbrainzId: string | null,
  trackCount: number | null = null,
): string {
  if (musicbrainzId) {
    return generateDeterministicId("release", musicbrainzId);
  }
  return generateDeterministicId(
    "release",
    releaseGroupId,
    nameNormalized,
    trackCount?.toString() ?? "null",
  );
}

export function generateTrackId(
  titleNormalized: string,
  artistId: string,
  releaseId: string,
  musicbrainzId: string | null,
  trackNumber: number | null,
  discNumber: number | null,
  durationMs: number | null = null,
): string {
  if (musicbrainzId) {
    // A MusicBrainz recording MBID is unique per recording, but the same
    // recording can legitimately appear on multiple releases (single, album,
    // compilation). Scope the id by releaseId so two appearances become two
    // unified_tracks rather than colliding on the PK.
    return generateDeterministicId("track", releaseId, musicbrainzId);
  }
  return generateDeterministicId(
    "track",
    artistId,
    releaseId,
    titleNormalized,
    trackNumber?.toString() ?? "null",
    discNumber?.toString() ?? "null",
    durationMs?.toString() ?? "null",
  );
}

export function generateTrackSourceId(
  unifiedTrackId: string,
  instanceId: string,
  instanceTrackId: string,
): string {
  // An instance can legitimately hold multiple files for one unified track
  // (e.g. an alt-take and a main take that share a recording MBID, or
  // duplicate rips). The schema's UNIQUE(unified_track_id, instance_track_id)
  // already permits this, so the source id must include instanceTrackId.
  return generateDeterministicId("track_source", unifiedTrackId, instanceId, instanceTrackId);
}
