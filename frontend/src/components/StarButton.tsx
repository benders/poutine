import { Star } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { star, unstar } from "@/lib/subsonic";
import { cn } from "@/lib/cn";

/**
 * Star/unstar toggle (issue #104). Shared by track rows, album headers, and
 * artist headers. The Subsonic id is whatever the server returned (`t…`,
 * `al…`, `ar…`); the backend classifies by prefix.
 *
 * `invalidateKeys` lets the caller pick which React Query caches to refresh
 * after a successful toggle so optimistic UI updates flip immediately. When
 * the affected list is the page itself, pass its key here.
 */
export function StarButton({
  id,
  starred,
  invalidateKeys,
  className,
  size = 16,
  showWhenUnstarred = "hover",
  variant = "icon",
}: {
  id: string;
  starred: string | undefined;
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
  className?: string;
  size?: number;
  /**
   * Whether the unstarred icon shows when the row is idle ("always") or only
   * on hover/focus ("hover"). Album/artist headers want "always"; track rows
   * use "hover" so the table stays calm.
   */
  showWhenUnstarred?: "always" | "hover";
  /**
   * "icon" is a bare icon button (track rows). "pill" matches the rounded-full
   * surface-hover treatment used by other header buttons (Share, metadata).
   */
  variant?: "icon" | "pill";
}) {
  const qc = useQueryClient();
  const isStarred = !!starred;

  const mut = useMutation({
    mutationFn: () => (isStarred ? unstar({ id }) : star({ id })),
    onSuccess: () => {
      // Re-fetch the surfaces that show this entity. getStarred2-backed views
      // are always invalidated so a Favorites tab reflects the change.
      qc.invalidateQueries({ queryKey: ["starred2"] });
      qc.invalidateQueries({ queryKey: ["albumList2", "favorites"] });
      for (const k of invalidateKeys ?? []) {
        qc.invalidateQueries({ queryKey: k as unknown[] });
      }
    },
  });

  const visibility =
    showWhenUnstarred === "always" || isStarred
      ? "opacity-100"
      : "opacity-0 group-hover:opacity-100 focus:opacity-100";

  const pill = variant === "pill";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (mut.isPending) return;
        mut.mutate();
      }}
      title={isStarred ? "Remove from Favorites" : "Add to Favorites"}
      aria-label={isStarred ? "Remove from Favorites" : "Add to Favorites"}
      aria-pressed={isStarred}
      className={cn(
        "transition-all cursor-pointer",
        pill
          ? "inline-flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-surface rounded-full text-sm font-medium"
          : "p-1",
        visibility,
        isStarred
          ? "text-yellow-400 hover:text-yellow-300"
          : pill
            ? "text-text-primary"
            : "text-text-muted hover:text-text-primary",
        className,
      )}
    >
      <Star
        width={pill ? 16 : size}
        height={pill ? 16 : size}
        className={isStarred ? "fill-current" : ""}
      />
      {pill && (isStarred ? "Starred" : "Star")}
    </button>
  );
}
