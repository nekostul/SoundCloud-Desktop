/**
 * Direct OAuth authentication component for Settings
 * Allows users to authenticate without backend via Tauri
 */

import { LogIn, LogOut } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  fetchDirectSoundCloudMe,
  mapDirectUserToAuthUser,
  startDirectOAuthFlow,
} from '../../lib/direct-soundcloud-api';
import { useDirectAuthStore } from '../../stores/direct-auth';
import { useSettingsStore } from '../../stores/settings';

export function DirectOAuthSection() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const { user, isAuthenticated, setTokens, setUser, logout } = useDirectAuthStore();
  const setSoundcloudClientId = useSettingsStore((s) => s.setSoundcloudClientId);
  const setSoundcloudClientSecret = useSettingsStore((s) => s.setSoundcloudClientSecret);

  const handleDirectOAuth = useCallback(async () => {
    const clientId = prompt(t('settings.directOAuthPromptClientId'))?.trim();
    if (!clientId) return;

    const clientSecret = prompt(t('settings.directOAuthPromptClientSecret'))?.trim();
    if (!clientSecret) return;

    setSoundcloudClientId(clientId);
    setSoundcloudClientSecret(clientSecret);

    setLoading(true);
    try {
      console.log('[DirectOAuth] Starting OAuth flow...');
      const tokens = await startDirectOAuthFlow(clientId, clientSecret);
      const token = tokens.accessToken;
      console.log('[DirectOAuth] Received token:', token?.substring(0, 20) + '...');

      setTokens(token, tokens.refreshToken ?? undefined, tokens.expiresIn ?? undefined);

      try {
        console.log('[DirectOAuth] Fetching user info...');
        const userInfo = await fetchDirectSoundCloudMe(token);
        console.log('[DirectOAuth] User info received:', userInfo);
        setUser(mapDirectUserToAuthUser(userInfo));
      } catch (err) {
        console.warn('[DirectOAuth] User info fetch failed, but token is valid:', err);
        toast.error(`${t('settings.directOAuthFetchUserFailed')}: ${String(err)}`);
      }

      toast.success(t('settings.directOAuthSuccess'));
    } catch (error) {
      console.error('[DirectOAuth] OAuth flow failed:', error);
      toast.error(`${t('settings.directOAuthFailed')}: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [setSoundcloudClientId, setSoundcloudClientSecret, setTokens, setUser, t]);

  const handleLogout = useCallback(() => {
    logout();
    toast.success(t('settings.directOAuthLogoutSuccess'));
  }, [logout, t]);

  return (
    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.03] p-6 space-y-4">
      <div>
        <h3 className="text-[14px] font-semibold uppercase tracking-[0.1em] text-white/70">
          {t('settings.directOAuthTitle')}
        </h3>
        <p className="text-[12px] text-white/50 mt-2">
          {t('settings.directOAuthDescription')}
        </p>
      </div>

      {isAuthenticated ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-white/[0.05] border border-white/[0.08] p-4">
            <p className="text-[13px] text-white/70">
              <span className="text-green-400">{t('settings.directOAuthAuthenticated')}</span>
            </p>
            {user && (
              <>
                <p className="text-[13px] text-white/60 mt-2">
                  <strong>{user.username}</strong>
                </p>
                <p className="text-[11px] text-white/40 mt-1">
                  {t('settings.directOAuthUserId')}: {user.id}
                </p>
              </>
            )}
          </div>
          <button
            onClick={handleLogout}
            disabled={loading}
            className="w-full px-4 py-2.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-[13px] font-medium text-red-300 transition-colors disabled:opacity-50"
          >
            <LogOut size={14} className="inline mr-2" />
            {t('auth.signOut')}
          </button>
        </div>
      ) : (
        <button
          onClick={handleDirectOAuth}
          disabled={loading}
          className="w-full px-4 py-2.5 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/30 text-[13px] font-medium text-orange-300 transition-colors disabled:opacity-50"
        >
          <LogIn size={14} className="inline mr-2" />
          {loading ? t('settings.directOAuthAuthenticating') : t('settings.directOAuthLogin')}
        </button>
      )}
    </div>
  );
}
