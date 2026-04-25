import { useEffect, useState } from "react";
import type { ReactNode, ComponentType } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

interface Props {
  /** Visible label for the group's parent row. */
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Path the parent row links to (also used to detect "active group"). */
  to: string;
  /** localStorage key for persisting expand/collapse state. */
  storageKey: string;
  /** Default to expanded on first render? */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Collapsable sidebar nav group. The parent row navigates on click; the
 * chevron toggles visibility of children. Open/closed state persists in
 * localStorage. Designed for Albums sub-views (All / Random / Local / per-Peer)
 * and reusable for future categories.
 */
export function NavGroup({
  label,
  icon: Icon,
  to,
  storageKey,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    const saved = window.localStorage.getItem(storageKey);
    if (saved === null) return defaultOpen;
    return saved === "1";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open, storageKey]);

  const location = useLocation();
  const groupActive =
    location.pathname === to || location.pathname.startsWith(to + "/");

  return (
    <div>
      <div
        className={cn(
          "flex items-center rounded-lg text-sm transition-colors",
          groupActive
            ? "text-text-primary"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        )}
      >
        <button
          type="button"
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="p-2 rounded-l-lg hover:bg-surface-hover"
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <NavLink
          to={to}
          className={({ isActive }) =>
            cn(
              "flex-1 flex items-center gap-3 pl-1 pr-3 py-2 rounded-r-lg",
              isActive && "bg-accent-muted text-accent",
            )
          }
        >
          <Icon className="w-4 h-4" />
          {label}
        </NavLink>
      </div>
      {open ? (
        <div className="ml-6 mt-0.5 space-y-0.5 max-h-72 overflow-y-auto">
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface NavGroupItemProps {
  to: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  end?: boolean;
}

export function NavGroupItem({ to, label, icon: Icon, end }: NavGroupItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
          isActive
            ? "bg-accent-muted text-accent"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        )
      }
    >
      {Icon ? <Icon className="w-3.5 h-3.5" /> : <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />}
      <span className="truncate">{label}</span>
    </NavLink>
  );
}
