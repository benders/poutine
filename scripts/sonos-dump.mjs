#!/usr/bin/env node
// Dump everything we can pull from a Sonos ZonePlayer over UPnP.
// Usage: node scripts/sonos-dump.mjs <ip> [--json]
//
// Read-only. Hits /xml/device_description.xml, every SCPD it points at,
// and a curated set of "Get*" / List* SOAP actions across the common services.

import { argv, exit } from "node:process";

const ip = argv[2];
const asJson = argv.includes("--json");
if (!ip || ip.startsWith("--")) {
  console.error("usage: sonos-dump.mjs <ip> [--json]");
  exit(2);
}

const BASE = `http://${ip}:1400`;
const TIMEOUT_MS = 4000;

async function http(path, init = {}) {
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${BASE}${path}`, { ...init, signal: ctl });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function pick(xml, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
}
function pickAll(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

async function soap(controlPath, serviceType, action, args = {}) {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  try {
    const res = await fetch(`${BASE}${controlPath}`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${action}"`,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, fault: extractFault(text) };
    // Strip the SOAP envelope, return the action response payload as a key/value map.
    const respTag = `${action}Response`;
    const inner = pick(text, respTag) ?? text;
    const kv = {};
    const fieldRe = /<([\w-]+)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = fieldRe.exec(inner)) !== null) {
      kv[m[1]] = m[2];
    }
    return { ok: true, fields: kv };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function extractFault(xml) {
  return {
    code: pick(xml, "errorCode"),
    desc: pick(xml, "errorDescription"),
    faultString: pick(xml, "faultstring"),
  };
}

// ---------- gather ----------

const out = { ip, base: BASE, fetchedAt: new Date().toISOString() };

// 1. Device description + services list
const desc = await http("/xml/device_description.xml");
if (!desc.ok) {
  console.error(`device description failed: ${desc.status}`);
  exit(1);
}
out.device = {
  friendlyName: pick(desc.text, "friendlyName"),
  roomName: pick(desc.text, "roomName"),
  modelName: pick(desc.text, "modelName"),
  modelNumber: pick(desc.text, "modelNumber"),
  modelDescription: pick(desc.text, "modelDescription"),
  serialNum: pick(desc.text, "serialNum"),
  softwareVersion: pick(desc.text, "softwareVersion"),
  hardwareVersion: pick(desc.text, "hardwareVersion"),
  MACAddress: pick(desc.text, "MACAddress"),
  UDN: pick(desc.text, "UDN"),
  displayVersion: pick(desc.text, "displayVersion"),
  zoneType: pick(desc.text, "zoneType"),
};

// Walk all <service> blocks (root + embedded devices)
const serviceBlocks = pickAll(desc.text, "service");
const services = serviceBlocks.map((blk) => ({
  serviceType: pick(blk, "serviceType"),
  serviceId: pick(blk, "serviceId"),
  SCPDURL: pick(blk, "SCPDURL"),
  controlURL: pick(blk, "controlURL"),
  eventSubURL: pick(blk, "eventSubURL"),
}));
out.services = services;

// 2. SCPD action lists (just names — full SCPDs are huge)
out.actions = {};
for (const svc of services) {
  if (!svc.SCPDURL) continue;
  try {
    const r = await http(svc.SCPDURL);
    if (!r.ok) {
      out.actions[svc.serviceId] = { error: `HTTP ${r.status}` };
      continue;
    }
    const names = pickAll(r.text, "name").filter((n) => /^[A-Z][A-Za-z0-9]+$/.test(n));
    // Dedup, preserving order
    const seen = new Set();
    const actions = [];
    for (const n of names) if (!seen.has(n)) (seen.add(n), actions.push(n));
    out.actions[svc.serviceId] = actions;
  } catch (e) {
    out.actions[svc.serviceId] = { error: String(e?.message ?? e) };
  }
}

