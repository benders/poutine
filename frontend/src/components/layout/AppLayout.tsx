import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "@/components/player/PlayerBar";

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>
      <PlayerBar />
    </div>
  );
}
