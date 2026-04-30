import { Star } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { star, unstar } from "@/lib/subsonic";
import { cn } from "@/lib/cn";

/**
 * Star/unstar toggle (issue #104). Shared by track rows, album headers, and
 * artist headers. The Subsonic id is whatever the server returned (`t…`,
 * `al…`, `ar…`); the backend classifies by prefix.
 *
 * Optimistic: the icon flips on click and holds the new state until the
 * mutation succeeds and the invalidated queries refetch (or rolls back on
 * error). `invalidateKeys` lets the caller refresh entity-specific caches;
 * `getStarred2` and the Favorites album list are always invalidated.
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

  // Optimistic override: holds the post-click state until the refetch settles
  // (or onError clears it). null means "follow the prop".
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const displayStarred = optimistic !== null ? optimistic : isStarred;

  const mut = useMutation({
    mutationFn: () => (isStarred ? unstar({ id }) : star({ id })),
    onMutate: () => {
      setOptimistic(!isStarred);
    },
    onError: () => {
      setOptimistic(null);
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["starred2"] }),
        qc.invalidateQueries({ queryKey: ["albumList2", "favorites"] }),
        ...(invalidateKeys ?? []).map((k) =>
          qc.invalidateQueries({ queryKey: k as unknown[] }),
        ),
      ]);
      setOptimistic(null);
    },
  });

  const visibility =
    showWhenUnstarred === "always" || displayStarred
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
      title={displayStarred ? "Remove from Favorites" : "Add to Favorites"}
      aria-label={displayStarred ? "Remove from Favorites" : "Add to Favorites"}
      aria-pressed={displayStarred}
      className={cn(
        "transition-all cursor-pointer",
        pill
          ? "inline-flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-surface rounded-full text-sm font-medium"
          : "p-1",
        visibility,
        displayStarred
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
        className={displayStarred ? "fill-current" : ""}
      />
      {pill && (displayStarred ? "Starred" : "Star")}
    </button>
  );
}
