import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { searchLibrary } from "@/lib/api";
import type { Track } from "@/lib/api";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { Search, Play, Disc, User, Music } from "lucide-react";

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

  const { data: results, isLoading } = useQuery({
    queryKey: ["search", debouncedQuery],
    queryFn: () => searchLibrary(debouncedQuery),
    enabled: debouncedQuery.length >= 2,
  });

  const hasResults =
    results &&
    (results.artists.length > 0 ||
      results.releaseGroups.length > 0 ||
      results.tracks.length > 0);

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

      {isLoading && debouncedQuery.length >= 2 && (
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
                        {artist.trackCount} {artist.trackCount === 1 ? "track" : "tracks"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Albums */}
          {results.releaseGroups.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Disc className="w-5 h-5 text-text-muted" />
                Albums
              </h2>
              <div className="space-y-1">
                {results.releaseGroups.slice(0, 10).map((rg) => (
                  <button
                    key={rg.id}
                    onClick={() => navigate(`/albums/${rg.id}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors text-left cursor-pointer"
                  >
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: hashColor(rg.name) }}
                    >
                      <Disc className="w-5 h-5 text-white/30" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">{rg.name}</p>
                      <p className="text-xs text-text-muted truncate">
                        {rg.artistName}
                        {rg.year ? ` \u00B7 ${rg.year}` : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Tracks */}
          {results.tracks.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Music className="w-5 h-5 text-text-muted" />
                Tracks
              </h2>
              <div className="space-y-1">
                {results.tracks.slice(0, 10).map((track) => (
                  <TrackResult key={track.id} track={track} onPlay={() => playTrack(track)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TrackResult({ track, onPlay }: { track: Track; onPlay: () => void }) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-colors">
      <button
        onClick={onPlay}
        className="w-10 h-10 rounded-md bg-surface flex items-center justify-center shrink-0 text-text-muted hover:text-accent transition-colors cursor-pointer"
      >
        <Play className="w-4 h-4 fill-current" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary truncate">{track.title}</p>
        <p className="text-xs text-text-muted truncate">
          {track.artistName} \u00B7 {track.releaseName}
        </p>
      </div>
      <span className="text-xs text-text-muted shrink-0">
        {formatDuration(track.durationMs)}
      </span>
    </div>
  );
}
