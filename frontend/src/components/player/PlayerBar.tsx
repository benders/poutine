import { useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayer } from "@/stores/player";
import { useToasts } from "@/stores/toast";
import { formatDuration } from "@/lib/format";
import { streamUrl, artUrl, effectiveStream } from "@/lib/subsonic";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Shuffle,
  Repeat,
  Repeat1,
  ListMusic,
} from "lucide-react";
import { cn } from "@/lib/cn";

export function PlayerBar() {
  const navigate = useNavigate();
  const audioRef = useRef<HTMLAudioElement>(null);
  const pushToast = useToasts((s) => s.push);
  const {
    queue,
    currentIndex,
    isPlaying,
    volume,
    currentTime,
    duration,
    shuffle,
    repeat,
    next,
    previous,
    togglePlay,
    setPlaying,
    setVolume,
    setCurrentTime,
    setDuration,
    toggleShuffle,
    cycleRepeat,
  } = usePlayer();

  const currentTrack =
    currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;

  // Base offset (seconds) for the current <audio> src. Non-zero when the
  // server was asked to start mid-track via Subsonic timeOffset. The browser
  // still reports audio.currentTime as 0 at the start of that response, so
  // we add this to derive the real track time. (#109)
  const baseOffsetRef = useRef(0);
  // Pending seek target carried across an audio.src reset for transcoded
  // streams: when the user drags past the buffered region we re-issue the
  // request with timeOffset; the new response starts at that offset, so we
  // leave audio.currentTime at 0.
  const pendingBaseOffsetRef = useRef<number | null>(null);

  const currentStreamUrl = currentTrack ? streamUrl(currentTrack.id) : null;
  const streamed = currentTrack ? effectiveStream(currentTrack) : null;
  const isTranscoded = streamed?.bitRateIsCap === true;
  const sourceLabel = currentTrack?.suffix && currentTrack.bitRate
    ? `Source: ${currentTrack.suffix.toUpperCase()} ${currentTrack.bitRate} kbps`
    : currentTrack?.suffix
      ? `Source: ${currentTrack.suffix.toUpperCase()}`
      : undefined;

  // Navigation handlers for Issue #40
  const navigateToAlbum = () => {
    if (currentTrack?.albumId) {
      navigate(`/albums/${currentTrack.albumId}`);
    }
  };

  const navigateToArtist = () => {
    if (currentTrack?.artistId) {
      navigate(`/artists/${currentTrack.artistId}`);
    }
  };

  // Seed duration from metadata when track changes
  useEffect(() => {
    baseOffsetRef.current = 0;
    pendingBaseOffsetRef.current = null;
    if (currentTrack) {
      setDuration(currentTrack.durationMs / 1000);
    }
  }, [currentStreamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update audio element when track changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentStreamUrl) return;

    audio.src = currentStreamUrl;
    audio.load();
    if (isPlaying) {
      audio.play().catch(() => {});
    }
  }, [currentStreamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // True if `target` (track-time seconds) lies in any of audio.buffered's
  // ranges, translated by the current base offset.
  const isBuffered = (audio: HTMLAudioElement, target: number) => {
    const local = target - baseOffsetRef.current;
    if (local < 0) return false;
    const ranges = audio.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (local >= ranges.start(i) && local <= ranges.end(i)) return true;
    }
    return false;
  };

  // Sync play/pause state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentStreamUrl) return;

    if (isPlaying) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync volume. Depends on currentStreamUrl so a freshly mounted <audio>
  // element (e.g. on first track load) picks up the stored volume instead
  // of staying at the element's default of 1.0.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, currentStreamUrl]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime + baseOffsetRef.current);
    }
  }, [setCurrentTime]);

  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Promote the pending base offset (set by a transcoded-seek re-request)
    // now that the new response has loaded. Browser will report
    // currentTime starting at 0; baseOffsetRef shifts it back to track time.
    if (pendingBaseOffsetRef.current !== null) {
      baseOffsetRef.current = pendingBaseOffsetRef.current;
      pendingBaseOffsetRef.current = null;
      setCurrentTime(baseOffsetRef.current);
      return;
    }
    if (isFinite(audio.duration)) {
      setDuration(audio.duration);
    }
  }, [setDuration, setCurrentTime]);

  const handleEnded = useCallback(() => {
    next();
  }, [next]);

  const handleError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const code = audio.error?.code;
    const detail =
      code === MediaError.MEDIA_ERR_NETWORK
        ? "Network error while streaming"
        : code === MediaError.MEDIA_ERR_DECODE
          ? "Audio decode error"
          : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? "Stream format not supported"
            : "Stream request failed";
    pushToast({
      kind: "error",
      title: `Playback failed: ${currentTrack?.title ?? "track"}`,
      detail,
    });
    setPlaying(false);
  }, [currentTrack, pushToast, setPlaying]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    // Transcoded streams don't honor HTTP Range (#97 covers raw passthrough).
    // For seeks past the buffered region, re-request the stream with
    // Subsonic's timeOffset and play the new response from the start. (#109)
    if (isTranscoded && !isBuffered(audio, time)) {
      pendingBaseOffsetRef.current = time;
      setCurrentTime(time);
      audio.src = streamUrl(currentTrack.id, { timeOffset: time });
      audio.load();
      if (isPlaying) audio.play().catch(() => setPlaying(false));
      return;
    }

    audio.currentTime = time - baseOffsetRef.current;
    setCurrentTime(time);
  };

  if (!currentTrack) {
    return (
      <div className="fixed bottom-0 left-0 right-0 h-20 bg-player border-t border-border flex items-center justify-center">
        <p className="text-text-muted text-sm">No track playing</p>
        <audio ref={audioRef} preload="auto" />
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 h-20 bg-player border-t border-border flex items-center px-8 gap-4 z-50">
      <audio
        ref={audioRef}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onError={handleError}
      />

      {/* Track info */}
      <div className="shrink-0 flex items-center gap-3">
        <div
          className="w-12 h-12 rounded overflow-hidden bg-surface-active shrink-0 flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity"
          onClick={navigateToAlbum}
          title={currentTrack?.album ? `View album: ${currentTrack.album}` : undefined}
        >
          {currentTrack?.coverArt ? (
            <img
              src={artUrl(currentTrack.coverArt, 48)}
              alt={currentTrack.album || "Album art"}
              className="w-full h-full object-cover"
            />
          ) : (
            <ListMusic className="w-5 h-5 text-text-muted" />
          )}
        </div>
        <div className="min-w-0 max-w-xs">
          <p
            className="text-sm font-medium truncate cursor-pointer hover:underline"
            onClick={navigateToAlbum}
            title={currentTrack?.album ? `View album: ${currentTrack.album}` : undefined}
          >
            {currentTrack.title}
          </p>
          <p
            className="text-xs text-text-secondary truncate cursor-pointer hover:underline"
            onClick={navigateToArtist}
            title={currentTrack?.artist ? `View artist: ${currentTrack.artist}` : undefined}
          >
            {currentTrack.artist}
          </p>
          <div
            className="flex items-center gap-2 text-xs text-text-muted mt-0.5"
            title={sourceLabel}
          >
            {streamed && (
              <>
                <span className="uppercase">{streamed.format}</span>
                <span>
                  {streamed.bitRateIsCap ? "transcoding" : `${streamed.bitRate} kbps`}
                </span>
              </>
            )}
            {currentTrack.sourceInstance && (
              <span>• {currentTrack.sourceInstance}</span>
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1 w-full max-w-xl mx-auto">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleShuffle}
            className={cn(
              "p-1 rounded transition-colors",
              shuffle
                ? "text-accent"
                : "text-text-muted hover:text-text-primary",
            )}
          >
            <Shuffle className="w-4 h-4" />
          </button>
          <button
            onClick={previous}
            className="p-1 text-text-secondary hover:text-text-primary transition-colors"
          >
            <SkipBack className="w-5 h-5" />
          </button>
          <button
            onClick={togglePlay}
            className="p-2 rounded-full bg-text-primary text-background hover:scale-105 transition-transform"
          >
            {isPlaying ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4 ml-0.5" />
            )}
          </button>
          <button
            onClick={next}
            className="p-1 text-text-secondary hover:text-text-primary transition-colors"
          >
            <SkipForward className="w-5 h-5" />
          </button>
          <button
            onClick={cycleRepeat}
            className={cn(
              "p-1 rounded transition-colors",
              repeat !== "none"
                ? "text-accent"
                : "text-text-muted hover:text-text-primary",
            )}
          >
            {repeat === "one" ? (
              <Repeat1 className="w-4 h-4" />
            ) : (
              <Repeat className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Seek bar */}
        <div className="w-full flex items-center gap-2">
          <span className="text-xs text-text-muted w-10 text-right">
            {formatDuration(currentTime * 1000)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1 appearance-none bg-border rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:rounded-full"
          />
          <span className="text-xs text-text-muted w-10">
            {formatDuration(duration * 1000)}
          </span>
        </div>
      </div>

      {/* Volume */}
      <div className="shrink-0 flex items-center gap-2">
        <button
          onClick={() => setVolume(volume > 0 ? 0 : 0.8)}
          className="p-1 text-text-muted hover:text-text-primary transition-colors"
        >
          {volume === 0 ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={Math.sqrt(volume)}
          onChange={(e) => {
            const pos = parseFloat(e.target.value);
            setVolume(pos * pos);
          }}
          className="flex-1 h-1 appearance-none bg-border rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:rounded-full"
        />
      </div>
    </div>
  );
}
