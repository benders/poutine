import type { ReactNode } from "react";
import { Search, ChevronDown } from "lucide-react";
import { ErrorMessage } from "@/components/ui/ErrorMessage";

export interface SortOptionDef<T extends string> {
  value: T;
  label: string;
}

interface Props<T, S extends string> {
  title: string;
  headerExtra?: ReactNode;
  items: T[] | undefined;
  isLoading: boolean;
  error: unknown;
  searchPlaceholder: string;
  search: string;
  onSearchChange: (v: string) => void;
  sortOptions?: SortOptionDef<S>[];
  sort?: S;
  onSortChange?: (v: S) => void;
  emptyMessage: string;
  emptySearchMessage: string;
  renderItem: (item: T) => ReactNode;
  itemKey: (item: T) => string;
}

/**
 * Shared layout for grid-style category pages (Albums, Artists, future
 * Playlists/Genres). Owns the title bar, search box, optional sort dropdown,
 * and the responsive card grid. Pages provide just the data, the per-card
 * markup, and any view-specific header controls via `headerExtra`.
 */
export function CategoryGrid<T, S extends string>({
  title,
  headerExtra,
  items,
  isLoading,
  error,
  searchPlaceholder,
  search,
  onSearchChange,
  sortOptions,
  sort,
  onSortChange,
  emptyMessage,
  emptySearchMessage,
  renderItem,
  itemKey,
}: Props<T, S>) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-text-primary">{title}</h1>
        <div className="flex items-center gap-3">
          {headerExtra}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-64"
            />
          </div>
          {sortOptions && sort !== undefined && onSortChange ? (
            <div className="relative">
              <select
                value={sort}
                onChange={(e) => onSortChange(e.target.value as S)}
                className="appearance-none pl-3 pr-8 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-secondary focus:outline-none focus:border-accent cursor-pointer"
              >
                {sortOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorMessage error={error} />
      ) : isLoading ? (
        <div className="text-text-muted text-center py-20">Loading...</div>
      ) : !items || items.length === 0 ? (
        <div className="text-text-muted text-center py-20">
          {search ? emptySearchMessage : emptyMessage}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {items.map((item) => (
            <div key={itemKey(item)}>{renderItem(item)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
