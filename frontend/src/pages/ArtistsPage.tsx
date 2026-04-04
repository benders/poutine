import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getArtists, artUrl } from "@/lib/api";
import { Search } from "lucide-react";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 35%, 35%)`;
}

export function ArtistsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const { data: artists, isLoading } = useQuery({
    queryKey: ["artists"],
    queryFn: () => getArtists({ limit: 500 }),
  });

  const filtered = useMemo(() => {
    if (!artists) return [];
    if (!search) return artists;
    const q = search.toLowerCase();
    return artists.filter((a) => a.name.toLowerCase().includes(q));
  }, [artists, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">Artists</h1>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            placeholder="Search artists..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-64"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-center py-20">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-text-muted text-center py-20">
          {search ? "No artists match your search." : "No artists in your library yet."}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((artist) => (
            <button
              key={artist.id}
              onClick={() => navigate(`/artists/${artist.id}`)}
              className="group text-left rounded-lg bg-surface p-4 transition-colors hover:bg-surface-hover cursor-pointer"
            >
              <div
                className="w-full aspect-square rounded-full mb-3 flex items-center justify-center mx-auto overflow-hidden"
                style={{ backgroundColor: hashColor(artist.name) }}
              >
                {artist.imageUrl ? (
                  <img
                    src={artUrl(artist.imageUrl, 300)}
                    alt={artist.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-xl font-semibold text-white/70">
                    {initials(artist.name)}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-text-primary truncate text-center">
                {artist.name}
              </p>
              <p className="text-xs text-text-muted text-center">
                {artist.trackCount} {artist.trackCount === 1 ? "track" : "tracks"}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
