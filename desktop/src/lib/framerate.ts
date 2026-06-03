import { isAppBackgrounded, subscribeAppVisibility } from './app-visibility';

export const FPS_PRESETS = [15, 30, 60, 120] as const;

type FrameLimiterRoot = Window &
  typeof globalThis & {
    __scdNativeRequestAnimationFrame?: typeof window.requestAnimationFrame;
    __scdNativeCancelAnimationFrame?: typeof window.cancelAnimationFrame;
    __scdFrameLimiterInstalled?: boolean;
    __scdFrameLimiterVisibilitySubscribed?: boolean;
    __scdFrameLimiterState?: {
      nextId: number;
      lastFlushTs: number;
      frameBudgetMs: number;
      schedulerId: number | null;
      paused: boolean;
      pending: Map<number, FrameRequestCallback>;
      nativeRequestAnimationFrame: typeof window.requestAnimationFrame;
      nativeCancelAnimationFrame: typeof window.cancelAnimationFrame;
      pump: () => void;
    };
  };

export interface FrameLimiterSnapshot {
  installed: boolean;
  paused: boolean;
  frameBudgetMs: number;
  pendingCallbacks: number;
  schedulerActive: boolean;
  lastFlushTs: number;
}

function getFrameLimiterRoot(): FrameLimiterRoot | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as FrameLimiterRoot;
}

function getClosestFpsPreset(target: number, fallback = 60): number {
  const safeTarget = Number.isFinite(target) ? target : fallback;
  let closest: number = FPS_PRESETS[0];
  let minDistance = Math.abs(safeTarget - closest);

  for (const preset of FPS_PRESETS.slice(1)) {
    const distance = Math.abs(safeTarget - preset);
    if (distance < minDistance) {
      closest = preset;
      minDistance = distance;
    }
  }

  return closest;
}

function ensureFrameLimiterInstalled() {
  const root = getFrameLimiterRoot();
  if (!root) {
    return null;
  }

  if (!root.__scdNativeRequestAnimationFrame) {
    root.__scdNativeRequestAnimationFrame = root.requestAnimationFrame.bind(root);
  }
  if (!root.__scdNativeCancelAnimationFrame) {
    root.__scdNativeCancelAnimationFrame = root.cancelAnimationFrame.bind(root);
  }

  if (!root.__scdFrameLimiterState) {
    const nativeRequestAnimationFrame = root.__scdNativeRequestAnimationFrame;
    const nativeCancelAnimationFrame = root.__scdNativeCancelAnimationFrame;
    root.__scdFrameLimiterState = {
      nextId: 1,
      lastFlushTs: 0,
      frameBudgetMs: 1000 / 60,
      schedulerId: null,
      paused: isAppBackgrounded(),
      pending: new Map<number, FrameRequestCallback>(),
      nativeRequestAnimationFrame,
      nativeCancelAnimationFrame,
      pump: () => {},
    };
  }

  const state = root.__scdFrameLimiterState;

  const pump = () => {
    if (state.paused) {
      return;
    }

    if (state.schedulerId != null) {
      return;
    }

    state.schedulerId = state.nativeRequestAnimationFrame((timestamp) => {
      state.schedulerId = null;

      if (state.paused) {
        return;
      }

      if (state.pending.size === 0) {
        return;
      }

      if (
        state.frameBudgetMs > 0 &&
        state.lastFlushTs > 0 &&
        timestamp - state.lastFlushTs < state.frameBudgetMs - 0.5
      ) {
        state.pump();
        return;
      }

      state.lastFlushTs = timestamp;
      const callbacks = Array.from(state.pending.entries());
      state.pending.clear();

      for (const [, callback] of callbacks) {
        try {
          callback(timestamp);
        } catch (error) {
          setTimeout(() => {
            throw error;
          }, 0);
        }
      }

      if (state.pending.size > 0) {
        state.pump();
      }
    });
  };

  state.pump = pump;

  if (!root.__scdFrameLimiterInstalled) {
    root.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = state.nextId++;
      state.pending.set(id, callback);
      state.pump();
      return id;
    }) as typeof window.requestAnimationFrame;

    root.cancelAnimationFrame = ((id: number) => {
      state.pending.delete(id);
    }) as typeof window.cancelAnimationFrame;

    root.__scdFrameLimiterInstalled = true;
  }

  if (!root.__scdFrameLimiterVisibilitySubscribed) {
    subscribeAppVisibility(() => {
      state.paused = isAppBackgrounded();
      state.lastFlushTs = 0;

      if (state.paused) {
        if (state.schedulerId != null) {
          state.nativeCancelAnimationFrame(state.schedulerId);
          state.schedulerId = null;
        }
        return;
      }

      if (state.pending.size > 0) {
        state.pump();
      }
    });

    root.__scdFrameLimiterVisibilitySubscribed = true;
  }

  return state;
}

export function normalizeTargetFramerate(target: number, fallback = 60): number {
  return getClosestFpsPreset(target, fallback);
}

export function getAnimationFrameBudgetMs(
  targetFramerate: number,
  unlockFramerate: boolean,
  fallback = 60,
): number {
  if (unlockFramerate) return 0;
  return 1000 / normalizeTargetFramerate(targetFramerate, fallback);
}

export function installGlobalFrameLimiter() {
  ensureFrameLimiterInstalled();
}

export function requestAnimationFrameImmediate(callback: FrameRequestCallback): number {
  const root = getFrameLimiterRoot();
  const nativeRequestAnimationFrame = root?.__scdNativeRequestAnimationFrame;
  if (nativeRequestAnimationFrame) {
    return nativeRequestAnimationFrame(callback);
  }
  return window.requestAnimationFrame(callback);
}

export function cancelAnimationFrameImmediate(id: number) {
  const root = getFrameLimiterRoot();
  const nativeCancelAnimationFrame = root?.__scdNativeCancelAnimationFrame;
  if (nativeCancelAnimationFrame) {
    nativeCancelAnimationFrame(id);
    return;
  }
  window.cancelAnimationFrame(id);
}

export function setGlobalFrameLimiterConfig(targetFramerate: number, unlockFramerate: boolean) {
  const state = ensureFrameLimiterInstalled();
  if (!state) {
    return;
  }

  state.frameBudgetMs = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);
  state.lastFlushTs = 0;
  if (state.pending.size > 0) {
    state.pump();
  }
}

export function getNativeRequestAnimationFrame(): typeof window.requestAnimationFrame | null {
  const root = getFrameLimiterRoot();
  return root?.__scdNativeRequestAnimationFrame ?? null;
}

export function getNativeCancelAnimationFrame(): typeof window.cancelAnimationFrame | null {
  const root = getFrameLimiterRoot();
  return root?.__scdNativeCancelAnimationFrame ?? null;
}

export function getGlobalFrameLimiterSnapshot(): FrameLimiterSnapshot {
  const root = getFrameLimiterRoot();
  const state = root?.__scdFrameLimiterState;

  return {
    installed: Boolean(root?.__scdFrameLimiterInstalled && state),
    paused: state?.paused ?? false,
    frameBudgetMs: state?.frameBudgetMs ?? 0,
    pendingCallbacks: state?.pending.size ?? 0,
    schedulerActive: state?.schedulerId != null,
    lastFlushTs: state?.lastFlushTs ?? 0,
  };
}
