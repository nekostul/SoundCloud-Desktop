import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getAppVisibilitySnapshot, subscribeAppVisibility } from './app-visibility';
import {
  getGlobalFrameLimiterSnapshot,
  getNativeCancelAnimationFrame,
  getNativeRequestAnimationFrame,
} from './framerate';
import { isTauriRuntime } from './runtime';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

let started = false;
let stopDiagnostics: (() => void) | null = null;

function roundMs(value: number) {
  return Math.round(value);
}

function describeTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return 'unknown';

  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : '';
  const className =
    target.classList.length > 0 ? `.${Array.from(target.classList).slice(0, 3).join('.')}` : '';

  return `${tag}${id}${className}`;
}

function writeLog(level: LogLevel, message: string) {
  if (level === 'ERROR') {
    console.error(message);
  } else if (level === 'WARN') {
    console.warn(message);
  } else {
    console.info(message);
  }

  if (!isTauriRuntime()) return;
  void invoke('diagnostics_log', { level, message }).catch(() => undefined);
}

function formatVisibilitySnapshot(source: string) {
  const snapshot = getAppVisibilitySnapshot();
  return `[UI][Visibility] source=${source} docVisible=${snapshot.documentVisible} nativeWindowVisible=${snapshot.nativeWindowVisible} appVisible=${snapshot.appVisible} backgrounded=${snapshot.backgrounded} visibilityState=${document.visibilityState} hidden=${document.hidden} hasFocus=${document.hasFocus()}`;
}

function formatResizeSnapshot(source: string) {
  return `[UI][Resize] source=${source} inner=${window.innerWidth}x${window.innerHeight} outer=${window.outerWidth}x${window.outerHeight} dpr=${window.devicePixelRatio.toFixed(2)}`;
}

