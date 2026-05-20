import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';

const SOUNDCLOUD_TOKEN_KEY = 'sc-direct-access-token';
const SOUNDCLOUD_REFRESH_TOKEN_KEY = 'sc-direct-refresh-token';
const SOUNDCLOUD_TOKEN_EXPIRES_KEY = 'sc-direct-token-expires';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

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

type DirectTokenSnapshot = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
};

type EnsureDirectAccessTokenOptions = {
  forceRefresh?: boolean;
  allowExpiredTokenFallback?: boolean;
  reason?: string;
};

export class DirectAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectAuthRequiredError';
  }
}

let refreshInFlight: Promise<string | null> | null = null;

function canUseBrowserStorage() {
  return typeof window !== 'undefined' && isTauriRuntime();
}

function computeExpiresAt(expiresIn?: number | null): number | null {
  return expiresIn && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
}

function readDirectTokenSnapshot(): DirectTokenSnapshot {
  if (!canUseBrowserStorage()) {
    return {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    };
  }

  try {
    const accessToken = localStorage.getItem(SOUNDCLOUD_TOKEN_KEY);
    const refreshToken = localStorage.getItem(SOUNDCLOUD_REFRESH_TOKEN_KEY);
    const rawExpiresAt = localStorage.getItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY);
    const parsedExpiresAt = rawExpiresAt ? Number.parseInt(rawExpiresAt, 10) : Number.NaN;

    return {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : null,
    };
  } catch {
    return {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    };
  }
}

function persistDirectTokenSnapshot(snapshot: DirectTokenSnapshot): void {
  if (!canUseBrowserStorage()) return;

  try {
    if (snapshot.accessToken) {
      localStorage.setItem(SOUNDCLOUD_TOKEN_KEY, snapshot.accessToken);
    } else {
      localStorage.removeItem(SOUNDCLOUD_TOKEN_KEY);
    }

    if (snapshot.refreshToken) {
      localStorage.setItem(SOUNDCLOUD_REFRESH_TOKEN_KEY, snapshot.refreshToken);
    } else {
      localStorage.removeItem(SOUNDCLOUD_REFRESH_TOKEN_KEY);
    }

    if (snapshot.expiresAt && Number.isFinite(snapshot.expiresAt)) {
      localStorage.setItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY, String(snapshot.expiresAt));
    } else {
      localStorage.removeItem(SOUNDCLOUD_TOKEN_EXPIRES_KEY);
    }
  } catch (error) {
    console.warn('[DirectSoundCloudAPI] Failed to persist tokens:', error);
  }
}

function isTokenExpired(expiresAt: number | null, bufferMs = 0): boolean {
  return expiresAt != null && Date.now() + bufferMs >= expiresAt;
}

async function getDirectStoreSnapshot(): Promise<DirectTokenSnapshot> {
  const { useDirectAuthStore } = await import('../stores/direct-auth');
  const state = useDirectAuthStore.getState();

  return {
    accessToken: state.accessToken ?? readDirectTokenSnapshot().accessToken,
    refreshToken: state.refreshToken ?? readDirectTokenSnapshot().refreshToken,
    expiresAt: state.expiresAt ?? readDirectTokenSnapshot().expiresAt,
  };
}

async function applyTokensToDirectStore(tokens: DirectOAuthTokens) {
  const { useDirectAuthStore } = await import('../stores/direct-auth');
  useDirectAuthStore.getState().setTokens(
    tokens.accessToken,
    tokens.refreshToken ?? undefined,
    tokens.expiresIn ?? undefined,
  );
}

async function clearDirectStoreSession() {
  const { useDirectAuthStore } = await import('../stores/direct-auth');
  useDirectAuthStore.getState().clear();
}

async function getSoundCloudOAuthCredentials() {
  const { useSettingsStore } = await import('../stores/settings');
  const state = useSettingsStore.getState();
  const clientId = state.soundcloudClientId.trim();
  const clientSecret = state.soundcloudClientSecret.trim();

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
  };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseDirectErrorStatus(error: unknown): number | null {
  const message = extractErrorMessage(error);
  const match = message.match(/\b(401|403)\b/);
  return match ? Number(match[1]) : null;
}

export function isDirectSoundCloudAuthError(error: unknown): boolean {
  const status = parseDirectErrorStatus(error);
  if (status === 401 || status === 403) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes('invalid_grant') ||
    message.includes('invalid_client') ||
    message.includes('invalid token') ||
    message.includes('expired token') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  );
}

function isRefreshInvalidationError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    isDirectSoundCloudAuthError(error) ||
    message.includes('refresh token') ||
    message.includes('oauth token')
  );
}

export function isDirectAuthRequiredError(error: unknown): error is DirectAuthRequiredError {
  return error instanceof DirectAuthRequiredError;
}

