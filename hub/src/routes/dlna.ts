/**
 * DLNA MediaServer HTTP surface (issue #175).
 *
 * Endpoints (mounted at `/dlna` by server.ts when `DLNA_ENABLED=true`):
 *
 *   GET  /dlna/device.xml                  Root device description
 *   GET  /dlna/scpd/content-directory.xml  ContentDirectory service description
 *   GET  /dlna/scpd/connection-manager.xml ConnectionManager service description
 *   POST /dlna/control/content-directory   ContentDirectory SOAP control
 *   POST /dlna/control/connection-manager  ConnectionManager SOAP control (stub)
 *   GET  /dlna/stream/:trackId             Audio stream (no auth — see notes)
 *
 * Auth model: DLNA has no user identity. The stream endpoint is open when
 * `DLNA_ENABLED=true` and attributes activity to a configurable pseudo-user
 * (defaults to the owner). Treat exposing the hub on the LAN as an
 * all-or-nothing decision — anyone on the LAN can browse and stream.
 */
import type { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import { SubsonicClient } from "../adapters/subsonic.js";
import { applyTranscodeRule, buildStreamParams } from "./stream-params.js";
import { DlnaObjectService } from "../services/dlna-objects.js";
import {
  buildSoapResponse,
  parseSoapAction,
  pickXmlTag,
  xmlEscape,
} from "../services/soap.js";
import { APP_VERSION } from "../version.js";

declare module "fastify" {
  interface FastifyInstance {
    dlnaObjects: DlnaObjectService;
    dlnaUuid: string;
  }
}

const CD = "urn:schemas-upnp-org:service:ContentDirectory:1";
const CM = "urn:schemas-upnp-org:service:ConnectionManager:1";

export const dlnaRoutes: FastifyPluginAsync = async (app) => {
  const friendlyName = app.config.dlnaFriendlyName || "Poutine";
  const uuid = app.dlnaUuid;

  // SOAP requests come in as text/xml; fastify has no built-in parser for
  // that — accept the raw body as a string and let the handlers parse the
  // bits they need. Encapsulated to this plugin scope.
  app.addContentTypeParser(
    ["text/xml", "application/soap+xml"],
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.get("/device.xml", async (_req, reply) => {
    reply
      .header("content-type", 'text/xml; charset="utf-8"')
      .send(deviceDescription({ uuid, friendlyName }));
  });

  app.get("/scpd/content-directory.xml", async (_req, reply) => {
    reply
      .header("content-type", 'text/xml; charset="utf-8"')
      .send(CONTENT_DIRECTORY_SCPD);
  });

  app.get("/scpd/connection-manager.xml", async (_req, reply) => {
    reply
      .header("content-type", 'text/xml; charset="utf-8"')
      .send(CONNECTION_MANAGER_SCPD);
  });

  app.post("/control/content-directory", async (req, reply) => {
    const baseUrl = (app.config.poutineLanUrl || "").replace(/\/$/, "");
    const body = typeof req.body === "string" ? req.body : "";
    const parsedAction = parseSoapAction(
      req.headers["soapaction"] as string | undefined,
    );

    if (!parsedAction || parsedAction.serviceType !== CD) {
      return soapFault(reply, 401, "Invalid Action");
    }

    reply.header("content-type", 'text/xml; charset="utf-8"');

    switch (parsedAction.action) {
      case "GetSearchCapabilities":
        return reply.send(
          buildSoapResponse(CD, "GetSearchCapabilities", { SearchCaps: "" }),
        );
      case "GetSortCapabilities":
        return reply.send(
          buildSoapResponse(CD, "GetSortCapabilities", { SortCaps: "" }),
        );
      case "GetSystemUpdateID":
        return reply.send(
          buildSoapResponse(CD, "GetSystemUpdateID", { Id: "1" }),
        );
      case "Browse": {
        const objectId = pickXmlTag(body, "ObjectID") || "0";
        const browseFlag =
          (pickXmlTag(body, "BrowseFlag") as
            | "BrowseMetadata"
            | "BrowseDirectChildren"
            | null) || "BrowseDirectChildren";
        const startIndex = parseInt(pickXmlTag(body, "StartingIndex") || "0", 10);
        const requestedCount = parseInt(
          pickXmlTag(body, "RequestedCount") || "0",
          10,
        );

        const out = app.dlnaObjects.browse(objectId, browseFlag, {
          startIndex: Number.isFinite(startIndex) ? startIndex : 0,
          requestedCount: Number.isFinite(requestedCount) ? requestedCount : 0,
          baseUrl,
        });
        return reply.send(
          buildSoapResponse(CD, "Browse", {
            Result: out.result,
            NumberReturned: String(out.numberReturned),
            TotalMatches: String(out.totalMatches),
            UpdateID: "1",
          }),
        );
      }
      // Search is optional in CDS:1; we advertise empty search caps so
      // clients shouldn't ask. Return an empty result if they do anyway.
      case "Search":
        return reply.send(
          buildSoapResponse(CD, "Search", {
            Result: "<DIDL-Lite/>",
            NumberReturned: "0",
            TotalMatches: "0",
            UpdateID: "1",
          }),
        );
      default:
        return soapFault(reply, 401, "Invalid Action");
    }
  });

  app.post("/control/connection-manager", async (req, reply) => {
    const parsedAction = parseSoapAction(
      req.headers["soapaction"] as string | undefined,
    );
    if (!parsedAction || parsedAction.serviceType !== CM) {
      return soapFault(reply, 401, "Invalid Action");
    }
    reply.header("content-type", 'text/xml; charset="utf-8"');
    switch (parsedAction.action) {
      case "GetProtocolInfo":
        return reply.send(
          buildSoapResponse(CM, "GetProtocolInfo", {
            // We export http-get for the common audio MIMEs. `*` would also
            // be conformant but some clients reject empty-source matrices.
            Source: [
              "http-get:*:audio/mpeg:*",
              "http-get:*:audio/flac:*",
              "http-get:*:audio/mp4:*",
              "http-get:*:audio/ogg:*",
              "http-get:*:audio/wav:*",
            ].join(","),
            Sink: "",
          }),
        );
      case "GetCurrentConnectionIDs":
        return reply.send(
          buildSoapResponse(CM, "GetCurrentConnectionIDs", { ConnectionIDs: "0" }),
        );
      case "GetCurrentConnectionInfo":
        return reply.send(
          buildSoapResponse(CM, "GetCurrentConnectionInfo", {
            RcsID: "-1",
            AVTransportID: "-1",
            ProtocolInfo: "",
            PeerConnectionManager: "",
            PeerConnectionID: "-1",
            Direction: "Output",
            Status: "OK",
          }),
        );
      default:
        return soapFault(reply, 401, "Invalid Action");
    }
  });

  app.get<{ Params: { trackId: string }; Querystring: Record<string, string> }>(
    "/stream/:trackId",
    async (request, reply) => {
      const { trackId } = request.params;

      const trackRow = app.db
        .prepare(
          `SELECT ut.id, ut.title, ua.name AS artist_name
             FROM unified_tracks ut
             JOIN unified_artists ua ON ua.id = ut.artist_id
            WHERE ut.id = ?`,
        )
        .get(trackId) as
        | { id: string; title: string; artist_name: string }
        | undefined;

      const best = app.db
        .prepare(
          `SELECT ts.instance_id, ts.format, ts.bitrate, it.remote_id
             FROM track_sources ts
             JOIN instance_tracks it ON it.id = ts.instance_track_id
            WHERE ts.unified_track_id = ? AND ts.preferred = 1
            LIMIT 1`,
        )
        .get(trackId) as
        | { instance_id: string; format: string | null; bitrate: number | null; remote_id: string }
        | undefined;

      if (!best || !trackRow) {
        reply.status(404).send({ error: "Track not found" });
        return;
      }

      const streamParams = applyTranscodeRule(buildStreamParams(request.query), {
        format: best.format,
        bitrate: best.bitrate,
      });
      const cap = Number(streamParams.get("maxBitRate")) || Infinity;
      const srcBr = best.bitrate ?? Infinity;
      const transcoded =
        streamParams.has("format") || (Number.isFinite(cap) && srcBr > cap);

      const attribUser =
        app.config.dlnaPseudoUser || app.config.poutineOwnerUsername || "dlna";

      const streamOpId = app.streamTracking.start({
        kind: "dlna",
        username: attribUser,
        trackId: trackRow.id,
        trackTitle: trackRow.title,
        artistName: trackRow.artist_name,
        clientName: "dlna",
        clientVersion: null,
        sourceKind: best.instance_id === "local" ? "local" : "peer",
        sourcePeerId: best.instance_id === "local" ? null : best.instance_id,
        format: best.format,
        bitrate: best.bitrate,
        transcoded,
        maxBitrate: Number.isFinite(cap) ? cap : null,
      });

      let response: Response;
      try {
        if (best.instance_id === "local") {
          const client = new SubsonicClient({
            url: app.config.navidromeUrl,
            username: app.config.navidromeUsername,
            password: app.config.navidromePassword,
          });
          const opts: {
            format?: string;
            maxBitRate?: number;
            timeOffset?: number;
            range?: string;
          } = {};
          const fmt = streamParams.get("format");
          const br = streamParams.get("maxBitRate");
          const to = streamParams.get("timeOffset");
          if (fmt) opts.format = fmt;
          if (br) opts.maxBitRate = parseInt(br, 10);
          if (to) opts.timeOffset = parseInt(to, 10);
          if (typeof request.headers.range === "string" && !transcoded) {
            opts.range = request.headers.range;
          }
          response = await client.stream(best.remote_id, opts);
        } else {
          const peer = app.peerRegistry.peers.get(best.instance_id);
          if (!peer) {
            app.streamTracking.finish(streamOpId, 0, "Peer not available");
            reply.status(502).send({ error: "Peer not available" });
            return;
          }
          const qs = streamParams.toString();
          const path = `/federation/stream/${encodeURIComponent(best.remote_id)}${qs ? `?${qs}` : ""}`;
          response = await app.federatedFetch(peer, path, {
            asUser: attribUser,
            headers:
              typeof request.headers.range === "string" && !transcoded
                ? { range: request.headers.range }
                : undefined,
          });
        }
      } catch (err) {
        app.streamTracking.finish(streamOpId, 0, `Stream error: ${String(err)}`);
        reply.status(502).send({ error: "Stream error" });
        return;
      }

      if (!response.body) {
        app.streamTracking.finish(streamOpId, 0, "Empty response from upstream");
        reply.status(502).send({ error: "Empty response from upstream" });
        return;
      }

      const headers: Record<string, string> = {
        "content-type": response.headers.get("content-type") || "audio/mpeg",
      };
      const contentLength = response.headers.get("content-length");
      if (contentLength) headers["content-length"] = contentLength;
      const acceptRanges = response.headers.get("accept-ranges") || "bytes";
      headers["accept-ranges"] = acceptRanges;
      const contentRange = response.headers.get("content-range");
      if (contentRange) headers["content-range"] = contentRange;

      // DLNA streaming response headers. `transferMode.dlna.org: Streaming`
      // tells the renderer this is a real-time audio stream (not a download).
      // `contentFeatures.dlna.org` mirrors the protocolInfo 4th field from
      // the DIDL `res@protocolInfo` — strict clients (WMP) reject responses
      // missing this.
      headers["transferMode.dlna.org"] =
        (request.headers["transfermode.dlna.org"] as string | undefined) ||
        "Streaming";
      headers["contentFeatures.dlna.org"] =
        "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000";

      reply.raw.writeHead(response.status, headers);
      const nodeStream = Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      );

      let bytesTransferred = 0;
      nodeStream.on("data", (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        app.streamTracking.updateBytes(streamOpId, bytesTransferred);
      });
      nodeStream.on("end", () => {
        app.streamTracking.finish(streamOpId, bytesTransferred, null);
      });
      nodeStream.on("error", (err) => {
        app.streamTracking.finish(
          streamOpId,
          bytesTransferred,
          err instanceof Error ? err.message : String(err),
        );
      });
      nodeStream.pipe(reply.raw);
    },
  );
};

function deviceDescription(opts: { uuid: string; friendlyName: string }): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${xmlEscape(opts.friendlyName)}</friendlyName>
    <manufacturer>Poutine</manufacturer>
    <manufacturerURL>https://github.com/benders/poutine</manufacturerURL>
    <modelDescription>Poutine federated music server</modelDescription>
    <modelName>Poutine</modelName>
    <modelNumber>${xmlEscape(APP_VERSION)}</modelNumber>
    <modelURL>https://github.com/benders/poutine</modelURL>
    <UDN>uuid:${xmlEscape(opts.uuid)}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>${CD}</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/scpd/content-directory.xml</SCPDURL>
        <controlURL>/dlna/control/content-directory</controlURL>
        <eventSubURL>/dlna/event/content-directory</eventSubURL>
      </service>
      <service>
        <serviceType>${CM}</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/scpd/connection-manager.xml</SCPDURL>
        <controlURL>/dlna/control/connection-manager</controlURL>
        <eventSubURL>/dlna/event/connection-manager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

function soapFault(
  reply: import("fastify").FastifyReply,
  upnpCode: number,
  description: string,
): void {
  reply
    .status(500)
    .header("content-type", 'text/xml; charset="utf-8"')
    .send(
      `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<s:Fault>
<faultcode>s:Client</faultcode>
<faultstring>UPnPError</faultstring>
<detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>${upnpCode}</errorCode>
<errorDescription>${xmlEscape(description)}</errorDescription>
</UPnPError>
</detail>
</s:Fault>
</s:Body>
</s:Envelope>`,
    );
}

// Minimal SCPD describing the actions we implement. Real DLNA clients only
// need the action list to send valid SOAP — they don't validate every
// state-variable table — but we include the canonical ones for completeness.
const CONTENT_DIRECTORY_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetSearchCapabilities</name>
      <argumentList>
        <argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetSortCapabilities</name>
      <argumentList>
        <argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetSystemUpdateID</name>
      <argumentList>
        <argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>BrowseMetadata</allowedValue>
        <allowedValue>BrowseDirectChildren</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const CONNECTION_MANAGER_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name>
      <argumentList>
        <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
        <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetCurrentConnectionIDs</name>
      <argumentList>
        <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetCurrentConnectionInfo</name>
      <argumentList>
        <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
        <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
        <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
        <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
        <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
        <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>Input</allowedValue><allowedValue>Output</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>OK</allowedValue><allowedValue>ContentFormatMismatch</allowedValue>
        <allowedValue>InsufficientBandwidth</allowedValue><allowedValue>UnreliableChannel</allowedValue>
        <allowedValue>Unknown</allowedValue>
      </allowedValueList>
    </stateVariable>
  </serviceStateTable>
</scpd>`;
