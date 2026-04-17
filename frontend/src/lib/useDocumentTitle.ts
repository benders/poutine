import { useEffect, useRef, useMemo } from "react";
import { usePlayer } from "@/stores/player";
import { getInstanceInfo, type InstanceInfo } from "./api";

/**
 * Manages the document title dynamically based on:
 * - Current playing track (if any)
 * - Instance ID from the server
 * 
 * Format when playing: "Poutine {instanceId}: {artist} - {song}"
 * Format when not playing: "Poutine"
 * Fallback: "Poutine"
 */
export function useDocumentTitle() {
  // Subscribe to the underlying state values that determine currentTrack
  // (not the computed getter, which won't trigger re-renders properly)
  const queue = usePlayer((state) => state.queue);
  const currentIndex = usePlayer((state) => state.currentIndex);
  const isPlaying = usePlayer((state) => state.isPlaying);
  
  const instanceIdRef = useRef<string | null>(null);

  // Compute currentTrack from the subscribed state values
  const currentTrack = useMemo(() => {
    return currentIndex >= 0 && currentIndex < queue.length
      ? queue[currentIndex]
      : null;
  }, [queue, currentIndex]);

  useEffect(() => {
    // Fetch instance info on mount
    getInstanceInfo()
      .then((info: InstanceInfo) => {
        instanceIdRef.current = info.instanceId;
        updateTitle();
      })
      .catch(() => {
        // If instance info is unavailable, use fallback
        instanceIdRef.current = null;
        updateTitle();
      });
  }, []);

  // Update title whenever track or playing state changes
  useEffect(() => {
    updateTitle();
  }, [currentTrack, isPlaying]);

  function updateTitle() {
    const instanceId = instanceIdRef.current;

    if (currentTrack && isPlaying) {
      // Format: "Poutine {instanceId}: {artist} - {song}"
      const prefix = instanceId ? `Poutine ${instanceId}` : "Poutine";
      document.title = `${prefix}: ${currentTrack.artist} - ${currentTrack.title}`;
    } else {
      // Not playing: just "Poutine"
      document.title = "Poutine";
    }
  }
}
