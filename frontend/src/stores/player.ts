import { create } from "zustand";
import type { Track } from "@/lib/api";
import { getAccessToken } from "@/lib/api";

interface PlayerState {
  queue: Track[];
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";

  // Computed
  currentTrack: Track | null;

  // Actions
  playTrack: (track: Track) => void;
  playTracks: (tracks: Track[], startIndex?: number) => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  next: () => void;
  previous: () => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  getStreamUrl: (trackId: string) => string;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  volume: parseFloat(localStorage.getItem("volume") || "0.8"),
  currentTime: 0,
  duration: 0,
  shuffle: false,
  repeat: "none",

  get currentTrack() {
    const { queue, currentIndex } = get();
    return currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;
  },

  playTrack: (track) =>
    set({ queue: [track], currentIndex: 0, isPlaying: true }),

  playTracks: (tracks, startIndex = 0) =>
    set({ queue: tracks, currentIndex: startIndex, isPlaying: true }),

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
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),
  cycleRepeat: () =>
    set((state) => {
      const modes: Array<"none" | "one" | "all"> = ["none", "all", "one"];
      const idx = modes.indexOf(state.repeat);
      return { repeat: modes[(idx + 1) % modes.length] };
    }),

  getStreamUrl: (trackId: string) => {
    const token = getAccessToken();
    return `/api/stream/${trackId}?format=opus&maxBitRate=128&token=${token}`;
  },
}));
