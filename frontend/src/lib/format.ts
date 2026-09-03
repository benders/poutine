export function formatDuration(ms: number): string {
  if (!isFinite(ms) || isNaN(ms)) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatDurationLong(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} min`;
}

/**
 * Countdown counterpart to `formatTimeAgo`, for deadlines rather than events
 * (invite expiry, #272). `formatTimeAgo` clamps a future timestamp to
 * "just now", which reads as "already expired" on an invite that has two days
 * left — hence a separate helper rather than a sign tweak in that one.
 */
export function formatTimeUntil(dateStr: string | null | undefined): string {
  if (!dateStr) return "never";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "never";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "expired";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${Math.max(diffMin, 1)}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `in ${diffHours}h`;
  return `in ${Math.floor(diffHours / 24)}d`;
}

export function formatTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  if (isNaN(date.getTime()) || date.getUTCFullYear() < 1970) return "Never";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
