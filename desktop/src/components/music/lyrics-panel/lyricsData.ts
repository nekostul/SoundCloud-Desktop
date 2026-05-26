import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import type { LyricLine, LyricsResult, LyricsSource } from '../../../lib/lyrics';
import {
  LYRICS_SEARCH_QUERY_VERSION,
  resolveLyricsAutoSyncFromCommentsOrAsr,
  searchLyrics,
  splitArtistTitle,
} from '../../../lib/lyrics';
import type { Track } from '../../../stores/player';

export type LyricsSearchQuery = {
  artist: string;
  title: string;
};

export type TrackScopedLyricsSearchQuery = LyricsSearchQuery & {
  trackUrn: string;
};

export type ManualLyricsCacheEntry = LyricsSearchQuery & {
  lyrics: LyricsResult;
};

function normalizeLyricsSearchQueryValue(value: string) {
  return value.trim().toLocaleLowerCase();
}

function isSameLyricsSearchQuery(
  left: LyricsSearchQuery | null | undefined,
  right: LyricsSearchQuery | null | undefined,
) {
  if (!left || !right) return false;

  return (
    normalizeLyricsSearchQueryValue(left.artist) ===
      normalizeLyricsSearchQueryValue(right.artist) &&
    normalizeLyricsSearchQueryValue(left.title) === normalizeLyricsSearchQueryValue(right.title)
  );
}

export function buildTrackScopedLyricsSearchQuery(
  trackUrn: string,
  query: LyricsSearchQuery,
): TrackScopedLyricsSearchQuery {
  return {
    trackUrn,
    artist: query.artist.trim(),
    title: query.title.trim(),
  };
}

export function getActiveTrackScopedLyricsSearchQuery(
  trackUrn: string | null | undefined,
  query: TrackScopedLyricsSearchQuery | null,
): LyricsSearchQuery | null {
  if (!trackUrn || !query || query.trackUrn !== trackUrn) return null;

  return {
    artist: query.artist,
    title: query.title,
  };
}

export function getPreferredTrackLyricsSearchQuery(
  trackUrn: string | null | undefined,
  query: TrackScopedLyricsSearchQuery | null,
  queryRef: React.MutableRefObject<Map<string, LyricsSearchQuery>>,
): LyricsSearchQuery | null {
  return (
    getActiveTrackScopedLyricsSearchQuery(trackUrn, query) ??
    (trackUrn ? (queryRef.current.get(trackUrn) ?? null) : null)
  );
}

export function getCachedManualLyrics(
  manualLyricsRef: React.MutableRefObject<Map<string, ManualLyricsCacheEntry>>,
  trackUrn: string | null | undefined,
  query: LyricsSearchQuery | null,
): LyricsResult | null {
  if (!trackUrn || !query) return null;

  const cachedEntry = manualLyricsRef.current.get(trackUrn);
  if (!cachedEntry || !isSameLyricsSearchQuery(cachedEntry, query)) {
    return null;
  }

  return cachedEntry.lyrics;
}

export function useResolvedLyrics<
  TManualCache extends Map<string, LyricsResult> | Map<string, ManualLyricsCacheEntry>,
