import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { toast } from 'sonner';
import i18n from '../i18n';
import { useAppStatusStore } from '../stores/app-status';
import { waitForAuthHydration } from './auth-hydration';
import { buildApiUrl } from './constants';
import { useAuthStore } from '../stores/auth';
import { isTauriRuntime } from './runtime';

let sessionId: string | null = null;
let rateLimitUntil = 0;
let rateLimitToastAt = 0;
let sessionExpiredToastAt = 0;
let sessionExpiredHandler: (() => void) | null = null;
let unauthorizedHandler: (() => void) | null = null;
let sessionInvalidated = false;
let lastUnauthorizedAt = 0;
let lastServerErrorToastAt = 0;

const SERVER_ERROR_TOAST_COOLDOWN_MS = 10000;
const UNAUTHORIZED_COOLDOWN_MS = 60_000; // increased to 60s to reduce re-login spam
const RATE_LIMIT_FALLBACK_MS = 3000;
const RATE_LIMIT_TOAST_COOLDOWN_MS = 15000;
const SESSION_EXPIRED_TOAST_COOLDOWN_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const SOUNDCLOUD_DIRECT_API_BASE = 'https://api.soundcloud.com';
const DIRECT_API_SUPPORTED_PREFIXES = [
  '/me',
  '/tracks',
  '/playlists',
  '/users',
  '/resolve',
  '/likes',
  '/reposts',
];
const DIRECT_API_UNSUPPORTED_PREFIXES = ['/auth', '/oauth-apps'];
const LOCAL_HISTORY_STORAGE_KEY = 'sc-local-history-v1';
const LOCAL_HISTORY_MAX_ENTRIES = 500;
const DIRECT_NO_MATCH = Symbol('direct-no-match');

const inflightRequests = new Map<string, Promise<unknown>>();

type DirectRequestContext = {
  accessToken: string;
  timeoutMs: number;
};

type LocalHistoryEntry = {
  id: string;
  scTrackId: string;
  title: string;
  artistName: string;
  artworkUrl: string | null;
  duration: number;
  playedAt: string;
};

type DirectTrackLike = {
  id?: number | string | null;
  urn?: string | null;
  likes_count?: number | null;
};

type DirectTrackCollection = {
  collection?: DirectTrackLike[];
  next_href?: string | null;
};

type DirectPlaylistLike = {
  id?: number | string | null;
  urn?: string | null;
};

type DirectPlaylistCollection = {
  collection?: DirectPlaylistLike[];
  next_href?: string | null;
};

type DirectFeedItem = {
  origin?: DirectTrackLike | null;
};

type DirectFeedCollection = {
  collection?: DirectFeedItem[];
  next_href?: string | null;
};

type DirectRecommendResult = {
  id: string;
  score?: number;
  payload?: Record<string, unknown>;
};

type DirectRecord = Record<string, unknown>;

type ArtistInsightSource = 'spotify' | 'yandex_music';

type ArtistInsightPlatform = {
  source: ArtistInsightSource;
  label: string;
  matchedName: string;
  url: string | null;
  audience: number | null;
};

type UserArtistInsights = {
  estimatedMonthlyPlays: number | null;
  platforms: ArtistInsightPlatform[];
  similarArtists: unknown[];
};

type ExternalHttpResponse = {
  status: number;
  content_type?: string;
  body: string;
};

async function tryInvokeExternalHttpGet(
  url: string,
  accept: string,
): Promise<ExternalHttpResponse | null> {
  try {
    return await invoke<ExternalHttpResponse>('external_http_get', {
      url,
      accept,
    });
  } catch (error) {
    console.log('[artist-insights][external-http][invoke-failed]', {
      url,
      accept,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type ExternalWebProfile = {
  url?: string;
  title?: string | null;
  username?: string | null;
  service?: string | null;
};

type ExternalUserProfile = {
  username?: string;
  full_name?: string | null;
  permalink?: string | null;
  website?: string | null;
  website_title?: string | null;
};

type ExternalArtistTrack = {
  title?: string | null;
  metadata_artist?: string | null;
  playback_count?: number | null;
};

type ExternalTrackCollection = {
  collection?: ExternalArtistTrack[];
};

type YandexMusicArtistSearchResponse = {
  result?: {
    artists?: {
      results?: Array<{
        id?: number | string;
        name?: string;
        likesCount?: number;
        ratings?: {
          month?: number;
        };
      }>;
    };
  };
};

type YandexMusicArtistBriefInfoResponse = {
  result?: {
    artist?: {
      id?: number | string;
      name?: string;
    };
    stats?: {
      lastMonthListeners?: number;
    };
  };
};

function asDirectRecord(value: unknown): DirectRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as DirectRecord)
    : null;
}

function normalizeArtistText(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeArtistText(value: string | null | undefined): string[] {
  return normalizeArtistText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function computeArtistMatchScore(query: string, candidate: string): number {
  const normalizedQuery = normalizeArtistText(query);
  const normalizedCandidate = normalizeArtistText(candidate);

  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 1;

  if (
    normalizedQuery.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedQuery)
  ) {
    return 0.9;
  }

  const queryTokens = new Set(tokenizeArtistText(normalizedQuery));
  const candidateTokens = new Set(tokenizeArtistText(normalizedCandidate));

  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(queryTokens.size, candidateTokens.size);
}

function roundAudience(value: number | null | undefined): number | null {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
}

function parseCompactAudience(value: string | null | undefined): number | null {
  const normalized = String(value || '')
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .trim();

  if (!normalized) return null;

  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) {
    const digitsOnly = normalized.replace(/[^\d]/g, '');
    return digitsOnly ? roundAudience(Number(digitsOnly)) : null;
  }

  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;

  const multiplier =
    match[2]?.toUpperCase() === 'B'
      ? 1_000_000_000
      : match[2]?.toUpperCase() === 'M'
        ? 1_000_000
        : match[2]?.toUpperCase() === 'K'
          ? 1_000
          : 1;

  return roundAudience(base * multiplier);
}

function extractMonthlyAudienceSnippet(
  html: string,
  label: 'monthly listeners' | 'monthly audience',
): number | null {
  const normalized = html.replace(/&#x27;/g, "'");
  const match = normalized.match(
    new RegExp(`(\\d[\\d.,]*\\s*[KMB]?)\\s+${label.replace(' ', '\\s+')}`, 'i'),
  );
  return parseCompactAudience(match?.[1] || null);
}

function extractYandexArtistIdsFromSearchHtml(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/\/artist\/(\d+)/g)]
        .map((match) => match[1] || '')
        .filter(Boolean),
    ),
  ];
}

function extractYandexArtistNameFromHtml(html: string): string | null {
  const ogTitleMatch = html.match(/og:title"\s+content="([^"]+)"/i);
  if (ogTitleMatch?.[1]) {
    return decodeHtmlEntities(ogTitleMatch[1]).trim();
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleMatch?.[1]) return null;

  const decoded = decodeHtmlEntities(titleMatch[1]).trim();
  return decoded.split(/\s*[\u2013\u2014-]\s*/)[0]?.trim() || null;
}

function extractYandexArtistAudienceFromHtml(html: string): number | null {
  const match = html.match(/"lastMonthListeners"\s*:\s*(\d+)/);
  return roundAudience(match ? Number(match[1]) : null);
}

type YandexHtmlArtistMatch = {
  artistId: string;
  matchedName: string;
  audience: number | null;
  url: string;
};

function isYandexArtistNameCompatible(artistNames: string[], candidateName: string): boolean {
  const normalizedCandidate = normalizeArtistText(candidateName);
  if (!normalizedCandidate) return false;

  return artistNames.some((artistName) => {
    const normalizedArtistName = normalizeArtistText(artistName);
    return (
      normalizedArtistName === normalizedCandidate ||
      normalizedArtistName.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedArtistName)
    );
  });
}

async function fetchYandexArtistHtmlMatch(url: string): Promise<YandexHtmlArtistMatch | null> {
  const html = await fetchExternalText(url);
  if (!html) return null;

  const artistId = extractArtistIdFromUrl(url);
  if (!artistId) return null;

  return {
    artistId,
    matchedName: extractYandexArtistNameFromHtml(html) || artistId,
    audience: extractYandexArtistAudienceFromHtml(html),
    url,
  };
}

async function resolveYandexHtmlFallback(
  artistNames: string[],
  profileUrl: string | null,
  artistId: string | null,
): Promise<YandexHtmlArtistMatch | null> {
  const candidateUrls: string[] = [];
  const seenIds = new Set<string>();

  const pushArtistUrl = (url: string | null | undefined) => {
    const candidateId = extractArtistIdFromUrl(url);
    if (!candidateId || seenIds.has(candidateId)) return;
    seenIds.add(candidateId);
    candidateUrls.push(`https://music.yandex.ru/artist/${candidateId}`);
  };

  pushArtistUrl(profileUrl);
  if (artistId) {
    pushArtistUrl(`https://music.yandex.ru/artist/${artistId}`);
  }

  const searchQueries = [
    ...new Set([
      ...artistNames.map((artistName) => artistName.trim()).filter(Boolean),
      ...artistNames.flatMap((artistName) => getArtistSearchVariants(artistName)),
    ]),
  ].slice(0, 6);

  for (const query of searchQueries) {
    const html = await fetchExternalText(
      `https://music.yandex.ru/search?type=artists&text=${encodeURIComponent(query)}`,
    );
    if (!html) continue;

    for (const candidateId of extractYandexArtistIdsFromSearchHtml(html).slice(0, 6)) {
      pushArtistUrl(`https://music.yandex.ru/artist/${candidateId}`);
    }

    if (candidateUrls.length >= 6) break;
  }

  if (candidateUrls.length === 0) return null;

  const matches = (
    await Promise.all(candidateUrls.slice(0, 6).map((url) => fetchYandexArtistHtmlMatch(url)))
  ).filter((match): match is YandexHtmlArtistMatch => Boolean(match));

  if (matches.length === 0) return null;

  const scoredMatches = matches.map((match) => ({
    match,
    score: Math.max(
      ...artistNames.map((artistName) => computeArtistMatchScore(artistName, match.matchedName)),
    ),
  }));

  return (
    scoredMatches
      .filter(
        ({ match, score }) =>
          score >= 0.45 || isYandexArtistNameCompatible(artistNames, match.matchedName),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.match.audience || 0) - Number(a.match.audience || 0),
      )[0]?.match || null
  );
}

