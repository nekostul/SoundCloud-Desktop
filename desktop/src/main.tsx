import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import ReactDOM, { type Root } from 'react-dom/client';
import App from './App';
import i18n from './i18n';
import { normalizeLanguage } from './i18n/language';
import { ApiError } from './lib/api';
import './lib/app-visibility';
import { installGlobalFrameLimiter, setGlobalFrameLimiterConfig } from './lib/framerate';
import { setServerPorts } from './lib/constants';
import { installEmbeddedFont } from './lib/embedded-font';
import { isTauriRuntime } from './lib/runtime';
import {
  applyMediaProxySettings,
  initMediaProxyRuntime,
} from './lib/media-proxy';
import './lib/audio';
import './index.css';
import { getEffectivePitchSemitones, usePlayerStore } from './stores/player';
import { useSettingsStore } from './stores/settings';

installGlobalFrameLimiter();
installEmbeddedFont();

function installBrowserChromeBlockers() {
  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const blocked =
      event.key === 'F12' ||
      ((event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        (key === 'i' || key === 'j' || key === 'c')) ||
      ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'u');

    if (!blocked) return;

    event.preventDefault();
    event.stopPropagation();
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);

  import.meta.hot?.dispose(() => {
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
  });
}

installBrowserChromeBlockers();

function syncGlobalFramerateLimiter(
  state = useSettingsStore.getState(),
) {
  setGlobalFrameLimiterConfig(state.targetFramerate, state.unlockFramerate);
}

syncGlobalFramerateLimiter();

function applyHydratedDesktopSettings(state = useSettingsStore.getState()) {
  if (!isTauriRuntime()) return;

  invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
  invoke('save_framerate_config', {
    target: state.targetFramerate,
    unlocked: state.unlockFramerate,
  }).catch(console.error);
  void applyMediaProxySettings().catch(console.error);
}

useSettingsStore.persist.onFinishHydration((state) => {
  const language = normalizeLanguage(state.language);
  if (language !== state.language) {
    useSettingsStore.getState().setLanguage(language);
  }
  if (language !== i18n.language) {
    i18n.changeLanguage(language);
  }
  syncGlobalFramerateLimiter(state);
  applyHydratedDesktopSettings(state);
});

const unsubscribeFramerateLimiter = useSettingsStore.subscribe((state, prev) => {
  if (
    state.targetFramerate === prev.targetFramerate &&
    state.unlockFramerate === prev.unlockFramerate
  ) {
    return;
  }
  syncGlobalFramerateLimiter(state);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeFramerateLimiter();
    unsubscribeMediaProxySync();
    if (proxySyncTimeout) {
      clearTimeout(proxySyncTimeout);
      proxySyncTimeout = null;
    }
  });
}

let proxySyncTimeout: ReturnType<typeof setTimeout> | null = null;
const unsubscribeMediaProxySync = useSettingsStore.subscribe((state, prev) => {
  if (state.mediaProxyMode !== 'manual') {
    if (proxySyncTimeout) {
      clearTimeout(proxySyncTimeout);
      proxySyncTimeout = null;
    }
    return;
  }

  if (
    state.mediaProxyHost === prev.mediaProxyHost &&
    state.mediaProxyUsername === prev.mediaProxyUsername &&
    state.mediaProxyPassword === prev.mediaProxyPassword
  ) {
    return;
  }

  if (proxySyncTimeout) {
    clearTimeout(proxySyncTimeout);
  }

  proxySyncTimeout = setTimeout(() => {
    proxySyncTimeout = null;
    void applyMediaProxySettings().catch(console.error);
  }, 500);
});

function syncHydratedPlayerAudioState(state = usePlayerStore.getState()) {
  if (!isTauriRuntime()) return;

  invoke('audio_set_playback_rate', { playbackRate: state.playbackRate }).catch(console.error);
  invoke('audio_set_pitch', {
    pitchSemitones: getEffectivePitchSemitones(
      state.playbackRate,
      state.pitchControlMode,
      state.pitchSemitones,
    ),
  }).catch(console.error);
}

if (usePlayerStore.persist.hasHydrated()) {
  syncHydratedPlayerAudioState();
}

usePlayerStore.persist.onFinishHydration((state) => {
  syncHydratedPlayerAudioState(state);
});

if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === '1') {
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/react-scan/dist/auto.global.js';
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 2,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 429) return false;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 1;
      },
      retryDelay: (attempt, error) => {
        if (error instanceof ApiError && error.retryAfterMs) {
          return Math.min(error.retryAfterMs, 10000);
        }
        return Math.min(1000 * 2 ** attempt, 5000);
      },
      refetchOnWindowFocus: false,
    },
  },
});

type RootWindow = Window & {
  __scdRoot?: Root;
  __scdDevPerfTimelineCleanup?: {
    intervalId: number;
    onVisibilityChange: () => void;
    onPageHide: () => void;
  };
};

// React StrictMode doubles mounts/effects in dev and tanks WebKitGTK FPS in tauri dev.
const useStrictMode = !(import.meta.env.DEV && isTauriRuntime());

