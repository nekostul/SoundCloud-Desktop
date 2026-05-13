export const FPS_PRESETS = [15, 30, 60, 120] as const;

type FrameLimiterRoot = Window &
  typeof globalThis & {
    __scdNativeRequestAnimationFrame?: typeof window.requestAnimationFrame;
    __scdNativeCancelAnimationFrame?: typeof window.cancelAnimationFrame;
    __scdFrameLimiterInstalled?: boolean;
    __scdFrameLimiterState?: {
      nextId: number;
      lastFlushTs: number;
      frameBudgetMs: number;
      schedulerId: number | null;
      pending: Map<number, FrameRequestCallback>;
      nativeRequestAnimationFrame: typeof window.requestAnimationFrame;
      nativeCancelAnimationFrame: typeof window.cancelAnimationFrame;
      pump: () => void;
    };
  };

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
      pending: new Map<number, FrameRequestCallback>(),
      nativeRequestAnimationFrame,
      nativeCancelAnimationFrame,
      pump: () => {},
    };
  }

  const state = root.__scdFrameLimiterState;

  const pump = () => {
    if (state.schedulerId != null) {
      return;
    }

    state.schedulerId = state.nativeRequestAnimationFrame((timestamp) => {
      state.schedulerId = null;

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
