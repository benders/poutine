import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { search3 } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { Search, Play, Disc, User, Music } from "lucide-react";
import { ErrorMessage } from "@/components/ui/ErrorMessage";

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 30%)`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function SearchPage() {
  const navigate = useNavigate();
  const { playTrack } = usePlayer();
  const [input, setInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(input);
    }, 300);
    return () => clearTimeout(timer);
  }, [input]);

  const { data: results, isLoading, error } = useQuery({
    queryKey: ["search", debouncedQuery],
    queryFn: () => search3(debouncedQuery),
    enabled: debouncedQuery.length >= 2,
    retry: false,
  });

  const hasResults =
    results &&
    (results.artists.length > 0 ||
      results.albums.length > 0 ||
      results.songs.length > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Search</h1>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" />
        <input
          type="text"
          placeholder="Search for artists, albums, or tracks..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-full pl-12 pr-4 py-3 bg-surface border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          autoFocus
        />
      </div>

      {debouncedQuery.length < 2 && (
        <div className="text-text-muted text-center py-16">
          Type at least 2 characters to search.
        </div>
      )}

      {error && debouncedQuery.length >= 2 && (
        <ErrorMessage error={error} />
      )}

      {isLoading && debouncedQuery.length >= 2 && !error && (
        <div className="text-text-muted text-center py-16">Searching...</div>
      )}

      {debouncedQuery.length >= 2 && !isLoading && !hasResults && (
        <div className="text-text-muted text-center py-16">
          No results found for "{debouncedQuery}".
        </div>
      )}

      {hasResults && (
        <div className="space-y-8">
          {/* Artists */}
          {results.artists.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <User className="w-5 h-5 text-text-muted" />
                Artists
              </h2>
              <div className="space-y-1">
                {results.artists.slice(0, 10).map((artist) => (
                  <button
                    key={artist.id}
                    onClick={() => navigate(`/artists/${artist.id}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
                  >
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                      style={{ backgroundColor: hashColor(artist.name) }}
                    >
                      <span className="text-xs font-semibold text-white/70">
                        {initials(artist.name)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">{artist.name}</p>
                      <p className="text-xs text-text-muted">
                        {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Albums */}
          {results.albums.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Disc className="w-5 h-5 text-text-muted" />
                Albums
              </h2>
              <div className="space-y-1">
                {results.albums.slice(0, 10).map((album) => (
                  <button
                    key={album.id}
                    onClick={() => navigate(`/albums/${album.id}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
                  >
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: hashColor(album.name) }}
                    >
                      <Disc className="w-5 h-5 text-white/30" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">{album.name}</p>
                      <p className="text-xs text-text-muted truncate">
                        {album.artist}
                        {album.year ? ` \u00B7 ${album.year}` : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Tracks */}
          {results.songs.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Music className="w-5 h-5 text-text-muted" />
                Tracks
              </h2>
              <div className="space-y-1">
                {results.songs.slice(0, 10).map((song) => (
                  <SongResult key={song.id} song={song} onPlay={() => playTrack(song)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SongResult({ song, onPlay }: { song: SubsonicSong; onPlay: () => void }) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors">
      <button
        onClick={onPlay}
        className="w-10 h-10 rounded-md bg-surface flex items-center justify-center shrink-0 text-text-muted hover:text-accent transition-colors cursor-pointer"
      >
        <Play className="w-4 h-4 fill-current" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary truncate">{song.title}</p>
        <p className="text-xs text-text-muted truncate">
          {song.artist} \u00B7 {song.album}
        </p>
      </div>
      <span className="text-xs text-text-muted shrink-0">
        {formatDuration(song.durationMs)}
      </span>
    </div>
  );
}
