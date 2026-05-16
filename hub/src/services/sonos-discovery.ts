import dgram from "node:dgram";

export interface SonosDevice {
  /** UPnP UUID (RINCON_xxx...) from the device description. */
  id: string;
  /** Sonos room name (e.g. "Living Room"). */
  room: string;
  /** Hardware model (e.g. "Sonos One"). */
  model: string;
  /** LAN IP address. */
  ip: string;
  /** Control port — always 1400 for Sonos. */
  port: number;
  /** Last time we saw an SSDP response or successful state poll. */
  lastSeen: Date;
}

const SSDP_MULTICAST_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const SONOS_PORT = 1400;
const SONOS_SEARCH_TARGET = "urn:schemas-upnp-org:device:ZonePlayer:1";

const M_SEARCH_PACKET = Buffer.from(
  [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 2",
    `ST: ${SONOS_SEARCH_TARGET}`,
    "",
    "",
  ].join("\r\n"),
);

/**
 * Parse an SSDP response into a header map. Returns null if not a Sonos device.
 */
export function parseSsdpResponse(buf: Buffer): {
  location: string;
  usn: string;
  server: string;
} | null {
  const text = buf.toString("utf8");
  const lines = text.split(/\r\n/);
  if (!lines[0] || !/^HTTP\/1\.\d 200/.test(lines[0])) return null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    const key = lines[i].slice(0, idx).trim().toLowerCase();
    const value = lines[i].slice(idx + 1).trim();
    headers[key] = value;
  }
  if (!headers.location || !headers.usn) return null;
  const server = headers.server || "";
  // Only accept Sonos devices.
  if (!/sonos/i.test(server) && !/Sonos/i.test(headers.usn)) return null;
  return { location: headers.location, usn: headers.usn, server };
}

/**
 * Extract the first capture group of the first matching tag. Tolerates
 * namespace prefixes (e.g. `<ns:UDN>`).
 */
function pickTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}>([^<]+)</(?:[\\w-]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse `/xml/device_description.xml` (or zone topology xml) into the device
 * fields we need. Returns null if any required field is missing.
 */
export function parseDeviceDescription(xml: string): {
  id: string;
  room: string;
  model: string;
} | null {
  // UDN looks like `uuid:RINCON_5CAAFD...` — strip the `uuid:` prefix.
  const udn = pickTag(xml, "UDN");
  const room = pickTag(xml, "roomName");
  const model = pickTag(xml, "modelName") || "Sonos";
  if (!udn || !room) return null;
  const id = udn.replace(/^uuid:/i, "");
  return { id, room, model };
}

export interface SonosDiscoveryOptions {
  /** Re-scan interval in ms. */
  intervalMs?: number;
  /** Drop devices we haven't heard from in this many ms. */
  staleAfterMs?: number;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
}

/**
 * SSDP discovery of Sonos ZonePlayer devices on the LAN.
 *
 * Requires multicast (network_mode: host in Docker). Devices are kept in
 * memory; the service does NOT itself control them — see SonosControl.
 */
export class SonosDiscoveryService {
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly devices = new Map<string, SonosDevice>();
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly log: { info: (msg: string) => void; error: (msg: string) => void };

  constructor(opts: SonosDiscoveryOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.staleAfterMs = opts.staleAfterMs ?? 3 * 60_000;
    this.log = opts.log ?? { info: () => {}, error: () => {} };
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;

    socket.on("message", (msg, rinfo) => {
      void this.handleResponse(msg, rinfo.address).catch((err) =>
        this.log.error(`Sonos: device description fetch failed: ${String(err)}`),
      );
    });

    socket.on("error", (err) => {
      this.log.error(`Sonos: SSDP socket error: ${err.message}`);
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
      } catch (err) {
        this.log.error(`Sonos: setMulticast failed: ${String(err)}`);
      }
      this.search();
      this.timer = setInterval(() => {
        this.search();
        this.evictStale();
      }, this.intervalMs);
      this.timer.unref();
      this.log.info(`Sonos discovery started (interval ${this.intervalMs}ms)`);
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }
  }

  /** Snapshot of currently-known devices. */
  list(): SonosDevice[] {
    return Array.from(this.devices.values()).sort((a, b) =>
      a.room.localeCompare(b.room),
    );
  }

  get(id: string): SonosDevice | undefined {
    return this.devices.get(id);
  }

  /** Send one M-SEARCH packet to the SSDP multicast group. */
  private search(): void {
    if (!this.socket) return;
    this.socket.send(
      M_SEARCH_PACKET,
      0,
      M_SEARCH_PACKET.length,
      SSDP_PORT,
      SSDP_MULTICAST_ADDR,
      (err) => {
        if (err) this.log.error(`Sonos: M-SEARCH send failed: ${err.message}`);
      },
    );
  }

  private async handleResponse(msg: Buffer, address: string): Promise<void> {
    const parsed = parseSsdpResponse(msg);
    if (!parsed) return;
    const url = new URL(parsed.location);
    // Trust the responding address over the URL host — devices sometimes
    // advertise hostnames that don't resolve from the hub.
    const ip = address || url.hostname;
    const desc = await this.fetchDescription(parsed.location);
    if (!desc) return;
    this.devices.set(desc.id, {
      id: desc.id,
      room: desc.room,
      model: desc.model,
      ip,
      port: SONOS_PORT,
      lastSeen: new Date(),
    });
  }

  private async fetchDescription(
    location: string,
  ): Promise<{ id: string; room: string; model: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(location, { signal: controller.signal });
      if (!res.ok) return null;
      const xml = await res.text();
      return parseDeviceDescription(xml);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.staleAfterMs;
    for (const [id, dev] of this.devices) {
      if (dev.lastSeen.getTime() < cutoff) {
        this.devices.delete(id);
        this.log.info(`Sonos: evicted stale device ${dev.room} (${id})`);
      }
    }
  }
}
