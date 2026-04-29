import { Navigate, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Play, Plus, Star, ChevronRight } from "lucide-react";
import { getStarred2 } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { StarButton } from "@/components/StarButton";
import { ErrorMessage } from "@/components/ui/ErrorMessage";

/**
 * Playlists page (issue #104). For now hosts a single virtual playlist:
 * Favorites — directly-starred tracks plus every track from a starred
 * album (server-side union; see getStarred2 in docs/opensubsonic.md).
 * Per-row star icons reflect each track's own state. Real (user-defined)
 * playlists are a future issue.
 */
export function PlaylistsPage() {
  const { view } = useParams<{ view: string }>();
  if (view !== "favorites") {
    return <Navigate to="/playlists/favorites" replace />;
  }
  return <FavoritesView />;
}

function FavoritesView() {
  const { playTracks, addToQueue } = usePlayer();
  const { data, isLoading, error } = useQuery({
    queryKey: ["starred2"],
    queryFn: getStarred2,
    retry: false,
  });

  if (error) {
    return (
      <div className="py-6">
        <ErrorMessage error={error} />
      </div>
    );
  }
  if (isLoading) {
    return <div className="text-text-muted text-center py-20">Loading...</div>;
  }

  const songs = data?.songs ?? [];

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-text-muted">
        <span>Playlists</span>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-text-primary">Favorites</span>
      </nav>

      <div className="flex items-center gap-4">
        <Star className="w-10 h-10 text-yellow-400 fill-current" />
        <div>
          <h1 className="text-3xl font-bold text-text-primary">Favorites</h1>
          <p className="text-text-secondary text-sm mt-1">
            {songs.length} {songs.length === 1 ? "track" : "tracks"}
          </p>
        </div>
        {songs.length > 0 && (
          <button
            onClick={() => playTracks(songs, 0)}
            className="ml-auto inline-flex items-center gap-2 px-5 py-2 bg-accent hover:bg-accent-hover text-white rounded-full text-sm font-medium transition-colors cursor-pointer"
          >
            <Play className="w-4 h-4 fill-current" />
            Play All
          </button>
        )}
      </div>

      {songs.length === 0 ? (
        <p className="text-text-muted text-center py-20">
          No favorites yet. Star a track or an album to add it here.
        </p>
      ) : (
        <div className="bg-surface rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wider">
                <th className="py-2.5 px-4 text-left w-12">#</th>
                <th className="py-2.5 px-4 text-left">Title</th>
                <th className="py-2.5 px-4 text-left">Album</th>
                <th className="py-2.5 px-4 text-left">Artist</th>
                <th className="py-2.5 px-4 text-right w-24">Duration</th>
                <th className="py-2.5 px-4 text-right w-20" />
              </tr>
            </thead>
            <tbody>
              {songs.map((song, index) => (
                <FavoriteRow
                  key={song.id}
                  song={song}
                  index={index}
                  onPlay={() => playTracks(songs, index)}
                  onAddToQueue={() => addToQueue(song)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FavoriteRow({
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
        <span className="group-hover:hidden">{index + 1}</span>
        <button
          onClick={onPlay}
          className="hidden group-hover:block text-text-primary hover:text-accent cursor-pointer"
          title="Play"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
        </button>
      </td>
      <td className="py-2.5 px-4">
        <p className="text-sm text-text-primary">{song.title}</p>
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted truncate">
        {song.albumId ? (
          <Link
            to={`/albums/${song.albumId}`}
            className="hover:text-text-primary transition-colors"
          >
            {song.album}
          </Link>
        ) : (
          song.album
        )}
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted truncate">
        {song.artistId ? (
          <Link
            to={`/artists/${song.artistId}`}
            className="hover:text-text-primary transition-colors"
          >
            {song.artist}
          </Link>
        ) : (
          song.artist
        )}
      </td>
      <td className="py-2.5 px-4 text-sm text-text-muted text-right">
        {formatDuration(song.durationMs)}
      </td>
      <td className="py-2.5 px-4 text-right">
        <div className="flex items-center justify-end gap-2">
          <StarButton id={song.id} starred={song.starred} />
          <button
            onClick={onAddToQueue}
            className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-text-primary transition-all cursor-pointer"
            title="Add to queue"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
