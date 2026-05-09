/**
 * Federation routes for peer-to-peer communication.
 * 
 * These routes are called by peer hubs to fetch resources on their behalf.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { createRequirePeerAuth } from "../federation/peer-auth.js";
import {
  decodeInvitation,
  verifyInvitationSignature,
  verifyInviteeProof,
} from "../federation/invitations.js";
import { parsePeerPublicKey } from "../federation/signing.js";
import { USER_AGENT, FEDERATION_API_VERSION } from "../version.js";
import { buildStreamParams } from "./stream-params.js";

// ── HTTP agents for upstream requests ────────────────────────────────────────

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const federationRoutes: FastifyPluginAsync = async (app) => {
  const requirePeerAuth = createRequirePeerAuth({
    registry: app.peerRegistry,
    db: app.db,
  });

  // POST /federation/handshake — invitee→inviter peer admission (federation v5).
  // Unauthenticated by federation request signing because the invitee is not
  // yet a known peer. Trust is established by:
  //   (1) the inviter's signature on the invitation (verifies against our pub key),
  //   (2) the invitee's signature over the nonce using its claimed public key,
  //   (3) a successful GET on invitee.url + /api/health (reachability + version).
  app.post<{
    Body: {
      invitation?: string;
      invitee?: {
        id?: string;
        url?: string;
        public_key?: string;
        proof_signature?: string;
      };
    };
  }>("/handshake", async (request, reply) => {
    const { invitation, invitee } = request.body ?? {};
    if (typeof invitation !== "string" || !invitee) {
      return reply.code(400).send({ error: "invitation and invitee are required" });
    }
    if (
      typeof invitee.id !== "string" ||
      typeof invitee.url !== "string" ||
      typeof invitee.public_key !== "string" ||
      typeof invitee.proof_signature !== "string"
    ) {
      return reply.code(400).send({
        error: "invitee.{id,url,public_key,proof_signature} are required",
      });
    }

    let signed;
    try {
      signed = decodeInvitation(invitation);
    } catch (err) {
      return reply.code(400).send({ error: `Invalid invitation: ${String(err)}` });
    }

    // Inviter must be us — invitations are issued and consumed locally.
    if (signed.payload.inviter_id !== app.peerRegistry.instanceId) {
      return reply.code(400).send({
        error: `Invitation inviter_id ${signed.payload.inviter_id} does not match this hub (${app.peerRegistry.instanceId})`,
      });
    }
    if (signed.payload.inviter_public_key !== app.publicKeySpec) {
      return reply.code(400).send({
        error: "Invitation inviter_public_key does not match this hub",
      });
    }

    const verified = verifyInvitationSignature(signed);
    if (!verified.ok) {
      return reply.code(400).send({ error: verified.error });
    }

    // Lookup the nonce — must exist, be unconsumed.
    const inv = app.db
      .prepare(
        "SELECT id, invitee_url, expires_at, consumed_at FROM invitations WHERE nonce = ?",
      )
      .get(signed.payload.nonce) as
      | {
          id: string;
          invitee_url: string | null;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!inv) {
      return reply.code(404).send({ error: "Unknown invitation nonce" });
    }
    if (inv.consumed_at) {
      return reply.code(409).send({ error: "Invitation already consumed" });
    }
    if (new Date(inv.expires_at).getTime() <= Date.now()) {
      return reply.code(410).send({ error: "Invitation expired" });
    }

    // If targeted, the invitee URL must match.
    const inviteeUrl = invitee.url.replace(/\/+$/, "");
    if (inv.invitee_url && inv.invitee_url !== inviteeUrl) {
      return reply.code(403).send({
        error: `Invitation was bound to ${inv.invitee_url}, not ${inviteeUrl}`,
      });
    }

    // Verify invitee owns the claimed public key.
    try {
      parsePeerPublicKey(invitee.public_key);
    } catch (err) {
      return reply.code(400).send({ error: `Invalid invitee.public_key: ${String(err)}` });
    }
    if (!verifyInviteeProof(invitee.public_key, signed.payload.nonce, invitee.proof_signature)) {
      return reply.code(401).send({ error: "Invitee proof_signature does not verify" });
    }

    // Defend against id collision.
    if (invitee.id === app.peerRegistry.instanceId) {
      return reply.code(400).send({ error: "Invitee id collides with this hub" });
    }

    // Reachability + version check.
    let healthApiVersion: number | null = null;
    let healthAppVersion: string | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${inviteeUrl}/api/health`, {
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { apiVersion?: number; appVersion?: string };
        healthApiVersion = typeof body.apiVersion === "number" ? body.apiVersion : null;
        healthAppVersion = typeof body.appVersion === "string" ? body.appVersion : null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `Invitee /api/health unreachable: ${String(err)}` });
    }
    if (healthApiVersion === null || healthApiVersion < FEDERATION_API_VERSION) {
      return reply.code(409).send({
        error: `Invitee apiVersion ${healthApiVersion ?? "unknown"} < required ${FEDERATION_API_VERSION}`,
      });
    }

    // Insert the peer + provenance, mark invitation consumed.
    const owner = app.db.prepare("SELECT id FROM users LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!owner) {
      return reply.code(500).send({ error: "No user row for instance ownership" });
    }
    const next = (
      app.db
        .prepare("SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances")
        .get() as { next: number }
    ).next;

    const tx = app.db.transaction(() => {
      app.db
        .prepare(
          `INSERT INTO instances
             (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id, server_version,
              public_key, invitation_payload, invitation_signature, inviter_id, inviter_url, inviter_public_key)
           VALUES (?, ?, ?, 'subsonic', '', ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invitee.id,
          invitee.id,
          inviteeUrl,
          owner.id,
          next,
          healthAppVersion,
          invitee.public_key,
          JSON.stringify(signed.payload),
          signed.signature,
          signed.payload.inviter_id,
          signed.payload.inviter_url,
          signed.payload.inviter_public_key,
        );
      app.db
        .prepare(
          "UPDATE invitations SET consumed_at = datetime('now'), consumed_by_id = ? WHERE id = ?",
        )
        .run(invitee.id, inv.id);
    });
    try {
      tx();
    } catch (err) {
      return reply.code(409).send({ error: `Could not insert peer: ${String(err)}` });
    }
    app.peerRegistry.reload();
    return reply.send({ ok: true, peerId: invitee.id });
  });

  // GET /federation/peers — gossip endpoint (federation v5, #147).
  // Authenticated via existing peer-auth (Ed25519 request signing). Returns
  // every peer we know about — minus 'local', the calling peer, and any peer
  // without invitation provenance — so receivers can verify each entry.
  app.get("/peers", { preHandler: requirePeerAuth }, async (request) => {
    const callerId = request.peer.id;
    const rows = app.db
      .prepare(
        `SELECT id, url, public_key, invitation_payload, invitation_signature,
                inviter_id, inviter_url, inviter_public_key
         FROM instances
         WHERE id != 'local'
           AND id != ?
           AND public_key IS NOT NULL
           AND invitation_payload IS NOT NULL
           AND invitation_signature IS NOT NULL`,
      )
      .all(callerId) as Array<{
      id: string;
      url: string;
      public_key: string;
      invitation_payload: string;
      invitation_signature: string;
      inviter_id: string;
      inviter_url: string;
      inviter_public_key: string;
    }>;

    const peers = rows.map((r) => ({
      id: r.id,
      url: r.url,
      public_key: r.public_key,
      invitation_payload: JSON.parse(r.invitation_payload),
      invitation_signature: r.invitation_signature,
      inviter_id: r.inviter_id,
      inviter_url: r.inviter_url,
      inviter_public_key: r.inviter_public_key,
    }));

    return { peers };
  });

  // Stream audio from local Navidrome to peer
  app.get("/stream/:id", { preHandler: requirePeerAuth }, async (request, reply) => {
    const config = app.config;
    const { id: trackId } = request.params as { id: string };

    // Build the stream URL for local Navidrome
    const targetBase = config.navidromeUrl.replace(/\/+$/, "");
    const targetUrl = new URL(`${targetBase}/rest/stream`);
    
    // Add Subsonic auth params
    const salt = crypto.randomBytes(8).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(config.navidromePassword + salt)
      .digest("hex");
    
    targetUrl.searchParams.set("u", config.navidromeUsername);
    targetUrl.searchParams.set("t", token);
    targetUrl.searchParams.set("s", salt);
    targetUrl.searchParams.set("v", "1.16.1");
    targetUrl.searchParams.set("c", "poutine-federation");
    targetUrl.searchParams.set("id", trackId);
    
    // Forward Subsonic passthrough params (format, maxBitRate, timeOffset, …)
    // via a single shared helper so the local and peer paths agree.
    const q = request.query as Record<string, string>;
    for (const [key, val] of buildStreamParams(q)) {
      targetUrl.searchParams.set(key, val);
    }

    // Make the upstream request
    const isHttps = targetUrl.protocol === "https:";
    const agent = isHttps ? httpsAgent : httpAgent;

    // Forward Range from peer caller so the upstream can return 206 + bytes
    // (#97). Other headers stay out of the federation passthrough.
    const upstreamHeaders: Record<string, string> = {};
    const incomingRange = request.headers.range;
    if (typeof incomingRange === "string") {
      upstreamHeaders.range = incomingRange;
    }

    const upstreamResponse = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: "GET",
          headers: upstreamHeaders,
          agent,
        };

        const req = (isHttps ? https : http).request(options, resolve);
        req.on("error", reject);
        req.end();
      },
    );

    // Forward response
    const responseHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(upstreamResponse.headers)) {
      if (key.toLowerCase() !== "set-cookie" && val !== undefined) {
        responseHeaders[key.toLowerCase()] = Array.isArray(val)
          ? val.join(", ")
          : val;
      }
    }

    // ── Stream tracking (issue #121) ──────────────────────────────────────────
    // Record this peer-served stream as kind='proxy'. The track is identified
    // by the Navidrome remote_id we just looked up; resolve to unified track
    // metadata for display.
    let streamOpId: string | undefined;
    let bytesTransferred = 0;
    if (
      (upstreamResponse.statusCode ?? 0) >= 200 &&
      (upstreamResponse.statusCode ?? 0) < 300
    ) {
      const trackRow = app.db
        .prepare(
          `SELECT ut.id AS track_id, ut.title, ua.name AS artist_name,
                  ts.format, ts.bitrate
           FROM instance_tracks it
           JOIN track_sources ts ON ts.instance_track_id = it.id
           JOIN unified_tracks ut ON ut.id = ts.unified_track_id
           JOIN unified_artists ua ON ua.id = ut.artist_id
           WHERE it.instance_id = 'local' AND it.remote_id = ?
           LIMIT 1`,
        )
        .get(trackId) as
        | {
            track_id: string;
            title: string;
            artist_name: string;
            format: string | null;
            bitrate: number | null;
          }
        | undefined;
      if (trackRow) {
        // Honor the caller's transcode params so the activity row reflects
        // what was actually streamed, not the original source file.
        const reqFormat = q.format ? String(q.format) : null;
        const reqMaxBitrate = q.maxBitRate ? Number(q.maxBitRate) : NaN;
        const srcBr = trackRow.bitrate ?? 0;
        const capApplies = Number.isFinite(reqMaxBitrate) && srcBr > reqMaxBitrate;
        const transcoded = reqFormat !== null || capApplies;
        const effectiveFormat = reqFormat ?? trackRow.format;
        const effectiveBitrate = capApplies ? reqMaxBitrate : trackRow.bitrate;
        streamOpId = app.streamTracking.start({
          kind: "proxy",
          username: request.peer.userAssertion,
          trackId: trackRow.track_id,
          trackTitle: trackRow.title,
          artistName: trackRow.artist_name,
          peerId: request.peer.id,
          sourceKind: "local",
          format: effectiveFormat,
          bitrate: effectiveBitrate,
          transcoded,
          maxBitrate: Number.isFinite(reqMaxBitrate) ? reqMaxBitrate : null,
        });
      }
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

    if (streamOpId) {
      upstreamResponse.on("data", (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        app.streamTracking.updateBytes(streamOpId!, bytesTransferred);
      });
    }

    try {
      await pipeline(upstreamResponse, raw);
      if (streamOpId) app.streamTracking.finish(streamOpId, bytesTransferred, null);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        app.log.error(err, "federation stream pipeline error");
      }
      if (streamOpId) {
        app.streamTracking.finish(
          streamOpId,
          bytesTransferred,
          nodeErr.code === "ERR_STREAM_PREMATURE_CLOSE" ? null : (nodeErr.message ?? "pipeline error"),
        );
      }
    }
  });
};
