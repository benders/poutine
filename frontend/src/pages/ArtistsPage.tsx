import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getArtists, artUrl } from "@/lib/subsonic";
import type { SubsonicArtist } from "@/lib/subsonic";
import { useScrollRestoration } from "@/lib/useScrollRestoration";
import { CategoryGrid } from "@/components/CategoryGrid";

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

  const { data: artists, isLoading, error } = useQuery({
    queryKey: ["artists"],
    queryFn: () => getArtists(),
    retry: false,
  });

  useScrollRestoration("artists", !!artists);

  const filtered = useMemo(() => {
    if (!artists) return undefined;
    if (!search) return artists;
    const q = search.toLowerCase();
    return artists.filter((a) => a.name.toLowerCase().includes(q));
  }, [artists, search]);

  return (
    <CategoryGrid<SubsonicArtist, never>
      title="Artists"
      items={filtered}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search artists..."
      search={search}
      onSearchChange={setSearch}
      emptyMessage="No artists in your library yet."
      emptySearchMessage="No artists match your search."
      itemKey={(a) => a.id}
      renderItem={(artist) => (
        <button
          onClick={() => navigate(`/artists/${artist.id}`)}
          className="w-full group text-left rounded-lg bg-surface p-4 transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <div
            className="w-full aspect-square rounded-full mb-3 flex items-center justify-center mx-auto overflow-hidden"
            style={{ backgroundColor: hashColor(artist.name) }}
          >
            {artist.coverArt ? (
              <img
                src={artUrl(artist.coverArt, 300)}
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
            {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}
          </p>
        </button>
      )}
    />
  );
}
