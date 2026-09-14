/**
 * Detect a Subsonic error envelope where audio bytes were expected (#285).
 *
 * Navidrome answers a failed `/rest/stream` (stale track ID, file gone) with
 * HTTP 200 + `<error code="70" .../>` (XML, or JSON under `f=json`). Relaying
 * that as a 200 audio response hands clients ~200 bytes of XML to decode and
 * records a successful transfer. Binary routes must check the content-type
 * before piping and map the envelope to a real HTTP error.
 */

import type { IncomingMessage } from "node:http";

/** Subsonic "data not found" — the requested ID doesn't exist upstream. */
const SUBSONIC_NOT_FOUND = 70;

/** Envelopes are a few hundred bytes; never buffer more than this. */
const MAX_ENVELOPE_BYTES = 64 * 1024;

const ENVELOPE_MIME_TYPES = new Set(["application/xml", "text/xml", "application/json"]);

export interface UpstreamEnvelopeError {
  /** 404 for Subsonic code 70, 502 for anything else. */
  httpStatus: 404 | 502;
  /** Subsonic error code, or null when the body had none. */
  code: number | null;
}

export function isSubsonicEnvelopeType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return ENVELOPE_MIME_TYPES.has(mime);
}

/** Extract the Subsonic error code from an XML or JSON envelope body. */
export function parseSubsonicEnvelopeError(body: string): UpstreamEnvelopeError {
  let code: number | null = null;
  try {
    const parsed = JSON.parse(body) as { "subsonic-response"?: { error?: { code?: unknown } } };
    const raw = parsed["subsonic-response"]?.error?.code;
    if (typeof raw === "number") code = raw;
  } catch {
    const m = /<error\b[^>]*\bcode\s*=\s*["'](\d+)["']/.exec(body);
    if (m) code = Number(m[1]);
  }
  return { httpStatus: code === SUBSONIC_NOT_FOUND ? 404 : 502, code };
}

/** Human-readable reason for `stream_operations.error`. Never echoes upstream text (#156). */
export function describeEnvelopeError(err: UpstreamEnvelopeError): string {
  return err.code === null
    ? "Source returned a Subsonic error envelope"
    : `Source returned Subsonic error ${err.code}`;
}

/**
 * If a fetch `Response` carries a Subsonic envelope, consume it (capped) and
 * return the mapped error. Returns null — body untouched — for anything else.
 */
export async function readEnvelopeError(response: Response): Promise<UpstreamEnvelopeError | null> {
  if (!isSubsonicEnvelopeType(response.headers.get("content-type"))) return null;
  if (!response.body) return parseSubsonicEnvelopeError("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (total < MAX_ENVELOPE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return parseSubsonicEnvelopeError(Buffer.concat(chunks).toString("utf8"));
}

/** `readEnvelopeError` for a raw `http.IncomingMessage` (federation stream proxy). */
export async function readIncomingEnvelopeError(
  message: IncomingMessage,
): Promise<UpstreamEnvelopeError | null> {
  if (!isSubsonicEnvelopeType(message.headers["content-type"])) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of message) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    total += buf.length;
    if (total >= MAX_ENVELOPE_BYTES) break;
  }
  message.destroy();
  return parseSubsonicEnvelopeError(Buffer.concat(chunks).toString("utf8"));
}
