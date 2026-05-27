import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { AlbumsPage } from "@/pages/AlbumsPage";
import { ArtistsPage } from "@/pages/ArtistsPage";
import { ArtistDetailPage } from "@/pages/ArtistDetailPage";
import { ReleaseGroupPage } from "@/pages/ReleaseGroupPage";
import { SearchPage } from "@/pages/SearchPage";
import { ActivityPage } from "@/pages/ActivityPage";
import { PlaylistsPage } from "@/pages/PlaylistsPage";
import { HubAdminPage } from "@/features/hub-admin/HubAdminPage";
import { PlayerAdminPage } from "@/features/player-admin/PlayerAdminPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// #232: admin-only routes redirect non-admin sessions back to the library.
// Belt-and-suspenders with the API's own `requireOwner` gate.
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.isAdmin) return <Navigate to="/library/all" replace />;
  return <>{children}</>;
}

export function App() {
  const { checkAuth } = useAuth();

  useEffect(() => {
    if (window.location.pathname !== "/login") {
      checkAuth();
    }
  }, [checkAuth]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/library/all" replace />} />
        <Route path="library" element={<Navigate to="/library/all" replace />} />
        <Route path="library/:view" element={<AlbumsPage />} />
        <Route path="playlists" element={<Navigate to="/playlists/favorites" replace />} />
        <Route path="playlists/:view" element={<PlaylistsPage />} />
        <Route path="artists" element={<ArtistsPage />} />
        <Route path="artists/:id" element={<ArtistDetailPage />} />
        <Route path="albums/:id" element={<ReleaseGroupPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route
          path="activity"
          element={
            <AdminRoute>
              <ActivityPage />
            </AdminRoute>
          }
        />
        {/* Admin split (#216): two destinations that never share a page. */}
        <Route path="admin" element={<Navigate to="/admin/hub" replace />} />
        <Route
          path="admin/hub"
          element={
            <AdminRoute>
              <HubAdminPage />
            </AdminRoute>
          }
        />
        <Route
          path="admin/player"
          element={
            <AdminRoute>
              <PlayerAdminPage />
            </AdminRoute>
          }
        />
      </Route>
    </Routes>
  );
}
