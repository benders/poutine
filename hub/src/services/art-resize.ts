/**
 * Downsamples externally-fetched cover art (fanart.tv / Last.fm) to the
 * requested dimension before it's cached and served. Local and peer art is
 * already resized upstream by Navidrome, so this is only wired into the
 * external-URL branch of `/rest/getCoverArt`.
 */
import sharp from "sharp";

export interface ResizedImage {
  data: Buffer;
  contentType: string;
}

const SKIP_CONTENT_TYPES = new Set(["image/gif", "image/svg+xml"]);

/**
 * Resize `data` to fit within `maxDim`x`maxDim`, preserving aspect ratio and
 * never enlarging. Animated GIFs and SVGs are passed through unchanged
 * (frame-drop / rasterization edge cases aren't worth handling here). Any
 * sharp failure (corrupt/unparseable upstream bytes) also falls back to the
 * original buffer — a bad image is served as-is, exactly like before this
 * resize step existed.
 */
export async function resizeImage(
  data: Buffer,
  contentType: string,
  maxDim: number,
): Promise<ResizedImage> {
  if (SKIP_CONTENT_TYPES.has(contentType)) {
    return { data, contentType };
  }

  try {
    const resized = await sharp(data)
      .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    return { data: resized, contentType };
  } catch {
    return { data, contentType };
  }
}
