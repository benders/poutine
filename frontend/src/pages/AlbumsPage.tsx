import { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAlbumList2, artUrl } from "@/lib/subsonic";
import type { SubsonicAlbum } from "@/lib/subsonic";
import { Disc, Shuffle } from "lucide-react";
import { useScrollRestoration } from "@/lib/useScrollRestoration";
import { CategoryGrid, type SortOptionDef } from "@/components/CategoryGrid";
import { getPeersSummary, peerDisplayName } from "@/lib/api";

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 30%)`;
}

type SortOption = "name" | "year" | "recent";

const SORT_OPTIONS: SortOptionDef<SortOption>[] = [
  { value: "name", label: "Name" },
  { value: "year", label: "Year" },
  { value: "recent", label: "Recently Added" },
];

interface ViewSpec {
  /** Subsonic getAlbumList2 type param. */
  type: string;
  /** Subsonic getAlbumList2 instanceId filter (Poutine extension). */
  instanceId?: string;
  /** Display title shown in the page header. */
  title: string;
}

/**
 * Map a URL view slug to the API params and display title.
 * Slugs: `all`, `random`, `local`, `peer-<peerId>`.
 * Returns null for unknown slugs so the page can redirect.
 */
function resolveView(
  slug: string,
  peerName: (id: string) => string,
): ViewSpec | null {
  if (slug === "all") return { type: "alphabeticalByName", title: "All Albums" };
  if (slug === "random") return { type: "random", title: "Random Albums" };
  if (slug === "local")
    return { type: "alphabeticalByName", instanceId: "local", title: "Local Albums" };
  if (slug.startsWith("peer-")) {
    const peerId = slug.slice("peer-".length);
    if (!peerId) return null;
    return {
      type: "alphabeticalByName",
      instanceId: peerId,
      title: peerName(peerId),
    };
  }
  return null;
}

export function AlbumsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { view: rawView } = useParams<{ view?: string }>();
  const view = rawView ?? "all";

  const { data: peers } = useQuery({
    queryKey: ["peers-summary"],
    queryFn: getPeersSummary,
    retry: false,
    // The summary changes infrequently and the same query feeds the sidebar;
    // share a long stale window so navigation doesn't refetch.
    staleTime: 60_000,
  });

  const peerName = (id: string) =>
    peerDisplayName(peers?.find((p) => p.id === id)?.name ?? id);

  const spec = resolveView(view, peerName);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("name");

  // Reset search/sort when changing tabs — feels cleaner than carrying a
  // search across very different lists.
  useEffect(() => {
    setSearch("");
    setSort(view === "random" ? "name" : "name");
  }, [view]);

  const queryKey = ["albumList2", view] as const;
  const enabled = spec !== null;

  const { data: albums, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      getAlbumList2({
        type: spec!.type,
        size: 500,
        instanceId: spec!.instanceId,
      }),
    enabled,
    retry: false,
    // Keep Random stable on back-nav; user taps Shuffle to reroll.
    staleTime: spec?.type === "random" ? Infinity : 0,
  });

  useScrollRestoration(`albums:${view}`, !!albums);

  const filtered = useMemo(() => {
    if (!albums) return undefined;
    let items = [...albums];
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.artist.toLowerCase().includes(q),
      );
    }
    // Random view: preserve server-shuffled order. Sort is hidden in that mode.
    if (spec?.type !== "random") {
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
    }
    return items;
  }, [albums, search, sort, spec]);

  if (!spec) return <Navigate to="/library/all" replace />;

  const isRandom = spec.type === "random";

  return (
    <CategoryGrid<SubsonicAlbum, SortOption>
      title={spec.title}
      headerExtra={
        isRandom ? (
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey })}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title="Shuffle"
          >
            <Shuffle className="w-4 h-4" />
            Shuffle
          </button>
        ) : null
      }
      items={filtered}
      isLoading={isLoading}
      error={error}
      searchPlaceholder="Search albums..."
      search={search}
      onSearchChange={setSearch}
      sortOptions={isRandom ? undefined : SORT_OPTIONS}
      sort={isRandom ? undefined : sort}
      onSortChange={isRandom ? undefined : setSort}
      emptyMessage="No albums in your library yet."
      emptySearchMessage="No albums match your search."
      itemKey={(a) => a.id}
      renderItem={(album) => (
        <AlbumCard album={album} onClick={() => navigate(`/albums/${album.id}`)} />
      )}
    />
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
      className="w-full group text-left rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover cursor-pointer"
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
        {album.year ? ` · ${album.year}` : ""}
      </p>
    </button>
  );
}