async function invokeRefreshDirectToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<DirectOAuthTokens> {
  const tokens = await invoke<{
    access_token: string;
    refresh_token?: string | null;
    expires_in?: number | null;
  }>('soundcloud_oauth_refresh', {
    clientId,
    clientSecret,
    refreshToken,
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresIn: tokens.expires_in ?? null,
  };
}

async function refreshDirectAccessToken(
  snapshot: DirectTokenSnapshot,
  options: EnsureDirectAccessTokenOptions,
): Promise<string | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const credentials = await getSoundCloudOAuthCredentials();
    if (!credentials || !snapshot.refreshToken) {
      if (snapshot.accessToken && options.allowExpiredTokenFallback !== false) {
        return snapshot.accessToken;
      }
      return null;
    }

    try {
      const refreshed = await invokeRefreshDirectToken(
        credentials.clientId,
        credentials.clientSecret,
        snapshot.refreshToken,
      );
      await applyTokensToDirectStore(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      if (isRefreshInvalidationError(error)) {
        await clearDirectStoreSession();
        throw new DirectAuthRequiredError('Direct SoundCloud session is no longer valid');
      }

      if (snapshot.accessToken && options.allowExpiredTokenFallback !== false) {
        return snapshot.accessToken;
      }

      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function getDirectAccessToken(): string | null {
  return readDirectTokenSnapshot().accessToken;
}

export function getDirectRefreshToken(): string | null {
  return readDirectTokenSnapshot().refreshToken;
}

export function getStoredExpiry(): number | null {
  return readDirectTokenSnapshot().expiresAt;
}

export function storeDirectTokens(
  accessToken: string,
  refreshToken?: string | null,
  expiresIn?: number | null,
): void {
  persistDirectTokenSnapshot({
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: computeExpiresAt(expiresIn),
  });
}

export function storeDirectTokenSnapshot(
  accessToken: string,
  refreshToken?: string | null,
  expiresAt?: number | null,
): void {
  persistDirectTokenSnapshot({
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: expiresAt ?? null,
  });
}

export function clearDirectTokens(): void {
  persistDirectTokenSnapshot({
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  });
}

export function hasValidDirectToken(bufferMs = 0): boolean {
  const snapshot = readDirectTokenSnapshot();
  return !!snapshot.accessToken && !isTokenExpired(snapshot.expiresAt, bufferMs);
}

export async function ensureDirectAccessToken(
  options: EnsureDirectAccessTokenOptions = {},
): Promise<string | null> {
  const snapshot = await getDirectStoreSnapshot();
  const tokenExpired = isTokenExpired(snapshot.expiresAt, TOKEN_REFRESH_BUFFER_MS);

  if (!options.forceRefresh && snapshot.accessToken && !tokenExpired) {
    return snapshot.accessToken;
  }

  if (!snapshot.refreshToken) {
    if (snapshot.accessToken && options.allowExpiredTokenFallback !== false) {
      return snapshot.accessToken;
    }
    return null;
  }

  return refreshDirectAccessToken(snapshot, options);
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

async function invokeResolveTrackStream(token: string, trackId: string) {
  return invoke<{
    url: string;
    format: string;
    protocol: string;
    mime_type: string;
    quality: 'hq' | 'lq' | string;
  }>('resolve_soundcloud_track_stream', {
    trackId,
    accessToken: token,
  });
}

function normalizeResolvedTrackStream(stream: {
  url: string;
  format: string;
  protocol: string;
  mime_type: string;
  quality: 'hq' | 'lq' | string;
}): DirectResolvedTrackStream {
  return {
    url: stream.url,
    format: stream.format,
    protocol: stream.protocol,
    mimeType: stream.mime_type,
    quality: stream.quality === 'hq' ? 'hq' : 'lq',
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

  const token =
    accessTokenOverride ??
    (await ensureDirectAccessToken({
      reason: `stream:${trackId}`,
      allowExpiredTokenFallback: true,
    }));

  if (!token) {
    throw new DirectAuthRequiredError('Direct SoundCloud OAuth is required for playback');
  }

  try {
    const stream = await invokeResolveTrackStream(token, trackId);
    return normalizeResolvedTrackStream(stream);
  } catch (error) {
    if (!accessTokenOverride && isDirectSoundCloudAuthError(error)) {
      const refreshedToken = await ensureDirectAccessToken({
        forceRefresh: true,
        reason: `stream:${trackId}:retry`,
        allowExpiredTokenFallback: false,
      });

      if (refreshedToken) {
        const retriedStream = await invokeResolveTrackStream(refreshedToken, trackId);
        return normalizeResolvedTrackStream(retriedStream);
      }
    }

    throw error;
  }
}

export async function fetchDirectSoundCloudMe(
  accessTokenOverride?: string | null,
): Promise<DirectSoundCloudUserInfo> {
  if (!isTauriRuntime()) {
    throw new Error('Direct SoundCloud API requires Tauri runtime');
  }

  const token =
    accessTokenOverride ??
    (await ensureDirectAccessToken({
      reason: 'me',
      allowExpiredTokenFallback: true,
    }));

  if (!token) {
    throw new DirectAuthRequiredError('Direct SoundCloud session is not available');
  }

  try {
    return await invoke<DirectSoundCloudUserInfo>('fetch_soundcloud_me', {
      accessToken: token,
    });
  } catch (error) {
    if (!accessTokenOverride && isDirectSoundCloudAuthError(error)) {
      const refreshedToken = await ensureDirectAccessToken({
        forceRefresh: true,
        reason: 'me:retry',
        allowExpiredTokenFallback: false,
      });

      if (!refreshedToken) {
        throw new DirectAuthRequiredError('Direct SoundCloud session is no longer valid');
      }

      try {
        return await invoke<DirectSoundCloudUserInfo>('fetch_soundcloud_me', {
          accessToken: refreshedToken,
        });
      } catch (retryError) {
        if (isDirectSoundCloudAuthError(retryError)) {
          throw new DirectAuthRequiredError('Direct SoundCloud session is no longer valid');
        }
        throw retryError;
      }
    }

    throw error;
  }
}

export async function startDirectOAuthFlow(
  clientId: string,
  clientSecret: string,
  locale: string,
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
    locale,
  });

  const normalized: DirectOAuthTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn: tokens.expires_in ?? null,
  };

  storeDirectTokens(normalized.accessToken, normalized.refreshToken, normalized.expiresIn);
  return normalized;
}
