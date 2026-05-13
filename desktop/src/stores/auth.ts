import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api, setSessionId, type ApiRequestOptions } from '../lib/api';
import { markAuthHydrated } from '../lib/auth-hydration';
import { tauriStorage } from '../lib/tauri-storage';

interface User {
  id: number;
  urn: string;
  username: string;
  avatar_url: string;
  permalink_url: string;
  followers_count: number;
  followings_count: number;
  track_count: number;
  playlist_count: number;
  public_favorites_count: number;
}

interface AuthState {
  sessionId: string | null;
  user: User | null;
  isAuthenticated: boolean;
  reloginRequestId: number | null;
  setSession: (sessionId: string) => void;
  fetchUser: (options?: ApiRequestOptions) => Promise<void>;
  beginRelogin: () => void;
  clearReloginRequest: () => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      user: null,
      isAuthenticated: false,
      reloginRequestId: null,

      setSession: (sessionId: string) => {
        setSessionId(sessionId);
        set({ sessionId, isAuthenticated: true, reloginRequestId: null });
      },

      fetchUser: async (options = {}) => {
        const { sessionId } = get();
        if (!sessionId) return;
        setSessionId(sessionId);
        const user = await api<User>('/me', options);
        set({ user, isAuthenticated: true, reloginRequestId: null });
      },

      beginRelogin: () => {
        setSessionId(null);
        set({
          sessionId: null,
          user: null,
          isAuthenticated: false,
          reloginRequestId: Date.now(),
        });
      },

      clearReloginRequest: () => {
        set({ reloginRequestId: null });
      },

      logout: () => {
        setSessionId(null);
        set({ sessionId: null, user: null, isAuthenticated: false, reloginRequestId: null });
      },
    }),
    {
      name: 'sc-auth',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ sessionId: state.sessionId }),
      onRehydrateStorage: () => (state) => {
        setSessionId(state?.sessionId || null);
        markAuthHydrated();
      },
    },
  ),
);
