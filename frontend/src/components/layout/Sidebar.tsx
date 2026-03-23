import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import {
  Library,
  Users,
  Search,
  Settings,
  LogOut,
  Disc3,
} from "lucide-react";
import { cn } from "@/lib/cn";

const navItems = [
  { to: "/", icon: Library, label: "Library" },
  { to: "/artists", icon: Users, label: "Artists" },
  { to: "/search", icon: Search, label: "Search" },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="w-56 shrink-0 bg-surface border-r border-border flex flex-col h-full">
      <div className="p-4 flex items-center gap-2">
        <Disc3 className="w-6 h-6 text-accent" />
        <span className="text-lg font-semibold">Poutine</span>
      </div>

      <nav className="flex-1 px-2 py-2 space-y-0.5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-accent-muted text-accent"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
              )
            }
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </NavLink>
        ))}

        {user?.isAdmin && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-accent-muted text-accent"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
              )
            }
          >
            <Settings className="w-4 h-4" />
            Instances
          </NavLink>
        )}
      </nav>

      <div className="p-3 border-t border-border">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary truncate">
            {user?.username}
          </span>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