>(
  visible: boolean,
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  trackDurationMs: number | undefined,
  manualLyricsRef: React.MutableRefObject<TManualCache>,
  manualQuery: LyricsSearchQuery | null = null,
  autoLyricsRef?: React.MutableRefObject<Map<string, LyricsResult>>,
) {
  const trackUrn = track?.urn;
  const legacyLyricsCacheRef = manualLyricsRef as React.MutableRefObject<Map<string, LyricsResult>>;
  const manualLyricsCacheRef = manualLyricsRef as React.MutableRefObject<
    Map<string, ManualLyricsCacheEntry>
  >;
  const cachedManualLyrics = getCachedManualLyrics(
    manualLyricsCacheRef,
    trackUrn ?? null,
    manualQuery,
  );
  const cachedAutoLyricsCandidate =
    !manualQuery && autoLyricsRef && trackUrn
      ? (autoLyricsRef.current.get(trackUrn) ?? null)
      : null;
  const cachedAutoLyrics =
    cachedAutoLyricsCandidate?.source === 'genius' ? null : cachedAutoLyricsCandidate;
  const cachedLegacyLyrics =
    !manualQuery && !autoLyricsRef && trackUrn
      ? (legacyLyricsCacheRef.current.get(trackUrn) ?? null)
      : null;
  const cachedLyrics = cachedManualLyrics ?? cachedAutoLyrics ?? cachedLegacyLyrics;
  const lyricsQuery = useQuery({
    queryKey: ['lyrics', LYRICS_SEARCH_QUERY_VERSION, trackUrn, reqArtist, reqTitle],
    queryFn: () =>
      searchLyrics(
        trackUrn!,
        reqArtist,
        reqTitle,
        getLyricsSearchOptions(track, reqArtist, reqTitle, trackDurationMs),
      ),
    enabled: visible && !!trackUrn && !cachedLyrics,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 1,
  });

  const resolvedQuery = useQuery({
    queryKey: [
      'lyrics-resolved',
      4,
      trackUrn,
      reqArtist,
      reqTitle,
      lyricsQuery.data?.source ?? null,
      lyricsQuery.data?.plain ?? null,
      lyricsQuery.data?.synced?.length ?? 0,
      trackDurationMs,
    ],
    queryFn: () =>
      resolveLyricsAutoSyncFromCommentsOrAsr(
        trackUrn ?? '',
        lyricsQuery.data ?? null,
        [],
        reqArtist,
        reqTitle,
      ),
    enabled:
      visible && !cachedLyrics && Boolean(lyricsQuery.data?.plain && !lyricsQuery.data?.synced),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 1,
  });

  const autoLyrics = resolvedQuery.data ?? lyricsQuery.data ?? null;

  if (trackUrn && autoLyrics && !cachedLyrics) {
    if (manualQuery) {
      manualLyricsCacheRef.current.set(trackUrn, {
        ...manualQuery,
        lyrics: autoLyrics,
      });
    } else if (autoLyricsRef) {
      autoLyricsRef.current.set(trackUrn, autoLyrics);
    } else {
      legacyLyricsCacheRef.current.set(trackUrn, autoLyrics);
    }
  }

  const data = cachedLyrics ?? autoLyrics;

  const generatedFromPlain = Boolean(
    lyricsQuery.data?.plain && !lyricsQuery.data?.synced && data?.synced,
  );

  const pseudoSynced = Boolean(
    generatedFromPlain &&
      lyricsQuery.data &&
      data?.source === lyricsQuery.data.source &&
      lyricsQuery.data.source === 'genius',
  );

  return {
    data,
    loadingPlain: lyricsQuery.data?.plain ?? null,
    loadingSource: lyricsQuery.data?.source ?? null,
    isLoading: !cachedLyrics && (lyricsQuery.isLoading || resolvedQuery.isLoading),
    pseudoSynced,
    generatedFromPlain,
  };
}

export function getTrackDurationMs(track: Track | null | undefined): number | undefined {
  return track?.duration;
}

export function getLyricsSearchOptions(
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  trackDurationMs?: number,
) {
  const originalArtist = track?.user?.username ?? '';
  const originalTitle = track?.title ?? '';
  return {
    uploaderUsername: originalArtist,
    originalTitle,
    durationMs: trackDurationMs,
    genre: track?.genre ?? null,
    tagList: track?.tag_list ?? null,
    description: track?.description ?? null,
    createdAt: track?.created_at ?? null,
    artworkUrl: track?.artwork_url ?? null,
    forceRefresh: reqArtist !== originalArtist || reqTitle !== originalTitle,
  };
}

export function shouldRenderSyncedLyrics(
  lyrics: LyricLine[] extends never
    ? never
    : { synced: LyricLine[] | null; source: LyricsSource; plain: string | null } | null | undefined,
): lyrics is { synced: LyricLine[]; source: LyricsSource; plain: string | null } {
  return Boolean(lyrics?.synced?.length);
}

export function shouldRenderPlainLyrics(
  lyrics:
    | { plain: string | null; source: LyricsSource; synced: LyricLine[] | null }
    | null
    | undefined,
): lyrics is { plain: string; source: LyricsSource; synced: null } {
  return Boolean(lyrics?.plain && !lyrics?.synced);
}

export function getLyricsSearchPrefill(
  track: Track | null | undefined,
  manualQuery: { artist: string; title: string } | null,
) {
  const parsed = splitArtistTitle(track?.title ?? '');
  return {
    artist: manualQuery?.artist || (parsed ? parsed[0] : track?.user?.username || ''),
    title: manualQuery?.title || (parsed ? parsed[1] : track?.title || ''),
  };
}

export type ResolvedLyricsData = {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
} | null;

export function hasRenderableLyrics(lyrics: ResolvedLyricsData) {
  return Boolean(lyrics?.synced?.length || lyrics?.plain);
}
