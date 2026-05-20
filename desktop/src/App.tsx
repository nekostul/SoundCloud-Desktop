import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useShallow } from 'zustand/shallow';
import { MediaConnectivityDialog } from './components/connectivity/MediaConnectivityDialog';
import { AppShell } from './components/layout/AppShell';
import { ContextMenuProvider } from './components/context-menu/ContextMenuProvider';
import { ThemeProvider } from './components/ThemeProvider';
import { UpdateChecker } from './components/UpdateChecker';
import { setSessionExpiredHandler, setSessionId, setUnauthorizedHandler } from './lib/api';
import { applyAppFont, FORCED_APP_TEXT_SIZE, FORCED_APP_UI_SCALE } from './lib/app-font';
import { hasAuthHydrated } from './lib/auth-hydration';
import {
  fetchDirectSoundCloudMe,
  isDirectAuthRequiredError,
  mapDirectUserToAuthUser,
} from './lib/direct-soundcloud-api';
import { checkSoundCloudCdnConnectivity } from './lib/media-connectivity';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { PlaylistPage } from './pages/PlaylistPage';
import { Search } from './pages/Search';
import { Settings } from './pages/Settings';
import { TrackPage } from './pages/TrackPage';
import { UserPage } from './pages/UserPage';
import { useAppStatusStore } from './stores/app-status';
import { useAuthStore } from './stores/auth';
import { useDirectAuthStore } from './stores/direct-auth';
import { useSettingsStore } from './stores/settings';

type AppErrorBoundaryState = {
  error: Error | null;
};

const MEDIA_CONNECTIVITY_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

