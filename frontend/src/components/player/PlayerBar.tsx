import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayer } from "@/stores/player";
import { useToasts } from "@/stores/toast";
import { formatDuration } from "@/lib/format";
import { streamUrl, artUrl, effectiveStream } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import {
  getCapabilities,
  sonosPlay,
  sonosCommand,
  sonosSetVolume,
  getSonosState,
} from "@/lib/api";
import { DevicePicker } from "./DevicePicker";
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
    castVolume,
    castVolumeCap,
    currentTime,
    duration,
    shuffle,
    repeat,
    next,
    previous,
    togglePlay,
    setPlaying,
    setVolume,
    setCastVolume,
    setCastVolumeCap,
    setCurrentTime,
    setDuration,
    toggleShuffle,
    cycleRepeat,
    sink,
  } = usePlayer();

  const currentTrack =
    currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;

  const isSonos = sink !== "local";

  // Capabilities are static per backend boot; fetch once and stash. We only
  // use this to decide whether to render the DevicePicker.
  const [sonosAvailable, setSonosAvailable] = useState(false);
  useEffect(() => {
    getCapabilities()
      .then((c) => setSonosAvailable(c.sonos))
      .catch(() => setSonosAvailable(false));
  }, []);

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

  // streamUrl() generates a fresh u+t+s salt per call, so we MUST memoize
  // by track id — otherwise every render produces a new string, every
  // [currentStreamUrl] effect re-fires, and React throws "Maximum update
  // depth exceeded" (#185) the moment a track loads. See PlayerBar.test.tsx.
  const currentStreamUrl = useMemo(
    () => (currentTrack ? streamUrl(currentTrack.id) : null),
    [currentTrack?.id],
  );
  // Same fresh-salt-per-call hazard for artUrl(): without memoization the
  // <img> src changes on every render and the browser re-fetches
  // getCoverArt in a tight loop.
  const currentArtUrl = useMemo(
    () => (currentTrack?.coverArt ? artUrl(currentTrack.coverArt, 48) : null),
    [currentTrack?.coverArt],
  );
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

  // Update audio element when track changes. Skipped when casting to Sonos
  // — the Sonos effect below handles track changes via the control API.
  // Resumes from the store's currentTime so Sonos → local mid-track keeps
  // playing where the user left off instead of restarting from 0:00 (#194).
  // For transcoded streams we pass Subsonic `timeOffset`; the new response
  // starts at that mark and `pendingBaseOffsetRef` shifts audio.currentTime
  // back to track time on loadedmetadata (same dance handleSeek uses).
  useEffect(() => {
    if (isSonos) return;
    const audio = audioRef.current;
    if (!audio || !currentStreamUrl || !currentTrack) return;

    const resumeAt = usePlayer.getState().currentTime;
    if (resumeAt > 0) {
      pendingBaseOffsetRef.current = resumeAt;
      audio.src =
        streamUrl(currentTrack.id, { timeOffset: resumeAt }) ??
        currentStreamUrl;
    } else {
      audio.src = currentStreamUrl;
    }
    audio.load();
    if (isPlaying) {
      audio.play().catch(() => {});
    }
  }, [currentStreamUrl, isSonos]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Sync play/pause state for local playback
  useEffect(() => {
    if (isSonos) return;
    const audio = audioRef.current;
    if (!audio || !currentStreamUrl) return;

    if (isPlaying) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [isPlaying, isSonos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync volume. Depends on currentStreamUrl so a freshly mounted <audio>
  // element (e.g. on first track load) picks up the stored volume instead
  // of staying at the element's default of 1.0.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, currentStreamUrl]);

  // ── Sonos sink: route playback through the hub's Sonos API ───────────────
  //
  // Track-change effect: when casting and the track changes, push it via
  // sonosPlay(). The backend mints a signed cast URL and issues
  // SetAVTransportURI; it issues Play only if autoplay=true. Without that
  // gate, simply switching the sink to Sonos while the local player was
  // paused would surprise the user with playback on the speaker.
  //
  // We pin to `deviceId` rather than the `sink` object so a no-op setSink
  // call (new object literal, same value) doesn't re-trigger play.
  const deviceId = isSonos ? sink.deviceId : null;

  // When the active Sonos device changes (Sonos → local, Sonos → DLNA,
  // Sonos A → Sonos B), the previous speaker keeps playing the current
  // track to completion unless we explicitly stop it (#198). Stop —
  // not pause — so the user's next cast to that room starts clean
  // instead of resuming where this left off.
  const prevDeviceIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevDeviceIdRef.current;
    prevDeviceIdRef.current = deviceId;
    if (prev && prev !== deviceId) {
      void sonosCommand(prev, "stop").catch(() => {});
    }
  }, [deviceId]);

  // Base offset (track-time seconds) for the Sonos stream. Non-zero when
  // we resumed mid-track (#194) or seeked past the buffer (#182): the
  // backend embeds Subsonic `timeOffset` in the cast URL, so Sonos sees a
  // stream starting at byte 0 = track-time `castBaseOffsetRef`. We add
  // this back into the polled device position before showing it.
  const castBaseOffsetRef = useRef(0);
  // Timestamp of the most-recent sonosPlay we issued. Used to suppress
  // the spurious PLAYING → STOPPED → PLAYING blip that follows a
  // SetAVTransportURI re-issue, which would otherwise look like EOT and
  // advance the queue. #182's worst symptom.
  const lastSonosPlayAtRef = useRef(0);

  const issueSonosPlay = useCallback(
    (track: SubsonicSong, startAt: number, autoplay: boolean) => {
      if (!deviceId) return;
      castBaseOffsetRef.current = startAt > 0 ? startAt : 0;
      lastSonosPlayAtRef.current = Date.now();
      void sonosPlay(deviceId, track.id, {
        autoplay,
        position: startAt > 0 ? startAt : undefined,
      }).catch((err) => {
        pushToast({
          kind: "error",
          title: "Sonos play failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        setPlaying(false);
      });
    },
    [deviceId, pushToast, setPlaying],
  );

  useEffect(() => {
    if (!deviceId || !currentTrack) return;
    // Resume from the current store position so a mid-track sink switch
    // (local → Sonos, or Sonos A → Sonos B) keeps playing where the user
    // left off instead of restarting from 0:00 (#194). next()/previous()
    // already zero currentTime, so a normal track-change passes no offset.
    const resumeAt = usePlayer.getState().currentTime;
    issueSonosPlay(currentTrack, resumeAt, isPlaying);
    // isPlaying intentionally excluded — pause/resume is handled by its
    // own effect below. We only read its value at track-change time.
  }, [deviceId, currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play/pause toggle while casting.
  useEffect(() => {
    if (!deviceId || !currentTrack) return;
    void sonosCommand(deviceId, isPlaying ? "resume" : "pause").catch(() => {
      // Best effort — state poll will resync.
    });
  }, [isPlaying, deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sonos volume is its own slider on its own scale (0..castVolumeCap), so
  // the local `volume` value MUST NOT mirror to the device — the local
  // slider is the gain on the <audio> element and is often pinned near max
  // because the user controls real loudness via their computer. Mirroring
  // it once produced #181's "device played at 80" surprise. Cast volume
  // changes flow through the slider's onChange (debounced) below.

  // Timestamp (ms) of the last user-driven slider input. Poll-driven
  // updates within this window are ignored so a slow /state response can't
  // snap the slider back while the user is still dragging.
  const lastCastVolumeDragRef = useRef(0);
  const CAST_VOLUME_DRAG_GUARD_MS = 1500;

  // Debounce timer for SetVolume POSTs while dragging. 150ms keeps the
  // device responsive without flooding RenderingControl with SOAP calls.
  const castVolumeDebounceRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (castVolumeDebounceRef.current !== null) {
        window.clearTimeout(castVolumeDebounceRef.current);
      }
    },
    [],
  );

  // Seed castVolume from the device the first time we point at it (and
  // on every device change). The 1.5s poll only runs when there's a
  // current track; without this, switching sinks while idle would leave
  // the slider at its default until the first track plays.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    void getSonosState(deviceId)
      .then((s) => {
        if (cancelled) return;
        setCastVolumeCap(s.volumeCap);
        setCastVolume(s.volume);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deviceId, setCastVolume, setCastVolumeCap]);

  // Stop local audio when switching to Sonos so it doesn't keep playing
  // in the background.
  useEffect(() => {
    if (!isSonos) return;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
  }, [isSonos]);

  // Poll Sonos transport state for position + end-of-track detection.
  // Coalesces: if a tick is still in flight when the interval fires, skip
  // — otherwise slow SOAP round-trips would pile up requests.
  useEffect(() => {
    if (!deviceId || !currentTrack) return;
    let cancelled = false;
    let inFlight = false;
    let lastState = "";
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await getSonosState(deviceId);
        if (cancelled) return;
        // Stream may have been started mid-track (timeOffset on the cast
        // URL). Sonos reports position relative to the stream, so add
        // back the offset; trust the track's metadata duration over the
        // truncated stream's TrackDuration in that case.
        const base = castBaseOffsetRef.current;
        if (base > 0) {
          setDuration(currentTrack.durationMs / 1000);
        } else if (s.duration > 0) {
          setDuration(s.duration);
        }
        setCurrentTime(s.position + base);
        // Mirror device volume into the slider so external changes
        // (Sonos app, hardware buttons) reflect within ~1.5s. Skip if
        // the user just touched the slider — otherwise an in-flight
        // poll response could clobber their drag.
        setCastVolumeCap(s.volumeCap);
        if (Date.now() - lastCastVolumeDragRef.current > CAST_VOLUME_DRAG_GUARD_MS) {
          setCastVolume(s.volume);
        }
        // Reflect device transport state back into the store so the
        // play/pause icon (driven by isPlaying) tracks the speaker. Without
        // this, any divergence — device-side pause, hub-side pause that
        // happened outside this tab, autoplay after SetAVTransportURI —
        // leaves the UI desynced. setPlaying with an unchanged value is a
        // no-op in zustand, so this doesn't fight the toggle effect.
        if (s.state === "PLAYING") setPlaying(true);
        else if (s.state === "PAUSED_PLAYBACK") setPlaying(false);
        // STOPPED after we observed PLAYING means the track ended —
        // EXCEPT during the brief transition right after a fresh
        // SetAVTransportURI, where Sonos blips through STOPPED. Without
        // this guard, a mid-track seek (#182) or sink-resume (#194)
        // looks like EOT and advances the queue.
        const playGuardMs = 2500;
        const recentlyPlayed =
          Date.now() - lastSonosPlayAtRef.current < playGuardMs;
        if (s.state === "STOPPED" && lastState === "PLAYING" && !recentlyPlayed) {
          next();
        }
        lastState = s.state;
      } catch {
        // device probably went away — let the UI keep its last state
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    deviceId,
    currentTrack?.id,
    next,
    setCurrentTime,
    setDuration,
    setPlaying,
    setCastVolume,
    setCastVolumeCap,
  ]);

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
    // Casting suspends local playback — the Sonos-switch effect clears the
    // <audio> src, which itself fires `error` with MEDIA_ERR_SRC_NOT_SUPPORTED.
    // That's deliberate teardown, not a playback failure; squelch.
    if (isSonos) return;
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
  }, [currentTrack, pushToast, setPlaying, isSonos]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (deviceId) {
      // Re-issue play with a fresh timeOffset URL rather than SOAP Seek.
      // Transcoded MP3 has no Range support, so seeking past the buffered
      // region drove Sonos to STOPPED and the poller fired next() (#182).
      // The stream restart approach is the same one #194 uses for sink
      // resume — one code path covers both.
      setCurrentTime(time);
      if (currentTrack) issueSonosPlay(currentTrack, time, isPlaying);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    // Transcoded streams don't honor HTTP Range (#97 covers raw passthrough).
    // For seeks past the buffered region, re-request the stream with
    // Subsonic's timeOffset and play the new response from the start. (#109)
    if (isTranscoded && !isBuffered(audio, time)) {
      pendingBaseOffsetRef.current = time;
      setCurrentTime(time);
      const url = streamUrl(currentTrack.id, { timeOffset: time });
      if (!url) return;
      audio.src = url;
      audio.load();
      if (isPlaying) audio.play().catch(() => setPlaying(false));
      return;
    }

    audio.currentTime = time - baseOffsetRef.current;
    setCurrentTime(time);
  };

  if (!currentTrack) {
    return (
      <div className="fixed bottom-0 left-0 right-0 h-20 bg-player border-t border-border flex items-center justify-between px-8">
        <div className="flex-1" />
        <p className="text-text-muted text-sm">No track playing</p>
        <div className="flex-1 flex justify-end">
          {sonosAvailable && <DevicePicker />}
        </div>
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
              src={currentArtUrl ?? undefined}
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
        {sonosAvailable && <DevicePicker />}
        {isSonos ? (
          <>
            <button
              aria-label={castVolume === 0 ? "Unmute" : "Mute"}
              onClick={() => {
                if (!deviceId) return;
                const target = castVolume > 0 ? 0 : Math.min(20, castVolumeCap);
                lastCastVolumeDragRef.current = Date.now();
                setCastVolume(target);
                void sonosSetVolume(deviceId, target).catch(() => {});
              }}
              className="p-1 text-text-muted hover:text-text-primary transition-colors"
            >
              {castVolume === 0 ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={castVolumeCap}
              step={1}
              value={castVolume}
              onChange={(e) => {
                const level = parseInt(e.target.value, 10);
                setCastVolume(level);
                lastCastVolumeDragRef.current = Date.now();
                if (!deviceId) return;
                if (castVolumeDebounceRef.current !== null) {
                  window.clearTimeout(castVolumeDebounceRef.current);
                }
                castVolumeDebounceRef.current = window.setTimeout(() => {
                  void sonosSetVolume(deviceId, level).catch(() => {});
                  castVolumeDebounceRef.current = null;
                }, 150);
              }}
              aria-label="Cast volume"
              className="flex-1 h-1 appearance-none bg-border rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:rounded-full"
            />
          </>
        ) : (
          <>
            <button
              aria-label={volume === 0 ? "Unmute" : "Mute"}
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
              aria-label="Volume"
              className="flex-1 h-1 appearance-none bg-border rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:rounded-full"
            />
          </>
        )}
      </div>
    </div>
  );
}
