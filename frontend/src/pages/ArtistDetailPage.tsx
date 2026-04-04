import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getArtist, artUrl } from "@/lib/api";
import type { ReleaseGroup } from "@/lib/api";
import { ChevronRight, Disc, User } from "lucide-react";

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

export function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: artist, isLoading } = useQuery({
    queryKey: ["artist", id],
    queryFn: () => getArtist(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="text-text-muted text-center py-20">Loading...</div>;
  }

  if (!artist) {
    return <div className="text-text-muted text-center py-20">Artist not found.</div>;
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-text-muted">
        <Link to="/artists" className="hover:text-text-primary transition-colors">
          Artists
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-text-primary">{artist.name}</span>
      </nav>

      {/* Artist header */}
      <div className="flex items-center gap-6">
        <div
          className="w-28 h-28 rounded-full flex items-center justify-center shrink-0"
          style={{ backgroundColor: hashColor(artist.name) }}
        >
          {artist.imageUrl ? (
            <img
              src={artUrl(artist.imageUrl, 300)}
              alt={artist.name}
              className="w-full h-full rounded-full object-cover"
            />
          ) : (
            <span className="text-3xl font-bold text-white/60">
              {initials(artist.name)}
            </span>
          )}
        </div>
        <div>
          <h1 className="text-3xl font-bold text-text-primary">{artist.name}</h1>
          <p className="text-text-secondary mt-1">
            {artist.releaseGroups.length}{" "}
            {artist.releaseGroups.length === 1 ? "album" : "albums"}
          </p>
        </div>
      </div>

      {/* Discography */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">Discography</h2>
        {artist.releaseGroups.length === 0 ? (
          <p className="text-text-muted">No albums found.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {artist.releaseGroups.map((rg) => (
              <AlbumCard
                key={rg.id}
                releaseGroup={rg}
                onClick={() => navigate(`/albums/${rg.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumCard({
  releaseGroup,
  onClick,
}: {
  releaseGroup: ReleaseGroup;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover cursor-pointer"
    >
      <div
        className="aspect-square rounded-md mb-3 flex items-center justify-center"
        style={{ backgroundColor: hashColor(releaseGroup.name) }}
      >
        <Disc className="w-10 h-10 text-white/30" />
      </div>
      <p className="text-sm font-medium text-text-primary truncate">
        {releaseGroup.name}
      </p>
      <p className="text-xs text-text-secondary truncate">
        {releaseGroup.year ?? "Unknown year"}
      </p>
    </button>
  );
}