function extractPlatformUrl(
  profiles: ExternalWebProfile[],
  predicates: Array<(url: URL) => boolean>,
): string | null {
  for (const profile of profiles) {
    try {
      const url = new URL(profile.url || '');
      if (predicates.some((predicate) => predicate(url))) return profile.url || null;
    } catch {}
  }
  return null;
}

function extractArtistIdFromUrl(url: string | null | undefined): string | null {
  const match = String(url || '').match(/\/artist\/(\d+)/);
  return match?.[1] || null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function transliterateCyrillicToLatin(value: string): string {
  return Array.from(String(value || ''))
    .map((char) => {
      const lower = char.toLowerCase();
      const mapped = CYRILLIC_TO_LATIN_MAP[lower];
      if (mapped == null) return char;
      return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('');
}

function getArtistSearchVariants(value: string): string[] {
  const source = String(value || '').trim();
  const normalizedSource = normalizeArtistText(source);
  const variants = new Set<string>();
  const push = (candidate: string) => {
    const normalized = candidate.trim().replace(/\s+/g, ' ');
    if (normalized) variants.add(normalized);
  };

  const bases = new Set([source, source.replace(/ё/gi, 'е')]);
  if (normalizedSource) {
    bases.add(normalizedSource);
    bases.add(normalizedSource.replace(/ё/gi, 'е'));
  }

  for (const base of bases) {
    push(base);

    const transliterated = transliterateCyrillicToLatin(base);
    push(transliterated);
    push(transliterated.replace(/yo/gi, 'e'));
    push(transliterated.replace(/yy/gi, 'y'));
    push(transliterated.replace(/yy/gi, 'i'));
    push(transliterated.replace(/yo/gi, 'e').replace(/yy/gi, 'y'));
    push(transliterated.replace(/yo/gi, 'e').replace(/yy/gi, 'i'));
  }

  return [...variants];
}

const GENERIC_PROFILE_LABELS = new Set([
  'tg',
  'telegram',
  'youtube',
  'instagram',
  'tiktok',
  'tour',
  'website',
  'site',
  'link',
]);

function pushArtistNameCandidate(target: Set<string>, value: string | null | undefined) {
  const candidate = String(value || '').trim();
  if (!candidate) return;
  target.add(candidate);
}

function splitArtistCredits(value: string | null | undefined): string[] {
  return String(value || '')
    .split(/\s*(?:,|&|\+|\/|;|\|| feat\.? | ft\.? | featuring | x )\s*/i)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length >= 2);
}

function appendUrlArtistCandidates(target: Set<string>, rawUrl: string | null | undefined) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const ignoredHostSegments = new Set([
      'www',
      'm',
      'music',
      'open',
      'soundcloud',
      'spotify',
      'youtube',
      'youtu',
      'instagram',
      'tiktok',
      'telegram',
      'twitter',
      'x',
      't',
      'me',
      'ru',
      'com',
      'net',
      'org',
    ]);
    const hostCandidate = url.hostname
      .split('.')
      .map((segment) => segment.toLowerCase())
      .find((segment) => segment && !ignoredHostSegments.has(segment));

    if (hostCandidate) {
      pushArtistNameCandidate(target, hostCandidate.replace(/[-_.]+/g, ' '));
    }

    const pathCandidates = url.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .map((segment) => segment.replace(/^@/, '').trim())
      .filter(Boolean)
      .filter((segment) => !['artist', 'channel', 'user', 'users'].includes(segment.toLowerCase()))
      .slice(-2);

    for (const segment of pathCandidates) {
      pushArtistNameCandidate(target, segment.replace(/[-_.]+/g, ' '));
    }
  } catch {}
}

function collectArtistInsightNames(
  user: ExternalUserProfile | null | undefined,
  profiles: ExternalWebProfile[],
  tracks: ExternalArtistTrack[] = [],
): string[] {
  const candidates = new Set<string>();

  pushArtistNameCandidate(candidates, user?.username);
  pushArtistNameCandidate(candidates, user?.full_name);
  pushArtistNameCandidate(candidates, String(user?.permalink || '').replace(/[-_.]+/g, ' '));

  const normalizedWebsiteTitle = normalizeArtistText(user?.website_title);
  if (normalizedWebsiteTitle && !GENERIC_PROFILE_LABELS.has(normalizedWebsiteTitle)) {
    pushArtistNameCandidate(candidates, user?.website_title);
  }
  appendUrlArtistCandidates(candidates, user?.website);

  for (const profile of profiles) {
    const normalizedTitle = normalizeArtistText(profile.title);
    if (normalizedTitle && !GENERIC_PROFILE_LABELS.has(normalizedTitle)) {
      pushArtistNameCandidate(candidates, profile.title);
    }
    pushArtistNameCandidate(candidates, profile.username);
    appendUrlArtistCandidates(candidates, profile.url);
  }

  const prioritizedTracks = [...tracks]
    .sort((a, b) => (b.playback_count ?? 0) - (a.playback_count ?? 0))
    .slice(0, 8);

  for (const track of prioritizedTracks) {
    pushArtistNameCandidate(candidates, track.metadata_artist);
    for (const credit of splitArtistCredits(track.metadata_artist)) {
      pushArtistNameCandidate(candidates, credit);
    }
  }

  return [...candidates];
}

function prioritizeArtistNames(
  primaryName: string | null | undefined,
  extraNames: string[],
): string[] {
  const result = new Set<string>();
  const normalizedSeen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const candidate = String(value || '').trim();
    if (!candidate) return;
    const normalized = normalizeArtistText(candidate);
    if (!normalized || normalizedSeen.has(normalized)) return;
    normalizedSeen.add(normalized);
    result.add(candidate);
  };

  push(primaryName);
  for (const name of extraNames) {
    push(name);
  }

  return [...result];
}

