import type { FastifyReply } from "fastify";

export const SUBSONIC_VERSION = "1.16.1";
export const SERVER_TYPE = "poutine";
export const SERVER_VERSION = "0.1.0";

export type Format = "json" | "xml";

export function getFormat(query: Record<string, string>): Format {
  return query.f === "xml" ? "xml" : "json";
}

// ── XML serializer ────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Recursively serialize a value to XML.
 * - Scalars (string/number/boolean) on an object → XML attributes
 * - Arrays → repeated child elements with the same tag
 * - Nested objects → child elements
 */
function xmlNode(tag: string, value: unknown): string {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    return value.map((item) => xmlNode(tag, item)).join("");
  }

  if (typeof value !== "object") {
    return `<${tag}>${escapeXml(String(value))}</${tag}>`;
  }

  const obj = value as Record<string, unknown>;
  const attrs: string[] = [];
  const children: string[] = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      attrs.push(`${k}="${escapeXml(String(v))}"`);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        children.push(xmlNode(k, item));
      }
    } else {
      children.push(xmlNode(k, v));
    }
  }

  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  if (children.length === 0) {
    return `<${tag}${attrStr}/>`;
  }
  return `<${tag}${attrStr}>${children.join("")}</${tag}>`;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function baseEnvelope(status: "ok" | "failed"): Record<string, unknown> {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  };
}

export function sendSubsonicOk(
  reply: FastifyReply,
  query: Record<string, string>,
  payload: Record<string, unknown>,
): void {
  const fmt = getFormat(query);
  const envelope = { ...baseEnvelope("ok"), ...payload };

  if (fmt === "xml") {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      xmlNode("subsonic-response", {
        ...envelope,
        xmlns: "http://subsonic.org/restapi",
      });
    void reply
      .code(200)
      .header("content-type", "application/xml; charset=utf-8")
      .send(body);
  } else {
    void reply
      .code(200)
      .header("content-type", "application/json; charset=utf-8")
      .send({ "subsonic-response": envelope });
  }
}

export function sendSubsonicError(
  reply: FastifyReply,
  code: number,
  message: string,
  query: Record<string, string>,
): void {
  const fmt = getFormat(query);
  // Subsonic always returns HTTP 200, even for errors
  const envelope = {
    ...baseEnvelope("failed"),
    error: { code, message },
  };

  if (fmt === "xml") {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      xmlNode("subsonic-response", {
        ...envelope,
        xmlns: "http://subsonic.org/restapi",
      });
    void reply
      .code(200)
      .header("content-type", "application/xml; charset=utf-8")
      .send(body);
  } else {
    void reply
      .code(200)
      .header("content-type", "application/json; charset=utf-8")
      .send({ "subsonic-response": envelope });
  }
}

// ── ID encoding ───────────────────────────────────────────────────────────────

export function encodeId(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

/**
 * Decode a prefixed ID (e.g. "ar<uuid>") back to the raw ID.
 * Throws if the prefix doesn't match — callers should catch and return error 70.
 */
export function decodeId(prefixed: string, expectedPrefix: string): string {
  if (!prefixed.startsWith(expectedPrefix)) {
    throw new Error(
      `Expected ID with prefix "${expectedPrefix}", got "${prefixed}"`,
    );
  }
  return prefixed.slice(expectedPrefix.length);
}
