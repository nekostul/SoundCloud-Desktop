import { Injectable } from '@nestjs/common';
import { SoundcloudService } from '../soundcloud/soundcloud.service.js';
import {
  ScPaginatedResponse,
  ScPlaylist,
  ScTrack,
  ScUser,
  ScWebProfile,
} from '../soundcloud/soundcloud.types.js';

type ArtistInsightSource = 'spotify' | 'yandex_music';

export interface ArtistInsightPlatform {
  source: ArtistInsightSource;
  label: string;
  matchedName: string;
  url: string | null;
  audience: number | null;
}

export interface UserArtistInsights {
  estimatedMonthlyPlays: number | null;
  platforms: ArtistInsightPlatform[];
  similarArtists: ScUser[];
}

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

interface YandexMusicArtistSearchResponse {
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
}

interface YandexMusicArtistBriefInfoResponse {
  result?: {
    artist?: {
      id?: number | string;
      name?: string;
    };
    stats?: {
      lastMonthListeners?: number;
      lastMonthListenersDelta?: number;
    };
  };
}

type ArtistCreditTrack = ScTrack & {
  metadata_artist?: string | null;
  playback_count?: number | null;
};

const normalizeArtistText = (value: string | null | undefined): string =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeArtistText = (value: string | null | undefined): string[] =>
  normalizeArtistText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const computeArtistMatchScore = (query: string, candidate: string): number => {
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

  const coverage = overlap / Math.max(queryTokens.size, candidateTokens.size);
  return coverage;
};

const roundAudience = (value: number | null | undefined): number | null => {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
};

const parseCompactAudience = (value: string | null | undefined): number | null => {
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
};

