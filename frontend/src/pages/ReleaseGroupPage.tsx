import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getReleaseGroup, artUrl } from "@/lib/api";
import type { Track, Release } from "@/lib/api";
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

  const { data: releaseGroup, isLoading } = useQuery({
    queryKey: ["releaseGroup", id],
    queryFn: () => getReleaseGroup(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="text-text-muted text-center py-20">Loading...</div>;
  }

  if (!releaseGroup) {
    return <div className="text-text-muted text-center py-20">Album not found.</div>;
  }

  const firstRelease = releaseGroup.releases?.[0];
  const allFirstReleaseTracks = firstRelease?.tracks ?? [];

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-text-muted">
        <Link to="/" className="hover:text-text-primary transition-colors">
          Library
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-text-primary truncate">{releaseGroup.name}</span>
      </nav>

      {/* Album header */}
      <div className="flex items-start gap-6">
        <div
          className="w-48 h-48 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
          style={{ backgroundColor: hashColor(releaseGroup.name) }}
        >
          {releaseGroup.imageUrl ? (
            <img
              src={artUrl(releaseGroup.imageUrl, 400)}
              alt={releaseGroup.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <Disc className="w-16 h-16 text-white/30" />
          )}
        </div>
        <div className="min-w-0 pt-2">
          <h1 className="text-3xl font-bold text-text-primary">{releaseGroup.name}</h1>
          <p className="text-text-secondary mt-1">
            <Link
              to={`/artists/${releaseGroup.artistId}`}
              className="hover:text-accent transition-colors"
            >
              {releaseGroup.artistName}
            </Link>
            {releaseGroup.year ? ` \u00B7 ${releaseGroup.year}` : ""}
            {releaseGroup.genre ? ` \u00B7 ${releaseGroup.genre}` : ""}
          </p>

          {allFirstReleaseTracks.length > 0 && (
            <button
              onClick={() => playTracks(allFirstReleaseTracks, 0)}
              className="mt-4 inline-flex items-center gap-2 px-5 py-2 bg-accent hover:bg-accent-hover text-white rounded-full text-sm font-medium transition-colors cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              Play All
            </button>
          )}
        </div>
      </div>

      {/* Releases */}
      {releaseGroup.releases?.map((release) => (
        <ReleaseSection
          key={release.id}
          release={release}
          showEdition={releaseGroup.releases.length > 1}
          onPlayTrack={(index) => playTracks(release.tracks, index)}
          onAddToQueue={addToQueue}
        />
      ))}
    </div>
  );
}

function ReleaseSection({
  release,
  showEdition,
  onPlayTrack,
  onAddToQueue,
}: {
  release: Release;
  showEdition: boolean;
  onPlayTrack: (index: number) => void;
  onAddToQueue: (track: Track) => void;
}) {
  return (
    <div>
      {showEdition && (
        <h3 className="text-sm font-medium text-text-secondary mb-3">
          {release.edition || release.name}
        </h3>
      )}
      <div className="bg-surface rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wider">
              <th className="py-2.5 px-4 text-left w-12">#</th>
              <th className="py-2.5 px-4 text-left">Title</th>
              <th className="py-2.5 px-4 text-right w-24">Duration</th>
              <th className="py-2.5 px-4 text-right w-20"></th>
            </tr>
          </thead>
          <tbody>
            {release.tracks.map((track, index) => (
              <tr
                key={track.id}
                className="group border-b border-border/50 last:border-0 hover:bg-surface-hover transition-colors"
              >
                <td className="py-2.5 px-4 text-sm text-text-muted">
                  <span className="group-hover:hidden">{track.trackNumber}</span>
                  <button
                    onClick={() => onPlayTrack(index)}
                    className="hidden group-hover:block text-text-primary hover:text-accent cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                </td>
                <td className="py-2.5 px-4">
                  <p className="text-sm text-text-primary">{track.title}</p>
                  {track.sources && track.sources.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {track.sources.map((source, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-border/50 text-text-muted"
                        >
                          {source.format}
                          {source.bitrate ? ` ${source.bitrate}k` : ""}
                          {" \u00B7 "}
                          {source.instanceName}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-2.5 px-4 text-sm text-text-muted text-right">
                  {formatDuration(track.durationMs)}
                </td>
                <td className="py-2.5 px-4 text-right">
                  <button
                    onClick={() => onAddToQueue(track)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-text-primary transition-all cursor-pointer"
                    title="Add to queue"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
