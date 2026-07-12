/**
 * External cover-art URL allowlist.
 *
 * `instance_albums.cover_art_id` may hold a full https URL when the cover
 * came from fanart.tv. The Subsonic getCoverArt route fetches such URLs
 * directly, so the value must be constrained to prevent SSRF — peers
 * federate `cover_art_id` values, and an attacker-controlled peer could
 * otherwise point us at intranet endpoints.
 */

const ALLOWED_HOSTNAMES: readonly string[] = [
  "fanart.tv",
  "assets.fanart.tv",
  // Last.fm artist-image CDN (fallback source for artists without an MBID).
  "lastfm.freetls.fastly.net",
];

const ALLOWED_SUFFIXES: readonly string[] = [".fanart.tv"];

export function isAllowedExternalArtUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_HOSTNAMES.includes(host)) return true;
  return ALLOWED_SUFFIXES.some((sfx) => host.endsWith(sfx));
}
