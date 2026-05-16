/**
 * Shared UPnP/SOAP helpers — used by the Sonos casting client and the DLNA
 * MediaServer. Both speak SOAP-over-HTTP with the same envelope shape, so
 * the envelope builder and a couple of XML primitives live here.
 */
import { XMLParser } from "fast-xml-parser";

const XML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);
}

/**
 * Build a SOAP 1.1 envelope wrapping the given UPnP action.
 *
 * `serviceType` is the full UPnP service URN, e.g.
 * `urn:schemas-upnp-org:service:AVTransport:1`.
 */
export function buildSoapEnvelope(
  serviceType: string,
  action: string,
  args: Record<string, string | number>,
): string {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}>
</s:Body>
</s:Envelope>`;
}

/**
 * Build a SOAP response envelope. Used when serving SOAP control endpoints
 * (e.g. the DLNA ContentDirectory `BrowseResponse`).
 */
export function buildSoapResponse(
  serviceType: string,
  action: string,
  args: Record<string, string>,
): string {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${action}Response xmlns:u="${serviceType}">${argXml}</u:${action}Response>
</s:Body>
</s:Envelope>`;
}

/**
 * Single-pass parser tuned for SOAP-action argument extraction. Strips
 * namespace prefixes so callers can name args by their local tag (`Browse`
 * args travel as `<ObjectID>…` with no prefix, but `<u:Browse>` wraps them
 * and `<s:Body>` wraps that — `removeNSPrefix` flattens both).
 */
const SOAP_ARG_PARSER = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Treat text as string; UPnP arg values are always strings on the wire.
  parseTagValue: false,
  trimValues: true,
});

/**
 * Look up the first text value for a given UPnP action argument name in a
 * SOAP request body. Returns null when not present. Namespace prefixes on
 * the request envelope are ignored.
 *
 * Uses fast-xml-parser rather than a regex so nested same-named elements
 * or CDATA can't trick us — important when ContentDirectory `Search` lands
 * and starts carrying user-supplied criteria strings.
 */
export function pickXmlTag(xml: string, tag: string): string | null {
  let parsed: unknown;
  try {
    parsed = SOAP_ARG_PARSER.parse(xml);
  } catch {
    return null;
  }
  const found = findFirstNamed(parsed, tag);
  if (found === null || found === undefined) return null;
  if (typeof found === "string") return found;
  if (typeof found === "number" || typeof found === "boolean") {
    return String(found);
  }
  if (typeof found === "object") {
    // Self-closing tag (`<ObjectID/>`) parses to {} — treat as empty string,
    // matching the `<ObjectID></ObjectID>` case the old regex returned "".
    return "";
  }
  return null;
}

function findFirstNamed(node: unknown, tag: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirstNamed(item, tag);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, tag)) {
    const v = obj[tag];
    // If multiple same-named children at this level, prefer the first.
    if (Array.isArray(v)) return v[0];
    return v;
  }
  for (const key of Object.keys(obj)) {
    const hit = findFirstNamed(obj[key], tag);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Parse a `SOAPACTION` header into `{ serviceType, action }`. Header value
 * looks like `"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"`.
 */
export function parseSoapAction(
  header: string | undefined,
): { serviceType: string; action: string } | null {
  if (!header) return null;
  const v = header.replace(/^"|"$/g, "");
  const hash = v.lastIndexOf("#");
  if (hash < 0) return null;
  return { serviceType: v.slice(0, hash), action: v.slice(hash + 1) };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format seconds as `HH:MM:SS.000` for the UPnP `res@duration` attribute. */
export function formatUpnpDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s / 60) % 60))}:${pad2(s % 60)}.000`;
}

/** Parse a `HH:MM:SS` (or `MM:SS`) duration into seconds. */
export function parseUpnpDuration(s: string): number {
  if (!s || s === "NOT_IMPLEMENTED") return 0;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}