const extractMonthlyAudienceSnippet = (
  html: string,
  label: 'monthly listeners' | 'monthly audience',
): number | null => {
  const normalized = html.replace(/&#x27;/g, "'");
  const match = normalized.match(
    new RegExp(`(\\d[\\d.,]*\\s*[KMB]?)\\s+${label.replace(' ', '\\s+')}`, 'i'),
  );
  return parseCompactAudience(match?.[1] || null);
};

const extractPlatformUrl = (
  profiles: ScWebProfile[],
  predicates: Array<(url: URL) => boolean>,
): string | null => {
  for (const profile of profiles) {
    try {
      const url = new URL(profile.url);
      if (predicates.some((predicate) => predicate(url))) return profile.url;
    } catch {
      continue;
    }
  }
  return null;
};

const extractArtistIdFromUrl = (url: string | null | undefined): string | null => {
  const match = String(url || '').match(/\/artist\/(\d+)/);
  return match?.[1] || null;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

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

const transliterateCyrillicToLatin = (value: string): string =>
  Array.from(String(value || ''))
    .map((char) => {
      const lower = char.toLowerCase();
      const mapped = CYRILLIC_TO_LATIN_MAP[lower];
      if (mapped == null) return char;
      return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('');

const getArtistSearchVariants = (value: string): string[] => {
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
};

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

const pushArtistNameCandidate = (
  target: Set<string>,
  value: string | null | undefined,
): void => {
  const candidate = String(value || '').trim();
  if (!candidate) return;
  target.add(candidate);
};

const splitArtistCredits = (value: string | null | undefined): string[] =>
  String(value || '')
    .split(/\s*(?:,|&|\+|\/|;|\|| feat\.? | ft\.? | featuring | x )\s*/i)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length >= 2);

const appendUrlArtistCandidates = (
  target: Set<string>,
  rawUrl: string | null | undefined,
): void => {
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
};

const collectArtistInsightNames = (
  user: Pick<ScUser, 'username' | 'full_name' | 'permalink' | 'website' | 'website_title'>,
  profiles: ScWebProfile[],
  tracks: ArtistCreditTrack[],
): string[] => {
  const candidates = new Set<string>();

  pushArtistNameCandidate(candidates, user.username);
  pushArtistNameCandidate(candidates, user.full_name);
  pushArtistNameCandidate(candidates, String(user.permalink || '').replace(/[-_.]+/g, ' '));

  const normalizedWebsiteTitle = normalizeArtistText(user.website_title);
  if (normalizedWebsiteTitle && !GENERIC_PROFILE_LABELS.has(normalizedWebsiteTitle)) {
    pushArtistNameCandidate(candidates, user.website_title);
  }
  appendUrlArtistCandidates(candidates, user.website);

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
};

const prioritizeArtistNames = (
  primaryName: string | null | undefined,
  extraNames: string[],
): string[] => {
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
};

const withSoftTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> =>
  new Promise((resolve) => {
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

const extractUserId = (user: Pick<ScUser, 'urn'> | null | undefined): string => {
  const value = String(user?.urn || '');
  const match = value.match(/(\d+)$/);
  return match?.[1] || '';
};

@Injectable()
export class UsersService {
  constructor(private readonly sc: SoundcloudService) {}

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6500);
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.8,ru;q=0.7',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6500);
      const response = await fetch(url, {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8,ru;q=0.7',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  private parseBingRssResults(xml: string): SearchResult[] {
    return [...xml.matchAll(/<item><title>([\s\S]*?)<\/title><link>([\s\S]*?)<\/link><description>([\s\S]*?)<\/description>/g)]
      .map((match) => ({
        title: decodeHtmlEntities(match[1] || '').trim(),
        url: decodeHtmlEntities(match[2] || '').trim(),
        snippet: decodeHtmlEntities(match[3] || '').trim(),
      }))
      .filter((result) => result.url.startsWith('http'));
  }

  private async searchBing(query: string): Promise<SearchResult[]> {
    const xml = await this.fetchText(
      `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
    );
    return xml ? this.parseBingRssResults(xml) : [];
  }

  private buildPlatformSearchVariants(artistNames: string[]): string[] {
    const seeds = artistNames
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 2);

    return [...new Set(seeds.flatMap((name) => getArtistSearchVariants(name)))].slice(0, 6);
  }

  private pickBestPlatformSearchResultByAudience(
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

  private async collectUserTracks(token: string, userUrn: string, limit = 120): Promise<ScTrack[]> {
    const tracks: ScTrack[] = [];
    let nextUrl: string | null = null;
    let page = 0;

    while (tracks.length < limit && page < 3) {
      const response: ScPaginatedResponse<ScTrack> = nextUrl
        ? await this.sc.apiGetByUrl<ScPaginatedResponse<ScTrack>>(nextUrl, token)
        : await this.sc.apiGet<ScPaginatedResponse<ScTrack>>(`/users/${userUrn}/tracks`, token, {
            limit: 50,
            linked_partitioning: true,
            access: 'playable,preview,blocked',
          });

      for (const track of response.collection || []) {
        if (!track?.urn) continue;
        if (tracks.some((existing) => existing.urn === track.urn)) continue;
        tracks.push(track);
        if (tracks.length >= limit) break;
      }

      nextUrl = response.next_href || null;
      if (!nextUrl) break;
      page += 1;
    }

    return tracks;
  }

  private async fetchSpotifyPlatform(
    artistNames: string[],
    profiles: ScWebProfile[],
  ): Promise<ArtistInsightPlatform | null> {
    const profileUrl = extractPlatformUrl(profiles, [
      (url) => url.hostname.includes('spotify.com') && url.pathname.includes('/artist/'),
    ]);
    const normalizedArtistNames = artistNames.map((name) => name.trim()).filter(Boolean);
    const primaryArtistName = normalizedArtistNames[0] || '';
    if (!primaryArtistName) return null;

    const searchQueries = this.buildPlatformSearchVariants(normalizedArtistNames).map(
      (artistName) => `site:open.spotify.com/artist "${artistName}" "monthly listeners"`,
    );
    const searchResults = (await Promise.all(searchQueries.map((query) => this.searchBing(query)))).flat();
    const match = this.pickBestPlatformSearchResultByAudience(
      searchResults,
      normalizedArtistNames,
      'open.spotify.com/artist/',
      (result) =>
        extractMonthlyAudienceSnippet(result.snippet || '', 'monthly listeners') ??
        extractMonthlyAudienceSnippet(result.title || '', 'monthly listeners'),
    );
    const audience = match?.audience ?? null;
    const url = profileUrl || match?.result.url || null;

    if (!audience && !url) return null;
    return {
      source: 'spotify',
      label: 'Spotify',
      matchedName: primaryArtistName,
      url,
      audience,
    };
  }

  private async fetchYandexMusicPlatform(
    artistNames: string[],
    profiles: ScWebProfile[],
  ): Promise<ArtistInsightPlatform | null> {
    const normalizedArtistNames = artistNames.map((name) => name.trim()).filter(Boolean);
    const primaryArtistName = normalizedArtistNames[0] || '';
    if (!primaryArtistName) return null;

    const profileUrl = extractPlatformUrl(profiles, [
      (url) => url.hostname.includes('music.yandex.') && url.pathname.includes('/artist/'),
    ]);

    let artistId = extractArtistIdFromUrl(profileUrl);
    let matchedName = primaryArtistName;
    let audience: number | null = null;
    let resolvedBriefInfo: YandexMusicArtistBriefInfoResponse | null = null;

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
        const response = await this.fetchJson<YandexMusicArtistSearchResponse>(
          `https://api.music.yandex.net/search?type=artist&text=${encodeURIComponent(query)}&page=0&nocorrect=false`,
        );
        const results = response?.result?.artists?.results || [];

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
      if (candidates.length === 0) return null;

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
                normalizedArtistNames.some((artistName) => {
                  const normalizedArtistName = normalizeArtistText(artistName);
                  const normalizedCandidateName = normalizeArtistText(entry.candidate.name || '');
                  return (
                    normalizedArtistName === normalizedCandidateName ||
                    normalizedArtistName.includes(normalizedCandidateName) ||
                    normalizedCandidateName.includes(normalizedArtistName)
                  );
                }),
              )
              .sort(
                (a, b) =>
                  Number(b.candidate.ratings?.month || 0) - Number(a.candidate.ratings?.month || 0) ||
                  Number(b.candidate.likesCount || 0) - Number(a.candidate.likesCount || 0) ||
                  b.score - a.score,
              );

      if (fallbackCandidates.length === 0) return null;

      const detailedMatch =
        (
          await Promise.all(
            fallbackCandidates.slice(0, 4).map(async ({ candidate, score }) => {
              const candidateId = String(candidate.id);
              const briefInfo = await this.fetchJson<YandexMusicArtistBriefInfoResponse>(
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

    if (!resolvedBriefInfo && artistId) {
      resolvedBriefInfo = await this.fetchJson<YandexMusicArtistBriefInfoResponse>(
        `https://api.music.yandex.net/artists/${artistId}/brief-info`,
      );
    }
    audience = audience ?? roundAudience(resolvedBriefInfo?.result?.stats?.lastMonthListeners);
    matchedName = resolvedBriefInfo?.result?.artist?.name || matchedName;

    return {
      source: 'yandex_music',
      label: 'Яндекс Музыка',
      matchedName,
      url: profileUrl || `https://music.yandex.ru/artist/${artistId}`,
      audience,
    };
  }

  private async fetchSimilarArtists(
    token: string,
    user: ScUser,
    tracks: ScTrack[],
  ): Promise<ScUser[]> {
    const seedTracks = [...tracks]
      .sort((a, b) => (b.playback_count ?? 0) - (a.playback_count ?? 0))
      .slice(0, 3);
    if (seedTracks.length === 0) return [];

    const candidates = new Map<
      string,
      {
        id: string;
        score: number;
      }
    >();

    const relatedGroups = await Promise.all(
      seedTracks.map((track) =>
        this.sc
          .apiGet<ScPaginatedResponse<ScTrack>>(`/tracks/${track.urn}/related`, token, {
            limit: 12,
            linked_partitioning: true,
            access: 'playable,preview,blocked',
          })
          .then((response) => response.collection || [])
          .catch(() => [] as ScTrack[]),
      ),
    );

    const ownUserKey = extractUserId(user) || user.urn;
    for (let groupIndex = 0; groupIndex < relatedGroups.length; groupIndex += 1) {
      const group = relatedGroups[groupIndex];
      for (let trackIndex = 0; trackIndex < group.length; trackIndex += 1) {
        const track = group[trackIndex];
        const relatedUser = track.user;
        if (!relatedUser?.urn) continue;

        const relatedKey = extractUserId(relatedUser) || relatedUser.urn;
        if (relatedKey === ownUserKey) continue;
        if (computeArtistMatchScore(user.username || '', relatedUser.username || '') >= 0.96) continue;

        const score =
          (group.length - trackIndex) * 1.1 +
          (relatedGroups.length - groupIndex) * 2.8 +
          Math.log10(Math.max(1, Number(track.playback_count || 0))) * 0.6;

        const existing = candidates.get(relatedKey);
        candidates.set(relatedKey, {
          id: extractUserId(relatedUser),
          score: (existing?.score || 0) + score,
        });
      }
    }

    const topCandidates = [...candidates.entries()]
      .filter(([, value]) => value.id)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 12);
    if (topCandidates.length === 0) return [];

    const usersResponse = await this.search(token, {
      ids: topCandidates.map(([, value]) => value.id).join(','),
    });
    const usersById = new Map(
      (usersResponse.collection || []).map((candidate) => [extractUserId(candidate) || candidate.urn, candidate]),
    );

    return topCandidates
      .map(([, value]) => usersById.get(value.id))
      .filter((candidate): candidate is ScUser => Boolean(candidate?.urn))
      .slice(0, 8);
  }

  search(token: string, params?: Record<string, unknown>): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet('/users', token, params);
  }

  getById(token: string, userUrn: string): Promise<ScUser> {
    return this.sc.apiGet(`/users/${userUrn}`, token);
  }

  getFollowers(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/users/${userUrn}/followers`, token, params);
  }

  getFollowings(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/users/${userUrn}/followings`, token, params);
  }

  async getIsFollowing(token: string, userUrn: string, followingUrn: string): Promise<boolean> {
    try {
      const response = (await this.sc.apiGet(
        `/users/${userUrn}/followings/${followingUrn}`,
        token,
      )) as { urn?: string } | null;

      return response?.urn === followingUrn;
    } catch {
      return false;
    }
  }

  getTracks(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet(`/users/${userUrn}/tracks`, token, params);
  }

  getPlaylists(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScPlaylist>> {
    return this.sc.apiGet(`/users/${userUrn}/playlists`, token, params);
  }

  getLikedTracks(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet(`/users/${userUrn}/likes/tracks`, token, params);
  }

  getLikedPlaylists(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScPlaylist>> {
    return this.sc.apiGet(`/users/${userUrn}/likes/playlists`, token, params);
  }

  getWebProfiles(
    token: string,
    userUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScWebProfile[]> {
    return this.sc.apiGet(`/users/${userUrn}/web-profiles`, token, params);
  }

  async getArtistInsights(token: string, userUrn: string): Promise<UserArtistInsights> {
    const [user, tracks, webProfiles] = await Promise.all([
      this.getById(token, userUrn),
      this.collectUserTracks(token, userUrn),
      this.getWebProfiles(token, userUrn).catch(() => [] as ScWebProfile[]),
    ]);
    const artistNames = prioritizeArtistNames(
      user.username,
      collectArtistInsightNames(user, webProfiles, tracks as ArtistCreditTrack[]),
    );

    const [yandexMusicPlatform, spotifyPlatform, similarArtists] =
      await Promise.all([
        withSoftTimeout(this.fetchYandexMusicPlatform(artistNames, webProfiles), 5500, null),
        withSoftTimeout(this.fetchSpotifyPlatform(artistNames, webProfiles), 2800, null),
        withSoftTimeout(this.fetchSimilarArtists(token, user, tracks), 3000, [] as ScUser[]),
      ]);

    const platforms = [spotifyPlatform, yandexMusicPlatform].filter(
      (platform): platform is ArtistInsightPlatform => Boolean(platform),
    );
    const numericAudiences = platforms
      .map((platform) => platform.audience)
      .filter((audience): audience is number => Boolean(audience && audience > 0));

    return {
      estimatedMonthlyPlays:
        numericAudiences.length > 0
          ? Math.round(
              numericAudiences.reduce((sum, audience) => sum + audience, 0) / numericAudiences.length,
            )
          : null,
      platforms,
      similarArtists,
    };
  }
}
