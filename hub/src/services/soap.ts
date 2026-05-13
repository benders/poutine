/**
 * Shared UPnP/SOAP helpers — used by the Sonos casting client and the DLNA
 * MediaServer. Both speak SOAP-over-HTTP with the same envelope shape, so
 * the envelope builder and a couple of XML primitives live here.
 */

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
      : c === "<" ? "&lt;"
        : c === ">" ? "&gt;"
          : c === '"' ? "&quot;"
            : "&apos;",
  );
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
 * Pick the first text content of `<tag>` in `xml`. Ignores namespace prefixes.
 * Returns null if not found. Decodes the common XML entities so callers
 * receive plain text.
 */
export function pickXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeEntities(m[1]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