function AppRoot({ children }: { children: React.ReactNode }) {
  return useStrictMode ? <React.StrictMode>{children}</React.StrictMode> : <>{children}</>;
}

function clearDevPerformanceTimeline() {
  performance.clearMeasures();
  performance.clearMarks();
}

function ensureDevPerformanceTimelineCleanup() {
  if (!import.meta.env.DEV) return;

  const rootWindow = window as RootWindow;
  if (rootWindow.__scdDevPerfTimelineCleanup) return;

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      clearDevPerformanceTimeline();
    }
  };
  const onPageHide = () => {
    clearDevPerformanceTimeline();
  };

  // Dev tooling can flood the User Timing timeline in long-running sessions.
  const intervalId = window.setInterval(() => {
    clearDevPerformanceTimeline();
  }, 15_000);

  clearDevPerformanceTimeline();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  rootWindow.__scdDevPerfTimelineCleanup = {
    intervalId,
    onVisibilityChange,
    onPageHide,
  };

  import.meta.hot?.dispose(() => {
    clearDevPerformanceTimeline();
    window.clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    delete rootWindow.__scdDevPerfTimelineCleanup;
  });
}

let instantSplashDismissed = false;

function dismissInstantSplash() {
  if (instantSplashDismissed) return;
  const splash = document.getElementById('boot-splash');
  if (!splash) {
    instantSplashDismissed = true;
    return;
  }

  instantSplashDismissed = true;

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      splash.classList.add('is-exiting');
      window.setTimeout(() => splash.remove(), 340);
    });
  });
}

const SPLASH_EXIT_MS = 560;
const SPLASH_MIN_VISIBLE_MS = 820;
const SPLASH_BARS = [
  { x: 18, height: 28, width: 9, delay: 0 },
  { x: 36, height: 52, width: 11, delay: 70 },
  { x: 57, height: 70, width: 12, delay: 140 },
  { x: 80, height: 86, width: 12, delay: 210 },
  { x: 103, height: 102, width: 13, delay: 280 },
  { x: 127, height: 118, width: 13, delay: 350 },
  { x: 151, height: 128, width: 13, delay: 420 },
  { x: 175, height: 136, width: 13, delay: 490 },
  { x: 199, height: 144, width: 13, delay: 560 },
  { x: 223, height: 152, width: 13, delay: 630 },
  { x: 247, height: 160, width: 13, delay: 700 },
  { x: 271, height: 168, width: 13, delay: 770 },
] as const;

function SplashLogo() {
  return (
    <div className="startup-logo-wrap" aria-hidden="true">
      <div className="startup-logo-glow" />
      <svg className="startup-logo" viewBox="0 0 520 240" fill="none">
        <defs>
          <linearGradient id="startup-bars-gradient" x1="120" y1="28" x2="340" y2="232">
            <stop offset="0%" stopColor="#ffe29d" />
            <stop offset="32%" stopColor="#ffbf59" />
            <stop offset="72%" stopColor="#ff8d2d" />
            <stop offset="100%" stopColor="#ff5f1f" />
          </linearGradient>
          <linearGradient id="startup-cloud-gradient" x1="270" y1="20" x2="474" y2="232">
            <stop offset="0%" stopColor="#ffeeb8" />
            <stop offset="38%" stopColor="#ffc86e" />
            <stop offset="78%" stopColor="#ff8a2c" />
            <stop offset="100%" stopColor="#ff5b1f" />
          </linearGradient>
          <linearGradient id="startup-cloud-highlight" x1="276" y1="44" x2="444" y2="176">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g className="startup-bars">
          {SPLASH_BARS.map((bar, index) => (
            <rect
              key={bar.x}
              className="startup-bar"
              style={
                {
                  '--bar-delay': `${bar.delay}ms`,
                  '--bar-opacity': `${0.68 + index * 0.024}`,
                } as React.CSSProperties
              }
              x={bar.x}
              y={196 - bar.height}
              width={bar.width}
              height={bar.height}
              rx={bar.width / 2}
              fill="url(#startup-bars-gradient)"
            />
          ))}
        </g>

        <path
          d="M301 196V64c0-17.673 14.327-32 32-32h16c55.537 0 102.311 38.347 115.169 89.968A59.43 59.43 0 0 1 487 117c33.137 0 60 26.863 60 60s-26.863 60-60 60H301Z"
          fill="url(#startup-cloud-gradient)"
        />
        <path
          className="startup-cloud-sheen"
          d="M322 52c34.372 0 64.994 12.278 86.35 33.67c17.817 17.853 28.687 40.73 31.992 66.251c-25.68 19.331-62.537 31.079-103.591 31.079H301V64c0-6.588 3.695-12 8.25-12H322Z"
          fill="url(#startup-cloud-highlight)"
        />
      </svg>
    </div>
  );
}

