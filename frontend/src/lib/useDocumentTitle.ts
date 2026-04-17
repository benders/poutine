import { useEffect, useRef } from "react";
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
  const { currentTrack, isPlaying } = usePlayer();
  const instanceIdRef = useRef<string | null>(null);

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
