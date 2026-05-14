import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { QrLinkSheet } from '../components/auth/QrLinkSheet';
import { api } from '../lib/api';
import { Check, ClipboardCopy, Disc3, Smartphone } from '../lib/icons';
import { queryClient } from '../main';
import { useAuthStore } from '../stores/auth';
import { useSettingsStore } from '../stores/settings';

const AUTH_SUCCESS_MESSAGE_TYPE = 'soundcloud-desktop-auth-success';
const AUTH_ERROR_MESSAGE_TYPE = 'soundcloud-desktop-auth-error';
const AUTH_SESSION_STORAGE_KEY = 'soundcloud-desktop-auth-session-id';

interface LoginResponse {
  url: string;
  loginRequestId?: string;
  sessionId?: string;
}

interface LoginStatusResponse {
  status: 'pending' | 'completed' | 'failed' | 'expired';
  sessionId?: string;
  error?: string;
}

type CallbackAuthMessage =
  | {
      type: typeof AUTH_SUCCESS_MESSAGE_TYPE;
      sessionId?: string;
    }
  | {
      type: typeof AUTH_ERROR_MESSAGE_TYPE;
      error?: string;
    };

interface LoginProps {
  autoStartRequestId?: number | null;
}

export function Login({ autoStartRequestId = null }: LoginProps) {
  const { t } = useTranslation();
  const setSession = useAuthStore((s) => s.setSession);
  const fetchUser = useAuthStore((s) => s.fetchUser);
  const clearReloginRequest = useAuthStore((s) => s.clearReloginRequest);
  const soundcloudClientId = useSettingsStore((s) => s.soundcloudClientId);
  const soundcloudClientSecret = useSettingsStore((s) => s.soundcloudClientSecret);
  const setSoundcloudClientId = useSettingsStore((s) => s.setSoundcloudClientId);
  const setSoundcloudClientSecret = useSettingsStore((s) => s.setSoundcloudClientSecret);
  const [loading, setLoading] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const credentialsSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledAutoStartRef = useRef<number | null>(null);
  const completedSessionRef = useRef<string | null>(null);
  const lastSyncedCredentialsRef = useRef<string>('');
  const hasCredentials =
    soundcloudClientId.trim().length > 0 && soundcloudClientSecret.trim().length > 0;

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  const finishLogin = async (sessionId: string) => {
    if (!sessionId || completedSessionRef.current === sessionId) {
      return;
    }

    completedSessionRef.current = sessionId;
    stopPolling();
    setSession(sessionId);
    queryClient.invalidateQueries();

    try {
      await fetchUser();
    } catch (error) {
      console.warn('[Auth] Session established, but initial /me fetch failed:', error);
    } finally {
      setLoading(false);
      setQrOpen(false);
      try {
        localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      } catch {}
    }
  };

  const failLogin = (error?: string) => {
    stopPolling();
    if (error) {
      console.error('Login failed:', error);
    }
    setLoading(false);
  };

  const onQrLoginSuccess = async (sessionId: string) => {
    await finishLogin(sessionId);
  };

  const handleLogin = async () => {
    if (!hasCredentials) {
      return;
    }

    stopPolling();
    completedSessionRef.current = null;
    setLoading(true);
    try {
      const clientId = soundcloudClientId.trim();
      const clientSecret = soundcloudClientSecret.trim();
      await api('/auth/credentials', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          clientSecret,
        }),
      });
      lastSyncedCredentialsRef.current = `${clientId}\n${clientSecret}`;

      const { url, loginRequestId, sessionId: loginSessionId } = await api<LoginResponse>('/auth/login');
      const requestId = loginRequestId || loginSessionId;
      if (!requestId) {
        throw new Error('Missing login request id');
      }
      setAuthUrl(url);
      if (isTauri()) {
        try {
          await openUrl(url);
        } catch (error) {
          console.error('Failed to open system browser for OAuth login:', error);
          toast.error('Could not open your default browser. Copy the login link and open it manually.');
        }
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }

      const pollSession = async () => {
        try {
          const data = await api<LoginStatusResponse>(
            `/auth/login/status?id=${encodeURIComponent(requestId)}`,
          );
          if (data.status === 'completed' && data.sessionId) {
            void finishLogin(data.sessionId);
            return;
          }
          if (data.status === 'failed' || data.status === 'expired') {
            failLogin(data.error ?? data.status);
            return;
          }
        } catch {}
        pollRef.current = setTimeout(pollSession, 2000);
      };

      pollRef.current = setTimeout(pollSession, 2000);
    } catch (e) {
      console.error('Login failed:', e);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (credentialsSyncRef.current) {
      clearTimeout(credentialsSyncRef.current);
      credentialsSyncRef.current = null;
    }

    if (!hasCredentials) {
      return;
    }

    const clientId = soundcloudClientId.trim();
    const clientSecret = soundcloudClientSecret.trim();
    const syncKey = `${clientId}\n${clientSecret}`;

    if (syncKey === lastSyncedCredentialsRef.current) {
      return;
    }

    credentialsSyncRef.current = setTimeout(() => {
      void api('/auth/credentials', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          clientSecret,
        }),
      })
        .then(() => {
          lastSyncedCredentialsRef.current = syncKey;
        })
        .catch((error) => {
          console.warn('[Auth] Failed to sync stored OAuth credentials to backend:', error);
        })
        .finally(() => {
          credentialsSyncRef.current = null;
        });
    }, 250);

    return () => {
      if (credentialsSyncRef.current) {
        clearTimeout(credentialsSyncRef.current);
        credentialsSyncRef.current = null;
      }
    };
  }, [hasCredentials, soundcloudClientId, soundcloudClientSecret]);

  useEffect(() => {
    const consumeStoredSession = () => {
      try {
        const sessionId = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
        if (sessionId) {
          void finishLogin(sessionId);
        }
      } catch {}
    };

    const handleMessage = (event: MessageEvent<CallbackAuthMessage>) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object' || !('type' in payload)) {
        return;
      }

      if (payload.type === AUTH_SUCCESS_MESSAGE_TYPE && payload.sessionId) {
        void finishLogin(payload.sessionId);
        return;
      }

      if (payload.type === AUTH_ERROR_MESSAGE_TYPE) {
        failLogin(payload.error ?? 'Authentication failed');
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SESSION_STORAGE_KEY && event.newValue) {
        void finishLogin(event.newValue);
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('storage', handleStorage);
    consumeStoredSession();

    return () => {
      stopPolling();
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('storage', handleStorage);
    };
  }, [fetchUser, setSession]);

  useEffect(() => {
    if (!autoStartRequestId || loading || !hasCredentials) return;
    if (handledAutoStartRef.current === autoStartRequestId) return;

    handledAutoStartRef.current = autoStartRequestId;
    clearReloginRequest();
    void handleLogin();
  }, [autoStartRequestId, clearReloginRequest, hasCredentials, loading]);

  return (
    <div className="h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-purple-500/[0.03] blur-[120px]" />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && hasCredentials) {
            void handleLogin();
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
              SoundCloud OAuth
            </p>
            <p className="text-[12px] leading-relaxed text-white/45">
              Enter your SoundCloud OAuth app credentials once. They are stored locally on this device and reused for future sign-ins.
            </p>
          </div>

          <div className="space-y-1.5">
            <input
              type="text"
              value={soundcloudClientId}
              onChange={(e) => setSoundcloudClientId(e.target.value)}
              placeholder="Client ID"
              className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
            />
            <input
              type="password"
              autoComplete="current-password"
              value={soundcloudClientSecret}
              onChange={(e) => setSoundcloudClientSecret(e.target.value)}
              placeholder="Client Secret"
              className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
            />
            {hasCredentials ? (
              <p className="text-[11px] text-green-400/70">Credentials saved locally and ready for sign-in</p>
            ) : (
              <p className="text-[11px] text-red-300/80">Client ID and Client Secret are required</p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full border-2 border-white/[0.06] border-t-accent animate-spin" />
            <p className="text-[12px] text-white/25">{t('auth.signingIn')}</p>
            {authUrl && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(authUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-white/30 hover:text-white/50 transition-all cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check size={12} />
                    {t('auth.copied')}
                  </>
                ) : (
                  <>
                    <ClipboardCopy size={12} />
                    {t('auth.copyLink')}
                  </>
                )}
              </button>
            )}
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
            <button
              type="button"
              onClick={() => setQrOpen(true)}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-2xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[12px] text-white/55 hover:text-white/85 transition-all cursor-pointer"
            >
              <Smartphone size={13} />
              {t('qrLink.scanQr')}
            </button>
          </div>
        )}
      </form>

      <QrLinkSheet open={qrOpen} onOpenChange={setQrOpen} mode="pull" onSuccess={onQrLoginSuccess} />
    </div>
  );
}
