/**
 * Cover art ID encoding/decoding helpers.
 *
 * Cover art IDs are stored in {instanceId}:{coverArtId} format so the hub
 * knows which upstream to query when serving art. The instanceId is always
 * the first colon-delimited segment; the rest is the (potentially colon-
 * containing) remote cover art ID.
 */

export function encodeCoverArtId(
  instanceId: string,
  coverArtId: string,
): string {
  return `${instanceId}:${coverArtId}`;
}

export function decodeCoverArtId(
  encoded: string,
): { instanceId: string; coverArtId: string } {
  const colonIdx = encoded.indexOf(":");
  if (colonIdx === -1) {
    throw new Error("Invalid cover art ID format");
  }
  return {
    instanceId: encoded.slice(0, colonIdx),
    coverArtId: encoded.slice(colonIdx + 1),
  };
}
