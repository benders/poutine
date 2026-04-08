export interface SelectableSource {
  remoteId: string;
  format: string | null;
  bitrate: number | null;
  sourceKind: "local" | "peer";
  peerId: string | null;
}

const FORMAT_QUALITY: Record<string, number> = {
  flac: 100,
  wav: 90,
  alac: 85,
  opus: 70,
  aac: 60,
  mp3: 50,
  ogg: 45,
};

function scoreSource(
  source: SelectableSource,
  requestedFormat?: string,
): number {
  let score = 0;

  // Prefer exact format match (avoids transcoding)
  if (
    requestedFormat &&
    source.format &&
    source.format.toLowerCase() === requestedFormat.toLowerCase()
  ) {
    score += 200;
  }

  // Prefer higher quality format
  score += FORMAT_QUALITY[source.format?.toLowerCase() ?? ""] ?? 30;

  // Prefer higher bitrate
  score += (source.bitrate ?? 0) / 10;

  // Small tie-break bonus for local sources to avoid unnecessary peer hops
  if (source.sourceKind === "local") score += 5;

  return score;
}

export function selectBestSource(
  sources: SelectableSource[],
  requestedFormat?: string,
): SelectableSource | null {
  if (sources.length === 0) return null;

  let best = sources[0];
  let bestScore = scoreSource(best, requestedFormat);

  for (let i = 1; i < sources.length; i++) {
    const score = scoreSource(sources[i], requestedFormat);
    if (score > bestScore) {
      best = sources[i];
      bestScore = score;
    }
  }

  return best;
}
