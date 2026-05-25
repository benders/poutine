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
 *
 * Stream URLs (`res@uri` in DIDL) point at `/rest/stream.view` directly
 * with an embedded cast token (#218). The Hub Subsonic stream handler
 * applies DLNA-specific response headers when the URL carries `dlna=1`.
 *
 * Auth model: DLNA has no user identity. DIDL responses are open on the
 * LAN; stream URLs embed a short-lived cast token bound to a pseudo-user
 * (defaults to the owner). Treat exposing the hub on the LAN as an
 * all-or-nothing decision — anyone on the LAN can browse and stream.
 */
import type { FastifyPluginAsync } from "fastify";
import { DlnaObjectService } from "../services/dlna-objects.js";
import {
  buildSoapResponse,
  parseSoapAction,
  pickXmlTag,
  xmlEscape,
} from "../services/soap.js";
import { requireLan } from "../auth/lan-only.js";
import { APP_VERSION } from "../version.js";

declare module "fastify" {
  interface FastifyInstance {
    dlnaObjects: DlnaObjectService;
    dlnaUuid: string;
  }
}

const CD = "urn:schemas-upnp-org:service:ContentDirectory:1";
const CM = "urn:schemas-upnp-org:service:ConnectionManager:1";

/**
 * SOAP bodies for the actions we accept are tiny — a few hundred bytes at
 * most. Cap well below Fastify's 1 MB default so a buggy (or malicious)
 * control point can't push large bodies at us. Applied per-route since
 * Fastify v5 doesn't accept `bodyLimit` on `register()` options.
 */
const SOAP_BODY_LIMIT = 64 * 1024;

export const dlnaRoutes: FastifyPluginAsync = async (app) => {
  // Friendly name persists in player.db (#217); read on each device.xml
  // request so an admin-side change takes effect on the next probe.
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

  // LAN gate. DLNA has no notion of user identity; we deliberately leave
  // every route here unauthenticated so off-the-shelf UPnP clients work
  // without surgery. To prevent that openness from leaking through a
  // public tunnel (Cloudflare/Caddy/nginx/Tailscale Funnel), reject any
  // request that carries a proxy-forwarding header. See auth/lan-only.ts.
  app.addHook("preHandler", requireLan);

  app.get("/device.xml", async (_req, reply) => {
    const friendlyName = app.sonosSettings.getDlnaFriendlyName();
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

  app.post("/control/content-directory", { bodyLimit: SOAP_BODY_LIMIT }, async (req, reply) => {
    const baseUrl = app.sonosSettings.getLanUrl();
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
          // #218: DIDL `res@uri` is a self-contained Hub Subsonic URL with
          // an embedded cast token. Devices fetch bytes directly — no
          // Player-side relay.
          castSecret: app.castSecret,
          username:
            app.config.dlnaPseudoUser ||
            app.config.poutineOwnerUsername ||
            "dlna",
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

  app.post("/control/connection-manager", { bodyLimit: SOAP_BODY_LIMIT }, async (req, reply) => {
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

  // #218: /dlna/stream/:trackId removed. DIDL `res@uri` now points at
  // /rest/stream.view with an embedded cast token; renderers fetch bytes
  // directly from the Hub Subsonic endpoint. DLNA-specific response
  // headers (`transferMode.dlna.org`, `contentFeatures.dlna.org`,
  // `accept-ranges: bytes` default) are emitted by the Subsonic stream
  // handler when the cast-token URL carries `dlna=1`.
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

/**
 * Build a UPnP-DA §3.2.2 SOAP fault. HTTP status is always 500 (per the
 * SOAP 1.1 fault convention); `upnpCode` is the inner UPnP error code,
 * NOT an HTTP code. 401 here means "Invalid Action," not "Unauthorized."
 */
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
