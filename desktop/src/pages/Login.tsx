import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  fetchDirectSoundCloudMe,
  mapDirectUserToAuthUser,
  startDirectOAuthFlow,
} from '../lib/direct-soundcloud-api';
import { normalizeLanguage } from '../i18n/language';
import { checkSoundCloudCdnConnectivity } from '../lib/media-connectivity';
import { Check, Disc3 } from '../lib/icons';
import { queryClient } from '../main';
import { useAuthStore } from '../stores/auth';
import { useDirectAuthStore } from '../stores/direct-auth';
import { useSettingsStore } from '../stores/settings';

interface LoginProps {
  autoStartRequestId?: number | null;
}

export function Login({ autoStartRequestId = null }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [settingsHydrated, setSettingsHydrated] = useState(() => useSettingsStore.persist.hasHydrated());
  const clearReloginRequest = useAuthStore((s) => s.clearReloginRequest);
  const soundcloudClientId = useSettingsStore((s) => s.soundcloudClientId);
  const soundcloudClientSecret = useSettingsStore((s) => s.soundcloudClientSecret);
  const setSoundcloudClientId = useSettingsStore((s) => s.setSoundcloudClientId);
  const setSoundcloudClientSecret = useSettingsStore((s) => s.setSoundcloudClientSecret);
  const mediaConnectivityDialogOpen = useSettingsStore((s) => s.mediaConnectivityDialogOpen);
  const setMediaConnectivityDialogOpen = useSettingsStore((s) => s.setMediaConnectivityDialogOpen);
  const setMediaConnectivityProbeState = useSettingsStore((s) => s.setMediaConnectivityProbeState);
  const directSetTokens = useDirectAuthStore((s) => s.setTokens);
  const directSetUser = useDirectAuthStore((s) => s.setUser);
  const [loading, setLoading] = useState(false);
  const loadingTimeoutRef = useRef<number | null>(null);
  const latestAttemptRef = useRef(0);
  const connectivityProbeInFlightRef = useRef(false);
  const mediaConnectivityDialogOpenRef = useRef(mediaConnectivityDialogOpen);

  const hasCredentials =
    soundcloudClientId.trim().length > 0 && soundcloudClientSecret.trim().length > 0;

  const clearLoadingTimeout = useCallback(() => {
    if (loadingTimeoutRef.current !== null) {
      window.clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, []);

  const handleDirectOAuth = useCallback(async () => {
    if (!hasCredentials) {
      toast.error(t('auth.oauthRequired'));
      return;
    }

    const attemptId = latestAttemptRef.current + 1;
    latestAttemptRef.current = attemptId;
    clearLoadingTimeout();
    setLoading(true);

    loadingTimeoutRef.current = window.setTimeout(() => {
      if (latestAttemptRef.current === attemptId) {
        setLoading(false);
      }
    }, 10_000);

    try {
      const tokens = await startDirectOAuthFlow(
        soundcloudClientId.trim(),
        soundcloudClientSecret.trim(),
        normalizeLanguage(i18n.resolvedLanguage || i18n.language),
      );

      if (latestAttemptRef.current !== attemptId) {
        return;
      }

      directSetTokens(
        tokens.accessToken,
        tokens.refreshToken ?? undefined,
        tokens.expiresIn ?? undefined,
      );

      const userInfo = await fetchDirectSoundCloudMe(tokens.accessToken);

      if (latestAttemptRef.current !== attemptId) {
        return;
      }

      const appUser = mapDirectUserToAuthUser(userInfo);

      directSetUser(appUser);
      useAuthStore.setState({
        sessionId: null,
        user: appUser,
        isAuthenticated: true,
        reloginRequestId: null,
      });

      clearReloginRequest();
      setMediaConnectivityDialogOpen(false);
      queryClient.invalidateQueries();
      toast.success(t('settings.directOAuthSuccess'));
      window.location.hash = '/';
    } catch (error) {
      if (latestAttemptRef.current !== attemptId) {
        return;
      }

      console.error('[DirectOAuth] Failed:', error);
      toast.error(`${t('settings.directOAuthFailed')}: ${String(error)}`);
    } finally {
      if (latestAttemptRef.current === attemptId) {
        clearLoadingTimeout();
        setLoading(false);
      }
    }
  }, [
    clearLoadingTimeout,
    clearReloginRequest,
    directSetTokens,
    directSetUser,
    hasCredentials,
    setMediaConnectivityDialogOpen,
    soundcloudClientId,
    soundcloudClientSecret,
    i18n.language,
    i18n.resolvedLanguage,
  ]);

  useEffect(() => clearLoadingTimeout, [clearLoadingTimeout]);

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
    mediaConnectivityDialogOpenRef.current = mediaConnectivityDialogOpen;
  }, [mediaConnectivityDialogOpen]);

  useEffect(() => {
    if (!settingsHydrated) return;

    setMediaConnectivityProbeState('unknown');
  }, [settingsHydrated, setMediaConnectivityProbeState]);

  const runConnectivityProbe = useCallback(async () => {
    if (connectivityProbeInFlightRef.current) return;
    if (mediaConnectivityDialogOpenRef.current) return;

    connectivityProbeInFlightRef.current = true;

    try {
      const result = await checkSoundCloudCdnConnectivity({ useRememberedStream: true });
      setMediaConnectivityProbeState(result.status);

      if (!result.healthy) {
        setMediaConnectivityDialogOpen(true);
      }
    } catch {
      setMediaConnectivityProbeState('degraded');
      setMediaConnectivityDialogOpen(true);
    } finally {
      connectivityProbeInFlightRef.current = false;
    }
  }, [setMediaConnectivityDialogOpen, setMediaConnectivityProbeState]);

  useEffect(() => {
    if (!settingsHydrated) return;

    let disposed = false;
    const scheduleProbe = (delayMs = 0) =>
      window.setTimeout(() => {
        if (disposed) return;
        void runConnectivityProbe();
      }, delayMs);

    const timeoutId = scheduleProbe(250);
    const handleFocus = () => {
      void runConnectivityProbe();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void runConnectivityProbe();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [runConnectivityProbe, settingsHydrated]);

  useEffect(() => {
    if (!autoStartRequestId || loading || !hasCredentials) return;
    clearReloginRequest();
    void handleDirectOAuth();
  }, [autoStartRequestId, clearReloginRequest, handleDirectOAuth, hasCredentials, loading]);

  return (
    <div className="h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-orange-500/[0.03] blur-[120px]" />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && hasCredentials) {
            void handleDirectOAuth();
          }
        }}
        className="relative flex flex-col items-center gap-8 max-w-sm w-full mx-4"
      >
        <div className="relative">
          <div className="absolute inset-0 bg-accent/20 blur-2xl rounded-full scale-150" />
          <div className="relative w-20 h-20 rounded-[22px] bg-white/[0.04] backdrop-blur-lg border border-white/[0.08] flex items-center justify-center shadow-[0_0_20px_rgba(255,85,0,0.05)]">
            <Disc3 size={36} className="text-accent" strokeWidth={1.5} />
          </div>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">SoundCloud Desktop</h1>
          <p className="text-[13px] text-white/30 mt-2">
            {loading ? t('auth.signingIn') : t('auth.loginSubtitle')}
          </p>
        </div>

        <div className="w-full rounded-[24px] border border-white/[0.06] bg-white/[0.03] p-3 backdrop-blur-lg space-y-3">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/35">
              {t('auth.oauthTitle')}
            </p>
            <p className="text-[12px] leading-relaxed text-white/45">
              {t('auth.oauthDescription')}
            </p>
          </div>

          <div className="space-y-1.5">
            <input
              type="text"
              value={soundcloudClientId}
              onChange={(e) => setSoundcloudClientId(e.target.value)}
              placeholder={t('auth.clientId')}
              className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
            />
            <input
              type="password"
              autoComplete="current-password"
              value={soundcloudClientSecret}
              onChange={(e) => setSoundcloudClientSecret(e.target.value)}
              placeholder={t('auth.clientSecret')}
              className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
            />

            {hasCredentials ? (
              <p className="text-[11px] text-green-400/70 flex items-center gap-1.5">
                <Check size={12} />
                {t('auth.oauthSaved')}
              </p>
            ) : (
              <p className="text-[11px] text-red-300/80">
                {t('auth.oauthRequired')}{' '}
                <a
                  href="https://soundcloud.com/you/apps"
                  target="_blank"
                  rel="noreferrer"
                  className="text-red-200 underline decoration-red-200/60 underline-offset-2 hover:text-white transition-colors"
                >
                  {t('auth.oauthGetCredentials')}
                </a>
              </p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full border-2 border-white/[0.06] border-t-accent animate-spin" />
            <p className="text-[12px] text-white/25">{t('auth.signingIn')}</p>
          </div>
        ) : (
          <div className="w-full flex flex-col gap-2">
            <button
              type="submit"
              disabled={!hasCredentials}
              className="w-full py-3.5 rounded-2xl bg-accent text-accent-contrast font-semibold text-sm hover:bg-accent-hover active:scale-[0.97] transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer shadow-[0_0_40px_var(--color-accent-glow),0_4px_12px_rgba(0,0,0,0.3)] hover:shadow-[0_0_60px_var(--color-accent-glow),0_4px_16px_rgba(0,0,0,0.4)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent disabled:active:scale-100 disabled:hover:shadow-[0_0_40px_var(--color-accent-glow),0_4px_12px_rgba(0,0,0,0.3)]"
            >
              {t('auth.signIn')}
            </button>
            <div></div>
          </div>
        )}
      </form>
    </div>
  );
}
