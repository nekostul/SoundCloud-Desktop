/**
 * Direct OAuth auth store (Tauri-based, no backend required)
 * Parallel to sessionId-based auth for gradual migration
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { markDirectAuthHydrated } from '../lib/auth-hydration';
import { tauriStorage } from '../lib/tauri-storage';
import {
  clearDirectTokens,
  storeDirectTokenSnapshot,
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

function hasActiveDirectSession(accessToken: string | null, refreshToken: string | null) {
  return !!accessToken || !!refreshToken;
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
          isAuthenticated: hasActiveDirectSession(accessToken, refreshToken || null),
        });
        storeDirectTokens(accessToken, refreshToken, expiresIn);
      },

      setUser: (user: DirectAuthState['user']) => {
        const { accessToken, refreshToken } = get();
        set({
          user,
          isAuthenticated: hasActiveDirectSession(accessToken, refreshToken),
        });
      },

      isTokenValid: () => {
        const state = get();
        if (!state.accessToken) return false;
        return !state.expiresAt || Date.now() < state.expiresAt;
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
      storage: createJSONStorage(() => tauriStorage),
      merge: (persistedState, currentState) => {
        const state = (
          persistedState && typeof persistedState === 'object' ? persistedState : {}
        ) as Partial<DirectAuthState>;
        const accessToken = state.accessToken ?? currentState.accessToken;
        const refreshToken = state.refreshToken ?? currentState.refreshToken;
        const isActive = hasActiveDirectSession(accessToken, refreshToken);

        return {
          ...currentState,
          ...state,
          isAuthenticated: isActive,
        };
      },
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        expiresAt: state.expiresAt,
        user: state.user,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state?.accessToken && !state?.refreshToken) {
          clearDirectTokens();
          markDirectAuthHydrated();
          return;
        }

        if (state.accessToken) {
          storeDirectTokenSnapshot(state.accessToken, state.refreshToken, state.expiresAt);
        }
        state.setUser(state.user ?? null);
        markDirectAuthHydrated();
      },
    },
  ),
);
