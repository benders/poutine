import type { SonosDevice } from "./sonos-discovery.js";
import {
  buildSoapEnvelope,
  pickXmlTag,
  formatUpnpDuration,
  parseUpnpDuration,
} from "./soap.js";
import { buildDidlLiteTrack, type TrackMetadata } from "./didl.js";

export type { TrackMetadata } from "./didl.js";

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

export interface TransportState {
  /** PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING | NO_MEDIA_PRESENT */
  state: string;
  position: number;
  duration: number;
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
      position: parseUpnpDuration(pickXmlTag(pos, "RelTime") ?? "00:00:00"),
      duration: parseUpnpDuration(pickXmlTag(pos, "TrackDuration") ?? "00:00:00"),
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
