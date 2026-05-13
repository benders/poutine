/**
 * DIDL-Lite builders. Used by:
 *  - Sonos casting (single-item metadata passed to SetAVTransportURI)
 *  - DLNA MediaServer ContentDirectory:Browse responses (containers + items)
 *
 * Spec: UPnP ContentDirectory:1, MediaServer:1, DLNA Guidelines.
 */
import { xmlEscape, formatUpnpDuration } from "./soap.js";

const DIDL_NS = [
  `xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"`,
  `xmlns:dc="http://purl.org/dc/elements/1.1/"`,
  `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"`,
  `xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"`,
].join(" ");

export interface TrackMetadata {
  /** Unified track UUID. Used as DIDL `item@id` after a prefix. */
  trackId: string;
  title: string;
  artist: string;
  album: string;
  albumArtUri?: string | null;
  /** Duration in seconds. */
  durationSec: number;
  /** Stream content-type. Defaults to `audio/mpeg`. */
  mimeType?: string;
}

/** Wrap one or more <item>/<container> fragments in a DIDL-Lite envelope. */
export function wrapDidl(inner: string): string {
  return `<DIDL-Lite ${DIDL_NS}>${inner}</DIDL-Lite>`;
}

/**
 * Sonos-compatible single-item DIDL blob. Used as
 * `CurrentURIMetaData` in `SetAVTransportURI`. Parent ID is `-1` because
 * Sonos doesn't browse the hub's library — the item is supplied inline.
 */
export function buildDidlLiteTrack(meta: TrackMetadata, streamUri: string): string {
  return wrapDidl(
    buildAudioItem({
      ...meta,
      objectId: `poutine-${meta.trackId}`,
      parentId: "-1",
      streamUri,
    }),
  );
}

export interface AudioItemInput extends TrackMetadata {
  objectId: string;
  parentId: string;
  streamUri: string;
  /**
   * Optional DLNA `protocolInfo` 4th field. Defaults to `*` for Sonos.
   * For DLNA clients prefer a real profile (e.g. `DLNA.ORG_PN=MP3` plus flags).
   */
  protocolInfoExtras?: string;
}

export function buildAudioItem(input: AudioItemInput): string {
  const mime = input.mimeType ?? "audio/mpeg";
  const extras = input.protocolInfoExtras ?? "*";
  const protocolInfo = `http-get:*:${mime}:${extras}`;
  const art = input.albumArtUri
    ? `<upnp:albumArtURI>${xmlEscape(input.albumArtUri)}</upnp:albumArtURI>`
    : "";
  return [
    `<item id="${xmlEscape(input.objectId)}" parentID="${xmlEscape(input.parentId)}" restricted="1">`,
    `<dc:title>${xmlEscape(input.title)}</dc:title>`,
    `<dc:creator>${xmlEscape(input.artist)}</dc:creator>`,
    `<upnp:artist>${xmlEscape(input.artist)}</upnp:artist>`,
    `<upnp:album>${xmlEscape(input.album)}</upnp:album>`,
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>`,
    art,
    `<res protocolInfo="${protocolInfo}" duration="${formatUpnpDuration(input.durationSec)}">${xmlEscape(input.streamUri)}</res>`,
    `</item>`,
  ].join("");
}

export interface ContainerInput {
  objectId: string;
  parentId: string;
  title: string;
  /** Number of immediate children. -1 if unknown — clients tolerate this. */
  childCount?: number;
  /** UPnP class — default `object.container`. Use specific subclasses for filtering. */
  upnpClass?: string;
  albumArtUri?: string | null;
  artist?: string | null;
}

export function buildContainer(c: ContainerInput): string {
  const childCount = c.childCount ?? -1;
  const upnpClass = c.upnpClass ?? "object.container";
  const art = c.albumArtUri
    ? `<upnp:albumArtURI>${xmlEscape(c.albumArtUri)}</upnp:albumArtURI>`
    : "";
  const artist = c.artist
    ? `<upnp:artist>${xmlEscape(c.artist)}</upnp:artist>`
    : "";
  return [
    `<container id="${xmlEscape(c.objectId)}" parentID="${xmlEscape(c.parentId)}" restricted="1" childCount="${childCount}">`,
    `<dc:title>${xmlEscape(c.title)}</dc:title>`,
    `<upnp:class>${upnpClass}</upnp:class>`,
    artist,
    art,
    `</container>`,
  ].join("");
}
