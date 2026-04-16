import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAlbum, artUrl } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { Play, Plus, ChevronRight, Disc } from "lucide-react";

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 30%)`;
}

export function ReleaseGroupPage() {
  const { id } = useParams<{ id: string }>();
  const { playTracks, addToQueue } = usePlayer();

  const { data: album, isLoading } = useQuery({
    queryKey: ["album", id],
    queryFn: () => getAlbum(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="text-text-muted text-center py-20">Loading...</div>;
  }

  if (!album) {
    return <div className="text-text-muted text-center py-20">Album not found.</div>;
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-text-muted">
        <Link to="/" className="hover:text-text-primary transition-colors">
          Library
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-text-primary truncate">{album.name}</span>
      </nav>

      {/* Album header */}
      <div className="flex items-start gap-6">
        <div
          className="w-48 h-48 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
          style={{ backgroundColor: hashColor(album.name) }}
        >
          {album.coverArt ? (
            <img
              src={artUrl(album.coverArt, 400)}
              alt={album.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <Disc className="w-16 h-16 text-white/30" />
          )}
        </div>
        <div className="min-w-0 pt-2">
          <h1 className="text-3xl font-bold text-text-primary">{album.name}</h1>
          <p className="text-text-secondary mt-1">
            <Link
              to={`/artists/${album.artistId}`}
              className="hover:text-accent transition-colors"
            >
              {album.artist}
            </Link>
            {album.year ? ` \u00B7 ${album.year}` : ""}
            {album.genre ? ` \u00B7 ${album.genre}` : ""}
          </p>

          {album.songs.length > 0 && (
            <button
              onClick={() => playTracks(album.songs, 0)}
              className="mt-4 inline-flex items-center gap-2 px-5 py-2 bg-accent hover:bg-accent-hover text-white rounded-full text-sm font-medium transition-colors cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              Play All
            </button>
          )}
        </div>
      </div>

      {/* Track list */}
      <div className="bg-surface rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wider">
              <th className="py-2.5 px-4 text-left w-12">#</th>
              <th className="py-2.5 px-4 text-left">Title</th>
              <th className="py-2.5 px-4 text-left w-20">Format</th>
              <th className="py-2.5 px-4 text-left w-24">Bitrate</th>
              <th className="py-2.5 px-4 text-left w-40">Source</th>
              <th className="py-2.5 px-4 text-right w-24">Duration</th>
              <th className="py-2.5 px-4 text-right w-20"></th>
            </tr>
          </thead>
          <tbody>
            {album.songs.map((song, index) => (
              <SongRow
                key={song.id}
                song={song}
                index={index}
                onPlay={() => playTracks(album.songs, index)}
                onAddToQueue={() => addToQueue(song)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SongRow({
  song,
  index,
  onPlay,
  onAddToQueue,
}: {
  song: SubsonicSong;
  index: number;
  onPlay: () => void;
  onAddToQueue: () => void;
}) {
  return (
    <tr className="group border-b border-border/50 last:border-0 hover:bg-surface-hover transition-colors">
      <td className="py-2.5 px-4 text-sm text-text-muted">
        <span className="group-hover:hidden">{song.track ?? index + 1}</span>
        <button
          onClick={onPlay}
          className="hidden group-hover:block text-text-primary hover:text-accent cursor-pointer"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
        </button>
      </td>
      <td className="py-2.5 px-4">
        <p className="text-sm text-text-primary">{song.title}</p>
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted">
        {song.suffix && <span className="uppercase">{song.suffix}</span>}
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted">
        {song.bitRate ? `${song.bitRate} kbps` : ""}
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted">
        {song.sourceInstance || ""}
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted text-right">
        {formatDuration(song.durationMs)}
      </td>
      <td className="py-2.5 px-4 text-right">
        <button
          onClick={onAddToQueue}
          className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-text-primary transition-all cursor-pointer"
          title="Add to queue"
        >
          <Plus className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}
