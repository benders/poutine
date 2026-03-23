import { create } from "zustand";
import { getMe, clearTokens, getAccessToken } from "@/lib/api";

interface User {
  id: string;
  username: string;
  isAdmin: boolean;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  checkAuth: () => Promise<void>;
  setUser: (user: User) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  checkAuth: async () => {
    if (!getAccessToken()) {
      set({ user: null, loading: false });
      return;
    }
    try {
      const user = await getMe();
      set({ user, loading: false });
    } catch {
      clearTokens();
      set({ user: null, loading: false });
    }
  },
  setUser: (user) => set({ user, loading: false }),
  logout: () => {
    clearTokens();
    set({ user: null });
  },
}));
