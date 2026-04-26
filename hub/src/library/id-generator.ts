/**
 * Deterministic ID generation for stable unified entity IDs.
 *
 * IDs are derived from content using SHA-256 hashing, ensuring:
 * - Same content always produces the same ID across all peers
 * - IDs remain stable across database rebuilds
 * - Consistent ID format (UUID-like, 32 hex chars)
 */

import crypto from "node:crypto";

/**
 * Generate a deterministic UUID-like ID from input strings.
 * Uses SHA-256 and formats as a UUID (8-4-4-4-12 hex pattern).
 */
export function generateDeterministicId(...inputs: string[]): string {
  const combined = inputs.join("|");
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate a deterministic artist ID.
 * Priority: MusicBrainz ID if available, otherwise normalized name.
 */
export function generateArtistId(name: string, musicbrainzId: string | null): string {
  if (musicbrainzId) {
    return generateDeterministicId("artist", musicbrainzId);
  }
  return generateDeterministicId("artist", name);
}

/**
 * Generate a deterministic release group ID.
 * Priority: Release group MBID if available, otherwise artist ID + normalized name.
 */
export function generateReleaseGroupId(
  name: string,
  artistId: string,
  releaseGroupMbid: string | null,
): string {
  if (releaseGroupMbid) {
    return generateDeterministicId("release_group", releaseGroupMbid);
  }
  return generateDeterministicId("release_group", artistId, name);
}

/**
 * Generate a deterministic release ID.
 * Priority: Release MBID if available, otherwise release group ID + name.
 */
export function generateReleaseId(
  name: string,
  releaseGroupId: string,
  musicbrainzId: string | null,
): string {
  if (musicbrainzId) {
    return generateDeterministicId("release", musicbrainzId);
  }
  return generateDeterministicId("release", releaseGroupId, name);
}

/**
 * Generate a deterministic track ID.
 * Priority: Recording MBID if available, otherwise artist + release + title + position.
 */
export function generateTrackId(
  title: string,
  artistId: string,
  releaseId: string,
  musicbrainzId: string | null,
  trackNumber: number | null,
  discNumber: number | null,
): string {
  if (musicbrainzId) {
    return generateDeterministicId("track", musicbrainzId);
  }
  return generateDeterministicId(
    "track",
    artistId,
    releaseId,
    title,
    trackNumber?.toString() ?? "null",
    discNumber?.toString() ?? "1",
  );
}

/**
 * Generate a deterministic track source ID.
 * Based on unified track ID + instance ID.
 */
export function generateTrackSourceId(unifiedTrackId: string, instanceId: string): string {
  return generateDeterministicId("track_source", unifiedTrackId, instanceId);
}