// 3. Curated state probes — the actually-useful read-only actions
const probes = [
  // ZoneGroupTopology — household topology, coordinator/satellite info
  ["/ZoneGroupTopology/Control", "urn:schemas-upnp-org:service:ZoneGroupTopology:1", "GetZoneGroupState"],
  ["/ZoneGroupTopology/Control", "urn:schemas-upnp-org:service:ZoneGroupTopology:1", "GetZoneGroupAttributes"],

  // DeviceProperties — per-device attributes
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetZoneAttributes"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetZoneInfo"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetHouseholdID"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetLEDState"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetButtonState"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetButtonLockState"],
  ["/DeviceProperties/Control", "urn:schemas-upnp-org:service:DeviceProperties:1", "GetAutoplayLinkedZones", { Source: "" }],

  // AVTransport — playback state (InstanceID=0, the only one Sonos exposes)
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetTransportInfo", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetPositionInfo", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetMediaInfo", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetCurrentTransportActions", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetCrossfadeMode", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetTransportSettings", { InstanceID: 0 }],
  ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1", "GetRemainingSleepTimerDuration", { InstanceID: 0 }],

  // RenderingControl — volume/mute/EQ
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetVolume", { InstanceID: 0, Channel: "Master" }],
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetMute", { InstanceID: 0, Channel: "Master" }],
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetBass", { InstanceID: 0 }],
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetTreble", { InstanceID: 0 }],
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetLoudness", { InstanceID: 0, Channel: "Master" }],
  ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1", "GetHeadphoneConnected"],

  // GroupRenderingControl — group volume
  ["/MediaRenderer/GroupRenderingControl/Control", "urn:schemas-upnp-org:service:GroupRenderingControl:1", "GetGroupVolume", { InstanceID: 0 }],
  ["/MediaRenderer/GroupRenderingControl/Control", "urn:schemas-upnp-org:service:GroupRenderingControl:1", "GetGroupMute", { InstanceID: 0 }],

  // ContentDirectory — root browse + a couple useful categories
  ["/MediaServer/ContentDirectory/Control", "urn:schemas-upnp-org:service:ContentDirectory:1", "Browse",
    { ObjectID: "0", BrowseFlag: "BrowseDirectChildren", Filter: "*", StartingIndex: 0, RequestedCount: 50, SortCriteria: "" }],
  ["/MediaServer/ContentDirectory/Control", "urn:schemas-upnp-org:service:ContentDirectory:1", "GetSortCapabilities"],
  ["/MediaServer/ContentDirectory/Control", "urn:schemas-upnp-org:service:ContentDirectory:1", "GetSystemUpdateID"],

  // AlarmClock
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "ListAlarms"],
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "GetTimeNow"],
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "GetHouseholdTimeAtStamp", { TimeStamp: "0" }],
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "GetFormat"],
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "GetTimeZone"],
  ["/AlarmClock/Control", "urn:schemas-upnp-org:service:AlarmClock:1", "GetDailyIndexRefreshTime"],

  // SystemProperties
  ["/SystemProperties/Control", "urn:schemas-upnp-org:service:SystemProperties:1", "GetWebCode", { AccountType: 0 }],

  // MusicServices
  ["/MusicServices/Control", "urn:schemas-upnp-org:service:MusicServices:1", "ListAvailableServices"],

  // GroupManagement
  ["/GroupManagement/Control", "urn:schemas-upnp-org:service:GroupManagement:1", "GetGroupCoordinatorIsLocal"],
];

out.state = {};
for (const [path, type, action, args] of probes) {
  out.state[`${type.split(":service:")[1].split(":")[0]}#${action}`] =
    await soap(path, type, action, args ?? {});
}

// ---------- print ----------

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const d = out.device;
  console.log(`# ${d.roomName} — ${d.modelName} (${d.modelNumber})`);
  console.log(`UDN:          ${d.UDN}`);
  console.log(`Serial:       ${d.serialNum}`);
  console.log(`MAC:          ${d.MACAddress}`);
  console.log(`SW / HW:      ${d.softwareVersion} / ${d.hardwareVersion}`);
  console.log(`displayVer:   ${d.displayVersion}`);
  console.log(`zoneType:     ${d.zoneType}`);
  console.log(`friendlyName: ${d.friendlyName}`);
  console.log(`\n## Services (${out.services.length})`);
  for (const s of out.services) {
    const acts = out.actions[s.serviceId];
    const count = Array.isArray(acts) ? acts.length : `err: ${acts?.error}`;
    console.log(`  ${s.serviceId.padEnd(48)} actions=${count}`);
  }
  console.log(`\n## State probes`);
  for (const [k, v] of Object.entries(out.state)) {
    if (v.ok) {
      const fields = Object.entries(v.fields)
        .map(([fk, fv]) => {
          const flat = fv.replace(/\s+/g, " ").trim();
          return `${fk}=${flat.length > 80 ? flat.slice(0, 77) + "..." : flat}`;
        })
        .join("  ");
      console.log(`  [ok]  ${k}\n        ${fields || "(no fields)"}`);
    } else {
      const reason = v.fault
        ? `${v.fault.code ?? "?"} ${v.fault.desc ?? v.fault.faultString ?? ""}`
        : v.error;
      console.log(`  [err] ${k}  ${reason}`);
    }
  }
  console.log(`\n## Action catalogue`);
  for (const [svcId, acts] of Object.entries(out.actions)) {
    if (!Array.isArray(acts)) {
      console.log(`  ${svcId}: ERROR ${acts.error}`);
      continue;
    }
    console.log(`  ${svcId} (${acts.length})`);
    console.log(`    ${acts.join(", ")}`);
  }
}
