import type { SonosDevice } from "./sonos-discovery.js";

type Service = "AVTransport" | "RenderingControl";

const SERVICE_PATHS: Record<Service, { control: string; serviceType: string }> = {
  AVTransport: {
    control: "/MediaRenderer/AVTransport/Control",
    serviceType: "urn:schemas-upnp-org:service:AVTransport:1",
  },
  RenderingControl: {
    control: "/MediaRenderer/RenderingControl/Control",
    serviceType: "urn:schemas-upnp-org:service:RenderingControl:1",
  },
};

export interface TrackMetadata {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  /** Absolute URL to cover art reachable from the Sonos device, or null. */
  albumArtUri?: string | null;
  /** Track duration in seconds. */
  durationSec: number;
  /** Stream content-type hint (e.g. "audio/mpeg"). */
  mimeType?: string;
}

export interface TransportState {
  /** PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING | NO_MEDIA_PRESENT */
  state: string;
  /** Current track position in seconds. */
  position: number;
  /** Current track duration in seconds (per device). */
  duration: number;
}

const xmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
      : c === "<" ? "&lt;"
        : c === ">" ? "&gt;"
          : c === '"' ? "&quot;"
            : "&apos;",
  );

/**
 * Build the DIDL-Lite metadata blob that Sonos expects in the
 * CurrentURIMetaData argument of SetAVTransportURI.
 */
export function buildDidlLite(meta: TrackMetadata, streamUri: string): string {
  const mime = meta.mimeType ?? "audio/mpeg";
  const protocolInfo = `http-get:*:${mime}:*`;
  const art = meta.albumArtUri
    ? `<upnp:albumArtURI>${xmlEscape(meta.albumArtUri)}</upnp:albumArtURI>`
    : "";
  return [
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"`,
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"`,
    ` xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">`,
    `<item id="poutine-${xmlEscape(meta.trackId)}" parentID="-1" restricted="1">`,
    `<dc:title>${xmlEscape(meta.title)}</dc:title>`,
    `<dc:creator>${xmlEscape(meta.artist)}</dc:creator>`,
    `<upnp:album>${xmlEscape(meta.album)}</upnp:album>`,
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>`,
    art,
    `<res protocolInfo="${protocolInfo}" duration="${formatHmsForRes(meta.durationSec)}">${xmlEscape(streamUri)}</res>`,
    `</item>`,
    `</DIDL-Lite>`,
  ].join("");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function formatHmsForRes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s / 60) % 60))}:${pad2(s % 60)}.000`;
}

function parseHms(s: string): number {
  if (!s || s === "NOT_IMPLEMENTED") return 0;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function pickXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

/**
 * Wrap arguments in a SOAP envelope for the given UPnP action.
 */
export function buildSoapEnvelope(
  service: Service,
  action: string,
  args: Record<string, string | number>,
): string {
  const serviceType = SERVICE_PATHS[service].serviceType;
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
 * SOAP client for Sonos AVTransport + RenderingControl. Uses InstanceID=0
 * and Channel="Master" — Sonos only supports those.
 */
export class SonosControl {
  async setAvTransportUri(
    device: SonosDevice,
    streamUri: string,
    meta: TrackMetadata,
  ): Promise<void> {
    const didl = buildDidlLite(meta, streamUri);
    await this.soap(device, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: streamUri,
      CurrentURIMetaData: didl,
    });
  }

  async play(device: SonosDevice): Promise<void> {
    await this.soap(device, "AVTransport", "Play", {
      InstanceID: 0,
      Speed: "1",
    });
  }

  async pause(device: SonosDevice): Promise<void> {
    await this.soap(device, "AVTransport", "Pause", { InstanceID: 0 });
  }

  async stop(device: SonosDevice): Promise<void> {
    await this.soap(device, "AVTransport", "Stop", { InstanceID: 0 });
  }

  async seek(device: SonosDevice, positionSec: number): Promise<void> {
    await this.soap(device, "AVTransport", "Seek", {
      InstanceID: 0,
      Unit: "REL_TIME",
      Target: formatHmsForRes(positionSec).slice(0, 8),
    });
  }

  async setVolume(device: SonosDevice, level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await this.soap(device, "RenderingControl", "SetVolume", {
      InstanceID: 0,
      Channel: "Master",
      DesiredVolume: clamped,
    });
  }

  async getVolume(device: SonosDevice): Promise<number> {
    const xml = await this.soap(device, "RenderingControl", "GetVolume", {
      InstanceID: 0,
      Channel: "Master",
    });
    const v = pickXmlTag(xml, "CurrentVolume");
    return v ? parseInt(v, 10) : 0;
  }

  async getState(device: SonosDevice): Promise<TransportState> {
    const transport = await this.soap(device, "AVTransport", "GetTransportInfo", {
      InstanceID: 0,
    });
    const state = pickXmlTag(transport, "CurrentTransportState") ?? "STOPPED";
    const pos = await this.soap(device, "AVTransport", "GetPositionInfo", {
      InstanceID: 0,
    });
    return {
      state,
      position: parseHms(pickXmlTag(pos, "RelTime") ?? "00:00:00"),
      duration: parseHms(pickXmlTag(pos, "TrackDuration") ?? "00:00:00"),
    };
  }

  private async soap(
    device: SonosDevice,
    service: Service,
    action: string,
    args: Record<string, string | number>,
  ): Promise<string> {
    const { control, serviceType } = SERVICE_PATHS[service];
    const body = buildSoapEnvelope(service, action, args);
    const url = `http://${device.ip}:${device.port}${control}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": 'text/xml; charset="utf-8"',
          soapaction: `"${serviceType}#${action}"`,
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `Sonos SOAP ${action} on ${device.room} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
        );
      }
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}
