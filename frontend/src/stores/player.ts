import { create } from "zustand";
import type { SubsonicSong } from "@/lib/subsonic";

/**
 * Playback sink. `"local"` plays through the HTML5 <audio> element in the
 * browser tab; `{ type: "sonos", ... }` routes playback through the hub's
 * Sonos control API (see /api/sonos/devices/:id/*). Not persisted across
 * sessions — always defaults to local on a fresh load.
 */
export type PlayerSink =
  | "local"
  | { type: "sonos"; deviceId: string; deviceName: string };

/**
 * Default cap fallback used until the hub's /state response supplies the
 * authoritative value (currently 50 server-side, see SONOS_VOLUME_CAP).
 * Hard-coded mirror — #184 will turn this into a settable user pref.
 */
export const DEFAULT_SONOS_VOLUME_CAP = 50;

interface PlayerState {
  queue: SubsonicSong[];
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  /**
   * Sonos device volume (0..100, integer, capped). Tracked separately
   * from `volume` because the local `<audio>` slider is commonly pinned
   * near max while the user controls real loudness via their computer's
   * volume — that value must not flow to a Sonos device.
   */
  castVolume: number;
  /** Authoritative cap from the hub; mirrored to bound the cast slider. */
  castVolumeCap: number;
  /**
   * Volume remembered across a mute/unmute cycle (#207). Session-scoped
   * (not persisted) — a fresh load has nothing to restore, which is fine
   * since `setVolume`/`setCastVolume` already seed sane defaults.
   */
  prevVolume: number | null;
  prevCastVolume: number | null;
  currentTime: number;
  duration: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  sink: PlayerSink;

  // Computed
  currentTrack: SubsonicSong | null;

  // Actions
  playTrack: (track: SubsonicSong) => void;
  playTracks: (tracks: SubsonicSong[], startIndex?: number) => void;
  addToQueue: (track: SubsonicSong) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  next: () => void;
  /**
   * Compute what `next()` *would* do without mutating state. Used by
   * `PlayerBar` to pre-load the next track on Sonos via
   * `SetNextAVTransportURI` for gapless auto-advance (#202). Returns the
   * next song and its queue index, or `null` if there is nothing to
   * follow up with (end of queue + repeat off).
   *
   * **Shuffle caveat.** With shuffle on this picks a random index, so two
   * calls return different songs. Callers that need the *same* choice
   * across multiple reads (e.g. POST /next, then jump to that index when
   * Sonos auto-advances onto it) must cache the result.
   */
  peekNext: () => { track: SubsonicSong; index: number } | null;
  /**
   * Jump to a specific queue index without picking randomly. Used by the
   * Sonos URI-change handler (#202) to sync the store onto whatever the
   * device actually started playing after a pre-loaded auto-advance,
   * sidestepping shuffle's nondeterminism.
   */
  jumpTo: (index: number) => void;
  previous: () => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setCastVolume: (level: number) => void;
  setCastVolumeCap: (cap: number) => void;
  /**
   * Mute/unmute the local `<audio>` volume, remembering the pre-mute level
   * so unmuting restores it (#207). Falls back to slider-halfway (raw 0.25,
   * since the slider is square-law — see PlayerBar) when there's nothing to
   * restore, or when the remembered value was itself 0.
   */
  toggleMute: () => void;
  /**
   * Mute/unmute cast volume, remembering the pre-mute level (#207). Returns
   * the new level so the caller can push it to the Sonos device — the store
   * doesn't own that side effect. Falls back to `min(20, castVolumeCap)`,
   * matching the pre-existing unmute default, and clamps a restored value
   * to the current cap in case it changed while muted.
   */
  toggleCastMute: () => number;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setSink: (sink: PlayerSink) => void;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  volume: parseFloat(localStorage.getItem("volume") || "0.8"),
  castVolume: DEFAULT_SONOS_VOLUME_CAP,
  castVolumeCap: DEFAULT_SONOS_VOLUME_CAP,
  prevVolume: null,
  prevCastVolume: null,
  currentTime: 0,
  duration: 0,
  shuffle: false,
  repeat: "none",
  sink: "local",

  get currentTrack() {
    const { queue, currentIndex } = get();
    return currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;
  },

  // Explicit user-initiated track changes zero `currentTime` so the local
  // <audio> + Sonos play effects don't pick up the previous track's
  // position as a resume point — #194 designed that hand-off for sink
  // switches, not click-to-play.
  playTrack: (track) =>
    set((state) => {
      const current = state.queue[state.currentIndex];
      if (current && current.id === track.id) {
        return { isPlaying: !state.isPlaying };
      }
      return { queue: [track], currentIndex: 0, isPlaying: true, currentTime: 0 };
    }),

