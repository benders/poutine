import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/stores/auth";
import { peerDisplayName } from "@/lib/api";
import { getMusicFolders } from "@/lib/subsonic";
import {
  Library,
  Users,
  Search,
  Settings,
  LogOut,
  Disc3,
  Shuffle,
  Server,
  Activity,
  Star,
  ListMusic,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_VERSION } from "@/version";
import { NavGroup, NavGroupItem } from "./NavGroup";

const flatNav = [
  { to: "/artists", icon: Users, label: "Artists" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/activity", icon: Activity, label: "Activity" },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const { data: folders } = useQuery({
    queryKey: ["musicFolders"],
    queryFn: getMusicFolders,
    retry: false,
    enabled: !!user,
    staleTime: 60_000,
  });

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="w-56 shrink-0 bg-surface border-r border-border flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 flex items-center gap-2">
        <Disc3 className="w-6 h-6 text-accent shrink-0" />
        <div className="flex flex-col leading-tight">
          <span className="text-lg font-semibold">Poutine</span>
          <span className="text-[10px] text-text-muted font-mono">v{APP_VERSION}</span>
        </div>
      </div>

      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        <NavGroup
          label="Albums"
          icon={Library}
          to="/library/all"
          storageKey="sidebar:albums:open"
        >
          <NavGroupItem to="/library/all" label="All" />
          <NavGroupItem to="/library/random" label="Random" icon={Shuffle} />
          <NavGroupItem to="/library/favorites" label="Favorites" icon={Star} />
          {folders?.map((folder) => (
            <NavGroupItem
              key={folder.id}
              to={`/library/folder-${folder.id}`}
              label={peerDisplayName(folder.name)}
              icon={Server}
            />
          ))}
        </NavGroup>

        <NavGroup
          label="Playlists"
          icon={ListMusic}
          to="/playlists/favorites"
          storageKey="sidebar:playlists:open"
        >
          <NavGroupItem
            to="/playlists/favorites"
            label="Favorites"
            icon={Star}
          />
        </NavGroup>

        {flatNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
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

        {user && (
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
            Settings
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