export function setupUiDiagnostics() {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return;
  started = true;

  const disposers: Array<() => void> = [];
  let lastFullscreenState: string | null = null;
  let lastVisibilityState: string | null = null;
  let lastNativeFrameAt = performance.now();
  let lastPatchedFrameAt = performance.now();
  let lastRenderLoopWarnAt = 0;
  let nativeLoopId: number | null = null;
  let patchedLoopId: number | null = null;
  const nativeRequestAnimationFrame =
    getNativeRequestAnimationFrame() ?? window.requestAnimationFrame.bind(window);
  const nativeCancelAnimationFrame =
    getNativeCancelAnimationFrame() ?? window.cancelAnimationFrame.bind(window);

  const logVisibility = (source: string) => {
    const line = formatVisibilitySnapshot(source);
    if (line === lastVisibilityState) return;
    lastVisibilityState = line;
    writeLog('INFO', line);
  };

  const syncFullscreenState = async (source: string) => {
    const documentFullscreen = Boolean(document.fullscreenElement);
    let nativeFullscreen: boolean | null = null;

    if (isTauriRuntime()) {
      try {
        nativeFullscreen = await getCurrentWindow().isFullscreen();
      } catch (error) {
        writeLog(
          'WARN',
          `[UI][Fullscreen] source=${source} failed to read native fullscreen: ${String(error)}`,
        );
      }
    }

    const key = `${source}|doc=${documentFullscreen}|native=${nativeFullscreen ?? 'n/a'}`;
    if (key === lastFullscreenState) return;
    lastFullscreenState = key;
    writeLog(
      'INFO',
      `[UI][Fullscreen] source=${source} document=${documentFullscreen} native=${nativeFullscreen ?? 'n/a'}`,
    );
  };

  const nativeFrameLoop = () => {
    lastNativeFrameAt = performance.now();
    nativeLoopId = nativeRequestAnimationFrame(nativeFrameLoop);
  };

  const patchedFrameLoop = () => {
    lastPatchedFrameAt = performance.now();
    patchedLoopId = window.requestAnimationFrame(patchedFrameLoop);
  };

  nativeLoopId = nativeRequestAnimationFrame(nativeFrameLoop);
  patchedLoopId = window.requestAnimationFrame(patchedFrameLoop);

  logVisibility('startup');
  void syncFullscreenState('startup');
  writeLog('INFO', `[UI][FrameLimiter] startup ${JSON.stringify(getGlobalFrameLimiterSnapshot())}`);

  const onVisibilityChange = () => {
    logVisibility('document.visibilitychange');
    void syncFullscreenState('document.visibilitychange');
  };
  const onFocus = () => {
    logVisibility('window.focus');
    void syncFullscreenState('window.focus');
  };
  const onBlur = () => {
    logVisibility('window.blur');
    void syncFullscreenState('window.blur');
  };
  const onResize = () => {
    writeLog('INFO', formatResizeSnapshot('window.resize'));
    void syncFullscreenState('window.resize');
  };
  const onFullscreenChange = () => {
    void syncFullscreenState('document.fullscreenchange');
  };
  const onPageShow = () => {
    logVisibility('window.pageshow');
  };
  const onPageHide = () => {
    logVisibility('window.pagehide');
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);

  disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  disposers.push(() => window.removeEventListener('focus', onFocus));
  disposers.push(() => window.removeEventListener('blur', onBlur));
  disposers.push(() => window.removeEventListener('resize', onResize));
  disposers.push(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
  disposers.push(() => window.removeEventListener('pageshow', onPageShow));
  disposers.push(() => window.removeEventListener('pagehide', onPageHide));

  const visibilityUnsubscribe = subscribeAppVisibility(() => {
    logVisibility('app-visibility-bridge');
  });
  disposers.push(visibilityUnsubscribe);

  const contextEventNames = [
    'contextlost',
    'contextrestored',
    'webglcontextlost',
    'webglcontextrestored',
  ] as const;

  for (const eventName of contextEventNames) {
    const handler = (event: Event) => {
      writeLog(
        eventName.includes('lost') ? 'WARN' : 'INFO',
        `[UI][Context] type=${eventName} target=${describeTarget(event.target)}`,
      );
    };

    window.addEventListener(eventName, handler, true);
    disposers.push(() => window.removeEventListener(eventName, handler, true));
  }

  const onError = (event: ErrorEvent) => {
    writeLog('ERROR', `[UI][Error] message=${event.message}`);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    writeLog('ERROR', `[UI][UnhandledRejection] reason=${String(event.reason)}`);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  disposers.push(() => window.removeEventListener('error', onError));
  disposers.push(() => window.removeEventListener('unhandledrejection', onUnhandledRejection));

  if (isTauriRuntime()) {
    void (async () => {
      try {
        const currentWindow = getCurrentWindow();
        const unlistenFocus = await currentWindow.onFocusChanged(({ payload }) => {
          writeLog('INFO', `[UI][TauriWindow] focus changed focused=${payload}`);
          void syncFullscreenState('tauri.onFocusChanged');
        });
        const unlistenResized = await currentWindow.onResized(({ payload }) => {
          writeLog(
            'INFO',
            `[UI][TauriWindow] resized width=${payload.width} height=${payload.height}`,
          );
          void syncFullscreenState('tauri.onResized');
        });
        const unlistenScale = await currentWindow.onScaleChanged(({ payload }) => {
          writeLog(
            'INFO',
            `[UI][TauriWindow] scale changed factor=${payload.scaleFactor} width=${payload.size.width} height=${payload.size.height}`,
          );
        });

        disposers.push(() => {
          void unlistenFocus();
          void unlistenResized();
          void unlistenScale();
        });
      } catch (error) {
        writeLog(
          'WARN',
          `[UI][TauriWindow] failed to subscribe to native window events: ${String(error)}`,
        );
      }
    })();
  }

  let expectedAt = performance.now() + 1000;
  const watchdogId = window.setInterval(() => {
    const now = performance.now();
    const lag = now - expectedAt;
    expectedAt = now + 1000;

    if (document.visibilityState === 'visible' && lag > 500) {
      writeLog('WARN', `[UI][EventLoop] lag=${roundMs(lag)}ms`);
    }

    const nativeGap = now - lastNativeFrameAt;
    const patchedGap = now - lastPatchedFrameAt;
    const limiter = getGlobalFrameLimiterSnapshot();
    const visibility = getAppVisibilitySnapshot();

    if (
      document.visibilityState === 'visible' &&
      nativeGap < 250 &&
      patchedGap > 1500 &&
      now - lastRenderLoopWarnAt > 3000
    ) {
      lastRenderLoopWarnAt = now;
      writeLog(
        'WARN',
        `[UI][RenderLoop] patched-rAF-stalled patchedGap=${roundMs(patchedGap)}ms nativeGap=${roundMs(nativeGap)}ms paused=${limiter.paused} pending=${limiter.pendingCallbacks} frameBudgetMs=${roundMs(limiter.frameBudgetMs)} docVisible=${visibility.documentVisible} nativeWindowVisible=${visibility.nativeWindowVisible} backgrounded=${visibility.backgrounded}`,
      );
    }
  }, 1000);

  disposers.push(() => window.clearInterval(watchdogId));

  stopDiagnostics = () => {
    if (nativeLoopId != null) {
      nativeCancelAnimationFrame(nativeLoopId);
      nativeLoopId = null;
    }
    if (patchedLoopId != null) {
      window.cancelAnimationFrame(patchedLoopId);
      patchedLoopId = null;
    }
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    started = false;
    stopDiagnostics = null;
  };
}

import.meta.hot?.dispose(() => {
  stopDiagnostics?.();
});
