import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAlbum, artUrl } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { Play, Plus, ChevronRight, Disc, ChevronDown, ChevronUp, FileAudio, Info } from "lucide-react";
import { useState } from "react";
import { ShareIdButton } from "@/components/ShareIdButton";
import { StarButton } from "@/components/StarButton";
import { ErrorMessage } from "@/components/ui/ErrorMessage";

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
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);
  const [showAlbumMetadata, setShowAlbumMetadata] = useState(false);

  const { data: album, isLoading, error } = useQuery({
    queryKey: ["album", id],
    queryFn: () => getAlbum(id!),
    enabled: !!id,
    retry: false,
  });

  if (error) {
    return <div className="py-6"><ErrorMessage error={error} /></div>;
  }

  if (isLoading) {
    return <div className="text-text-muted text-center py-20">Loading...</div>;
  }

  if (!album) {
    return <div className="text-text-muted text-center py-20">Album not found.</div>;
  }

  const toggleTrackMetadata = (trackId: string) => {
    setExpandedTrackId(expandedTrackId === trackId ? null : trackId);
  };

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
              src={artUrl(album.coverArt, 400) ?? undefined}
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
            {album.year ? ` · ${album.year}` : ""}
            {album.genre ? ` · ${album.genre}` : ""}
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

          <span className="mt-3 inline-flex mr-2 align-middle">
            <StarButton
              id={album.id}
              starred={album.starred}
              invalidateKeys={[["album", id]]}
              size={20}
              showWhenUnstarred="always"
            />
          </span>

          {album.shareId && (
            <span className="mt-3 inline-flex mr-2">
              <ShareIdButton shareId={album.shareId} />
            </span>
          )}

          {/* Album metadata toggle */}
          <button
            onClick={() => setShowAlbumMetadata(!showAlbumMetadata)}
            className="mt-3 inline-flex items-center gap-2 px-4 py-1.5 bg-surface-hover hover:bg-surface text-text-primary rounded-full text-sm font-medium transition-colors cursor-pointer"
          >
            {showAlbumMetadata ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
            <Info className="w-4 h-4" />
            {showAlbumMetadata ? "Hide" : "Show"} Album Metadata
          </button>
        </div>
      </div>

      {/* Album metadata section */}
      {showAlbumMetadata && (
        <div className="bg-surface rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <FileAudio className="w-5 h-5" />
            Album Metadata
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <MetadataField label="Album Name" value={album.name} />
            <MetadataField label="Artist" value={album.artist} />
            {album.year && <MetadataField label="Year" value={album.year.toString()} />}
            {album.genre && <MetadataField label="Genre" value={album.genre} />}
            <MetadataField label="Song Count" value={album.songCount.toString()} />
            {album.coverArt && <MetadataField label="Cover Art ID" value={album.coverArt} />}
          </div>
        </div>
      )}

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
                isExpanded={expandedTrackId === song.id}
                onToggleMetadata={() => toggleTrackMetadata(song.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetadataField({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <span className="text-text-muted text-xs uppercase tracking-wide">{label}</span>
      <span className="text-text-primary font-mono text-xs break-all">{value}</span>
    </div>
  );
}

function SongRow({
  song,
  index,
  onPlay,
  onAddToQueue,
  isExpanded,
  onToggleMetadata,
}: {
  song: SubsonicSong;
  index: number;
  onPlay: () => void;
  onAddToQueue: () => void;
  isExpanded: boolean;
  onToggleMetadata: () => void;
}) {
  return (
    <>
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
          <div className="flex items-center justify-end gap-2">
            <StarButton
              id={song.id}
              starred={song.starred}
              invalidateKeys={[["album", song.albumId]]}
            />
            <button
              onClick={onAddToQueue}
              className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-text-primary transition-all cursor-pointer"
              title="Add to queue"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onToggleMetadata}
              className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-text-primary transition-all cursor-pointer"
              title="View metadata"
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="px-4 py-4 bg-surface-hover">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm">
              <MetadataField label="Title" value={song.title} />
              <MetadataField label="Artist" value={song.artist} />
              {song.album && <MetadataField label="Album" value={song.album} />}
              {song.track && <MetadataField label="Track" value={song.track.toString()} />}
              {song.discNumber && <MetadataField label="Disc" value={song.discNumber.toString()} />}
              {song.year && <MetadataField label="Year" value={song.year.toString()} />}
              {song.genre && <MetadataField label="Genre" value={song.genre} />}
              {song.bitRate && <MetadataField label="Bit Rate" value={`${song.bitRate} kbps`} />}
              {song.suffix && <MetadataField label="Format" value={song.suffix.toUpperCase()} />}
              {song.contentType && <MetadataField label="Content Type" value={song.contentType} />}
              {song.size && <MetadataField label="Size" value={`${(song.size / (1024 * 1024)).toFixed(2)} MB`} />}
              {song.durationMs && <MetadataField label="Duration" value={formatDuration(song.durationMs)} />}
              {song.sortName && <MetadataField label="Sort Name" value={song.sortName} />}
              {song.musicBrainzId && <MetadataField label="MusicBrainz ID" value={song.musicBrainzId} />}
              {song.path && <MetadataField label="Path" value={song.path} />}
              {song.comment && <MetadataField label="Comment" value={song.comment} />}
              {song.bpm && <MetadataField label="BPM" value={song.bpm.toString()} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
