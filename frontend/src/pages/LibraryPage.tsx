import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAlbumList2, artUrl } from "@/lib/subsonic";
import type { SubsonicAlbum } from "@/lib/subsonic";
import { Search, Disc, ChevronDown } from "lucide-react";

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 30%)`;
}

type SortOption = "name" | "year" | "recent";

export function LibraryPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("name");

  const { data: albums, isLoading } = useQuery({
    queryKey: ["albumList2"],
    queryFn: () => getAlbumList2({ size: 500 }),
  });

  const filtered = useMemo(() => {
    if (!albums) return [];
    let items = [...albums];

    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.artist.toLowerCase().includes(q),
      );
    }

    items.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "year":
          return (b.year ?? 0) - (a.year ?? 0);
        case "recent":
          return b.id.localeCompare(a.id);
      }
    });

    return items;
  }, [albums, search, sort]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">Library</h1>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              placeholder="Search albums..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-64"
            />
          </div>
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOption)}
              className="appearance-none pl-3 pr-8 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-secondary focus:outline-none focus:border-accent cursor-pointer"
            >
              <option value="name">Name</option>
              <option value="year">Year</option>
              <option value="recent">Recently Added</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-center py-20">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-text-muted text-center py-20">
          {search ? "No albums match your search." : "No albums in your library yet."}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((album) => (
            <AlbumCard key={album.id} album={album} onClick={() => navigate(`/albums/${album.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumCard({
  album,
  onClick,
}: {
  album: SubsonicAlbum;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover cursor-pointer"
    >
      <div
        className="aspect-square rounded-md mb-3 flex items-center justify-center overflow-hidden"
        style={{ backgroundColor: hashColor(album.name) }}
      >
        {album.coverArt ? (
          <img
            src={artUrl(album.coverArt, 300)}
            alt={album.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <Disc className="w-10 h-10 text-white/30" />
        )}
      </div>
      <p className="text-sm font-medium text-text-primary truncate">
        {album.name}
      </p>
      <p className="text-xs text-text-secondary truncate">
        {album.artist}
        {album.year ? ` \u00B7 ${album.year}` : ""}
      </p>
    </button>
  );
}
