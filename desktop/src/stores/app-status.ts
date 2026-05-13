import { create } from 'zustand';

interface AppStatusState {
  navigatorOnline: boolean;
  backendReachable: boolean;
  soundcloudBlocked: boolean;
  setNavigatorOnline: (online: boolean) => void;
  setBackendReachable: (reachable: boolean) => void;
  setSoundcloudBlocked: (blocked: boolean) => void;
  resetConnectivity: () => void;
}

export const useAppStatusStore = create<AppStatusState>((set) => ({
  navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  backendReachable: true,
  soundcloudBlocked: false,
  setNavigatorOnline: (online) => set({ navigatorOnline: online }),
  setBackendReachable: (backendReachable) => set({ backendReachable }),
  setSoundcloudBlocked: (soundcloudBlocked) => set({ soundcloudBlocked }),
  resetConnectivity: () =>
    set({
      navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
      backendReachable: true,
      soundcloudBlocked: false,
    }),
}));