function BootstrapScreen({
  title,
  label,
  ready = false,
  error,
  children,
}: {
  title: string;
  label: string;
  ready?: boolean;
  error?: string;
  children?: ReactNode;
}) {
  const bootStartedAtRef = useRef<number>(performance.now());
  const [phase, setPhase] = useState<'visible' | 'exiting' | 'hidden'>(() =>
    error ? 'visible' : 'visible',
  );

  useEffect(() => {
    if (error) {
      setPhase('visible');
      return;
    }

    if (!ready) {
      if (phase !== 'visible') {
        setPhase('visible');
      }
      return;
    }

    if (phase === 'hidden') return;

    const elapsed = performance.now() - bootStartedAtRef.current;
    const exitDelay = Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed);
    const exitTimer = window.setTimeout(() => setPhase('exiting'), exitDelay);
    const hideTimer = window.setTimeout(() => setPhase('hidden'), exitDelay + SPLASH_EXIT_MS);

    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(hideTimer);
    };
  }, [error, phase, ready]);

  const showOverlay = phase !== 'hidden' || Boolean(error);

  return (
    <div
      className={[
        'startup-shell',
        ready ? 'is-ready' : '',
        phase === 'exiting' ? 'is-exiting' : '',
        showOverlay ? 'is-blocking' : '',
        error ? 'has-error' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children ? <div className="startup-shell__app">{children}</div> : null}

      {showOverlay ? (
        <div className={['startup-overlay', phase === 'exiting' ? 'is-exiting' : '', error ? 'is-error' : '']
          .filter(Boolean)
          .join(' ')}
        >
          <div className="startup-overlay__backdrop" />
          <div className="startup-content">
            {!error ? (
              <>
                <SplashLogo />
                <div className="startup-meta">
                  <div className="startup-title">{title}</div>
                  <div className="startup-label">{label}</div>
                </div>
              </>
            ) : (
              <div className="startup-error-card">
                <div className="startup-error-card__badge">!</div>
                <div className="startup-meta">
                  <div className="startup-title">{title}</div>
                  <div className="startup-label">{label}</div>
                </div>
                <pre className="startup-error-card__details">{error}</pre>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getRoot(): Root | null {
  const rootEl = document.getElementById('root');
  if (!rootEl) return null;

  const rootWindow = window as RootWindow;
  const root = rootWindow.__scdRoot ?? ReactDOM.createRoot(rootEl);
  rootWindow.__scdRoot = root;
  return root;
}

function renderBootstrapScreen(
  root: Root,
  title: string,
  label: string,
  options?: {
    ready?: boolean;
    error?: string;
    children?: ReactNode;
  },
) {
  root.render(
    <AppRoot>
      <BootstrapScreen
        title={title}
        label={label}
        ready={options?.ready}
        error={options?.error}
      >
        {options?.children}
      </BootstrapScreen>
    </AppRoot>,
  );

  dismissInstantSplash();
}

async function disableLegacyServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const hadLegacyController =
      navigator.serviceWorker.controller?.scriptURL?.includes('/sw.js') ?? false;
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if (hadLegacyController && sessionStorage.getItem('scd-sw-reset-v1') !== '1') {
      sessionStorage.setItem('scd-sw-reset-v1', '1');
      window.location.reload();
      return;
    }
    sessionStorage.removeItem('scd-sw-reset-v1');
  } catch (error) {
    console.warn('[SW] Failed to unregister legacy proxy service worker:', error);
  }
}

async function bootstrap() {
  ensureDevPerformanceTimelineCleanup();

  const t = i18n.t.bind(i18n);

  const root = getRoot();
  if (!root) return;

  renderBootstrapScreen(
    root,
    t('boot.title'),
    t('boot.starting'),
  );

  let staticPort = 1420;
  let proxyPort = 1420;

  try {
    let tauriRuntime = isTauriRuntime();

    if (!tauriRuntime) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      tauriRuntime = isTauriRuntime();
    }

    if (tauriRuntime) {
      renderBootstrapScreen(
        root,
        t('boot.title'),
        t('boot.connectingServices'),
      );

      await Promise.all([
        import('./lib/scproxy'),
        import('./lib/discord'),
        import('./lib/tray'),
      ]);

      await initMediaProxyRuntime();

      if (useSettingsStore.persist.hasHydrated()) {
        applyHydratedDesktopSettings();
      }

      await disableLegacyServiceWorker();

      try {
        const ports = await invoke<[number, number]>('get_server_ports');

        staticPort = ports[0];
        proxyPort = ports[1];
      } catch (e) {
        console.warn(t('boot.failedPorts'), e);
      }
    } else {
      console.warn('[Bootstrap] Browser mode detected (without Tauri runtime).');

      console.warn(
        '[Bootstrap] For full app behavior run `pnpm dev:mcp` and use the Tauri window.',
      );
    }

    setServerPorts(staticPort, proxyPort);

    renderBootstrapScreen(
      root,
      t('boot.title'),
      t('boot.openingLibrary'),
      {
        ready: true,
        children: (
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        ),
      },
    );
  } catch (error) {
    console.error('[Bootstrap] Failed to initialize app:', error);

    renderBootstrapScreen(
      root,
      t('boot.title'),
      t('boot.startupFailed'),
      {
        error:
          error instanceof Error
            ? error.stack || error.message
            : String(error),
      },
    );
  }
}

void bootstrap();
