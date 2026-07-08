import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { SubsonicQueries } from "../../db/queries/subsonic-queries.js";

// ── Shared context passed to each endpoint-family registerX() (#243 phase 3) ──
// One plain object built once in index.ts and handed to every module below —
// no classes, no per-module reconstruction. `route`/`publicRoute`/`binaryRoute`
// are the same registration helpers the monolith used; queries is the
// `createSubsonicQueries(app.db)` result.
export interface SubsonicRouteContext {
  app: FastifyInstance;
  queries: SubsonicQueries;
  route: (path: string, handler: RouteHandlerMethod) => void;
  publicRoute: (path: string, handler: RouteHandlerMethod) => void;
  binaryRoute: (path: string, handler: RouteHandlerMethod) => void;
}

// ── DB row types shared between the route handlers and the response builders ──

export interface ReleaseGroupRow {
  id: string;
  name: string;
  artist_id: string;
  artist_name: string;
  year: number | null;
  genre: string | null;
  image_url: string | null;
  songCount: number;
  // `urg.created_at` — when this release group was first added to the
  // local hub DB (via Navidrome sync or peer federation). Drives the
  // OpenSubsonic `created` field and the "Recently Added" sort (#148).
  created_at?: string | null;
  // Present only on the getAlbumList2 frequent/recent playJoin: the user's
  // per-album play aggregate, reused for playCount/played to avoid a second
  // pass over play_events (#197).
  play_count?: number | null;
  last_played?: string | null;
}

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
  image_url: string | null;
}

export interface GenreRow {
  genre: string;
  albumCount: number;
  songCount: number;
}

export interface TrackRow {
  id: string;
  title: string;
  track_number: number | null;
  disc_number: number | null;
  duration_ms: number | null;
  genre: string | null;
  artist_id: string;
  artist_name: string;
  rg_id: string;
  rg_name: string;
  rg_year: number | null;
  rg_image_url: string | null;
  rg_artist_id: string;
  rg_artist_name: string;
  format: string | null;
  bitrate: number | null;
  size: number | null;
  // #199: hi-res capability metadata; null for peer-federated tracks and
  // for tracks synced before the schema added these columns.
  sampling_rate: number | null;
  bit_depth: number | null;
  channel_count: number | null;
  instance_name: string | null;
  musicbrainz_id: string | null;
}
