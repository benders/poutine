import type { SonosDevice } from "./sonos-discovery.js";
import {
  buildSoapEnvelope,
  pickXmlTag,
  formatUpnpDuration,
  parseUpnpDuration,
} from "./soap.js";
import { buildDidlLiteTrack, type TrackMetadata } from "./didl.js";

export type { TrackMetadata } from "./didl.js";

/**
 * Default ceiling for any SetVolume we issue. Sonos can reach physically
 * unsafe loudness at higher values, and the SPA's `volume` slider is
 * often pinned near max because the user's computer volume is the real
 * gain control. Re-clamping at the service layer makes every code path
 * — routes, future schedulers, retries — uniformly safe.
 *
 * The runtime cap is admin-configurable via the `sonos_volume_cap` setting
 * (issue #184); callers should pass the live value from `app.sonosSettings`.
 * This constant is the fallback default used at first boot.
 */
export const SONOS_VOLUME_CAP = 50;

type Service =
  | "AVTransport"
  | "RenderingControl"
  | "ZoneGroupTopology"
  | "ConnectionManager";

const SERVICE_PATHS: Record<Service, { control: string; serviceType: string }> = {
  AVTransport: {
    control: "/MediaRenderer/AVTransport/Control",
    serviceType: "urn:schemas-upnp-org:service:AVTransport:1",
  },
  RenderingControl: {
    control: "/MediaRenderer/RenderingControl/Control",
    serviceType: "urn:schemas-upnp-org:service:RenderingControl:1",
  },
  ZoneGroupTopology: {
    control: "/ZoneGroupTopology/Control",
    serviceType: "urn:schemas-upnp-org:service:ZoneGroupTopology:1",
  },
  ConnectionManager: {
    control: "/MediaRenderer/ConnectionManager/Control",
    serviceType: "urn:schemas-upnp-org:service:ConnectionManager:1",
  },
};

/**
 * Mapping from `track_sources.format` (lowercase) to MIME candidates Sonos
 * may advertise in `ConnectionManager:GetProtocolInfo` Sink. First entry is
 * the canonical IANA value used in DIDL `protocolInfo`; later entries are
 * legacy aliases some firmware reports instead.
 *
 * Codecs missing from this table (ogg/opus/vorbis/wma/etc.) are not
 * Sonos-castable byte-for-byte — fall back to MP3 transcode.
 */
