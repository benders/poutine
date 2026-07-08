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