function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function toNumericId(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function buildFallbackUrn(kind: 'tracks' | 'playlists' | 'users', value: unknown): string | null {
  const id = toNumericId(value);
  return id ? `soundcloud:${kind}:${id}` : null;
}

function unwrapTrackEntity(value: unknown): DirectRecord | null {
  const record = asDirectRecord(value);
  if (!record) return null;

  const nestedTrack = asDirectRecord(record.track);
  if (nestedTrack) {
    return unwrapTrackEntity(nestedTrack);
  }

  if (record.kind === 'playlist' || record.kind === 'system-playlist') {
    return null;
  }

  if (
    record.kind === 'track' ||
    record.stream_url != null ||
    record.media != null ||
    (record.duration != null && record.track_count == null && !Array.isArray(record.tracks))
  ) {
    return record;
  }

  return null;
}

function unwrapPlaylistEntity(value: unknown): DirectRecord | null {
  const record = asDirectRecord(value);
  if (!record) return null;

  const nestedPlaylist = asDirectRecord(record.playlist);
  if (nestedPlaylist) {
    return unwrapPlaylistEntity(nestedPlaylist);
  }

  if (
    record.kind === 'playlist' ||
    record.kind === 'system-playlist' ||
    record.track_count != null ||
    Array.isArray(record.tracks)
  ) {
    return record;
  }

  return null;
}

function unwrapUserEntity(value: unknown): DirectRecord | null {
  const record = asDirectRecord(value);
  if (!record) return null;

  const nestedUser = asDirectRecord(record.user);
  if (nestedUser) {
    return unwrapUserEntity(nestedUser);
  }

  if (
    typeof record.urn === 'string' ||
    typeof record.username === 'string' ||
    record.permalink_url != null ||
    record.followers_count != null
  ) {
    return record;
  }

  return null;
}

function normalizeUserEntity<T = DirectRecord>(value: unknown): T | null {
  const user = unwrapUserEntity(value);
  if (!user) return null;

  const fallbackUrn = buildFallbackUrn('users', user.id);
  const permalink =
    typeof user.permalink === 'string' && user.permalink.trim()
      ? user.permalink.trim()
      : null;
  const permalinkUrl =
    typeof user.permalink_url === 'string' && user.permalink_url.trim()
      ? user.permalink_url
      : permalink
        ? `https://soundcloud.com/${permalink}`
        : user.permalink_url;

  return {
    ...user,
    urn:
      typeof user.urn === 'string' && user.urn.trim()
        ? user.urn
        : fallbackUrn ?? user.urn,
    permalink_url: permalinkUrl,
  } as T;
}

function normalizeTrackEntity<T = DirectRecord>(
  value: unknown,
  options: { liked?: boolean } = {},
): T | null {
  const track = unwrapTrackEntity(value);
  if (!track) return null;

  const fallbackUrn = buildFallbackUrn('tracks', track.id);
  const user = normalizeUserEntity(track.user);

  return {
    ...track,
    urn:
      typeof track.urn === 'string' && track.urn.trim()
        ? track.urn
        : fallbackUrn ?? track.urn,
    uri:
      typeof track.uri === 'string' && track.uri.trim()
        ? track.uri
        : fallbackUrn
          ? `https://api.soundcloud.com/tracks/${encodeURIComponent(fallbackUrn)}`
          : track.uri,
    user: user ?? track.user,
    user_favorite: options.liked ? true : track.user_favorite,
  } as T;
}

function normalizePlaylistEntity<T = DirectRecord>(
  value: unknown,
  options: { liked?: boolean } = {},
): T | null {
  const playlist = unwrapPlaylistEntity(value);
  if (!playlist) return null;

  const fallbackUrn = buildFallbackUrn('playlists', playlist.id);
  const user = normalizeUserEntity(playlist.user);
  const tracks = Array.isArray(playlist.tracks)
    ? playlist.tracks
        .map((track) => normalizeTrackEntity(track))
        .filter((track): track is DirectRecord => track !== null)
    : playlist.tracks;

  return {
    ...playlist,
    urn:
      typeof playlist.urn === 'string' && playlist.urn.trim()
        ? playlist.urn
        : fallbackUrn ?? playlist.urn,
    uri:
      typeof playlist.uri === 'string' && playlist.uri.trim()
        ? playlist.uri
        : fallbackUrn
          ? `https://api.soundcloud.com/playlists/${encodeURIComponent(fallbackUrn)}`
          : playlist.uri,
    user: user ?? playlist.user,
    tracks,
    user_favorite: options.liked ? true : playlist.user_favorite,
  } as T;
}

function normalizeCommentEntity<T = DirectRecord>(value: unknown): T | null {
  const comment = asDirectRecord(value);
  if (!comment) return null;

  const user = normalizeUserEntity(comment.user);

  return {
    ...comment,
    user: user ?? comment.user,
  } as T;
}

function normalizeCollectionResponse<T extends DirectRecord>(
  value: unknown,
  normalizeEntry: (entry: unknown) => DirectRecord | null,
): T {
  const source = asDirectRecord(value);
  const rawCollection = Array.isArray(value)
    ? value
    : Array.isArray(source?.collection)
      ? source.collection
      : [];
  const collection = rawCollection
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is DirectRecord => entry !== null);

  return {
    ...(source ?? {}),
    collection,
    next_href: typeof source?.next_href === 'string' ? source.next_href : null,
  } as unknown as T;
}

function normalizeFeedItem(value: unknown): DirectRecord | null {
  const item = asDirectRecord(value);
  if (!item) return null;

  const origin =
    normalizeTrackEntity(item.origin) ??
    normalizePlaylistEntity(item.origin) ??
    normalizeTrackEntity(item.track) ??
    normalizePlaylistEntity(item.playlist);

  if (!origin) {
    return null;
  }

  return {
    ...item,
    origin,
  };
}

function normalizeDirectResponse(path: string, value: unknown): unknown {
  let pathname = path.split('?')[0] || path;

  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      pathname = new URL(path).pathname;
    } catch {}
  }

  const pathSegments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (pathSegments.length === 0 || value == null) {
    return value;
  }

  if (pathSegments[0] === 'history' || pathSegments[0] === 'recommendations') {
    return value;
  }

  if (pathSegments[0] === 'me') {
    if (pathSegments.length === 1) {
      return normalizeUserEntity(value) ?? value;
    }

    if (pathSegments[1] === 'feed') {
      return normalizeCollectionResponse(value, normalizeFeedItem);
    }

    if (pathSegments[1] === 'likes' && pathSegments[2] === 'tracks') {
      return normalizeCollectionResponse(value, (entry) => normalizeTrackEntity(entry, { liked: true }));
    }

    if (pathSegments[1] === 'likes' && pathSegments[2] === 'playlists') {
      return normalizeCollectionResponse(value, (entry) =>
        normalizePlaylistEntity(entry, { liked: true }),
      );
    }

    if (pathSegments[1] === 'followings' && pathSegments[2] === 'tracks') {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }

    if (pathSegments[1] === 'followings' || pathSegments[1] === 'followers') {
      return normalizeCollectionResponse(value, normalizeUserEntity);
    }

    if (pathSegments[1] === 'playlists') {
      return normalizeCollectionResponse(value, normalizePlaylistEntity);
    }

    if (pathSegments[1] === 'tracks') {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }
  }

  if (pathSegments[0] === 'users') {
    if (pathSegments.length === 1) {
      return normalizeCollectionResponse(value, normalizeUserEntity);
    }

    if (pathSegments.length === 2) {
      return normalizeUserEntity(value) ?? value;
    }

    if (pathSegments[2] === 'tracks' || (pathSegments[2] === 'likes' && pathSegments[3] === 'tracks')) {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }

    if (pathSegments[2] === 'playlists') {
      return normalizeCollectionResponse(value, normalizePlaylistEntity);
    }

    if (pathSegments[2] === 'followings' || pathSegments[2] === 'followers') {
      return normalizeCollectionResponse(value, normalizeUserEntity);
    }
  }

  if (pathSegments[0] === 'playlists') {
    if (pathSegments.length === 1) {
      return normalizeCollectionResponse(value, normalizePlaylistEntity);
    }

    if (pathSegments[2] === 'tracks') {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }

    return normalizePlaylistEntity(value) ?? value;
  }

  if (pathSegments[0] === 'tracks') {
    if (pathSegments.length === 1) {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }

    if (pathSegments[2] === 'comments') {
      return normalizeCollectionResponse(value, normalizeCommentEntity);
    }

    if (pathSegments[2] === 'related') {
      return normalizeCollectionResponse(value, normalizeTrackEntity);
    }

    if (pathSegments[2] === 'reposters' || pathSegments[2] === 'favoriters') {
      return normalizeCollectionResponse(value, normalizeUserEntity);
    }

    return normalizeTrackEntity(value) ?? value;
  }

  return value;
}

function shouldSetJsonContentType(body: BodyInit | null | undefined): boolean {
  if (!body) return false;
  if (
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  ) {
    return false;
  }

  return true;
}

function splitPathAndSearch(path: string) {
  const [pathname = path, search = ''] = path.split('?');
  return {
    pathname: pathname || '/',
    searchParams: new URLSearchParams(search),
  };
}

function buildPath(pathSegments: string[], searchParams?: URLSearchParams) {
  const pathname = `/${pathSegments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  const query = searchParams?.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function ensureDefaultSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: string,
) {
  if (!searchParams.has(key)) {
    searchParams.set(key, value);
  }
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeResourceRef(resourceRef: string, kind: 'tracks' | 'playlists' | 'users') {
  const raw = decodeURIComponent(resourceRef).trim();

  if (/^\d+$/.test(raw)) {
    return {
      raw,
      id: raw,
      urn: `soundcloud:${kind}:${raw}`,
    };
  }

  const match = raw.match(new RegExp(`^soundcloud:${kind}:(\\d+)$`, 'i'));
  if (match) {
    return {
      raw,
      id: match[1],
      urn: `soundcloud:${kind}:${match[1]}`,
    };
  }

  return {
    raw,
    id: null,
    urn: raw,
  };
}

function requireResourceId(resourceRef: string, kind: 'tracks' | 'playlists' | 'users') {
  const normalized = normalizeResourceRef(resourceRef, kind);
  if (!normalized.id) {
    throw new Error(`Invalid SoundCloud ${kind.slice(0, -1)} reference: ${resourceRef}`);
  }
  return normalized.id;
}

function buildNormalizedResourcePath(
  kind: 'tracks' | 'playlists' | 'users',
  resourceRef: string,
  tailSegments: string[] = [],
  searchParams?: URLSearchParams,
) {
  const normalized = normalizeResourceRef(resourceRef, kind);
  return buildPath([kind, normalized.id ?? normalized.raw, ...tailSegments], searchParams);
}

function extractDirectTrackId(track: DirectTrackLike | null | undefined): string | null {
  if (!track) return null;

  if (track.id != null) {
    const value = String(track.id).trim();
    if (/^\d+$/.test(value)) {
      return value;
    }
  }

  if (track.urn) {
    return normalizeResourceRef(track.urn, 'tracks').id;
  }

  return null;
}

function toRecommendResults(tracks: DirectTrackLike[], limit: number): DirectRecommendResult[] {
  const seen = new Set<string>();
  const results: DirectRecommendResult[] = [];

  for (const track of tracks) {
    const id = extractDirectTrackId(track);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    results.push({ id });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function readLocalHistory(): LocalHistoryEntry[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is LocalHistoryEntry => {
      return (
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.scTrackId === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.artistName === 'string' &&
        typeof entry.playedAt === 'string'
      );
    });
  } catch {
    return [];
  }
}

function writeLocalHistory(entries: LocalHistoryEntry[]) {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(
      LOCAL_HISTORY_STORAGE_KEY,
      JSON.stringify(entries.slice(0, LOCAL_HISTORY_MAX_ENTRIES)),
    );
  } catch {}
}

function createHistoryEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function setSessionId(id: string | null) {
  sessionId = id;

  if (id) {
    sessionInvalidated = false;
  }
}

export function getSessionId() {
  return sessionId;
}

export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function requestWithFallback(input: string, init: RequestInit): Promise<Response> {
  if (!isTauriRuntime()) {
    return await fetch(input, init);
  }

  try {
    return await tauriFetch(input, init);
  } catch {
    return await fetch(input, init);
  }
}

function isDirectApiPathSupported(path: string): boolean {
  const pathname = path.split('?')[0] || path;
  if (!pathname.startsWith('/')) return false;

  if (
    DIRECT_API_UNSUPPORTED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return false;
  }

  return DIRECT_API_SUPPORTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function buildDirectApiUrl(path: string): string {
  return path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${SOUNDCLOUD_DIRECT_API_BASE}${path}`;
}