function isDirectAuthFailure(error: unknown) {
  return isDirectAuthRequiredError(error);
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[App] Render crash:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen relative overflow-hidden bg-[rgb(8,8,10)] text-white">
          <div className="absolute inset-0">
            <div className="absolute top-[12%] left-[10%] h-72 w-72 rounded-full bg-red-500/[0.12] blur-[120px]" />
            <div className="absolute bottom-[8%] right-[10%] h-80 w-80 rounded-full bg-accent/[0.08] blur-[140px]" />
          </div>
          <div className="relative flex h-full items-center justify-center p-6">
            <div className="w-full max-w-lg rounded-[28px] border border-white/8 bg-white/[0.04] px-7 py-8 backdrop-blur-lg">
              <div className="text-lg font-semibold tracking-tight text-white/92">Renderer crashed</div>
              <div className="mt-2 text-sm text-white/55">
                The app hit a React error before the main UI finished rendering.
              </div>
              <pre className="mt-4 overflow-auto rounded-2xl border border-white/8 bg-black/20 p-4 text-xs text-white/70">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function AppInner() {
  const { t } = useTranslation();
  const { isAuthenticated, sessionId, reloginRequestId } = useAuthStore(
    useShallow((s) => ({
      isAuthenticated: s.isAuthenticated,
      sessionId: s.sessionId,
      reloginRequestId: s.reloginRequestId,
    })),
  );
  const [checking, setChecking] = useState(true);
  const [authHydrated, setAuthHydrated] = useState(() => useAuthStore.persist.hasHydrated());
  const [directHydrated, setDirectHydrated] = useState(() => useDirectAuthStore.persist.hasHydrated());
  const [settingsHydrated, setSettingsHydrated] = useState(() =>
    useSettingsStore.persist.hasHydrated(),
  );
  const directAuthenticated = useDirectAuthStore((s) => s.isAuthenticated);
  const directUser = useDirectAuthStore((s) => s.user);
  const directSetUser = useDirectAuthStore((s) => s.setUser);
  const setMediaConnectivityProbeState = useSettingsStore((s) => s.setMediaConnectivityProbeState);
  const effectiveAuthenticated = isAuthenticated || directAuthenticated;

  // Re-apply persisted app icon choice on each app start. Tauri uses the
  // built-in icon from tauri.conf.json at boot — if the user previously
  // picked something else, we override here as soon as React mounts.
  useEffect(() => {
    const s = useSettingsStore.getState();
    if (s.appIcon === 'custom' && s.customAppIconPath) {
      void invokeTauri('set_custom_app_icon', { path: s.customAppIconPath }).catch(() => {
        // File missing/unreadable — fall back to default so the user isn't
        // stuck with a broken titlebar icon.
        void invokeTauri('set_app_icon', { variant: 'default' }).catch(() => {});
      });
    } else {
      void invokeTauri('set_app_icon', { variant: s.appIcon }).catch(() => {});
    }
  }, []);

  // Re-apply the chosen font on every relevant settings change. Subscribing
  // to a slice (not the whole store) keeps this effect quiet when unrelated
  // settings update.
  useEffect(() => {
    void applyAppFont({
      textSize: FORCED_APP_TEXT_SIZE,
      uiScale: FORCED_APP_UI_SCALE,
    });
  }, []);

  useEffect(() => {
    const syncOnline = () => {
      const online = navigator.onLine;
      const appStatus = useAppStatusStore.getState();
      appStatus.setNavigatorOnline(online);
      if (online) {
        appStatus.setBackendReachable(true);
      }
    };

    syncOnline();
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);

    return () => {
      window.removeEventListener('online', syncOnline);
      window.removeEventListener('offline', syncOnline);
    };
  }, []);

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated() || hasAuthHydrated()) {
      setAuthHydrated(true);
      return;
    }

    const unsubscribe = useAuthStore.persist.onFinishHydration(() => {
      setAuthHydrated(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (useDirectAuthStore.persist.hasHydrated()) {
      setDirectHydrated(true);
      return;
    }

    const unsubscribe = useDirectAuthStore.persist.onFinishHydration(() => {
      setDirectHydrated(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (useSettingsStore.persist.hasHydrated()) {
      setSettingsHydrated(true);
      return;
    }

    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      setSettingsHydrated(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      useAuthStore.getState().beginRelogin();
    });

    setSessionExpiredHandler(() => {
      useAuthStore.getState().beginRelogin();
    });

    return () => {
      setUnauthorizedHandler(null);
      setSessionExpiredHandler(null);
    };
  }, []);

  // Handle sessionId from deep link URL parameters (from OAuth callback redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionIdParam = params.get('sessionId');

    if (sessionIdParam?.trim()) {
      console.log('[Auth] Received sessionId from OAuth callback:', sessionIdParam.substring(0, 8) + '...');
      useAuthStore.setState({ sessionId: sessionIdParam });

      // Clean up URL parameters
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  }, []);

  useEffect(() => {
    if (!authHydrated || !directHydrated) {
      setChecking(true);
      return;
    }

    if (directAuthenticated) {
      if (sessionId) {
        setSessionId(null);
        useAuthStore.setState({ sessionId: null });
      }

      setChecking(true);

      if (directUser) {
        useAuthStore.setState({
          sessionId: null,
          user: directUser,
          isAuthenticated: true,
          reloginRequestId: null,
        });
        setChecking(false);
        return;
      }

      fetchDirectSoundCloudMe()
        .then((userInfo) => {
          const mapped = mapDirectUserToAuthUser(userInfo);
          directSetUser(mapped);
          useAuthStore.setState({
            sessionId: null,
            user: mapped,
            isAuthenticated: true,
            reloginRequestId: null,
          });
        })
        .catch((error) => {
          console.warn('[Auth] Failed to restore direct SoundCloud user:', error);
          if (isDirectAuthFailure(error)) {
            useDirectAuthStore.getState().clear();
            useAuthStore.setState({
              sessionId: null,
              user: null,
              isAuthenticated: false,
              reloginRequestId: null,
            });
            return;
          }

          useAuthStore.setState({
            sessionId: null,
            user: null,
            isAuthenticated: true,
            reloginRequestId: null,
          });
        })
        .finally(() => setChecking(false));
      return;
    }

    if (sessionId) {
      console.warn('[Auth] Ignoring legacy backend session in standalone mode');
      setSessionId(null);
      useAuthStore.setState({
        sessionId: null,
        user: null,
        isAuthenticated: false,
        reloginRequestId: null,
      });
      setChecking(false);
      return;
    }

    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      reloginRequestId: null,
    });
    setChecking(false);
  }, [
    authHydrated,
    directAuthenticated,
    directHydrated,
    directSetUser,
    directUser,
    sessionId,
  ]);

  useEffect(() => {
    if (!authHydrated || !directHydrated || !settingsHydrated) return;

    let cancelled = false;

    const runConnectivityProbe = async () => {
      try {
        const result = await checkSoundCloudCdnConnectivity({
          useRememberedStream: effectiveAuthenticated,
        });
        if (cancelled) return;
        setMediaConnectivityProbeState(result.status);
      } catch {
        if (cancelled) return;
        setMediaConnectivityProbeState('degraded');
      }
    };

    setMediaConnectivityProbeState('unknown');
    void runConnectivityProbe();

    const intervalId = window.setInterval(() => {
      void runConnectivityProbe();
    }, MEDIA_CONNECTIVITY_RECHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    authHydrated,
    directHydrated,
    effectiveAuthenticated,
    setMediaConnectivityProbeState,
    settingsHydrated,
  ]);

  const isBooting = !authHydrated || !directHydrated || !settingsHydrated || checking;

  return (
    <ThemeProvider>
      <BrowserRouter>
        <ContextMenuProvider>
          <Toaster
            theme="dark"
            position="top-right"
            toastOptions={{
              style: {
                background: 'rgba(30, 30, 34, 0.9)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.85)',
                fontSize: '13px',
              },
            }}
          />
          <MediaConnectivityDialog />
          {isBooting && (
            <div
              className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-5 py-2.5 rounded-full border border-white/[0.08] bg-white/[0.06] backdrop-blur-lg shadow-[0_4px_16px_rgba(0,0,0,0.3)] animate-fade-in whitespace-nowrap"
            >
                <span className="text-[12px] font-medium text-white/70">
                {sessionId || directAuthenticated ? t('auth.restoringSession') : t('auth.startingApp')}
              </span>
              <div className="h-4 w-4 rounded-full border-2 border-white/10 border-t-accent animate-spin" />
            </div>
          )}
          {effectiveAuthenticated && <UpdateChecker />}

          {!effectiveAuthenticated ? (
            <Login autoStartRequestId={reloginRequestId} />
          ) : (
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Home />} />
                <Route path="search" element={<Search />} />
                <Route path="library" element={<Library />} />
                <Route path="track/:urn" element={<TrackPage />} />
                <Route path="playlist/:urn" element={<PlaylistPage />} />
                <Route path="user/:urn" element={<UserPage />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          )}
        </ContextMenuProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
}
