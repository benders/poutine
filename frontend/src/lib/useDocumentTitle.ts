import { useEffect } from "react";
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

  useEffect(() => {
    let instanceId: string | null = null;
    let mounted = true;

    // Fetch instance info on mount
    getInstanceInfo()
      .then((info: InstanceInfo) => {
        if (mounted) {
          instanceId = info.instanceId;
          updateTitle();
        }
      })
      .catch(() => {
        // If instance info is unavailable, use fallback
        if (mounted) {
          instanceId = null;
          updateTitle();
        }
      });

    // Update title whenever track or playing state changes
    function updateTitle() {
      if (!mounted) return;

      if (currentTrack && isPlaying) {
        // Format: "Poutine {instanceId}: {artist} - {song}"
        const prefix = instanceId ? `Poutine ${instanceId}` : "Poutine";
        document.title = `${prefix}: ${currentTrack.artist} - ${currentTrack.title}`;
      } else {
        // Not playing: just "Poutine"
        document.title = "Poutine";
      }
    }

    // Initial title update
    updateTitle();

    return () => {
      mounted = false;
    };
  }, [currentTrack, isPlaying, instanceId]);
}
