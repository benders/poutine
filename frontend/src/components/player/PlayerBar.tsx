import { useEffect, useRef, useCallback } from "react";
import { usePlayer } from "@/stores/player";
import { formatDuration } from "@/lib/format";
import { getAccessToken } from "@/lib/api";
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
  const audioRef = useRef<HTMLAudioElement>(null);
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

  const streamUrl = currentTrack
    ? `/api/stream/${currentTrack.id}?format=mp3&maxBitRate=192&token=${getAccessToken()}`
    : null;

  // Update audio element when track changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !streamUrl) return;

    audio.src = streamUrl;
    audio.load();
    if (isPlaying) {
      audio.play().catch(() => {});
    }
  }, [streamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync play/pause state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !streamUrl) return;

    if (isPlaying) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync volume
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  }, [setCurrentTime]);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  }, [setDuration]);

  const handleEnded = useCallback(() => {
    next();
  }, [next]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
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
    <div className="fixed bottom-0 left-0 right-0 h-20 bg-player border-t border-border flex items-center px-4 gap-4 z-50">
      <audio
        ref={audioRef}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
      />

      {/* Track info */}
      <div className="w-56 shrink-0 flex items-center gap-3 min-w-0">
        <div className="w-12 h-12 rounded bg-surface-active shrink-0 flex items-center justify-center">
          <ListMusic className="w-5 h-5 text-text-muted" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{currentTrack.title}</p>
          <p className="text-xs text-text-secondary truncate">
            {currentTrack.artistName}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1 max-w-xl">
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
      <div className="w-36 shrink-0 flex items-center gap-2">
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
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="flex-1 h-1 appearance-none bg-border rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:rounded-full"
        />
      </div>
    </div>
  );
}