  playTracks: (tracks, startIndex = 0) =>
    set((state) => {
      const requested = tracks[startIndex];
      const current = state.queue[state.currentIndex];
      if (requested && current && current.id === requested.id) {
        return { isPlaying: !state.isPlaying };
      }
      return { queue: tracks, currentIndex: startIndex, isPlaying: true, currentTime: 0 };
    }),

  addToQueue: (track) =>
    set((state) => ({ queue: [...state.queue, track] })),

  removeFromQueue: (index) =>
    set((state) => {
      const queue = state.queue.filter((_, i) => i !== index);
      let currentIndex = state.currentIndex;
      if (index < currentIndex) currentIndex--;
      else if (index === currentIndex) {
        currentIndex = Math.min(currentIndex, queue.length - 1);
      }
      return { queue, currentIndex };
    }),

  clearQueue: () => set({ queue: [], currentIndex: -1, isPlaying: false }),

  next: () =>
    set((state) => {
      const { queue, currentIndex, repeat, shuffle } = state;
      if (queue.length === 0) return {};

      if (repeat === "one") return { currentTime: 0 };

      let nextIndex: number;
      if (shuffle) {
        nextIndex = Math.floor(Math.random() * queue.length);
      } else {
        nextIndex = currentIndex + 1;
      }

      if (nextIndex >= queue.length) {
        if (repeat === "all") nextIndex = 0;
        else return { isPlaying: false };
      }

      return { currentIndex: nextIndex, isPlaying: true, currentTime: 0 };
    }),

  peekNext: () => {
    const { queue, currentIndex, repeat, shuffle } = get();
    if (queue.length === 0) return null;
    if (repeat === "one") {
      const cur = queue[currentIndex];
      return cur ? { track: cur, index: currentIndex } : null;
    }
    let nextIndex: number;
    if (shuffle) {
      nextIndex = Math.floor(Math.random() * queue.length);
    } else {
      nextIndex = currentIndex + 1;
    }
    if (nextIndex >= queue.length) {
      if (repeat === "all") nextIndex = 0;
      else return null;
    }
    const track = queue[nextIndex];
    return track ? { track, index: nextIndex } : null;
  },

  jumpTo: (index) =>
    set((state) => {
      if (index < 0 || index >= state.queue.length) return {};
      return { currentIndex: index, isPlaying: true, currentTime: 0 };
    }),

  previous: () =>
    set((state) => {
      if (state.currentTime > 3) return { currentTime: 0 };
      const prevIndex = Math.max(0, state.currentIndex - 1);
      return { currentIndex: prevIndex, currentTime: 0 };
    }),

  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setVolume: (volume) => {
    localStorage.setItem("volume", String(volume));
    set({ volume });
  },
  setCastVolume: (castVolume) =>
    set((state) => ({
      castVolume: Math.max(
        0,
        Math.min(state.castVolumeCap, Math.round(castVolume)),
      ),
    })),
  setCastVolumeCap: (castVolumeCap) =>
    set((state) => ({
      castVolumeCap,
      // Re-clamp the current value to the new cap so we never present a
      // slider position above its own max.
      castVolume: Math.min(state.castVolume, castVolumeCap),
    })),
  toggleMute: () =>
    set((state) => {
      if (state.volume > 0) {
        localStorage.setItem("volume", "0");
        return { volume: 0, prevVolume: state.volume };
      }
      // Unmute: restore the remembered level, or fall back to slider-halfway
      // (raw 0.25 under the square-law slider) if there's nothing usable to
      // restore to (#207).
      const restored =
        state.prevVolume && state.prevVolume > 0 ? state.prevVolume : 0.25;
      localStorage.setItem("volume", String(restored));
      return { volume: restored, prevVolume: null };
    }),
  toggleCastMute: () => {
    const state = get();
    if (state.castVolume > 0) {
      set({ castVolume: 0, prevCastVolume: state.castVolume });
      return 0;
    }
    const restored =
      state.prevCastVolume && state.prevCastVolume > 0
        ? Math.min(state.prevCastVolume, state.castVolumeCap)
        : Math.min(20, state.castVolumeCap);
    set({ castVolume: restored, prevCastVolume: null });
    return restored;
  },
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),
  cycleRepeat: () =>
    set((state) => {
      const modes: Array<"none" | "one" | "all"> = ["none", "all", "one"];
      const idx = modes.indexOf(state.repeat);
      return { repeat: modes[(idx + 1) % modes.length] };
    }),
  // Keep currentTime when switching sinks so playback resumes from the
  // current position on the new device (#194). Track-changes (next/previous)
  // already reset it; this is the only path that needs to *preserve* it.
  setSink: (sink) => set({ sink }),
}));
