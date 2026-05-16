import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';

const SOUNDCLOUD_TOKEN_KEY = 'sc-direct-access-token';
const SOUNDCLOUD_REFRESH_TOKEN_KEY = 'sc-direct-refresh-token';
const SOUNDCLOUD_TOKEN_EXPIRES_KEY = 'sc-direct-token-expires';

export interface DirectOAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
}

export interface DirectSoundCloudUserInfo {
  id: number;
  urn?: string | null;
  username: string;
  avatar_url?: string | null;
  permalink_url?: string | null;
  followers_count?: number | null;
  followings_count?: number | null;
  track_count?: number | null;
  playlist_count?: number | null;
  public_favorites_count?: number | null;
}

export interface DirectAuthUser {
  id: number;
  urn: string;
  username: string;
  avatar_url: string;
  permalink_url: string;
  followers_count: number;
  followings_count: number;
  track_count: number;
  playlist_count: number;
  public_favorites_count: number;
}

export interface DirectResolvedTrackStream {
  url: string;
  format: string;
  protocol: string;
  mimeType: string;
  quality: 'hq' | 'lq';
}

export function getDirectAccessToken(): string | null {
  if (typeof window === 'undefined' || !isTauriRuntime()) {
    return null;
  }

  try {
    return localStorage.getItem(SOUNDCLOUD_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getDirectRefreshToken(): string | null {
  if (typeof window === 'undefined' || !isTauriRuntime()) {
    return null;
  }

  try {
    return localStorage.getItem(SOUNDCLOUD_REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function getStoredExpiry(): number | null {
  if (typeof window === 'undefined' || !isTauriRuntime()) {
    return null;
  }

  try {
    const raw = localStorage.getItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTokenExpired(): boolean {
  const expiresAt = getStoredExpiry();
  return expiresAt != null && Date.now() >= expiresAt;
}

export function storeDirectTokens(
  accessToken: string,
  refreshToken?: string | null,
  expiresIn?: number | null,
): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(SOUNDCLOUD_TOKEN_KEY, accessToken);

    if (refreshToken) {
      localStorage.setItem(SOUNDCLOUD_REFRESH_TOKEN_KEY, refreshToken);
    } else {
      localStorage.removeItem(SOUNDCLOUD_REFRESH_TOKEN_KEY);
    }

    if (expiresIn && expiresIn > 0) {
      const expiresAt = Date.now() + expiresIn * 1000;
      localStorage.setItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY, String(expiresAt));
    } else {
      localStorage.removeItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY);
    }
  } catch (error) {
    console.warn('[DirectSoundCloudAPI] Failed to store tokens:', error);
  }
}

export function clearDirectTokens(): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(SOUNDCLOUD_TOKEN_KEY);
    localStorage.removeItem(SOUNDCLOUD_REFRESH_TOKEN_KEY);
    localStorage.removeItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY);
  } catch {}
}

export function hasValidDirectToken(): boolean {
  const token = getDirectAccessToken();
  if (!token) return false;

  if (isTokenExpired()) {
    clearDirectTokens();
    return false;
  }

  return true;
}

export function mapDirectUserToAuthUser(user: DirectSoundCloudUserInfo): DirectAuthUser {
  return {
    id: user.id,
    urn: user.urn || `soundcloud:users:${user.id}`,
    username: user.username,
    avatar_url: user.avatar_url || '',
    permalink_url:
      user.permalink_url || `https://soundcloud.com/${encodeURIComponent(user.username)}`,
    followers_count: user.followers_count ?? 0,
    followings_count: user.followings_count ?? 0,
    track_count: user.track_count ?? 0,
    playlist_count: user.playlist_count ?? 0,
    public_favorites_count: user.public_favorites_count ?? 0,
  };
}

export async function getDirectCdnStreamUrl(
  trackId: string,
  accessTokenOverride?: string | null,
): Promise<string> {
  const stream = await resolveDirectTrackStream(trackId, accessTokenOverride);
  return stream.url;
}

export async function resolveDirectTrackStream(
  trackId: string,
  accessTokenOverride?: string | null,
): Promise<DirectResolvedTrackStream> {
  if (!isTauriRuntime()) {
    throw new Error('Direct SoundCloud API requires Tauri runtime');
  }

  const token = accessTokenOverride || getDirectAccessToken();
  if (!token) {
    throw new Error('No direct SoundCloud token available');
  }

  const stream = await invoke<{
    url: string;
    format: string;
    protocol: string;
    mime_type: string;
    quality: 'hq' | 'lq' | string;
  }>('resolve_soundcloud_track_stream', {
    trackId,
    accessToken: token,
  });

  return {
    url: stream.url,
    format: stream.format,
    protocol: stream.protocol,
    mimeType: stream.mime_type,
    quality: stream.quality === 'hq' ? 'hq' : 'lq',
  };
}

export async function startDirectOAuthFlow(
  clientId: string,
  clientSecret: string,
): Promise<DirectOAuthTokens> {
  if (!isTauriRuntime()) {
    throw new Error('Direct SoundCloud OAuth requires Tauri runtime');
  }

  const tokens = await invoke<{
    access_token: string;
    refresh_token?: string | null;
    expires_in?: number | null;
  }>('soundcloud_oauth_start', {
    clientId,
    clientSecret,
  });

  const normalized: DirectOAuthTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn: tokens.expires_in ?? null,
  };

  storeDirectTokens(normalized.accessToken, normalized.refreshToken, normalized.expiresIn);
  return normalized;
}