export const FORMAT_MIME_CANDIDATES: Record<string, string[]> = {
  flac: ["audio/flac", "audio/x-flac"],
  mp3: ["audio/mpeg"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  aac: ["audio/mp4", "audio/aac", "audio/aacp"],
  alac: ["audio/mp4"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
};

/**
 * Decide the AVTransport DIDL mime + whether the cast URL should request
 * an MP3 transcode, given the source file's format and the target device's
 * advertised Sink mime set.
 *
 * Always-safe default: MP3 transcode + `audio/mpeg`. Used when source
 * format is unknown, codec is not byte-for-byte castable (ogg/opus/…), or
 * the device's capability set is not yet known (probe pending / failed).
 */
export function chooseSonosCastFormat(
  sourceFormat: string | null | undefined,
  sinkMimes: Set<string> | null | undefined,
): { mime: string; transcode: boolean } {
  const fallback = { mime: "audio/mpeg", transcode: true } as const;
  const fmt = sourceFormat?.toLowerCase() ?? null;
  if (!fmt) return fallback;
  const candidates = FORMAT_MIME_CANDIDATES[fmt];
  if (!candidates) return fallback;
  if (!sinkMimes || sinkMimes.size === 0) return fallback;
  for (const m of candidates) {
    if (sinkMimes.has(m)) return { mime: m, transcode: false };
  }
  return fallback;
}

/**
 * Parse the `Sink` field of a `ConnectionManager:GetProtocolInfo` response.
 *
 * Wire format: comma-separated `protocol:network:mimeType:extras` entries,
 * e.g. `http-get:*:audio/mpeg:*,http-get:*:audio/flac:*,...`. Returns the
 * set of mime types from `http-get` entries. Other protocols (rtsp,
 * x-rincon-stream, x-sonos-spotify, …) are ignored — we only push bytes
 * over plain HTTP.
 */
export function parseSinkProtocolInfo(sink: string): Set<string> {
  const out = new Set<string>();
  for (const raw of sink.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split(":");
    if (parts.length < 3) continue;
    if (parts[0] !== "http-get") continue;
    const mime = parts[2].trim();
    if (mime) out.add(mime);
  }
  return out;
}

export interface TransportState {
  /** PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING | NO_MEDIA_PRESENT */
  state: string;
  position: number;
  duration: number;
  /**
   * Current TrackURI from `GetPositionInfo`. The SPA's poller compares this
   * across ticks to detect Sonos auto-advancing onto a pre-loaded next
   * track (#202) — a change between non-empty values means the device
   * transitioned tracks on its own and the store's currentIndex should
   * follow. Empty string when nothing is loaded.
   */
  trackUri: string;
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
    const didl = buildDidlLiteTrack(meta, streamUri);
    await this.soap(device, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: streamUri,
      CurrentURIMetaData: didl,
    });
  }

  /**
   * Pre-load the track Sonos should auto-advance to at end-of-current (#202).
   * Eliminates the PLAYING→STOPPED gap the SPA-driven one-track-at-a-time
   * model produces between tracks. Pass `""` + `null` to clear the slot
   * (queue end, sink switch); UPnP treats empty NextURI as "no follow-up".
   */
  async setNextAvTransportUri(
    device: SonosDevice,
    streamUri: string,
    meta: TrackMetadata | null,
  ): Promise<void> {
    const didl = streamUri && meta ? buildDidlLiteTrack(meta, streamUri) : "";
    await this.soap(device, "AVTransport", "SetNextAVTransportURI", {
      InstanceID: 0,
      NextURI: streamUri,
      NextURIMetaData: didl,
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
      Target: formatUpnpDuration(positionSec).slice(0, 8),
    });
  }

  async setVolume(
    device: SonosDevice,
    level: number,
    cap: number = SONOS_VOLUME_CAP,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(cap, Math.round(level)));
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

  /**
   * Returns the inner `<ZoneGroupState>` XML payload — the full household
   * topology in one shot. Used by discovery to collapse stereo pairs /
   * bonded zones (issue #177). Satellite UUIDs only appear here, not in
   * the lighter `GetZoneGroupAttributes` action.
   */
  async getZoneGroupState(device: SonosDevice): Promise<string> {
    const xml = await this.soap(device, "ZoneGroupTopology", "GetZoneGroupState", {});
    return pickXmlTag(xml, "ZoneGroupState") ?? "";
  }

  /**
   * Query `ConnectionManager:GetProtocolInfo` and return the parsed set of
   * `http-get` Sink mime types the device accepts. Discovery calls this
   * once per device lifecycle so the play route can pass FLAC/AAC/etc.
   * through verbatim when the target supports it (#180).
   */
  async getProtocolInfo(device: SonosDevice): Promise<Set<string>> {
    const xml = await this.soap(device, "ConnectionManager", "GetProtocolInfo", {});
    return parseSinkProtocolInfo(pickXmlTag(xml, "Sink") ?? "");
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
      position: parseUpnpDuration(pickXmlTag(pos, "RelTime") ?? "00:00:00"),
      duration: parseUpnpDuration(pickXmlTag(pos, "TrackDuration") ?? "00:00:00"),
      trackUri: pickXmlTag(pos, "TrackURI") ?? "",
    };
  }

  private async soap(
    device: SonosDevice,
    service: Service,
    action: string,
    args: Record<string, string | number>,
  ): Promise<string> {
    const { control, serviceType } = SERVICE_PATHS[service];
    const body = buildSoapEnvelope(serviceType, action, args);
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
