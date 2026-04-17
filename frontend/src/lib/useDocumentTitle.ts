import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlayer } from "@/stores/player";
import { getInstanceInfo, type InstanceInfo } from "./api";

/**
 * Manages the document title dynamically based on:
 * - Current playing track (if any)
 * - Instance ID from the server (for fallback when not playing)
 * 
 * Format when playing: "{artist} - {song}"
 * Format when not playing: "Poutine {instanceId}"
 * Fallback: "Poutine"
 */
export function useDocumentTitle() {
  const instanceIdRef = useRef<string | null>(null);

  // Use useShallow to subscribe to multiple state values without causing
  // re-renders when the selector object reference changes
  const { queue, currentIndex, isPlaying } = usePlayer(
    useShallow((state) => ({
      queue: state.queue,
      currentIndex: state.currentIndex,
      isPlaying: state.isPlaying,
    }))
  );

  // Fetch instance info once on mount
  useEffect(() => {
    getInstanceInfo()
      .then((info: InstanceInfo) => {
        instanceIdRef.current = info.instanceId;
        updateTitle();
      })
      .catch(() => {
        instanceIdRef.current = null;
        updateTitle();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update title whenever player state changes
  useEffect(() => {
    updateTitle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, currentIndex, isPlaying]);

  function updateTitle() {
    const currentTrack = currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;

    if (currentTrack && isPlaying) {
      // When playing: just "{artist} - {song}"
      document.title = `${currentTrack.artist} - ${currentTrack.title}`;
    } else {
      // Not playing: "Poutine {instanceId}" or just "Poutine" as fallback
      const instanceId = instanceIdRef.current;
      document.title = instanceId ? `Poutine ${instanceId}` : "Poutine";
    }
  }
}
