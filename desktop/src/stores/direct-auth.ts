/**
 * Direct OAuth auth store (Tauri-based, no backend required)
 * Parallel to sessionId-based auth for gradual migration
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  clearDirectTokens,
  storeDirectTokens,
  type DirectAuthUser,
} from '../lib/direct-soundcloud-api';

interface DirectAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  user: DirectAuthUser | null;
  isAuthenticated: boolean;
  setTokens: (accessToken: string, refreshToken?: string, expiresIn?: number) => void;
  setUser: (user: DirectAuthState['user']) => void;
  isTokenValid: () => boolean;
  logout: () => void;
  clear: () => void;
}

export const useDirectAuthStore = create<DirectAuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      user: null,
      isAuthenticated: false,

      setTokens: (accessToken: string, refreshToken?: string, expiresIn?: number) => {
        const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
        set({
          accessToken,
          refreshToken: refreshToken || null,
          expiresAt,
          isAuthenticated: true,
        });
        storeDirectTokens(accessToken, refreshToken, expiresIn);
      },

      setUser: (user: DirectAuthState['user']) => {
        set({ user, isAuthenticated: !!user });
      },

      isTokenValid: () => {
        const state = get();
        if (!state.accessToken) return false;
        if (state.expiresAt && Date.now() >= state.expiresAt) {
          get().logout();
          return false;
        }
        return true;
      },

      logout: () => {
        set({
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          user: null,
          isAuthenticated: false,
        });
        clearDirectTokens();
      },

      clear: () => {
        set({
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          user: null,
          isAuthenticated: false,
        });
        clearDirectTokens();
      },
    }),
    {
      name: 'sc-direct-auth',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            },
      ),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        expiresAt: state.expiresAt,
        user: state.user,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state?.accessToken) {
          clearDirectTokens();
          return;
        }

        if (state.expiresAt && Date.now() >= state.expiresAt) {
          state.clear();
          return;
        }

        const expiresIn =
          state.expiresAt != null
            ? Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000))
            : undefined;

        storeDirectTokens(state.accessToken, state.refreshToken, expiresIn);
      },
    },
  ),
);
