import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/stores/auth";
import { getPeersSummary, peerDisplayName } from "@/lib/api";
import {
  Library,
  Users,
  Search,
  Settings,
  LogOut,
  Disc3,
  Shuffle,
  HardDrive,
  Server,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { NavGroup, NavGroupItem } from "./NavGroup";

const flatNav = [
  { to: "/artists", icon: Users, label: "Artists" },
  { to: "/search", icon: Search, label: "Search" },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const { data: peers } = useQuery({
    queryKey: ["peers-summary"],
    queryFn: getPeersSummary,
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
      <div className="p-4 flex items-center gap-2">
        <Disc3 className="w-6 h-6 text-accent" />
        <span className="text-lg font-semibold">Poutine</span>
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
          <NavGroupItem to="/library/local" label="Local" icon={HardDrive} />
          {peers?.map((peer) => (
            <NavGroupItem
              key={peer.id}
              to={`/library/peer-${peer.id}`}
              label={peerDisplayName(peer.name)}
              icon={Server}
            />
          ))}
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