function createTimedSignal(sourceSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();

  const forwardAbort = () => controller.abort();

  if (sourceSignal) {
    if (sourceSignal.aborted) {
      controller.abort();
    } else {
      sourceSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);

      if (sourceSignal) {
        sourceSignal.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;

  const secs = Number(header);

  if (Number.isFinite(secs) && secs > 0) {
    return Math.floor(secs * 1000);
  }

  const dateTs = Date.parse(header);

  if (!Number.isNaN(dateTs)) {
    const diff = dateTs - Date.now();
    return diff > 0 ? diff : null;
  }

  return null;
}

async function waitForRateLimitWindow() {
  const waitMs = rateLimitUntil - Date.now();

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function applyRateLimitWindow(retryAfterMs: number | null) {
  const waitMs =
    Math.max(retryAfterMs ?? RATE_LIMIT_FALLBACK_MS, 500) +
    Math.random() * 700;

  const until = Date.now() + waitMs;

  if (until > rateLimitUntil) {
    rateLimitUntil = until;
  }

  if (Date.now() - rateLimitToastAt > RATE_LIMIT_TOAST_COOLDOWN_MS) {
    rateLimitToastAt = Date.now();
    toast.error('Too many requests, slowing down');
  }
}

function showSessionExpiredToast() {
  if (Date.now() - sessionExpiredToastAt <= SESSION_EXPIRED_TOAST_COOLDOWN_MS) {
    return;
  }

  sessionExpiredToastAt = Date.now();

  toast.error(i18n.t('auth.sessionExpired'), {
    action: {
      label: i18n.t('auth.reloginNow'),
      onClick: () => sessionExpiredHandler?.(),
    },
  });
}

function handleUnauthorized() {
  const now = Date.now();

  if (now - lastUnauthorizedAt < UNAUTHORIZED_COOLDOWN_MS) {
    return false;
  }

  lastUnauthorizedAt = now;

  if (sessionInvalidated) {
    return false;
  }

  sessionInvalidated = true;

  setTimeout(() => {
    sessionInvalidated = false;
  }, UNAUTHORIZED_COOLDOWN_MS);

  unauthorizedHandler?.();

  return true;
}

async function performDirectHttpRequest(
  input: string,
  requestOptions: RequestInit,
  ctx: DirectRequestContext,
): Promise<Response> {
  const headers = new Headers(requestOptions.headers);
  headers.set('Authorization', `OAuth ${ctx.accessToken}`);
  headers.set('Accept', 'application/json; charset=utf-8');

  if (!headers.has('Content-Type') && shouldSetJsonContentType(requestOptions.body)) {
    headers.set('Content-Type', 'application/json');
  }

  const timed = createTimedSignal(requestOptions.signal, ctx.timeoutMs);

  try {
    const response = await requestWithFallback(input, {
      ...requestOptions,
      headers,
      signal: timed.signal,
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const body = await response.text();

      if (response.status === 429) {
        applyRateLimitWindow(retryAfterMs);
      }

      throw new ApiError(response.status, body, retryAfterMs);
    }

    useAppStatusStore.getState().setSoundcloudBlocked(false);
    return response;
  } finally {
    timed.cleanup();
  }
}

async function parseResponseBody<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type');

  if (contentType?.includes('application/json')) {
    return response.json();
  }

  return (await response.text()) as T;
}

async function requestDirectPath<T>(
  path: string,
  requestOptions: RequestInit,
  ctx: DirectRequestContext,
): Promise<T> {
  const response = await performDirectHttpRequest(buildDirectApiUrl(path), requestOptions, ctx);
  const parsed = await parseResponseBody<unknown>(response);
  return normalizeDirectResponse(path, parsed) as T;
}

async function fetchExternalJson<T>(url: string): Promise<T | null> {
  const invokedResponse = await tryInvokeExternalHttpGet(url, 'application/json');
  if (invokedResponse) {
    if (invokedResponse.status < 200 || invokedResponse.status >= 300) {
      console.log('[artist-insights][external-json][non-ok]', {
        url,
        status: invokedResponse.status,
      });
      return null;
    }

    try {
      return JSON.parse(invokedResponse.body) as T;
    } catch (error) {
      console.log('[artist-insights][external-json][parse-failed]', {
        url,
        error: error instanceof Error ? error.message : String(error),
        bodyPreview: invokedResponse.body.slice(0, 240),
      });
      return null;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      console.log('[artist-insights][external-json][fetch-non-ok]', {
        url,
        status: response.status,
      });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.log('[artist-insights][external-json][fetch-failed]', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchExternalText(url: string): Promise<string | null> {
  const accept =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  const invokedResponse = await tryInvokeExternalHttpGet(url, accept);
  if (invokedResponse) {
    if (invokedResponse.status < 200 || invokedResponse.status >= 300) {
      console.log('[artist-insights][external-text][non-ok]', {
        url,
        status: invokedResponse.status,
      });
      return null;
    }

    return invokedResponse.body;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      console.log('[artist-insights][external-text][fetch-non-ok]', {
        url,
        status: response.status,
      });
      return null;
    }
    return await response.text();
  } catch (error) {
    console.log('[artist-insights][external-text][fetch-failed]', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseBingRssResults(xml: string): SearchResult[] {
  return [...xml.matchAll(/<item><title>([\s\S]*?)<\/title><link>([\s\S]*?)<\/link><description>([\s\S]*?)<\/description>/g)]
    .map((match) => ({
      title: decodeHtmlEntities(match[1] || '').trim(),
      url: decodeHtmlEntities(match[2] || '').trim(),
      snippet: decodeHtmlEntities(match[3] || '').trim(),
    }))
    .filter((result) => result.url.startsWith('http'));
}

async function searchBing(query: string): Promise<SearchResult[]> {
  const xml = await fetchExternalText(
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
  );
  return xml ? parseBingRssResults(xml) : [];
}

function buildPlatformSearchVariants(artistNames: string[]): string[] {
  const seeds = artistNames
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 2);

  return [...new Set(seeds.flatMap((name) => getArtistSearchVariants(name)))].slice(0, 6);
}

function pickBestPlatformSearchResultByAudience(
  results: SearchResult[],
  artistNames: string[],
  domainHint: string,
  extractAudience: (result: SearchResult) => number | null,
): { audience: number | null; result: SearchResult } | null {
  return (
    [...results]
      .filter((result) => result.url.includes(domainHint))
      .map((result) => ({
        audience: extractAudience(result),
        result,
        score: Math.max(
          ...artistNames.map((artistName) =>
            computeArtistMatchScore(
              artistName,
              `${result.title} ${result.snippet} ${result.url}`,
            ),
          ),
        ),
      }))
      .filter((entry) => entry.score >= 0.45)
      .sort(
        (a, b) =>
          Number(b.audience || 0) - Number(a.audience || 0) ||
          b.score - a.score,
      )[0] || null
  );
}

async function fetchSpotifyPlatform(
  artistNames: string[],
  profiles: ExternalWebProfile[],
): Promise<ArtistInsightPlatform | null> {
  const profileUrl = extractPlatformUrl(profiles, [
    (url) => url.hostname.includes('spotify.com') && url.pathname.includes('/artist/'),
  ]);
  const normalizedArtistNames = artistNames.map((name) => name.trim()).filter(Boolean);
  const primaryArtistName = normalizedArtistNames[0] || '';
  if (!primaryArtistName) return null;

  const searchQueries = buildPlatformSearchVariants(normalizedArtistNames).map((artistName) =>
    `site:open.spotify.com/artist "${artistName}" "monthly listeners"`,
  );
  const searchResults = (
    await Promise.all(searchQueries.map((query) => searchBing(query)))
  ).flat();
  const match = pickBestPlatformSearchResultByAudience(
    searchResults,
    normalizedArtistNames,
    'open.spotify.com/artist/',
    (result) =>
      extractMonthlyAudienceSnippet(result.snippet || '', 'monthly listeners') ??
      extractMonthlyAudienceSnippet(result.title || '', 'monthly listeners'),
  );
  const audience = match?.audience ?? null;
  const url = profileUrl || match?.result.url || null;

  console.log('[artist-insights][spotify]', {
    artistNames: normalizedArtistNames,
    profileUrl,
    searchResultsCount: searchResults.length,
    matchedUrl: match?.result.url ?? null,
    audience,
    url,
  });

  if (!audience && !url) return null;

  return {
    source: 'spotify',
    label: 'Spotify',
    matchedName: primaryArtistName,
    url,
    audience,
  };
}

async function fetchYandexMusicPlatform(
  artistNames: string[],
  profiles: ExternalWebProfile[],
): Promise<ArtistInsightPlatform | null> {
  const normalizedArtistNames = artistNames.map((name) => name.trim()).filter(Boolean);
  const primaryArtistName = normalizedArtistNames[0] || '';
  if (!primaryArtistName) return null;

  let profileUrl = extractPlatformUrl(profiles, [
    (url) => url.hostname.includes('music.yandex.') && url.pathname.includes('/artist/'),
  ]);

  let artistId = extractArtistIdFromUrl(profileUrl);
  let matchedName = primaryArtistName;
  let audience: number | null = null;
  let resolvedBriefInfo: YandexMusicArtistBriefInfoResponse | null = null;
  let candidateDebug: Array<{
    id: string;
    name: string;
    score: number;
    ratingsMonth: number;
    likesCount: number;
  }> = [];
  let searchDebug: Array<{ query: string; count: number }> = [];

  if (artistId) {
    const profileHtmlMatch = await fetchYandexArtistHtmlMatch(
      `https://music.yandex.ru/artist/${artistId}`,
    );
    if (profileHtmlMatch?.audience) {
      console.log('[artist-insights][yandex][profile-html-hit]', {
        artistNames: normalizedArtistNames,
        profileUrl,
        artistId: profileHtmlMatch.artistId,
        matchedName: profileHtmlMatch.matchedName,
        audience: profileHtmlMatch.audience,
      });
      return {
        source: 'yandex_music',
        label: 'Yandex Music',
        matchedName: profileHtmlMatch.matchedName || matchedName,
        url: profileUrl || profileHtmlMatch.url,
        audience: profileHtmlMatch.audience,
      };
    }

    if (profileHtmlMatch) {
      matchedName = profileHtmlMatch.matchedName || matchedName;
      profileUrl = profileUrl || profileHtmlMatch.url;
    }
  }

  if (!artistId) {
    const exactQueries = normalizedArtistNames.flatMap((artistName) => {
      const normalized = artistName.trim();
      if (!normalized) return [];
      const withPlainE = normalized.replace(/ё/gi, 'е');
      return [...new Set([normalized, withPlainE])];
    });
    const searchVariants = [
      ...new Set([
        ...exactQueries,
        ...normalizedArtistNames.flatMap((artistName) => getArtistSearchVariants(artistName)),
      ]),
    ].slice(0, 12);
    const candidatesMap = new Map<
      string,
      {
        id?: number | string;
        name?: string;
        likesCount?: number;
        ratings?: {
          month?: number;
        };
      }
    >();
    let nonEmptyQueries = 0;

    for (const query of searchVariants) {
      const response = await fetchExternalJson<YandexMusicArtistSearchResponse>(
        `https://api.music.yandex.net/search?type=artist&text=${encodeURIComponent(query)}&page=0&nocorrect=false`,
      );
      const results = response?.result?.artists?.results || [];
      searchDebug.push({ query, count: results.length });

      if (results.length > 0) {
        nonEmptyQueries += 1;
      }

      for (const candidate of results) {
        if (!candidate.id) continue;
        const key = String(candidate.id);
        if (!candidatesMap.has(key)) {
          candidatesMap.set(key, candidate);
        }
      }

      if (candidatesMap.size >= 8 && nonEmptyQueries >= 1) {
        break;
      }
    }

    const candidates = [...candidatesMap.values()];

    if (candidates.length === 0) {
      const htmlMatch = await resolveYandexHtmlFallback(normalizedArtistNames, profileUrl, artistId);
      if (htmlMatch) {
        artistId = htmlMatch.artistId;
        matchedName = htmlMatch.matchedName;
        audience = htmlMatch.audience;
        profileUrl = profileUrl || htmlMatch.url;
      } else {
        console.log('[artist-insights][yandex][no-candidates]', {
          artistNames: normalizedArtistNames,
          searchVariants,
          searchDebug,
        });
        return null;
      }
    }

    if (!artistId) {
      const scoredCandidates = [...candidates]
        .map((candidate) => ({
          candidate,
          score: Math.max(
            ...normalizedArtistNames.map((artistName) =>
              computeArtistMatchScore(artistName, candidate.name || ''),
            ),
          ),
        }))
        .filter((entry) => entry.candidate.id);

      candidateDebug = scoredCandidates.slice(0, 10).map((entry) => ({
        id: String(entry.candidate.id),
        name: entry.candidate.name || '',
        score: Number(entry.score.toFixed(3)),
        ratingsMonth: Number(entry.candidate.ratings?.month || 0),
        likesCount: Number(entry.candidate.likesCount || 0),
      }));

      const rankedCandidates = scoredCandidates
        .filter((entry) => entry.score >= 0.45)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.candidate.ratings?.month || 0) - Number(a.candidate.ratings?.month || 0) ||
            Number(b.candidate.likesCount || 0) - Number(a.candidate.likesCount || 0),
        );

      const fallbackCandidates =
        rankedCandidates.length > 0
          ? rankedCandidates
          : scoredCandidates
              .filter((entry) =>
                isYandexArtistNameCompatible(normalizedArtistNames, entry.candidate.name || ''),
              )
              .sort(
                (a, b) =>
                  Number(b.candidate.ratings?.month || 0) - Number(a.candidate.ratings?.month || 0) ||
                  Number(b.candidate.likesCount || 0) - Number(a.candidate.likesCount || 0) ||
                  b.score - a.score,
              );

      if (fallbackCandidates.length === 0) {
        const htmlMatch = await resolveYandexHtmlFallback(
          normalizedArtistNames,
          profileUrl,
          artistId,
        );
        if (htmlMatch) {
          artistId = htmlMatch.artistId;
          matchedName = htmlMatch.matchedName;
          audience = htmlMatch.audience;
          profileUrl = profileUrl || htmlMatch.url;
        } else {
          console.log('[artist-insights][yandex][no-ranked-candidates]', {
            artistNames: normalizedArtistNames,
            profileUrl,
            searchDebug,
            candidates: candidateDebug,
          });
          return null;
        }
      } else {
        const detailedMatch =
          (
            await Promise.all(
              fallbackCandidates.slice(0, 4).map(async ({ candidate, score }) => {
                const candidateId = String(candidate.id);
                const briefInfo = await fetchExternalJson<YandexMusicArtistBriefInfoResponse>(
                  `https://api.music.yandex.net/artists/${candidateId}/brief-info`,
                );

                return {
                  candidate,
                  score,
                  candidateId,
                  briefInfo,
                  audience:
                    roundAudience(briefInfo?.result?.stats?.lastMonthListeners) ??
                    roundAudience(candidate.ratings?.month),
                  matchedName: briefInfo?.result?.artist?.name || candidate.name || primaryArtistName,
                };
              }),
            )
          )
            .sort(
              (a, b) =>
                Number(b.audience || 0) - Number(a.audience || 0) ||
                b.score - a.score ||
                Number(b.candidate.ratings?.month || 0) - Number(a.candidate.ratings?.month || 0) ||
                Number(b.candidate.likesCount || 0) - Number(a.candidate.likesCount || 0),
            )[0] ?? null;

        const fallbackMatch = fallbackCandidates[0];
        const selectedMatch = detailedMatch ?? {
          candidate: fallbackMatch.candidate,
          score: fallbackMatch.score,
          candidateId: String(fallbackMatch.candidate.id),
          briefInfo: null,
          audience: roundAudience(fallbackMatch.candidate.ratings?.month),
          matchedName: fallbackMatch.candidate.name || primaryArtistName,
        };

        artistId = selectedMatch.candidateId;
        matchedName = selectedMatch.matchedName;
        audience = selectedMatch.audience;
        resolvedBriefInfo = selectedMatch.briefInfo;
      }
    }
  }

  if (!resolvedBriefInfo && artistId) {
    resolvedBriefInfo = await fetchExternalJson<YandexMusicArtistBriefInfoResponse>(
      `https://api.music.yandex.net/artists/${artistId}/brief-info`,
    );
  }

  audience = audience ?? roundAudience(resolvedBriefInfo?.result?.stats?.lastMonthListeners);
  matchedName = resolvedBriefInfo?.result?.artist?.name || matchedName;

  if (artistId && audience == null) {
    const htmlMatch = await resolveYandexHtmlFallback(normalizedArtistNames, profileUrl, artistId);
    if (htmlMatch) {
      matchedName = htmlMatch.matchedName || matchedName;
      audience = htmlMatch.audience ?? audience;
      profileUrl = profileUrl || htmlMatch.url;
    }
  }

  console.log('[artist-insights][yandex]', {
    artistNames: normalizedArtistNames,
    profileUrl,
    artistId,
    matchedName,
    audience,
    searchDebug,
    candidates: candidateDebug,
    resolvedListeners: resolvedBriefInfo?.result?.stats?.lastMonthListeners ?? null,
  });

  return {
    source: 'yandex_music',
    label: 'Yandex Music',
    matchedName,
    url: profileUrl || `https://music.yandex.ru/artist/${artistId}`,
    audience,
  };
}

async function buildDirectArtistInsights(
  userRef: string,
  ctx: DirectRequestContext,
): Promise<UserArtistInsights> {
  const trackSearchParams = new URLSearchParams({
    limit: '12',
    linked_partitioning: 'true',
    access: 'playable,preview,blocked',
  });
  const [user, webProfiles] = await Promise.all([
    requestDirectPath<ExternalUserProfile>(buildNormalizedResourcePath('users', userRef), {}, ctx),
    requestDirectPath<ExternalWebProfile[]>(
      buildNormalizedResourcePath('users', userRef, ['web-profiles']),
      {},
      ctx,
    ).catch(() => []),
  ]);
  const tracksResponse = await requestDirectPath<ExternalTrackCollection>(
    buildNormalizedResourcePath('users', userRef, ['tracks'], trackSearchParams),
    {},
    ctx,
  ).catch(() => ({ collection: [] }));

  const artistNames = prioritizeArtistNames(
    user?.username,
    collectArtistInsightNames(user, webProfiles, tracksResponse.collection ?? []),
  );
  console.log('[artist-insights][direct][input]', {
    userRef,
    username: user?.username ?? null,
    webProfiles,
    artistNames,
    trackCount: tracksResponse.collection?.length ?? 0,
  });
  if (artistNames.length === 0) {
    console.log('[artist-insights][direct][empty-artist-names]', { userRef, user });
    return {
      estimatedMonthlyPlays: null,
      platforms: [],
      similarArtists: [],
    };
  }

  const [spotifyPlatform, yandexPlatform] = await Promise.all([
    withSoftTimeout(fetchSpotifyPlatform(artistNames, webProfiles), 2800, null),
    withSoftTimeout(fetchYandexMusicPlatform(artistNames, webProfiles), 9000, null),
  ]);

  const platforms = [spotifyPlatform, yandexPlatform].filter(
    (platform): platform is ArtistInsightPlatform => Boolean(platform),
  );
  const numericAudiences = platforms
    .map((platform) => platform.audience)
    .filter((audience): audience is number => typeof audience === 'number' && audience > 0);
  const result = {
    estimatedMonthlyPlays:
      numericAudiences.length > 0
        ? Math.round(
            numericAudiences.reduce((sum, audience) => sum + audience, 0) / numericAudiences.length,
          )
        : null,
    platforms,
    similarArtists: [],
  };

  console.log('[artist-insights][direct][result]', {
    userRef,
    result,
  });

  return result;
}

async function handleLocalHistoryRequest<T>(
  method: string,
  searchParams: URLSearchParams,
  requestOptions: RequestInit,
): Promise<T> {
  if (method === 'GET') {
    const limit = clampInt(Number(searchParams.get('limit') ?? 50), 1, 200);
    const offset = clampInt(Number(searchParams.get('offset') ?? 0), 0, 10_000);
    const entries = readLocalHistory();

    return {
      collection: entries.slice(offset, offset + limit),
      total: entries.length,
    } as T;
  }

  if (method === 'DELETE') {
    writeLocalHistory([]);
    return { ok: true } as T;
  }

  if (method === 'POST') {
    try {
      const payload =
        typeof requestOptions.body === 'string' ? JSON.parse(requestOptions.body) : null;

      if (payload?.scTrackId && payload?.title) {
        const entries = readLocalHistory();
        const normalizedTrack = normalizeResourceRef(String(payload.scTrackId), 'tracks');
        const entry: LocalHistoryEntry = {
          id: createHistoryEntryId(),
          scTrackId: normalizedTrack.urn,
          title: String(payload.title),
          artistName: String(payload.artistName ?? ''),
          artworkUrl:
            typeof payload.artworkUrl === 'string' && payload.artworkUrl.trim()
              ? payload.artworkUrl
              : null,
          duration: Number(payload.duration ?? 0) || 0,
          playedAt: new Date().toISOString(),
        };

        writeLocalHistory([entry, ...entries]);
      }
    } catch (error) {
      console.warn('[history] Failed to persist local playback history:', error);
    }

    return { ok: true } as T;
  }

  throw new Error(`Standalone mode does not support ${method} /history`);
}

async function getPlaylistLikedState(
  playlistRef: string,
  ctx: DirectRequestContext,
): Promise<{ liked: boolean }> {
  const target = normalizeResourceRef(playlistRef, 'playlists');
  let cursor: string | undefined;

  for (;;) {
    const params = new URLSearchParams({
      limit: '200',
      linked_partitioning: 'true',
    });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const page = await requestDirectPath<DirectPlaylistCollection>(
      `/me/likes/playlists?${params.toString()}`,
      {},
      ctx,
    );

    const found = (page.collection ?? []).some((playlist) => {
      const playlistId =
        playlist.id != null ? String(playlist.id) : playlist.urn ? normalizeResourceRef(playlist.urn, 'playlists').id : null;
      return playlist.urn === target.urn || (target.id && playlistId === target.id);
    });

    if (found) {
      return { liked: true };
    }

    if (!page.next_href) {
      break;
    }

    const next = new URL(page.next_href);
    cursor = next.searchParams.get('cursor') ?? undefined;
    if (!cursor) {
      break;
    }
  }

  return { liked: false };
}

async function buildPopularRecommendationResults(
  limit: number,
  ctx: DirectRequestContext,
): Promise<DirectRecommendResult[]> {
  const params = new URLSearchParams({
    limit: String(Math.max(limit, 20)),
    linked_partitioning: 'true',
    access: 'playable,preview,blocked',
  });
  const result = await requestDirectPath<DirectTrackCollection>(`/tracks?${params.toString()}`, {}, ctx);
  return toRecommendResults(result.collection ?? [], limit);
}

async function gatherRecommendationSeedTrackIds(
  ctx: DirectRequestContext,
  limit: number,
): Promise<string[]> {
  const seeds: string[] = [];
  const seen = new Set<string>();

  const pushSeed = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    seeds.push(id);
  };

  for (const entry of readLocalHistory().slice(0, 10)) {
    pushSeed(normalizeResourceRef(entry.scTrackId, 'tracks').id);
    if (seeds.length >= limit) {
      return seeds;
    }
  }

  const [liked, following, feed] = await Promise.allSettled([
    requestDirectPath<DirectTrackCollection>('/me/likes/tracks?limit=40', {}, ctx),
    requestDirectPath<DirectTrackCollection>('/me/followings/tracks?limit=30', {}, ctx),
    requestDirectPath<DirectFeedCollection>('/me/feed?limit=20', {}, ctx),
  ]);

  if (liked.status === 'fulfilled') {
    for (const track of liked.value.collection ?? []) {
      pushSeed(extractDirectTrackId(track));
      if (seeds.length >= limit) return seeds;
    }
  }

  if (following.status === 'fulfilled') {
    for (const track of following.value.collection ?? []) {
      pushSeed(extractDirectTrackId(track));
      if (seeds.length >= limit) return seeds;
    }
  }

  if (feed.status === 'fulfilled') {
    for (const item of feed.value.collection ?? []) {
      pushSeed(extractDirectTrackId(item.origin ?? undefined));
      if (seeds.length >= limit) return seeds;
    }
  }

  return seeds;
}

async function buildRelatedRecommendationResults(
  seedTrackIds: string[],
  limit: number,
  ctx: DirectRequestContext,
  excludeIds: Set<string> = new Set(),
): Promise<DirectRecommendResult[]> {
  const scoreById = new Map<string, number>();
  const relatedLimit = clampInt(Math.max(limit * 2, 12), 12, 40);
  const effectiveSeeds = seedTrackIds.slice(0, 6);

  const pages = await Promise.allSettled(
    effectiveSeeds.map((trackId) =>
      requestDirectPath<DirectTrackCollection>(
        `/tracks/${encodeURIComponent(trackId)}/related?limit=${relatedLimit}&access=playable,preview,blocked`,
        {},
        ctx,
      ),
    ),
  );

  pages.forEach((page, index) => {
    if (page.status !== 'fulfilled') return;

    for (const track of page.value.collection ?? []) {
      const id = extractDirectTrackId(track);
      if (!id || excludeIds.has(id) || effectiveSeeds.includes(id)) continue;

      const popularityBoost = Math.log10((track.likes_count ?? 0) + 1) * 0.08;
      const seedBoost = Math.max(0.2, 1 - index * 0.12);
      scoreById.set(id, (scoreById.get(id) ?? 0) + seedBoost + popularityBoost);
    }
  });

  return [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

async function handleRecommendationsRequest<T>(
  pathSegments: string[],
  searchParams: URLSearchParams,
  ctx: DirectRequestContext,
): Promise<T> {
  const limit = clampInt(Number(searchParams.get('limit') ?? 24), 1, 50);

  if (pathSegments.length === 1) {
    const seedTrackIds = await gatherRecommendationSeedTrackIds(ctx, 10);
    const results =
      seedTrackIds.length > 0
        ? await buildRelatedRecommendationResults(seedTrackIds, limit, ctx)
        : [];
    return (results.length > 0 ? results : await buildPopularRecommendationResults(limit, ctx)) as T;
  }

  if (pathSegments[1] === 'search') {
    const query = searchParams.get('q')?.trim() ?? '';
    if (!query) {
      return [] as T;
    }

    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      linked_partitioning: 'true',
      access: 'playable,preview,blocked',
    });
    const result = await requestDirectPath<DirectTrackCollection>(`/tracks?${params.toString()}`, {}, ctx);
    return toRecommendResults(result.collection ?? [], limit) as T;
  }

  if ((pathSegments[1] === 'similar' || pathSegments[1] === 'wave') && pathSegments[2]) {
    const anchor = normalizeResourceRef(pathSegments[2], 'tracks');
    const excludeIds = new Set(
      (searchParams.get('exclude') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeResourceRef(value, 'tracks').id)
        .filter((value): value is string => !!value),
    );

    const results = await buildRelatedRecommendationResults(
      anchor.id ? [anchor.id] : [],
      limit,
      ctx,
      excludeIds,
    );

    return (results.length > 0 ? results : await buildPopularRecommendationResults(limit, ctx)) as T;
  }

  throw new Error(`Standalone mode does not support /${pathSegments.join('/')}`);
}

async function handleDirectRoute<T>(
  path: string,
  requestOptions: RequestInit,
  ctx: DirectRequestContext,
): Promise<T | typeof DIRECT_NO_MATCH> {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return requestDirectPath<T>(path, requestOptions, ctx);
  }

  const method = (requestOptions.method ?? 'GET').toUpperCase();
  const { pathname, searchParams } = splitPathAndSearch(path);
  const pathSegments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));

  if (pathSegments.length === 0) {
    return DIRECT_NO_MATCH;
  }

  if (pathSegments[0] === 'history') {
    return handleLocalHistoryRequest<T>(method, searchParams, requestOptions);
  }

  if (pathSegments[0] === 'recommendations') {
    return handleRecommendationsRequest<T>(pathSegments, searchParams, ctx);
  }

  if (pathSegments[0] === 'indexing' && pathSegments[1] === 'stats') {
    return null as T;
  }

  if (pathSegments[0] === 'likes' && pathSegments[1] === 'tracks' && pathSegments[2]) {
    const trackId = requireResourceId(pathSegments[2], 'tracks');
    return requestDirectPath<T>(
      buildPath(['likes', 'tracks', trackId], searchParams),
      requestOptions,
      ctx,
    );
  }

  if (pathSegments[0] === 'likes' && pathSegments[1] === 'playlists' && pathSegments[2]) {
    if (method === 'GET') {
      return (await getPlaylistLikedState(pathSegments[2], ctx)) as T;
    }

    const playlistId = requireResourceId(pathSegments[2], 'playlists');
    return requestDirectPath<T>(
      buildPath(['likes', 'playlists', playlistId], searchParams),
      requestOptions,
      ctx,
    );
  }

  if (pathSegments[0] === 'reposts' && pathSegments[1] === 'tracks' && pathSegments[2]) {
    const trackId = requireResourceId(pathSegments[2], 'tracks');
    return requestDirectPath<T>(
      buildPath(['reposts', 'tracks', trackId], searchParams),
      requestOptions,
      ctx,
    );
  }

  if (pathSegments[0] === 'reposts' && pathSegments[1] === 'playlists' && pathSegments[2]) {
    const playlistId = requireResourceId(pathSegments[2], 'playlists');
    return requestDirectPath<T>(
      buildPath(['reposts', 'playlists', playlistId], searchParams),
      requestOptions,
      ctx,
    );
  }

  if (pathSegments[0] === 'me') {
    if (method === 'GET') {
      if (
        ['feed', 'followers', 'followings', 'playlists', 'tracks'].includes(pathSegments[1] ?? '') ||
        (pathSegments[1] === 'likes' && ['tracks', 'playlists'].includes(pathSegments[2] ?? '')) ||
        (pathSegments[1] === 'followings' && pathSegments[2] === 'tracks')
      ) {
        ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      }

      if (pathSegments[1] === 'likes' && pathSegments[2] === 'tracks') {
        ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      }

      if (pathSegments[1] === 'tracks') {
        ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      }

      return requestDirectPath<T>(buildPath(pathSegments, searchParams), requestOptions, ctx);
    }

    if (pathSegments[1] === 'followings' && pathSegments[2] && ['PUT', 'DELETE'].includes(method)) {
      const userId = requireResourceId(pathSegments[2], 'users');
      return requestDirectPath<T>(
        buildPath(['me', 'followings', userId], searchParams),
        requestOptions,
        ctx,
      );
    }

    return DIRECT_NO_MATCH;
  }

  if (pathSegments[0] === 'users' && pathSegments[1]) {
    if (pathSegments[2] === 'artist-insights' && method === 'GET') {
      return buildDirectArtistInsights(pathSegments[1], ctx) as Promise<T>;
    }

    if (pathSegments[2] === 'followings' && pathSegments[3] && method === 'GET') {
      try {
        const userPath = buildNormalizedResourcePath(
          'users',
          pathSegments[1],
          ['followings', normalizeResourceRef(pathSegments[3], 'users').id ?? pathSegments[3]],
          searchParams,
        );
        const result = await requestDirectPath<{ urn?: string | null; id?: number | string | null } | boolean>(
          userPath,
          requestOptions,
          ctx,
        );
        if (typeof result === 'boolean') {
          return result as T;
        }

        const target = normalizeResourceRef(pathSegments[3], 'users');
        const resultId =
          result.id != null ? String(result.id) : result.urn ? normalizeResourceRef(result.urn, 'users').id : null;
        return Boolean(result.urn === target.urn || (target.id && resultId === target.id)) as T;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return false as T;
        }
        throw error;
      }
    }

    if (pathSegments[2] === 'tracks' && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
    }

    if (pathSegments[2] === 'playlists' && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
    }

    if (pathSegments[2] === 'likes' && pathSegments[3] === 'tracks' && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
    }

    if ((pathSegments[2] === 'followings' || pathSegments[2] === 'followers') && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
    }

    return requestDirectPath<T>(
      buildNormalizedResourcePath('users', pathSegments[1], pathSegments.slice(2), searchParams),
      requestOptions,
      ctx,
    );
  }

  if (pathSegments[0] === 'playlists') {
    if (pathSegments.length === 1 && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      return requestDirectPath<T>(buildPath(['playlists'], searchParams), requestOptions, ctx);
    }

    if (pathSegments[1]) {
      if (method === 'GET' && (!pathSegments[2] || pathSegments[2] === 'tracks')) {
        if (!pathSegments[2] || pathSegments[2] === 'tracks') {
          ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
        }
        ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      }

      return requestDirectPath<T>(
        buildNormalizedResourcePath('playlists', pathSegments[1], pathSegments.slice(2), searchParams),
        requestOptions,
        ctx,
      );
    }
  }

  if (pathSegments[0] === 'tracks') {
    if (pathSegments.length === 1 && method === 'GET') {
      ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      return requestDirectPath<T>(buildPath(['tracks'], searchParams), requestOptions, ctx);
    }

    if (pathSegments[1]) {
      if (pathSegments[2] === 'lyrics-sync' && pathSegments[3] === 'qwen') {
        throw new Error('Standalone mode does not support lyrics sync alignment');
      }

      if (method === 'GET' && pathSegments[2] === 'related') {
        ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
        ensureDefaultSearchParam(searchParams, 'access', 'playable,preview,blocked');
      }

      if (method === 'GET' && pathSegments[2] === 'comments') {
        ensureDefaultSearchParam(searchParams, 'linked_partitioning', 'true');
      }

      return requestDirectPath<T>(
        buildNormalizedResourcePath('tracks', pathSegments[1], pathSegments.slice(2), searchParams),
        requestOptions,
        ctx,
      );
    }
  }

  return DIRECT_NO_MATCH;
}

async function performStandaloneRequest<T>(
  path: string,
  requestOptions: RequestInit,
  ctx: DirectRequestContext,
): Promise<T> {
  const handled = await handleDirectRoute<T>(path, requestOptions, ctx);
  if (handled !== DIRECT_NO_MATCH) {
    return handled;
  }

  if (!isDirectApiPathSupported(path)) {
    throw new Error(`Standalone mode does not support ${path} yet`);
  }

  return requestDirectPath<T>(path, requestOptions, ctx);
}

export async function api<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const {
    quietHttpErrors = false,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ...requestOptions
  } = options;

  await waitForAuthHydration();
  await waitForRateLimitWindow();

  const dedupeKey = `${requestOptions.method || 'GET'}:${path}`;

  if ((requestOptions.method ?? 'GET').toUpperCase() === 'GET') {
    const existing = inflightRequests.get(dedupeKey);

    if (existing) {
      return existing as Promise<T>;
    }
  }

  const requestPromise = (async () => {
    const {
      ensureDirectAccessToken,
      isDirectSoundCloudAuthError,
    } = await import('./direct-soundcloud-api');
    const directAccessToken = await ensureDirectAccessToken({
      reason: `api:${path}`,
      allowExpiredTokenFallback: true,
    });
    const isArtistInsightsRequest = path.includes('/artist-insights');

    if (isArtistInsightsRequest) {
      console.log('[artist-insights][api][start]', {
        path,
        hasDirectAccessToken: Boolean(directAccessToken),
        hasSessionId: Boolean(sessionId ?? useAuthStore.getState().sessionId),
      });
    }

    if (directAccessToken) {
      try {
        const result = await performStandaloneRequest<T>(
          path,
          requestOptions,
          { accessToken: directAccessToken, timeoutMs },
        );
        if (isArtistInsightsRequest) {
          console.log('[artist-insights][api][direct-result]', {
            path,
            result,
          });
        }
        return result;
      } catch (error) {
        if (isDirectSoundCloudAuthError(error)) {
          const refreshedToken = await ensureDirectAccessToken({
            forceRefresh: true,
            reason: `api:${path}:retry`,
            allowExpiredTokenFallback: false,
          });

          if (refreshedToken) {
            const retried = await performStandaloneRequest<T>(
              path,
              requestOptions,
              { accessToken: refreshedToken, timeoutMs },
            );
            if (isArtistInsightsRequest) {
              console.log('[artist-insights][api][direct-retried-result]', {
                path,
                result: retried,
              });
            }
            return retried;
          }
        }

        console.warn(`[api] Direct SoundCloud request failed for ${path}:`, error);
        if (isArtistInsightsRequest) {
          console.log('[artist-insights][api][direct-error]', {
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }

    const headers = new Headers(requestOptions.headers);

    const effectiveSessionId =
      sessionId ?? useAuthStore.getState().sessionId;

    if (effectiveSessionId) {
      headers.set('x-session-id', effectiveSessionId);
    }

    if (!headers.has('Content-Type') && shouldSetJsonContentType(requestOptions.body)) {
      headers.set('Content-Type', 'application/json');
    }

    let res: Response;

    const timed = createTimedSignal(requestOptions.signal, timeoutMs);

    try {
      res = await requestWithFallback(buildApiUrl(path), {
        ...requestOptions,
        headers,
        signal: timed.signal,
      });

      if ([502, 503, 504].includes(res.status)) {
        await new Promise((resolve) =>
          setTimeout(resolve, 450 + Math.random() * 350),
        );

        res = await requestWithFallback(buildApiUrl(path), {
          ...requestOptions,
          headers,
          signal: timed.signal,
        });
      }

      useAppStatusStore.getState().setBackendReachable(true);
    } catch (error) {
      if (
        error instanceof Error &&
        /network|socket|reset|fetch/i.test(error.message)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + Math.random() * 350),
        );

        res = await requestWithFallback(buildApiUrl(path), {
          ...requestOptions,
          headers,
          signal: timed.signal,
        });
      } else {
        throw error;
      }
    } finally {
      timed.cleanup();
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const body = await res.text();

      if (res.status === 429) {
        applyRateLimitWindow(retryAfterMs);
      }

      const err = new ApiError(res.status, body, retryAfterMs);

      const shouldHandleUnauthorized =
        res.status === 401 &&
        !path.includes('/stream') &&
        handleUnauthorized();

      if (!quietHttpErrors) {
        if (res.status >= 500) {
          if (
            Date.now() - lastServerErrorToastAt >
            SERVER_ERROR_TOAST_COOLDOWN_MS
          ) {
            lastServerErrorToastAt = Date.now();
            toast.error(`Server error (${res.status})`);
          }
        } else if (res.status === 401 && shouldHandleUnauthorized) {
          showSessionExpiredToast();
        } else if (res.status === 429) {
          // handled via applyRateLimitWindow to avoid toast spam
        } else if (res.status >= 400) {
          try {
            const parsed = JSON.parse(body);
            toast.error(parsed.message || parsed.error || `Error ${res.status}`);
          } catch {
            toast.error(`Error ${res.status}`);
          }
        }

        if (res.status !== 401 || shouldHandleUnauthorized) {
          console.error(`HTTP ERROR: url: ${path}, `, err);
        }
      }

      throw err;
    }

    const contentType = res.headers.get('content-type');

    useAppStatusStore.getState().setSoundcloudBlocked(false);

    if (contentType?.includes('application/json')) {
      const result = await res.json();
      if (isArtistInsightsRequest) {
        console.log('[artist-insights][api][backend-result]', {
          path,
          result,
        });
      }
      return result;
    }

    return res.text() as T;
  })();

  if ((requestOptions.method ?? 'GET').toUpperCase() === 'GET') {
    inflightRequests.set(dedupeKey, requestPromise);
  }

  try {
    return await requestPromise;
  } finally {
    inflightRequests.delete(dedupeKey);
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterMs: number | null = null,
  ) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

/**
 * Extract numeric track ID from URN (e.g., "soundcloud:tracks:123" -> "123")
 */
function extractTrackId(trackUrn: string): string {
  return trackUrn.split(':').pop() || trackUrn;
}

export interface DirectTrackStreamSource {
  url: string;
  format: string;
  protocol: string;
  mimeType: string;
  quality: 'hq' | 'lq';
}

/**
 * Resolve a direct standalone SoundCloud stream source.
 * Progressive MP3 is preferred, but HLS is allowed as a direct fallback.
 */
export async function getTrackStreamSource(trackUrn: string): Promise<DirectTrackStreamSource> {
  const trackId = extractTrackId(trackUrn);

  const { resolveDirectTrackStream } = await import(
    './direct-soundcloud-api'
  );
  return resolveDirectTrackStream(trackId);
}

/**
 * Get direct CDN/HLS URL for standalone playback and background jobs.
 */
export async function getCdnStreamUrl(trackUrn: string): Promise<string> {
  const stream = await getTrackStreamSource(trackUrn);
  return stream.url;
}

export async function getBackendProgressiveTrackStreamSource(
  trackUrn: string,
): Promise<DirectTrackStreamSource | null> {
  await waitForAuthHydration();

  const effectiveSessionId = sessionId ?? useAuthStore.getState().sessionId;
  if (!effectiveSessionId) {
    return null;
  }

  const trackId = extractTrackId(trackUrn);
  const headers = new Headers({
    'x-session-id': effectiveSessionId,
  });

  try {
    const response = await requestWithFallback(
      buildApiUrl(`/tracks/${encodeURIComponent(trackId)}/stream-url`),
      {
        method: 'GET',
        headers,
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      url?: string;
      contentType?: string;
      quality?: 'hq' | 'lq';
    };

    if (!payload.url) {
      return null;
    }

    return {
      url: payload.url,
      format: 'http_mp3_128',
      protocol: 'progressive',
      mimeType: payload.contentType || 'audio/mpeg',
      quality: payload.quality === 'hq' ? 'hq' : 'lq',
    };
  } catch {
    return null;
  }
}

export type ResolvedStreamingTrack = Partial<import('../stores/player').Track> & {
  full_duration?: number;
};

export function resolveTrackFromStreaming(url: string) {
  return api<ResolvedStreamingTrack>(`/resolve?url=${encodeURIComponent(url)}`, {
    quietHttpErrors: true,
  });
}

export type ApiRequestOptions = RequestInit & {
  quietHttpErrors?: boolean;
  timeoutMs?: number;
};

export interface TrackComment {
  id: number;
  body: string;
  created_at: string;
  timestamp: number;
  user: {
    urn: string;
    username: string;
    avatar_url: string;
  };
}

export async function getTrackComments(trackUrn: string): Promise<TrackComment[]> {
  try {
    const urnParts = trackUrn.split(':');
    const id = urnParts[urnParts.length - 1]; // get the numeric ID part
const res = await api<{ collection: TrackComment[] }>(
  `/tracks/${id}/comments?limit=200&offset=0&threaded=0`,
  {
    quietHttpErrors: true,
    timeoutMs: 7000,
  },
);
    return res.collection || [];
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return [];
    }
    if (!(e instanceof ApiError && [401, 403, 404].includes(e.status))) {
  console.error('Failed to fetch comments', e);
}
    return [];
  }
}
