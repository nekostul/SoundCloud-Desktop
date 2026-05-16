/**
 * Direct OAuth authentication component for Settings
 * Allows users to authenticate without backend via Tauri
 */

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { LogOut, LogIn } from 'lucide-react';
import { useDirectAuthStore } from '../../stores/direct-auth';
import {
  hasValidDirectToken,
  mapDirectUserToAuthUser,
  startDirectOAuthFlow,
  type DirectSoundCloudUserInfo,
} from '../../lib/direct-soundcloud-api';

export function DirectOAuthSection() {
  const [loading, setLoading] = useState(false);
  const { user, isAuthenticated, setTokens, setUser, logout } =
    useDirectAuthStore();

  const handleDirectOAuth = useCallback(async () => {
    const clientId = prompt('Enter your SoundCloud Client ID:');
    if (!clientId) return;

    const clientSecret = prompt('Enter your SoundCloud Client Secret:');
    if (!clientSecret) return;

    setLoading(true);
    try {
      console.log('[DirectOAuth] Starting OAuth flow...');
      
      // Start OAuth flow via Tauri
      const tokens = await startDirectOAuthFlow(clientId, clientSecret);
      const token = tokens.accessToken;
      console.log('[DirectOAuth] Received token:', token?.substring(0, 20) + '...');

      setTokens(token, tokens.refreshToken ?? undefined, tokens.expiresIn ?? undefined);

      try {
        console.log('[DirectOAuth] Fetching user info...');
        const userInfo = await invoke<DirectSoundCloudUserInfo>('fetch_soundcloud_me', {
          accessToken: token,
        });
        console.log('[DirectOAuth] User info received:', userInfo);
        
        setUser(mapDirectUserToAuthUser(userInfo));
      } catch (err) {
        console.warn('[DirectOAuth] User info fetch failed, but token is valid:', err);
        toast.error(`User fetch failed: ${String(err)}`);
      }

      toast.success('Successfully authenticated via Direct OAuth');
    } catch (error) {
      console.error('[DirectOAuth] OAuth flow failed:', error);
      toast.error(`Authentication failed: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [setTokens, setUser]);

  const handleLogout = useCallback(() => {
    logout();
    toast.success('Logged out from Direct OAuth');
  }, [logout]);

  return (
    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.03] p-6 space-y-4">
      <div>
        <h3 className="text-[14px] font-semibold uppercase tracking-[0.1em] text-white/70">
          Direct OAuth (No Backend)
        </h3>
        <p className="text-[12px] text-white/50 mt-2">
          Authenticate directly with SoundCloud using Tauri. No backend server required.
        </p>
      </div>

      {isAuthenticated && hasValidDirectToken() ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-white/[0.05] border border-white/[0.08] p-4">
            <p className="text-[13px] text-white/70">
              ✅ <span className="text-green-400">Authenticated</span>
            </p>
            {user && (
              <>
                <p className="text-[13px] text-white/60 mt-2">
                  <strong>{user.username}</strong>
                </p>
                <p className="text-[11px] text-white/40 mt-1">ID: {user.id}</p>
              </>
            )}
          </div>
          <button
            onClick={handleLogout}
            disabled={loading}
            className="w-full px-4 py-2.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-[13px] font-medium text-red-300 transition-colors disabled:opacity-50"
          >
            <LogOut size={14} className="inline mr-2" />
            Logout
          </button>
        </div>
      ) : (
        <button
          onClick={handleDirectOAuth}
          disabled={loading}
          className="w-full px-4 py-2.5 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/30 text-[13px] font-medium text-orange-300 transition-colors disabled:opacity-50"
        >
          <LogIn size={14} className="inline mr-2" />
          {loading ? 'Authenticating...' : 'Login via Tauri OAuth'}
        </button>
      )}
    </div>
  );
}
