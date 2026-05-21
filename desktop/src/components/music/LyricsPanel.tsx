import * as Slider from '@radix-ui/react-slider';
import { invoke } from '@tauri-apps/api/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Volume, Volume2, VolumeX } from 'lucide-react';
import { createPortal, flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { isAppBackgrounded } from '../../lib/app-visibility';
import {
  getFallbackArtworkGradientPalette,
  useArtworkGradientPalette,
} from '../../lib/artwork-palette';
import { getCurrentTime, getDuration, getSmoothCurrentTime, seek } from '../../lib/audio';
import type { AudioFeatures } from '../../lib/audio-analyser';
import { audioAnalyser } from '../../lib/audio-analyser';
import { art, formatTime } from '../../lib/formatters';
import { getAnimationFrameBudgetMs } from '../../lib/framerate';
import { invalidateAllLikesCache } from '../../lib/hooks';
import {
  TRACK_SWITCH_NEXT_SCOPE,
  TRACK_SWITCH_PREV_SCOPE,
  useTrackSwitchCooldown,
} from '../../lib/useTrackSwitchCooldown';
import {
  Ban,
  ExternalLink,
  Eye,
  Heart,
  ListPlus,
  Loader2,
  Maximize2,
  MicVocal,
  pauseBlack18,
  playBlack18,
  repeat1Icon16,
  repeatIcon16,
  Search,
  SkipBack,
  SkipForward,
  shuffleIcon16,
  X,
} from '../../lib/icons';
import { optimisticToggleLike, useLiked } from '../../lib/likes';
import type { LyricLine, LyricsResult, LyricsSource } from '../../lib/lyrics';
import {
  getLyricMotionHintsForTrack,
  LYRICS_SEARCH_QUERY_VERSION,
  resolveLyricsAutoSyncFromCommentsOrAsr,
  searchLyrics,
  splitArtistTitle,
} from '../../lib/lyrics';
import type { CommunityLyricsDraft } from '../../stores/communityLyricsDrafts';
import { useCommunityLyricsDraftStore } from '../../stores/communityLyricsDrafts';
import { useDislikesStore } from '../../stores/dislikes';
import {
  type CommunitySyncStage,
  useArtworkStore,
  useFullscreenPanelStore,
  useLyricsStore,
} from '../../stores/lyrics';
import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  type Track,
  usePlayerStore,
} from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { useSoundWaveStore } from '../../stores/soundwave';
import { ProgressSlider, ProgressTime } from '../layout/NowPlayingBar';
import { AdaptiveTrackTitle } from '../ui/AdaptiveTrackTitle';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { PlaybackSpeedPresets } from './PlaybackSpeedPresets';
import { StreamQualityBadge } from './StreamQualityBadge';

/* ── Source Badge ─────────────────────────────────────────── */

const SOURCE_LABELS: Record<LyricsSource, string> = {
  soundcloud: 'SoundCloud',
  lrclib: 'LRCLib',
  netease: 'NetEase',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
  textyl: 'Textyl',
  kroko: 'Genius',
  qwen: 'Genius',
  vosk: 'Genius',
};

function uniqueArtworkSources(values: Array<string | null | undefined>): string[] {
  return values.filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
}

type ArtworkLightboxSource = 'track-column' | 'lyrics-mini-player';

type ArtworkLightboxRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
};

type ViewTransitionHandle = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionHandle;
};

function runDocumentViewTransition(update: () => void) {
  if (typeof document === 'undefined') {
    update();
    return;
  }

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const doc = document as ViewTransitionDocument;

  if (!doc.startViewTransition || prefersReducedMotion) {
    update();
    return;
  }

  doc.startViewTransition(() => {
    flushSync(update);
  });
}

function measureArtworkRect(element: HTMLElement | null): ArtworkLightboxRect | null {
  if (!element) return null;

  const rect = element.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const computedStyle = window.getComputedStyle(element);
  const radius = Number.parseFloat(computedStyle.borderTopLeftRadius || '24') || 24;

  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    radius,
  };
}

function shrinkArtworkRect(rect: ArtworkLightboxRect): ArtworkLightboxRect {
  const scale = 0.94;
  const width = rect.width * scale;
  const height = rect.height * scale;

  return {
    top: rect.top + (rect.height - height) / 2,
    left: rect.left + (rect.width - width) / 2,
    width,
    height,
    radius: rect.radius,
  };
}

function useArtworkLightboxState(defaultSource: ArtworkLightboxSource = 'track-column') {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<ArtworkLightboxSource>(defaultSource);
  const [anchorRect, setAnchorRect] = useState<ArtworkLightboxRect | null>(null);
  const [sourceArtworkHidden, setSourceArtworkHidden] = useState(false);
  const sourceElementRef = useRef<HTMLElement | null>(null);

  const openLightbox = useCallback(
    (nextSource: ArtworkLightboxSource, sourceElement: HTMLElement | null = null) => {
      sourceElementRef.current = sourceElement;
      setSource(nextSource);
      setAnchorRect(measureArtworkRect(sourceElement));
      setSourceArtworkHidden(true);
      setOpen(true);
    },
    [],
  );

  const closeLightbox = useCallback(() => {
    setOpen(false);
  }, []);

  const handleLightboxExited = useCallback(() => {
    setSourceArtworkHidden(false);
  }, []);

  return {
    artworkLightboxOpen: open,
    artworkLightboxSource: source,
    artworkLightboxAnchorRect: anchorRect,
    artworkLightboxSourceArtworkHidden: sourceArtworkHidden,
    artworkLightboxSourceElement: sourceElementRef.current,
    openArtworkLightbox: openLightbox,
    closeArtworkLightbox: closeLightbox,
    handleArtworkLightboxExited: handleLightboxExited,
  };
}

function getTrackArtworkSources(track: Track | null | undefined, size: string): string[] {
  if (!track) return [];

  return uniqueArtworkSources([art(track.artwork_url, size), art(track.user.avatar_url, size)]);
}

function getTrackBackgroundArtworkSources(track: Track | null | undefined): string[] {
  return uniqueArtworkSources([
      ...getTrackArtworkSources(track, 't200x200'),
      ...getTrackArtworkSources(track, 't500x500'),
  ]);
}

function getTrackFullscreenArtworkSources(track: Track | null | undefined): string[] {
  return uniqueArtworkSources([
    ...getTrackArtworkSources(track, 't500x500'),
    ...getTrackArtworkSources(track, 'original'),
    ...getTrackArtworkSources(track, 't200x200'),
  ]);
}

function useFallbackImageSource(sources: string[], resetKey: string) {
  const sourcesKey = sources.join('|');
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [resetKey, sourcesKey]);

  const hasNextSource = index + 1 < sources.length;
  const currentSrc = failed ? null : sources[index] ?? null;

  const handleError = useCallback(() => {
    if (hasNextSource) {
      setIndex((current) => Math.min(current + 1, sources.length - 1));
      return;
    }

    setFailed(true);
  }, [hasNextSource, sources.length]);

  return {
    currentSrc,
    handleError,
  };
}

type LyricsSearchQuery = {
  artist: string;
  title: string;
};

type TrackScopedLyricsSearchQuery = LyricsSearchQuery & {
  trackUrn: string;
};

type ManualLyricsCacheEntry = LyricsSearchQuery & {
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

function buildTrackScopedLyricsSearchQuery(
  trackUrn: string,
  query: LyricsSearchQuery,
): TrackScopedLyricsSearchQuery {
  return {
    trackUrn,
    artist: query.artist.trim(),
    title: query.title.trim(),
  };
}

function getActiveTrackScopedLyricsSearchQuery(
  trackUrn: string | null | undefined,
  query: TrackScopedLyricsSearchQuery | null,
): LyricsSearchQuery | null {
  if (!trackUrn || !query || query.trackUrn !== trackUrn) return null;

  return {
    artist: query.artist,
    title: query.title,
  };
}

function getPreferredTrackLyricsSearchQuery(
  trackUrn: string | null | undefined,
  query: TrackScopedLyricsSearchQuery | null,
  queryRef: React.MutableRefObject<Map<string, LyricsSearchQuery>>,
): LyricsSearchQuery | null {
  return getActiveTrackScopedLyricsSearchQuery(trackUrn, query) ?? (trackUrn ? (queryRef.current.get(trackUrn) ?? null) : null);
}

function getCachedManualLyrics(
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


function useResolvedLyrics<TManualCache extends Map<string, LyricsResult> | Map<string, ManualLyricsCacheEntry>>(
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
  const manualLyricsCacheRef = manualLyricsRef as React.MutableRefObject<Map<string, ManualLyricsCacheEntry>>;
  const cachedManualLyrics = getCachedManualLyrics(manualLyricsCacheRef, trackUrn ?? null, manualQuery);
  const cachedAutoLyrics =
    !manualQuery && autoLyricsRef && trackUrn ? (autoLyricsRef.current.get(trackUrn) ?? null) : null;
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
      visible &&
      !cachedLyrics &&
      Boolean(lyricsQuery.data?.plain && !lyricsQuery.data?.synced),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 1,
  });

const autoLyrics =
  resolvedQuery.data ?? lyricsQuery.data ?? null;

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

const data =
  cachedLyrics ?? autoLyrics;

  const generatedFromPlain = Boolean(
    lyricsQuery.data?.plain && !lyricsQuery.data?.synced && data?.synced,
  );

  const pseudoSynced = Boolean(
    generatedFromPlain &&
      lyricsQuery.data &&
      data?.source === lyricsQuery.data.source &&
      (lyricsQuery.data.source === 'genius' || lyricsQuery.data.source === 'musixmatch'),
  );

  return {
    data,
    loadingPlain: lyricsQuery.data?.plain ?? null,
    loadingSource: lyricsQuery.data?.source ?? null,
    isLoading:
      !cachedLyrics && (lyricsQuery.isLoading || resolvedQuery.isLoading),
    pseudoSynced,
    generatedFromPlain,
  };
}

function getTrackDurationMs(track: Track | null | undefined): number | undefined {
  return track?.duration;
}

function getLyricsSearchOptions(
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

function shouldRenderSyncedLyrics(
  lyrics: LyricLine[] extends never
    ? never
    : { synced: LyricLine[] | null; source: LyricsSource; plain: string | null } | null | undefined,
): lyrics is { synced: LyricLine[]; source: LyricsSource; plain: string | null } {
  return Boolean(lyrics?.synced?.length);
}

function shouldRenderPlainLyrics(
  lyrics:
    | { plain: string | null; source: LyricsSource; synced: LyricLine[] | null }
    | null
    | undefined,
): lyrics is { plain: string; source: LyricsSource; synced: null } {
  return Boolean(lyrics?.plain && !lyrics?.synced);
}

const resolveTrackPermalink = async (track: Track): Promise<string | null> => {
  const direct = track.permalink_url?.trim();
  if (direct) return direct;

  try {
    const refreshed = await api<Pick<Track, 'permalink_url'>>(
      `/tracks/${encodeURIComponent(track.urn)}`,
      {
        quietHttpErrors: true,
      },
    );
    const refreshedPermalink = refreshed.permalink_url?.trim();
    if (refreshedPermalink) return refreshedPermalink;
  } catch {
    // noop
  }

  if (track.id > 0) {
    return `https://soundcloud.com/tracks/${track.id}`;
  }

  return null;
};

const openExternal = async (url: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

const LyricsSourceBadge = React.memo(
  ({ source, onSearch }: { source: LyricsSource; onSearch?: () => void }) => (
    <div className="mx-auto flex w-full max-w-[880px] items-center justify-between gap-3 px-[clamp(8px,1.4vw,18px)] pt-3 pb-0">
      <span className="text-[10px] font-semibold text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-full border border-white/[0.06]">
        {SOURCE_LABELS[source]}
      </span>
      {onSearch && (
        <button
          type="button"
          onClick={onSearch}
          className="w-8 h-8 flex items-center justify-center rounded-full text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
        >
          <Search size={14} />
        </button>
      )}
    </div>
  ),
);

/* ── Shared: dynamic background ───────────────────────────── */

const FullscreenBackground = React.memo(
  ({
    artworkSources,
    trackKey,
    color,
  }: {
    artworkSources: string[];
    trackKey: string;
    color: [number, number, number];
  }) => {
    const { currentSrc, handleError } = useFallbackImageSource(artworkSources, trackKey);
    const [r, g, b] = color;
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        {currentSrc ? (
          <>
            <img
              src={currentSrc}
              alt=""
              className="w-full h-full object-cover scale-[1.2] blur-[72px] opacity-24 saturate-[1.18]"
              loading="eager"
              decoding="async"
              fetchPriority="low"
              onError={handleError}
            />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(8,8,10,0.06)_0%,rgba(8,8,10,0.5)_62%,rgba(8,8,10,0.82)_100%)]" />
          </>
        ) : (
          <div
            className="absolute inset-0"
            style={{
              background: `
                radial-gradient(ellipse at 25% 50%, rgba(${r},${g},${b},0.2) 0%, transparent 60%),
                radial-gradient(ellipse at 75% 70%, rgba(${r},${g},${b},0.12) 0%, transparent 50%)
              `,
            }}
          />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,8,10,0.3)_0%,rgba(8,8,10,0.56)_48%,rgba(8,8,10,0.84)_100%)]" />
      </div>
    );
  },
);

/* ── Fullscreen Visualizer ────────────────────────────────── */

const FullscreenVisualizer = React.memo(() => {
  const w = useSettingsStore((s) => s.visualizerWidth);
  const op = useSettingsStore((s) => s.visualizerOpacity);
  const fade = useSettingsStore((s) => s.visualizerFade);
  const fadeStart = Math.max(30, 64 - fade * 0.22);
  const fadeMid = Math.max(fadeStart + 16, 82 - fade * 0.18);
  const mask = `linear-gradient(to top, black 0%, black ${fadeStart}%, rgba(0,0,0,0.84) ${fadeMid}%, transparent 100%)`;
  const glowOpacity = Math.min(0.88, op / 100);

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-0 pointer-events-none overflow-visible"
      style={{
        height: '46%',
        minHeight: '280px',
        maxHeight: '480px',
      }}
    >
      <div
        className="absolute bottom-0 left-1/2 h-full -translate-x-1/2 overflow-visible mix-blend-screen"
        style={{
          width: `${w}%`,
          opacity: glowOpacity,
          maskImage: mask,
          WebkitMaskImage: mask,
          filter:
            'drop-shadow(0 0 18px var(--color-accent-glow)) drop-shadow(0 0 44px rgba(255,255,255,0.1))',
        }}
      >
      </div>
    </div>
  );
});

/* ── Shared: like button (for fullscreen panels) ──────────── */

const FullscreenLikeButton = React.memo(({ track, compact }: { track: Track; compact?: boolean }) => {
  const likedFromStore = useLiked(track.urn);
  const qc = useQueryClient();
  const { data: trackData } = useQuery({
    queryKey: ['track', track.urn],
    queryFn: () => api<Track>(`/tracks/${encodeURIComponent(track.urn)}`),
    enabled: !!track.urn,
    staleTime: 30_000,
  });
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const prevUrnRef = useRef(track.urn);

  if (prevUrnRef.current !== track.urn) {
    prevUrnRef.current = track.urn;
    setLikedOverride(null);
  }

  const isLiked =
    likedOverride ??
    (trackData ? Boolean(trackData.user_favorite) : likedFromStore || Boolean(track.user_favorite));

  const toggle = async () => {
    const next = !isLiked;
    setLikedOverride(next);
    optimisticToggleLike(qc, trackData ?? track, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(track.urn)}`, {
        method: next ? 'POST' : 'DELETE',
      });
      qc.invalidateQueries({ queryKey: ['track', track.urn, 'favoriters'] });
    } catch {
      setLikedOverride(!next);
      optimisticToggleLike(qc, trackData ?? track, !next);
    }
  };

  const buttonClass = compact
    ? 'flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/58 transition-all duration-200 outline-none hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white active:scale-[0.97]'
    : 'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.06] outline-none';

  return (
    <button
      type="button"
      onClick={toggle}
      className={`${buttonClass} ${
        isLiked ? 'text-accent' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Heart size={compact ? 16 : 20} fill={isLiked ? 'currentColor' : 'none'} />
    </button>
  );
});

/* ── Shared: dislike button (for fullscreen panels) ────────── */

const FullscreenDislikeButton = React.memo(({ track, compact }: { track: Track; compact?: boolean }) => {
  const trackUrn = track.urn;
  const isDisliked = useDislikesStore((s) => s.dislikedTrackUrns.includes(trackUrn));
  const toggle = useDislikesStore((s) => s.toggleDislike);
  const next = usePlayerStore((s) => s.next);

  const handleToggle = () => {
    toggle(trackUrn);
    if (!isDisliked) {
      const sw = useSoundWaveStore.getState();
      if (sw.isActive) {
        sw.recordFeedback(track, 'negative');
      }
      next();
    }
  };

  const buttonClass = compact
    ? 'flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/58 transition-all duration-200 outline-none hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white active:scale-[0.97]'
    : 'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.06] outline-none';

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`${buttonClass} ${
        isDisliked ? 'text-red-500' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Ban size={compact ? 16 : 18} />
    </button>
  );
});

/* ── Shared: volume slider (for fullscreen panels) ─────────── */

const FullscreenVolumeSlider = React.memo(() => {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

return (
  <div
    className="flex w-full max-w-[320px] items-center gap-2 group/vol"
    onWheel={(event) => {
      if (event.cancelable) {
        event.preventDefault();
      }

      setVolume(
        Math.max(0, Math.min(100, volume + (event.deltaY < 0 ? 1 : -1))),
      );
    }}
  >
    <button
      type="button"
      onClick={() => setVolume(volume > 0 ? 0 : 100)}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-150 ${
        volume === 0
          ? 'text-accent'
          : 'text-white/40 hover:text-white/70'
      }`}
    >
      {volume === 0 ? (
        <VolumeX className="h-4 w-4" />
      ) : volume < 50 ? (
        <Volume className="h-4 w-4" />
      ) : (
        <Volume2 className="h-4 w-4" />
      )}
    </button>

    <div className="flex-1 relative flex items-center h-5">
      <Slider.Root
        className="relative flex items-center h-full w-full cursor-pointer select-none touch-none"
        value={[volume]}
        max={100}
        step={1}
        onValueChange={([v]) => setVolume(v)}
      >
        <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover/vol:h-[4px] transition-all duration-150">
          <Slider.Range className="absolute h-full rounded-full bg-white/40" />
        </Slider.Track>

        <Slider.Thumb className="block w-2.5 h-2.5 rounded-full bg-white transition-all duration-150 outline-none scale-0 opacity-0 group-hover/vol:scale-100 group-hover/vol:opacity-100" />
      </Slider.Root>
    </div>
<span
  className={`w-[36px] text-right text-[11px] tabular-nums translate-x-0.1 ${
    volume > 100 ? 'text-amber-400/70' : 'text-white/35'
  }`}
>
  {volume}%
</span>
  </div>
);
});



/* ── Shared: transport controls + like ────────────────────── */

const Controls = React.memo(({ track }: { track: Track }) => {
  const { t } = useTranslation();

  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  const next = usePlayerStore((s) => s.next);
  const handlePrev = usePlayerStore((s) => s.prev);

  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);

  const nextLocked = useTrackSwitchCooldown(TRACK_SWITCH_NEXT_SCOPE);
  const prevLocked = useTrackSwitchCooldown(TRACK_SWITCH_PREV_SCOPE);

  const ctrl =
    'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer hover:bg-white/[0.06] outline-none';

  const handleOpenInSoundCloud = () => {
    void (async () => {
      const permalink = await resolveTrackPermalink(track);

      if (!permalink) return;

      await openExternal(permalink);
    })();
  };

  return (
    <div className="flex items-center justify-center gap-2">
      <AddToPlaylistDialog trackUrn={track.urn}>
        <button type="button" className={ctrl}>
          <ListPlus
            size={20}
            className="text-white/30 hover:text-white/60"
          />
        </button>
      </AddToPlaylistDialog>

      <FullscreenLikeButton track={track} />

      <button
        type="button"
        onClick={toggleShuffle}
        className={`${ctrl} ${
          shuffle
            ? 'text-accent'
            : 'text-white/35 hover:text-white/60'
        }`}
      >
        {shuffleIcon16}
      </button>

      <button
        type="button"
        onClick={handlePrev}
        disabled={prevLocked}
        className={`${ctrl} ${
          prevLocked
            ? 'text-white/30 cursor-default'
            : 'text-white/60 hover:text-white'
        }`}
      >
        <SkipBack
          size={20}
          fill="currentColor"
        />
      </button>

      <button
        type="button"
        onClick={togglePlay}
        className="w-14 h-14 rounded-full bg-white flex items-center justify-center hover:scale-105 active:scale-95 transition-all duration-200 cursor-pointer shadow-lg outline-none mx-2"
      >
        {isPlaying
          ? pauseBlack18
          : playBlack18}
      </button>

      <button
        type="button"
        onClick={next}
        disabled={nextLocked}
        className={`${ctrl} ${
          nextLocked
            ? 'text-white/30 cursor-default'
            : 'text-white/60 hover:text-white'
        }`}
      >
        <SkipForward
          size={20}
          fill="currentColor"
        />
      </button>

      <button
        type="button"
        onClick={toggleRepeat}
        className={`${ctrl} ${
          repeat !== 'off'
            ? 'text-accent'
            : 'text-white/35 hover:text-white/60'
        }`}
      >
        {repeat === 'one'
          ? repeat1Icon16
          : repeatIcon16}
      </button>

      <FullscreenDislikeButton track={track} />

      <button
        type="button"
        className={ctrl}
        onClick={handleOpenInSoundCloud}
        title={t(
          'player.openInSoundCloud',
          'Open in SoundCloud',
        )}
      >
        <ExternalLink
          size={18}
          className="text-white/30 hover:text-white/60"
        />
      </button>
    </div>
  );
});

/* ── Shared: artwork + info + slider + controls column ────── */

const ArtworkLightbox = React.memo(
  ({
    track,
    open,
    source,
    anchorRect,
    sourceElement,
    onAfterClose,
    onClose,
  }: {
    track: Track;
    open: boolean;
    source: ArtworkLightboxSource;
    anchorRect: ArtworkLightboxRect | null;
    sourceElement: HTMLElement | null;
    onAfterClose?: () => void;
    onClose: () => void;
  }) => {
    const { t } = useTranslation();
    const fullscreenArtSources = getTrackFullscreenArtworkSources(track);
    const [fullscreenArtIndex, setFullscreenArtIndex] = useState(0);
    const [mounted, setMounted] = useState(open);
    const [chromeVisible, setChromeVisible] = useState(open);
    const [frameRect, setFrameRect] = useState<ArtworkLightboxRect | null>(null);
    const [animationPhase, setAnimationPhase] = useState<'idle' | 'opening' | 'open' | 'closing'>(
      open ? 'open' : 'idle',
    );
    const placeholderRef = useRef<HTMLDivElement | null>(null);
    const settleTimerRef = useRef<number | null>(null);
    const rafOneRef = useRef<number | null>(null);
    const rafTwoRef = useRef<number | null>(null);
    const anchorRectRef = useRef<ArtworkLightboxRect | null>(anchorRect);
    const sourceElementRef = useRef<HTMLElement | null>(sourceElement);
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    useEffect(() => {
      setFullscreenArtIndex(0);
    }, [open, track.urn]);

    useEffect(() => {
      if (!mounted) return;
      const handler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [mounted, onClose]);

    const fullscreenArtSrc = fullscreenArtSources[fullscreenArtIndex] ?? null;

    useEffect(() => {
      if (!open) return;
      anchorRectRef.current = anchorRect;
      sourceElementRef.current = sourceElement;
    }, [anchorRect, open, sourceElement]);

    useEffect(() => {
      return () => {
        if (settleTimerRef.current !== null) {
          window.clearTimeout(settleTimerRef.current);
        }
        if (rafOneRef.current !== null) {
          window.cancelAnimationFrame(rafOneRef.current);
        }
        if (rafTwoRef.current !== null) {
          window.cancelAnimationFrame(rafTwoRef.current);
        }
      };
    }, []);

    useEffect(() => {
      if (!fullscreenArtSrc || typeof document === 'undefined') {
        setMounted(false);
        setAnimationPhase('idle');
        return;
      }

      if (open) {
        setMounted(true);
      } else if (mounted && animationPhase !== 'closing') {
        setAnimationPhase('closing');
        setChromeVisible(false);
      }
    }, [animationPhase, fullscreenArtSrc, mounted, open]);

    const clearAnimationTimers = () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      if (rafOneRef.current !== null) {
        window.cancelAnimationFrame(rafOneRef.current);
        rafOneRef.current = null;
      }
      if (rafTwoRef.current !== null) {
        window.cancelAnimationFrame(rafTwoRef.current);
        rafTwoRef.current = null;
      }
    };

    useLayoutEffect(() => {
      if (!mounted || !fullscreenArtSrc) return;

      const placeholderRect = measureArtworkRect(placeholderRef.current);

      if (!placeholderRect) return;

      clearAnimationTimers();

      const finalRect = {
        ...placeholderRect,
        radius: 24,
      } satisfies ArtworkLightboxRect;

      if (open) {
        if (prefersReducedMotion) {
          setFrameRect(finalRect);
          setChromeVisible(true);
          setAnimationPhase('open');
          return;
        }

        const startRect = shrinkArtworkRect(anchorRectRef.current ?? finalRect);
        setAnimationPhase('opening');
        setChromeVisible(false);
        setFrameRect(startRect);

        rafOneRef.current = window.requestAnimationFrame(() => {
          rafTwoRef.current = window.requestAnimationFrame(() => {
            setChromeVisible(true);
            setFrameRect(finalRect);
            settleTimerRef.current = window.setTimeout(() => {
              setAnimationPhase('open');
              settleTimerRef.current = null;
            }, 760);
          });
        });

        return;
      }

      if (prefersReducedMotion) {
        setMounted(false);
        setFrameRect(null);
        setAnimationPhase('idle');
        onAfterClose?.();
        return;
      }

      const closingRect =
        measureArtworkRect(sourceElementRef.current) ??
        anchorRectRef.current ??
        shrinkArtworkRect(finalRect);

      setAnimationPhase('closing');
      setFrameRect(finalRect);

      rafOneRef.current = window.requestAnimationFrame(() => {
        rafTwoRef.current = window.requestAnimationFrame(() => {
          setFrameRect({
            ...closingRect,
            radius: closingRect.radius || 24,
          });
          settleTimerRef.current = window.setTimeout(() => {
            setMounted(false);
            setFrameRect(null);
            setAnimationPhase('idle');
            settleTimerRef.current = null;
            onAfterClose?.();
          }, 860);
        });
      });
    }, [fullscreenArtSrc, mounted, onAfterClose, open, prefersReducedMotion]);

    if (!mounted || !fullscreenArtSrc || typeof document === 'undefined') {
      return null;
    }

    const isMiniPlayerSource = source === 'lyrics-mini-player';
    const isOpening = animationPhase === 'opening';
    const frameInlineStyle = frameRect
      ? {
          top: `${frameRect.top}px`,
          left: `${frameRect.left}px`,
          width: `${frameRect.width}px`,
          height: `${frameRect.height}px`,
          borderRadius: `${frameRect.radius}px`,
        }
      : undefined;
    const glowClassName = chromeVisible
      ? 'opacity-80 scale-100 blur-[76px]'
      : 'opacity-0 scale-[0.96] blur-[60px]';
    const metaClassName = chromeVisible
      ? 'translate-y-0 scale-100 opacity-100 blur-0'
      : 'translate-y-2 scale-[0.985] opacity-0 blur-[2px]';
    const frameShellClassName =
      isOpening && !chromeVisible
        ? 'border-transparent bg-black/0 shadow-[0_0_0_rgba(0,0,0,0)]'
        : 'border-white/12 bg-black/30 shadow-[0_44px_160px_rgba(0,0,0,0.72)]';

    return createPortal(
      <div className="fixed inset-0 z-[240] overflow-hidden">
        <button
          type="button"
          aria-label={t('common.close', 'Close')}
          className={`absolute inset-0 bg-black/88 backdrop-blur-xl transition-[opacity,backdrop-filter] duration-[820ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
            chromeVisible ? 'opacity-100 backdrop-blur-xl' : 'opacity-0 backdrop-blur-0'
          }`}
          onClick={onClose}
        />

        <button
          type="button"
          onClick={onClose}
          className={`absolute right-5 top-5 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white transition-all duration-300 ease-[var(--ease-apple)] hover:scale-[1.04] hover:bg-white/18 ${
            chromeVisible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
          }`}
          aria-label={t('common.close', 'Close')}
        >
          <X size={20} />
        </button>

        <div className="pointer-events-none absolute inset-0 z-10 flex max-h-full w-full flex-col items-center justify-center gap-5 p-6 sm:p-10">
          <div
            className={`pointer-events-none absolute inset-x-[18%] top-[14%] bottom-[18%] rounded-[44px] bg-white/[0.06] transition-[opacity,transform,filter] duration-[820ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${glowClassName}`}
          />
          <div
            ref={placeholderRef}
            aria-hidden="true"
            className="aspect-square w-[min(calc(100vw-3rem),calc(100vh-7.5rem))] max-h-[calc(100vh-7.5rem)] max-w-full opacity-0 sm:w-[min(calc(100vw-6rem),calc(100vh-9rem))]"
          />

          <div
            className={`pointer-events-none origin-center w-[min(560px,calc(100vw-2.5rem))] transition-[opacity,transform,filter] duration-[820ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${metaClassName}`}
          >
            <div className="mx-auto flex w-fit max-w-full flex-col items-center gap-0.5 rounded-[22px] border border-white/10 bg-black/42 px-4 py-3 text-center shadow-[0_18px_48px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-opacity duration-[820ms] ease-[cubic-bezier(0.16,1,0.3,1)]">
              <p className="max-w-[min(480px,calc(100vw-5rem))] truncate text-lg font-bold text-white/92">
                {track.title}
              </p>
              <p className="max-w-[min(440px,calc(100vw-5rem))] truncate text-sm text-white/48">
                {track.user.username}
              </p>
            </div>
          </div>
        </div>

        {frameRect ? (
          <div
            className={`pointer-events-auto fixed z-[15] overflow-hidden transition-[top,left,width,height,border-radius,box-shadow,background-color,border-color] duration-[720ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${frameShellClassName}`}
            style={frameInlineStyle}
            data-sc-context-image-url={fullscreenArtSrc}
            data-sc-context-image-alt={`${track.user.username} - ${track.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={fullscreenArtSrc}
              alt={track.title}
              data-sc-context-image-url={fullscreenArtSrc}
              data-sc-context-image-alt={`${track.user.username} - ${track.title}`}
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className={`h-full w-full object-cover transition-[transform,filter,opacity] duration-[720ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isOpening && !chromeVisible
                  ? isMiniPlayerSource
                    ? 'scale-[1.04] opacity-[0.6] blur-[10px]'
                    : 'scale-[1.015] opacity-[0.72] blur-[6px]'
                  : 'scale-100 opacity-100 blur-0'
              }`}
              onError={() => {
                setFullscreenArtIndex((current) =>
                  current + 1 < fullscreenArtSources.length ? current + 1 : current,
                );
              }}
            />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0)_18%,rgba(0,0,0,0.06)_100%)]" />
          </div>
        ) : null}
      </div>,
      document.body,
    );
  },
);

const TrackColumn = React.memo(({
  track,
  maxArt,
  onOpenArtworkLightbox,
}: {
  track: Track;
  maxArt?: string;
  onOpenArtworkLightbox?: (sourceElement: HTMLElement | null) => void;
}) => {
  const { t } = useTranslation();
  const previewArtSources = uniqueArtworkSources([
    ...getTrackArtworkSources(track, 't200x200'),
    ...getTrackArtworkSources(track, 't500x500'),
  ]);
  const displayArtSources = uniqueArtworkSources([
    ...getTrackArtworkSources(track, 't500x500'),
    ...getTrackArtworkSources(track, 't200x200'),
  ]);
  const previewArtBase = previewArtSources[0] ?? null;
  const displayArtBase = displayArtSources[0] ?? null;
  const displayArtSourcesKey = displayArtSources.join('|');
  const { currentSrc: previewArtSrc, handleError: handlePreviewArtError } = useFallbackImageSource(
    previewArtSources,
    `${track.urn}:preview`,
  );
  const { currentSrc: displayArtSrc, handleError: handleDisplayArtError } = useFallbackImageSource(
    displayArtSources,
    `${track.urn}:display`,
  );
  const [loaded, setLoaded] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const prevUrnRef = useRef<string | null>(track.urn);
  const mountedRef = useRef(false);
  const switchTimerRef = useRef<number | null>(null);
  const artworkFrameRef = useRef<HTMLDivElement | null>(null);

  const clearSwitching = () => {
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = null;
    }
    setIsSwitching(false);
  };

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    if (prevUrnRef.current !== track.urn) {
      prevUrnRef.current = track.urn;
      setLoaded(false);

      const shouldBlurTransition = Boolean(
        previewArtBase && displayArtBase && previewArtBase !== displayArtBase,
      );
      setIsSwitching(shouldBlurTransition);

      if (shouldBlurTransition) {
        if (switchTimerRef.current !== null) {
          window.clearTimeout(switchTimerRef.current);
        }
        switchTimerRef.current = window.setTimeout(() => {
          setIsSwitching(false);
          switchTimerRef.current = null;
        }, 2200);
      }
    }
  }, [track.urn, displayArtBase, previewArtBase]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const urls = displayArtSources.slice(0, 2);
    const preloadedImages: HTMLImageElement[] = [];

    for (const [index, url] of urls.entries()) {
      const img = new window.Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = index === 0 ? 'high' : 'auto';
      img.src = url;
      preloadedImages.push(img);
    }

    return () => {
      for (const img of preloadedImages) {
        img.src = '';
      }
    };
  }, [displayArtSourcesKey, track.urn]);

  const hasArtwork = Boolean(previewArtSrc || displayArtSrc);
  // Artwork can grow large with viewport height (driven by maxArt prop).
  // Title/slider/controls/volume-panel keep a tighter readable width — wide
  // sliders and centered text on a 640px column look unbalanced.
const artMaxWidthClass = `w-full ${maxArt ?? 'max-w-[280px]'}`;
const columnMaxWidthClass = `w-full max-w-[320px]`;
const columnWidthTransitionStyle = {
    transition: 'max-width 500ms cubic-bezier(0.22, 1, 0.36, 1)',
  } satisfies React.CSSProperties;
  return (
    <div className="relative z-10 flex h-full min-h-0 w-full flex-col items-center justify-center gap-[clamp(10px,1.6vh,28px)] overflow-y-auto px-12 py-6">
      <div
        className={`${artMaxWidthClass} aspect-square rounded-[24px] overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/[0.08] relative group/art`}
        data-sc-disable-context-image="true"
        style={columnWidthTransitionStyle}
      >
        {hasArtwork ? (
          <>
            <div
              ref={artworkFrameRef}
              className="absolute inset-0 overflow-hidden rounded-[24px]"
              style={columnWidthTransitionStyle}
            >
              {/* Low-res placeholder (Blur applied only during track switch) */}
              <img
                src={previewArtSrc || displayArtSrc || ''}
                alt=""
                loading="eager"
                decoding="async"
                fetchPriority="high"
                onError={handlePreviewArtError}
                className={`absolute inset-0 w-full h-full object-cover scale-110 transition-[transform,opacity,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ease-[var(--ease-apple)] ${
                  isSwitching ? 'blur-2xl scale-125' : ''
                } ${loaded ? 'opacity-0' : 'opacity-100'}`}
              />
              {/* High-res image */}
              <img
                src={displayArtSrc || previewArtSrc || ''}
                alt=""
                loading="eager"
                decoding="async"
                fetchPriority="high"
                onLoad={() => {
                  setLoaded(true);
                  clearSwitching();
                }}
                onError={() => {
                  setLoaded(false);
                  handleDisplayArtError();
                  clearSwitching();
                }}
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ease-[var(--ease-apple)] ${loaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </div>

            {/* Hover Overlay with View Icon */}
            {onOpenArtworkLightbox ? (
              <button
                type="button"
                onClick={() => onOpenArtworkLightbox(artworkFrameRef.current)}
                data-sc-disable-context-image="true"
                className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0)_34%),linear-gradient(180deg,rgba(0,0,0,0.12)_0%,rgba(0,0,0,0.4)_100%)] opacity-0 group-hover/art:opacity-100 transition-opacity duration-300 flex items-center justify-center text-white/90 backdrop-blur-sm cursor-pointer outline-none"
              >
                <div className="flex flex-col items-center gap-2 scale-90 group-hover/art:scale-100 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/18 bg-white/[0.16] shadow-[0_10px_32px_rgba(0,0,0,0.24)]">
                    <Eye size={24} />
                  </div>
                  <span className="text-[11px] font-bold tracking-[0.2em] uppercase opacity-72">
                    {t('track.viewArtwork', 'View')}
                  </span>
                </div>
              </button>
            ) : null}
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
            <MicVocal size={48} className="text-white/10" />
          </div>
        )}
      </div>

      <div
        className={`${columnMaxWidthClass} text-center space-y-1`}
        style={columnWidthTransitionStyle}
      >
        <p className="text-[18px] font-bold text-white/95 truncate">{track.title}</p>
        <p className="text-[14px] text-white/40 truncate">{track.user.username}</p>
      </div>

      <div className={columnMaxWidthClass} style={columnWidthTransitionStyle}>
        <ProgressSlider />
        <div className="flex justify-center mt-1">
          <ProgressTime />
        </div>
      </div>

      <div className="relative z-20">
        <Controls track={track} />
      </div>

      <div
        className={`relative z-20 flex ${columnMaxWidthClass} flex-col items-center gap-3 rounded-[22px] border border-white/[0.08] bg-black/28 px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-lg`}
        style={columnWidthTransitionStyle}
      >
        <FullscreenVolumeSlider />
        <PlaybackSpeedPresets variant="compact" />
      </div>
    </div>
  );
});

/* ── Shared: color hook ───────────────────────────────────── */

function useArtworkColor(artworkUrl: string | null) {
  return (
    useArtworkGradientPalette(artworkUrl)?.accent ?? getFallbackArtworkGradientPalette().accent
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(value, 1));
}

function getSmoothLyricTime(): number {
  try {
    return getSmoothCurrentTime();
  } catch {
    return getCurrentTime();
  }
}

const LYRIC_ACTIVE_TIME_BIAS_PER_RATE = 0.11;
const LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC = -0.03;
const LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC = 0.08;

function getActiveLyricTime(rawTime: number): number {
  const smoothTime = getSmoothLyricTime();
  const playbackRate = Math.max(
    PLAYBACK_RATE_MIN,
    Math.min(PLAYBACK_RATE_MAX, usePlayerStore.getState().playbackRate),
  );
  const smoothLead = smoothTime - rawTime;
  const rateBias = (1 - playbackRate) * LYRIC_ACTIVE_TIME_BIAS_PER_RATE;
  const correctedLead = Math.max(
    LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC,
    Math.min(LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC, smoothLead + rateBias),
  );
  return Math.max(0, rawTime + correctedLead);
}

function stabilizeCharProgress(value: number) {
  const clamped = clamp01(value);
  if (clamped >= 0.996) return 1;
  if (clamped <= 0.001) return 0;
  return clamped;
}

function getLyricCharOnsetFactor(headPosition: number) {
  return clamp01(headPosition / 1.4);
}

const LYRIC_TRAIL_CHAR_SPAN = 4.4;
const LYRIC_CURSOR_CHAR_SPAN = 1.7;

function getLyricAnimatedCharCount(lineEl: HTMLElement) {
  const raw = Number(lineEl.dataset.charCount ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getLyricTransitionWindow(progress: number, charCount: number) {
  const safeProgress = clamp01(progress);
  const safeCharCount = Math.max(1, charCount);
  const tailSpan = Math.max(3.2, Math.min(LYRIC_TRAIL_CHAR_SPAN, safeCharCount * 0.2));
  const cursorSpan = Math.max(1.05, Math.min(LYRIC_CURSOR_CHAR_SPAN, tailSpan * 0.46));
  const charUnit = 1 / safeCharCount;

  return {
    tailStart: safeProgress,
    tailEnd: clamp01(safeProgress + tailSpan * charUnit),
    cursorStart: clamp01(safeProgress - cursorSpan * charUnit * 0.34),
    cursorEnd: clamp01(safeProgress + cursorSpan * charUnit * 0.92),
  };
}

function applyLyricProgressStyle(lineEl: HTMLElement, progress: number) {
  const safeProgress = clamp01(progress);
  const { tailStart, tailEnd, cursorStart, cursorEnd } = getLyricTransitionWindow(
    safeProgress,
    getLyricAnimatedCharCount(lineEl),
  );

  lineEl.style.setProperty('--lyric-progress', `${safeProgress * 100}%`);
  lineEl.style.setProperty('--lyric-progress-value', `${safeProgress}`);
  lineEl.style.setProperty('--lyric-tail-start', `${tailStart}`);
  lineEl.style.setProperty('--lyric-tail-end', `${tailEnd}`);
  lineEl.style.setProperty('--lyric-cursor-start', `${cursorStart}`);
  lineEl.style.setProperty('--lyric-cursor-end', `${cursorEnd}`);
  lineEl.style.setProperty(
    '--lyric-cursor-opacity',
    safeProgress > 0.001 && safeProgress < 0.999 ? '1' : '0',
  );
}

function syncLyricCharProgress(charEl: HTMLElement, progress: number) {
  const clamped = stabilizeCharProgress(progress);
  const easedProgress = clamped * clamped * (3 - 2 * clamped);
  const charState = easedProgress >= 0.996 ? 'active' : easedProgress > 0 ? 'fading' : '';
  const blurPx = (1 - easedProgress) * 7;
  const offsetEm = (1 - easedProgress) * 0.18;
  const scale = 0.92 + easedProgress * 0.08;

  charEl.style.setProperty('--char-progress', `${easedProgress}`);
  charEl.style.opacity = `${0.18 + easedProgress * 0.82}`;
  charEl.style.transform = `translate3d(0, ${offsetEm.toFixed(3)}em, 0) scale(${scale.toFixed(3)})`;
  charEl.style.filter = `blur(${blurPx.toFixed(3)}px)`;
  charEl.dataset.charState = charState;
}

function getLyricMotionWeight(text: string | undefined) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0.6;
  return Math.max(0.72, Math.min(normalized.length / 16, 1.65));
}

function countLyricVowels(value: string) {
  return (value.match(/[aeiouyаеёиоуыэюя]/giu) || []).length;
}

function getRapLineBoost(text: string | undefined) {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0;

  const tokens = normalized.split(' ').filter(Boolean);
  const vowels = countLyricVowels(normalized);
  const cyr = (normalized.match(/[а-яё]/giu) || []).length;
  const lat = (normalized.match(/[a-z]/giu) || []).length;
  const denseLanguage = cyr > 0 || lat > 0;
  const languageBoost = cyr > 0 && lat > 0 ? 0.2 : denseLanguage ? 0.12 : 0;
  const rapidMarkers =
    /\b(yeah|hey|go|get|run|drop|drip|flow|fast|дай|бей|эй|го|лети|пау|пау|рау|скрт)\b/iu.test(
      normalized,
    )
      ? 0.12
      : 0;
  const repeatedEdges =
    (normalized.match(/[бвгджзйклмнпрстфхцчшщbcdfghjklmnpqrstvwxyz]/giu) || []).length /
    Math.max(normalized.length, 1);
  const density =
    tokens.length * 0.11 + vowels * 0.03 + repeatedEdges * 0.9 + languageBoost + rapidMarkers;

  return clamp01((density - 0.72) / 0.9);
}

function getReactiveLyricDrive(features: AudioFeatures | null, rapBoost = 0) {
  if (!features) {
    return {
      speedMultiplier: 1 + rapBoost * 0.12,
      onsetPull: rapBoost * 0.12,
    };
  }

  const flux = clamp01((features.flux - 0.02) / 0.11);
  const mids = clamp01(features.midPresence ?? 0);
  const bass = clamp01(features.subBass ?? 0);
  const dynamics = clamp01(features.dynamicRange ?? 0);
  const stability = clamp01(features.rhythmicStability ?? 0.5);
  const arousal = clamp01(features.arousal);
  const bpmDrive = clamp01(((features.bpm || 0) - 84) / 72);
  const rapPresence = clamp01(
    mids * 0.34 + flux * 0.28 + bpmDrive * 0.18 + dynamics * 0.12 + rapBoost * 0.48,
  );

  const dropDrive = clamp01(
    bass * 0.24 +
      dynamics * 0.22 +
      arousal * 0.17 +
      flux * 0.14 +
      bpmDrive * 0.08 +
      stability * 0.07 +
      rapBoost * 0.22,
  );
  const onsetPull = clamp01(
    flux * 0.46 +
      mids * 0.18 +
      dynamics * 0.12 +
      stability * 0.08 +
      rapPresence * 0.26 +
      rapBoost * 0.14,
  );

  return {
    speedMultiplier: 1 + dropDrive * 0.34 + onsetPull * 0.18 + rapPresence * 0.32 + rapBoost * 0.22,
    onsetPull,
  };
}

function getAnimatedLineProgress(
  lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[],
  idx: number,
  time: number,
  reactiveMode: boolean,
  features: AudioFeatures | null,
  hintBoost = 0,
) {
  const currentLine = lines[idx];
  if (!currentLine) return 0;

  const nextLine = lines[idx + 1];
  const prevLine = lines[idx - 1];
  const rawDuration = Math.max((nextLine?.time ?? currentLine.time + 2.4) - currentLine.time, 0.35);
  const rawProgress = clamp01((time - currentLine.time) / rawDuration);
  if (!reactiveMode) return rawProgress;

  const prevDuration = prevLine ? Math.max(currentLine.time - prevLine.time, 0.35) : rawDuration;
  const prevWeight = getLyricMotionWeight(prevLine?.text);
  const currentWeight = getLyricMotionWeight(currentLine.text);
  const rapBoost = getRapLineBoost(currentLine.text);
  const continuityDuration = Math.max(
    0.32,
    Math.min(
      rawDuration,
      prevDuration *
        clamp01(currentWeight / Math.max(prevWeight, 0.001)) *
        (1.25 - rapBoost * 0.18),
    ),
  );
  const { speedMultiplier, onsetPull } = getReactiveLyricDrive(features, rapBoost);
  const boostedDuration = Math.max(
    0.2,
    continuityDuration / (speedMultiplier + hintBoost * 0.22 + rapBoost * 0.3),
  );
  const boostedProgress = clamp01((time - currentLine.time) / boostedDuration);
  const blendedProgress = Math.max(rawProgress, boostedProgress);

  return clamp01(
    blendedProgress +
      (1 - blendedProgress) * onsetPull * (0.18 + hintBoost * 0.06 + rapBoost * 0.08),
  );
}

function getMotionHintBoost(
  motionHints: Array<{ index: number; importance: number; density: number; onsetBias: number }>,
  idx: number,
) {
  let best = 0;
  for (const hint of motionHints) {
    const distance = Math.abs(hint.index - idx);
    if (distance > 2) continue;
    const proximity = distance === 0 ? 1 : distance === 1 ? 0.58 : 0.24;
    const score = (hint.importance * 0.5 + hint.density * 0.28 + hint.onsetBias * 0.22) * proximity;
    if (score > best) best = score;
  }
  return clamp01(best / 1.45);
}

function getMotionHintFloor(
  motionHints: Array<{ importance: number; onsetBias: number; density?: number }>,
) {
  if (!motionHints.length) return 1;
  const peak = Math.max(
    ...motionHints.map(
      (hint) => hint.importance * 0.56 + hint.onsetBias * 0.24 + (hint.density ?? 0) * 0.2,
    ),
  );
  return 1 + clamp01(peak / 1.95) * 0.13;
}

function getAudioTextHintLabel(motionHints: Array<{ language: string }>) {
  const hasRu = motionHints.some((hint) => hint.language === 'ru' || hint.language === 'mixed');
  const hasEn = motionHints.some((hint) => hint.language === 'en' || hint.language === 'mixed');
  if (hasRu && hasEn) return 'RU/EN';
  if (hasRu) return 'RU';
  if (hasEn) return 'EN';
  return null;
}


function useWarmLyricMotionHints(
  trackUrn: string | undefined,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
  enabled: boolean,
) {
  const [motionHints, setMotionHints] = useState<ReturnType<typeof getLyricMotionHintsForTrack>>(
    [],
  );

  useEffect(() => {
    if (!enabled || !trackUrn || !lyrics?.synced?.length) {
      setMotionHints([]);
      return;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const next = getLyricMotionHintsForTrack(
        trackUrn,
        lyrics as { synced: LyricLine[] | null; plain: string | null; source: LyricsSource },
      );
      if (!cancelled) setMotionHints(next);
    };

    const idleApi = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (idleApi.requestIdleCallback) {
      const id = idleApi.requestIdleCallback(run, { timeout: 700 });
      return () => {
        cancelled = true;
        idleApi.cancelIdleCallback?.(id);
      };
    }

    const timeoutId = window.setTimeout(run, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [enabled, trackUrn, lyrics]);

  return motionHints;
}

function usePrimeLyricsSearch(
  track: Track | null | undefined,
  visible: boolean,
  reqArtist: string,
  reqTitle: string,
) {
  useEffect(() => {
    if (!visible || !track?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        track.urn,
        reqArtist,
        reqTitle,
        getLyricsSearchOptions(track, reqArtist, reqTitle, getTrackDurationMs(track)),
      ).catch(() => null);
    }, 20);
    return () => window.clearTimeout(timeoutId);
  }, [visible, track, reqArtist, reqTitle]);
}

function usePrefetchNextTrackLyrics(visible: boolean) {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);

  useEffect(() => {
    if (!visible) return;
    const nextTrack = queue[queueIndex + 1];
    if (!nextTrack?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        nextTrack.urn,
        nextTrack.user?.username ?? '',
        nextTrack.title ?? '',
        getLyricsSearchOptions(
          nextTrack,
          nextTrack.user?.username ?? '',
          nextTrack.title ?? '',
          getTrackDurationMs(nextTrack),
        ),
      ).catch(() => null);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [visible, queue, queueIndex]);
}

function useAudioTextWarmup(
  enabled: boolean,
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
) {
  usePrimeLyricsSearch(track, enabled, reqArtist, reqTitle);
  usePrefetchNextTrackLyrics(enabled);
  const motionHints = useWarmLyricMotionHints(
    track?.urn,
    lyrics,
    enabled && Boolean(lyrics?.synced?.length),
  );
  return {
    motionHints,
    hintLabel: enabled ? getAudioTextHintLabel(motionHints) : null,
  };
}

type DisplayLyricLine = LyricLine | { time: number; text: string; isPlaceholder: true };

const PAUSE_MARKER = '\u266A\u266A\u266A';
const NOTE_GRADIENT_DURATION_SEC = 3.2;

function isPauseMarkerText(text: string): boolean {
  const trimmed = String(text || '').trim();
  return trimmed.length === 0 || trimmed === '...' || trimmed === PAUSE_MARKER;
}

function buildDisplayLinesWithPausePlaceholders(lines: LyricLine[]): DisplayLyricLine[] {
  if (!lines || lines.length === 0) return [];

  const result: DisplayLyricLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (!isPauseMarkerText(current.text)) {
      result.push(current);
      continue;
    }

    let runEnd = i;
    while (runEnd + 1 < lines.length && isPauseMarkerText(lines[runEnd + 1].text)) {
      runEnd += 1;
    }

    result.push({
      ...current,
      text: PAUSE_MARKER,
    });

    i = runEnd;
  }

  return result;
}

function getPauseNoteAnimationDelay(time: number): string {
  const safeTime = Number.isFinite(time) ? Math.max(time, 0) : 0;
  const phase =
    ((safeTime % NOTE_GRADIENT_DURATION_SEC) + NOTE_GRADIENT_DURATION_SEC) %
    NOTE_GRADIENT_DURATION_SEC;
  return `-${phase.toFixed(3)}s`;
}

function getPauseNoteAnimationDurationSec(playbackRate: number): number {
  return NOTE_GRADIENT_DURATION_SEC / Math.max(playbackRate, 0.35);
}

type ReleaseSyncedLyricsLayout = 'default' | 'communityPreview';

const SyncedLyricsWithPlaceholders = React.memo(
  ({
    lines,
    layout = 'default',
  }: {
    lines: LyricLine[];
    layout?: ReleaseSyncedLyricsLayout;
  }) => {
  const displayLines = useMemo(() => buildDisplayLinesWithPausePlaceholders(lines), [lines]);

    return <ReleaseSyncedLyricsWithProgress lines={displayLines} layout={layout} />;
  },
);

function getCenteredLyricScrollTop(
  container: HTMLElement,
  el: HTMLElement,
  centerOffsetRatio = 0.05,
) {
  return (
    el.offsetTop -
    container.clientHeight / 2 +
    el.clientHeight / 2 +
    container.clientHeight * centerOffsetRatio
  );
}

const ReleaseSyncedLyricsWithProgress = React.memo(
  ({
    lines,
    layout = 'default',
  }: {
    lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[];
    layout?: ReleaseSyncedLyricsLayout;
  }) => {
    const playbackRate = usePlayerStore((s) => s.playbackRate);
    const targetFramerate = useSettingsStore((s) => s.targetFramerate);
    const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
    const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);
    const isCommunityPreviewLayout = layout === 'communityPreview';
    const centerOffsetRatio = isCommunityPreviewLayout ? 0 : 0.05;
    const [isUserScrolling, setIsUserScrolling] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [timeUntilLyrics, setTimeUntilLyrics] = useState(999);
    const [, setIntroExitProgress] = useState(0);
    const [firstLineOpacity, setFirstLineOpacity] = useState(1);
    const firstLineTime = lines[0]?.time ?? 0;

    const containerRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef(-1);
    const lastScrollTsRef = useRef(0);
    const manualScrollDetachedRef = useRef(false);
    const linesRef = useRef(lines);
    const lineElsRef = useRef<HTMLElement[]>([]);
    const linePauseBarsRef = useRef<Array<HTMLElement | null>>([]);
    const frameBudgetRef = useRef(getAnimationFrameBudgetMs(targetFramerate, unlockFramerate));
    const isUserScrollingRef = useRef(false);
    const userScrollTimeoutRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);
    const autoScrollTokenRef = useRef(0);
    linesRef.current = lines;
    frameBudgetRef.current = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);

    const syncUserScrollingState = (next: boolean) => {
      if (isUserScrollingRef.current === next) return;
      isUserScrollingRef.current = next;
      setIsUserScrolling(next);
    };

    const findActiveIndex = (source: typeof lines, time: number): number => {
      let lo = 0;
      let hi = source.length - 1;
      let ans = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (source[mid].time <= time + 0.02) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      return ans;
    };

    const getLineProgress = (idx: number, time: number) => {
      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const duration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      return clamp01((time - currentLine.time) / duration);
    };

    const updateLineProgress = (idx: number, progress: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;
      const currentLine = linesRef.current[idx];
      

      current.style.setProperty('--lyric-progress', `${progress * 100}%`);

      if (currentLine?.text.trim() === PAUSE_MARKER) {
        const progressBar = linePauseBarsRef.current[idx];
        if (progressBar) {
          progressBar.style.width = `${progress * 100}%`;
        }
      }
    };

    const applyStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = currentLine?.text.trim() === PAUSE_MARKER;

        let state = '';
        let filled = false;
        if (i === idx) {
          state = 'active';
        } else if (i < idx) {
          state = idx - i === 1 ? 'past-near' : 'past';
          filled = true;
        } else if (i > idx) {
          state = i - idx === 1 ? 'next-near' : 'next';
        }

        const stateChanged = el.dataset.state !== state;
        if (stateChanged) {
          el.dataset.state = state;
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        if (isPauseDisplay && stateChanged) {
          const progressBar = linePauseBarsRef.current[i];
          if (progressBar) {
            progressBar.style.width = filled ? '100%' : '0%';
          }
        }

        if (state !== 'active') {
          el.style.setProperty('--lyric-progress', filled ? '100%' : '0%');
        }
      }
    };

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      lineElsRef.current = Array.from(container.querySelectorAll<HTMLElement>('.lyric-line'));
      linePauseBarsRef.current = lineElsRef.current.map((el) =>
        el.querySelector<HTMLElement>('.pause-progress-bar'),
      );

      const clearUserScrollTimeout = () => {
        if (userScrollTimeoutRef.current !== null) {
          window.clearTimeout(userScrollTimeoutRef.current);
          userScrollTimeoutRef.current = null;
        }
      };

      const cancelAutoScrollAnimation = () => {
        autoScrollTokenRef.current += 1;
        if (autoScrollRafRef.current !== null) {
          cancelAnimationFrame(autoScrollRafRef.current);
          autoScrollRafRef.current = null;
        }
      };

      const scrollToActiveLine = (behavior: ScrollBehavior) => {
        const activeIdx = activeRef.current;
        if (activeIdx >= 0 && activeIdx < lineElsRef.current.length) {
          const el = lineElsRef.current[activeIdx];
          if (!el) return;
          const top = getCenteredLyricScrollTop(container, el, centerOffsetRatio);
          container.scrollTo({ top, behavior });
          lastScrollTsRef.current = performance.now();
          return;
        }

        if (activeIdx === -1) {
          container.scrollTo({ top: 0, behavior });
        }
      };

      const scheduleUserScrollReset = () => {
        clearUserScrollTimeout();
        userScrollTimeoutRef.current = window.setTimeout(() => {
          syncUserScrollingState(false);
          manualScrollDetachedRef.current = false;
          userScrollTimeoutRef.current = null;
          scrollToActiveLine('smooth');
        }, isCommunityPreviewLayout ? 2600 : 900);
      };

      const markManualScroll = () => {
        cancelAutoScrollAnimation();
        manualScrollDetachedRef.current = true;
        syncUserScrollingState(true);
        scheduleUserScrollReset();
      };

      const updateFirstLineOpacity = () => {
        // Fade out first line as user scrolls down (200px fade distance)
        const scrollY = container.scrollTop;
        const fadeDistance = 200;
        const opacity = Math.max(0, 1 - scrollY / fadeDistance);
        setFirstLineOpacity(opacity);
      };

      container.addEventListener('wheel', markManualScroll, { passive: true });
      container.addEventListener('touchmove', markManualScroll, { passive: true });
      container.addEventListener('scroll', updateFirstLineOpacity, { passive: true });
      updateFirstLineOpacity();

      activeRef.current = -1;
      manualScrollDetachedRef.current = false;

      let rafId = 0;
      let lastFrameTs = 0;

const tick = (ts: number) => {
  rafId = requestAnimationFrame(tick);

  const lineEls = lineElsRef.current;

  if (!container || lineEls.length === 0) return;
  if (isAppBackgrounded()) return;

  const effectiveBudgetMs = Math.max(frameBudgetRef.current || 0, 50);

  if (ts - lastFrameTs < effectiveBudgetMs) return;

  lastFrameTs = ts;

  const time = getCurrentTime();
  setTimeUntilLyrics(firstLineTime - time);
setIntroExitProgress(
  Math.max(
    0,
    Math.min(1, (time - (firstLineTime - 0.8)) / 0.8),
  ),
);
  const activeTime = getActiveLyricTime(time);
  const visualTime = getSmoothLyricTime();
  const currentLines = linesRef.current;

  const idx = findActiveIndex(currentLines, activeTime);
  const prev = activeRef.current;

if (idx !== activeRef.current) {
  activeRef.current = idx;
  setActiveIndex(idx);

        if (idx >= 0 && idx < lineEls.length) {
          const el = lineEls[idx];
      const top = getCenteredLyricScrollTop(container, el, centerOffsetRatio);
      const now = performance.now();

          if (!manualScrollDetachedRef.current) {
            const start = container.scrollTop;
            const target = top;
            cancelAutoScrollAnimation();
            const autoScrollToken = autoScrollTokenRef.current;

            let current = start;

            const animateScroll = () => {
              if (
                manualScrollDetachedRef.current ||
                autoScrollTokenRef.current !== autoScrollToken
              ) {
                autoScrollRafRef.current = null;
                return;
              }

              current += (target - current) * 0.085;

              container.scrollTop = current;

              if (Math.abs(target - current) > 0.5) {
                autoScrollRafRef.current = requestAnimationFrame(animateScroll);
              } else {
                autoScrollRafRef.current = null;
              }
            };

            autoScrollRafRef.current = requestAnimationFrame(animateScroll);

            lastScrollTsRef.current = now;
          }
        } else if (idx === -1 && !manualScrollDetachedRef.current) {
          cancelAutoScrollAnimation();
          container.scrollTo({ top: 0, behavior: 'auto' });
        }

    applyStates(idx, prev);
  }

  if (idx !== -1) {
    updateLineProgress(idx, getLineProgress(idx, visualTime));
  }
};

      rafId = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafId);
        cancelAutoScrollAnimation();
        container.removeEventListener('wheel', markManualScroll);
        container.removeEventListener('touchmove', markManualScroll);
        clearUserScrollTimeout();
      };
    }, [centerOffsetRatio, isCommunityPreviewLayout, lines, targetFramerate, unlockFramerate]);

    const containerClassName = isCommunityPreviewLayout
      ? 'mx-auto h-full min-h-0 max-h-[62vh] w-full max-w-[880px] overflow-y-auto scrollbar-hide px-[clamp(18px,3vw,38px)] py-[clamp(24px,4.4vh,46px)]'
      : 'h-full min-h-0 overflow-y-auto scrollbar-hide px-2 py-16 pl-[14vw] pr-[8vw]';
    const stackClassName = isCommunityPreviewLayout
      ? 'mx-auto flex min-h-full max-w-[780px] flex-col justify-center gap-1'
      : 'mx-auto flex max-w-[1100px] flex-col gap-2';
    const lineBaseClassName = isCommunityPreviewLayout
      ? 'lyric-line group relative origin-center will-change-transform py-1 text-[clamp(22px,2.35vw,30px)] font-bold tracking-tight antialiased text-white/55 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]'
      : 'lyric-line group relative origin-center will-change-transform py-3 text-[38px] font-bold tracking-tight antialiased text-white/55 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]';
    const pauseStateClassName = isCommunityPreviewLayout
      ? 'flex w-full justify-center px-0 pr-0 opacity-52 scale-[0.995] blur-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.08] data-[state=active]:blur-0 data-[state=past-near]:opacity-46 data-[state=past-near]:scale-[0.988] data-[state=past-near]:blur-0 data-[state=past]:opacity-34 data-[state=past]:scale-[0.956] data-[state=past]:blur-[2px] data-[state=next-near]:opacity-76 data-[state=next-near]:scale-[0.99] data-[state=next-near]:blur-0 data-[state=next]:opacity-34 data-[state=next]:scale-[0.952] data-[state=next]:blur-[2px]'
      : 'flex w-full justify-center px-0 pr-0 opacity-55 scale-[0.995] blur-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.12] data-[state=active]:blur-0 data-[state=past-near]:opacity-40 data-[state=past-near]:scale-[0.985] data-[state=past-near]:blur-0 data-[state=past]:opacity-30 data-[state=past]:scale-[0.94] data-[state=past]:blur-[3px] data-[state=next-near]:opacity-74 data-[state=next-near]:scale-[0.985] data-[state=next-near]:blur-0 data-[state=next]:opacity-30 data-[state=next]:scale-[0.93] data-[state=next]:blur-[4px]';
    const lyricStateClassName = isCommunityPreviewLayout
      ? 'cursor-pointer opacity-52 scale-[0.99] blur-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.1] data-[state=active]:blur-0 data-[state=active]:[text-shadow:0_0_24px_rgba(255,255,255,0.2)] data-[state=past-near]:opacity-46 data-[state=past-near]:scale-[0.99] data-[state=past-near]:blur-[1px] data-[state=past]:opacity-34 data-[state=past]:scale-[0.96] data-[state=past]:blur-[2px] data-[state=next-near]:opacity-76 data-[state=next-near]:scale-[0.99] data-[state=next-near]:blur-[1px] data-[state=next]:opacity-34 data-[state=next]:scale-[0.955] data-[state=next]:blur-[2px]'
      : 'cursor-pointer pr-12 opacity-55 scale-[0.985] blur-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.15] data-[state=active]:blur-0 data-[state=active]:[text-shadow:0_0_32px_rgba(255,255,255,0.22)] data-[state=past-near]:opacity-40 data-[state=past-near]:scale-[0.985] data-[state=past-near]:blur-[2px] data-[state=past]:opacity-30 data-[state=past]:scale-[0.94] data-[state=past]:blur-[3px] data-[state=next-near]:opacity-72 data-[state=next-near]:scale-[0.985] data-[state=next-near]:blur-[2px] data-[state=next]:opacity-30 data-[state=next]:scale-[0.93] data-[state=next]:blur-[4px]';
    const bottomSpacerClassName = isCommunityPreviewLayout ? 'h-[14vh]' : 'h-[50vh]';

return (
  <div
    ref={containerRef}
    data-user-scrolling={isUserScrolling ? 'true' : 'false'}
    className={containerClassName}
  >
    <div className={stackClassName}>
      {activeIndex < 0 && (
        <div className="flex w-full justify-center py-10 pointer-events-none">
          <div className="flex items-end gap-2">
            {[0, 1, 2].map((i) => {
              const visible =
                i === 0
                  ? timeUntilLyrics > 0
                  : i === 1
                    ? timeUntilLyrics > 1
                    : timeUntilLyrics > 2;

              return (
                <span
                  key={i}
                  className="text-[42px] font-bold text-white/70 leading-none select-none"
                  style={{
                    animation: visible
                      ? 'introNoteBounce 1.2s ease-in-out infinite'
                      : 'introNoteExit 420ms cubic-bezier(0.22,1,0.36,1) forwards',

                    animationDelay: `${i * 0.18}s`,
                  }}
                >
                  ♪
                </span>
              );
            })}
          </div>
        </div>
      )}
          {lines.map((line, i) => {
            const isPlaceholder = 'isPlaceholder' in line && line.isPlaceholder;

const displayText =
     line.text.trim().length === 0
      ? PAUSE_MARKER
      : line.text;
            const isPauseDisplay = displayText === PAUSE_MARKER;
            const noteGradientDelay = getPauseNoteAnimationDelay(line.time);
            return (
              <div
                key={`${line.time}-${i}-${isPlaceholder ? 'ph' : 'lyric'}`}
                className={`${lineBaseClassName} ${activeIndex < 0 ? 'blur-[3px] opacity-40' : ''} ${isPauseDisplay ? pauseStateClassName : lyricStateClassName}`}
                style={{
                  textRendering: 'optimizeLegibility',
                  ['--lyric-progress' as string]: '0%',
                  filter: isUserScrolling ? 'blur(0px)' : undefined,
                  ...(isPauseDisplay ? { cursor: 'default' } : {}),
                }}
                onClick={() => {
                  if (!isPauseDisplay) {
                    manualScrollDetachedRef.current = false;
                    if (i === activeRef.current) {
                      const container = containerRef.current;
                      const el = lineElsRef.current[i];
                      if (container && el) {
                        const top = getCenteredLyricScrollTop(container, el, centerOffsetRatio);
                        container.scrollTo({ top, behavior: 'smooth' });
                      }
                    } else {
                      seek(line.time, true, true);
                    }
                  }
                }}
              >
                <div
                  className={
                    isPauseDisplay
                      ? 'flex w-28 flex-col items-center'
                      : 'flex w-full flex-col items-center'
                  }
                >
                  {isPauseDisplay ? (
                    <span
                      className="note-gradient-text text-center text-transparent"
                      style={{
                        ['--note-gradient-delay' as string]: noteGradientDelay,
                        ['--note-gradient-duration' as string]: `${noteGradientDurationSec}s`,
                      }}
                    >
                      {displayText}
                    </span>
                ) : (
                    <span
                      className="block whitespace-pre-wrap text-center transition-[filter] duration-500"
                      style={{
                        opacity: i < activeIndex && !isUserScrolling ? firstLineOpacity : 1,
                        transition: 'opacity 0.3s ease-out',
                        filter: isUserScrolling
                          ? 'none'
                          : 'drop-shadow(0 0 10px rgba(255,255,255,0.14))',
                      }}
                    >
                      {displayText}
                    </span>
                  )}
                  {isPauseDisplay ? (
                    <div className="mt-3 h-[3px] w-28 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="pause-progress-bar h-full rounded-full bg-white/70 transition-[width] duration-150 ease-linear"
                        style={{ width: '0%' }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className={bottomSpacerClassName} />
      </div>
    );
  },
);

/* ── Synced Lyrics with pause placeholders ───────────────────── */

const ReleaseSyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => (
  <ReleaseSyncedLyricsWithProgress lines={lines} />
));

const SyncedLyricsWithProgress = React.memo(
  ({
    lines,
    motionHints = [],
    reactiveEnabled = true,
  }: {
    lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[];
    motionHints?: Array<{ index: number; importance: number; density: number; onsetBias: number }>;
    reactiveEnabled?: boolean;
  }) => {
    const safeReactiveEnabled = reactiveEnabled;
    const playbackRate = usePlayerStore((s) => s.playbackRate);
    const targetFramerate = useSettingsStore((s) => s.targetFramerate);
    const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
    const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);
    const [isUserScrolling, setIsUserScrolling] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef(-1);
    const lastScrollTsRef = useRef(0);
    const manualScrollDetachedRef = useRef(false);
    const visualProgressRef = useRef(0);
    const speedFloorRef = useRef(1);
    const lineActivatedAtRef = useRef(0);
    const linesRef = useRef(lines);
    const motionHintsRef = useRef(motionHints);
    const lineElsRef = useRef<HTMLElement[]>([]);
    const frameBudgetRef = useRef(getAnimationFrameBudgetMs(targetFramerate, unlockFramerate));
    const isUserScrollingRef = useRef(false);
    const userScrollTimeoutRef = useRef<number | null>(null);
    const autoScrollRafRef = useRef<number | null>(null);
    const autoScrollTokenRef = useRef(0);
    linesRef.current = lines;
    motionHintsRef.current = motionHints;
    frameBudgetRef.current = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);

    const syncUserScrollingState = (next: boolean) => {
      if (isUserScrollingRef.current === next) return;
      isUserScrollingRef.current = next;
      setIsUserScrolling(next);
    };

    const findActiveIndex = (source: typeof lines, time: number): number => {
      let lo = 0;
      let hi = source.length - 1;
      let ans = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (source[mid].time <= time + 0.35) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      return ans;
    };

    const getLineProgress = (idx: number, time: number, features: AudioFeatures | null) => {
      if (!safeReactiveEnabled) {
        const currentLine = linesRef.current[idx];
        if (!currentLine) return 0;
        const nextLine = linesRef.current[idx + 1];
        const duration = Math.max(
          (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
          0.35,
        );
        return clamp01((time - currentLine.time) / duration);
      }

      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const rawDuration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      const rawProgress = clamp01((time - currentLine.time) / rawDuration);

      // For regular synced lyrics (without warmup motion hints), keep timing strictly linear.
      const hasReactiveHints = motionHintsRef.current.length > 0;
      const reactiveMode = hasReactiveHints && idx >= 0 && idx < linesRef.current.length - 1;
      if (!reactiveMode) {
        return rawProgress;
      }

      const hintBoost = getMotionHintBoost(motionHintsRef.current, idx);
      const progress = getAnimatedLineProgress(
        linesRef.current,
        idx,
        time,
        reactiveMode,
        features,
        hintBoost,
      );
      const elapsedSinceActivation = Math.max(0, time - lineActivatedAtRef.current);
      const elapsedSinceLineStart = Math.max(0, time - currentLine.time);
      const gatedElapsed = Math.min(elapsedSinceActivation, elapsedSinceLineStart);
      const startupWindow = Math.min(Math.max(rawDuration * 0.18, 0.08), 0.2);

      if (gatedElapsed < startupWindow) {
        const startupCap = clamp01(gatedElapsed / startupWindow) * 0.14;
        return Math.min(progress, startupCap);
      }

      return progress;
    };

    const getStepLineProgress = (idx: number, time: number) => {
      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const duration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      return clamp01((time - currentLine.time) / duration);
    };

    const syncActiveChars = (activeChars: NodeListOf<HTMLElement>, progress: number) => {
      const charCount = Math.max(activeChars.length, 1);
      const headPosition = progress * charCount;
      const onsetFactor = getLyricCharOnsetFactor(headPosition);
      activeChars.forEach((charEl, charIndex) => {
        const rawProgress =
          (headPosition - charIndex - 0.18 + LYRIC_CURSOR_CHAR_SPAN * 0.66 * onsetFactor) /
          LYRIC_TRAIL_CHAR_SPAN;
        syncLyricCharProgress(charEl, rawProgress);
      });
    };

    const updateStepLineProgress = (idx: number, time: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;

      const progress = getStepLineProgress(idx, time);
      const activeChars = current.querySelectorAll<HTMLElement>('[data-char-index]');

      applyLyricProgressStyle(current, progress);
      syncActiveChars(activeChars, progress);
    };

    const applyStepStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = isPauseDisplayLine(currentLine);

        let state = '';
        let progress = '0%';
        if (i === idx) {
          state = 'active';
        } else if (i < idx) {
          state = idx - i === 1 ? 'past-near' : 'past';
          progress = '100%';
        } else if (i > idx) {
          state = i - idx === 1 ? 'next-near' : 'next';
        }

        const stateChanged = el.dataset.state !== state;
        if (stateChanged) {
          el.dataset.state = state;
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        const progressChanged = el.style.getPropertyValue('--lyric-progress') !== progress;
        if (progressChanged) {
          el.style.setProperty('--lyric-progress', progress);
        }

        if (isPauseDisplay && (stateChanged || progressChanged)) {
          const progressBar = el.querySelector('.pause-progress-bar') as HTMLElement | null;
          if (progressBar) {
            progressBar.style.width = progress;
          }
        }

        if (state !== 'active' && (stateChanged || progressChanged)) {
          applyLyricProgressStyle(el, progress === '100%' ? 1 : 0);
          el.querySelectorAll<HTMLElement>('[data-char-index]').forEach((charEl) => {
            syncLyricCharProgress(charEl, progress === '100%' ? 1 : 0);
          });
        }
      }
    };

    const applyVisualStates = (idx: number, prev: number) =>
      safeReactiveEnabled ? applyStates(idx, prev) : applyStepStates(idx, prev);
    const getVisualTime = () => getSmoothLyricTime();
    const getVisualProgress = (idx: number, time: number, features: AudioFeatures | null) =>
      safeReactiveEnabled ? getLineProgress(idx, time, features) : getStepLineProgress(idx, time);

    const getCurrentFeatures = () => {
      if (!safeReactiveEnabled) return null;
      try {
        return audioAnalyser.getCurrentFeatures();
      } catch {
        return null;
      }
    };
    const buildFlooredFeatures = (currentFeatures: AudioFeatures | null) => {
      if (!safeReactiveEnabled) return null;
      const activeLine = activeRef.current >= 0 ? linesRef.current[activeRef.current] : null;
      const rapBoost = getRapLineBoost(activeLine?.text);
      const reactiveDrive = getReactiveLyricDrive(currentFeatures, rapBoost);
      speedFloorRef.current = Math.max(
        1,
        reactiveDrive.speedMultiplier,
        getMotionHintFloor(motionHintsRef.current),
        1 + rapBoost * 0.18,
        speedFloorRef.current * (currentFeatures ? 0.988 : 0.982),
      );
      const activeHintBoost =
        activeRef.current >= 0 ? getMotionHintBoost(motionHintsRef.current, activeRef.current) : 0;
      const flooredFeatures = currentFeatures
        ? {
            ...currentFeatures,
            flux: Math.max(
              currentFeatures.flux,
              (speedFloorRef.current - 1) * 0.036 + activeHintBoost * 0.024 + rapBoost * 0.018,
            ),
            midPresence: Math.max(
              currentFeatures.midPresence ?? 0,
              (speedFloorRef.current - 1) * 0.56 + activeHintBoost * 0.2 + rapBoost * 0.18,
            ),
            dynamicRange: Math.max(
              currentFeatures.dynamicRange ?? 0,
              (speedFloorRef.current - 1) * 0.72 + activeHintBoost * 0.11 + rapBoost * 0.08,
            ),
            arousal: Math.max(
              currentFeatures.arousal,
              clamp01(
                (speedFloorRef.current - 1) / 0.62 + activeHintBoost * 0.16 + rapBoost * 0.14,
              ),
            ),
            bpm: Math.max(currentFeatures.bpm || 0, 88 + rapBoost * 74),
          }
        : null;

      if (!currentFeatures && rapBoost > 0.1) {
        speedFloorRef.current = Math.max(speedFloorRef.current, 1 + rapBoost * 0.14);
      }

      return flooredFeatures;
    };

    const applyReactiveVisualProgress = (
      idx: number,
      time: number,
      features: AudioFeatures | null,
    ) => {
      const targetProgress = getVisualProgress(idx, time, features);
      const currentVisualProgress = visualProgressRef.current;
      const diff = targetProgress - currentVisualProgress;
      const justActivated = time - lineActivatedAtRef.current < 0.18;
      const smoothFactor =
        diff >= 0 ? (justActivated ? 0.28 : diff > 0.2 || targetProgress > 0.9 ? 0.8 : 0.38) : 0.36;
      const nextVisualProgress = Math.max(
        currentVisualProgress,
        Math.min(currentVisualProgress + diff * smoothFactor, 1),
      );
      visualProgressRef.current = nextVisualProgress;
      updateLineProgress(idx, nextVisualProgress);
    };

    const applyTimedVisualProgress = (idx: number, time: number) => {
      updateStepLineProgress(idx, time);
    };

    const applyProgressTick = safeReactiveEnabled
      ? (idx: number, time: number, features: AudioFeatures | null) =>
          applyReactiveVisualProgress(idx, time, features)
      : (idx: number, time: number) => applyTimedVisualProgress(idx, time);

    const isPauseDisplayLine = (
      line: (LyricLine | { time: number; text: string; isPlaceholder: true }) | undefined,
    ) => {
      if (!line) return false;
      const text = line.text.trim();
      return text.length === 0 || text === '♪♪♪' || text === '...';
    };

    const updateLineProgress = (idx: number, progress: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;

      const currentLine = linesRef.current[idx];
      const activeChars = current.querySelectorAll<HTMLElement>('[data-char-index]');

      applyLyricProgressStyle(current, progress);
      syncActiveChars(activeChars, progress);

      if (isPauseDisplayLine(currentLine)) {
        const progressBar = current.querySelector('.pause-progress-bar') as HTMLElement | null;
        if (progressBar) {
          progressBar.style.width = `${progress * 100}%`;
        }
      }
    };

    const applyStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = isPauseDisplayLine(currentLine);

        let state = '';
        let progress = '0%';
        if (i === idx) {
          state = 'active';
        } else if (i < idx) {
          state = idx - i === 1 ? 'past-near' : 'past';
          progress = '100%';
        } else if (i > idx) {
          state = i - idx === 1 ? 'next-near' : 'next';
        }

        const stateChanged = el.dataset.state !== state;
        if (stateChanged) {
          el.dataset.state = state;
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        const progressChanged = el.style.getPropertyValue('--lyric-progress') !== progress;
        if (progressChanged) {
          el.style.setProperty('--lyric-progress', progress);
        }

        if (isPauseDisplay && (stateChanged || progressChanged)) {
          const progressBar = el.querySelector('.pause-progress-bar') as HTMLElement | null;
          if (progressBar) {
            progressBar.style.width = progress;
          }
        }

        if (state !== 'active' && (stateChanged || progressChanged)) {
          applyLyricProgressStyle(el, progress === '100%' ? 1 : 0);
          el.querySelectorAll<HTMLElement>('[data-char-index]').forEach((charEl) => {
            syncLyricCharProgress(charEl, progress === '100%' ? 1 : 0);
          });
        }
      }
    };

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      lineElsRef.current = Array.from(container.querySelectorAll<HTMLElement>('.lyric-line'));

      const clearUserScrollTimeout = () => {
        if (userScrollTimeoutRef.current !== null) {
          window.clearTimeout(userScrollTimeoutRef.current);
          userScrollTimeoutRef.current = null;
        }
      };

      const cancelAutoScrollAnimation = () => {
        autoScrollTokenRef.current += 1;
        if (autoScrollRafRef.current !== null) {
          cancelAnimationFrame(autoScrollRafRef.current);
          autoScrollRafRef.current = null;
        }
      };

      const scrollToActiveLine = (behavior: ScrollBehavior) => {
        const activeIdx = activeRef.current;
        if (activeIdx >= 0 && activeIdx < lineElsRef.current.length) {
          const el = lineElsRef.current[activeIdx];
          if (!el) return;
          const top = getCenteredLyricScrollTop(container, el);
          container.scrollTo({ top, behavior });
          lastScrollTsRef.current = performance.now();
          return;
        }

        if (activeIdx === -1) {
          container.scrollTo({ top: 0, behavior });
        }
      };

      const scheduleUserScrollReset = () => {
        clearUserScrollTimeout();
        userScrollTimeoutRef.current = window.setTimeout(() => {
          syncUserScrollingState(false);
          manualScrollDetachedRef.current = false;
          userScrollTimeoutRef.current = null;
          scrollToActiveLine('smooth');
        }, 2200);
      };

      const markManualScroll = () => {
        cancelAutoScrollAnimation();
        manualScrollDetachedRef.current = true;
        syncUserScrollingState(true);
        scheduleUserScrollReset();
      };

      container.addEventListener('wheel', markManualScroll, { passive: true });
      container.addEventListener('touchmove', markManualScroll, { passive: true });

      activeRef.current = -1;
      manualScrollDetachedRef.current = false;
      speedFloorRef.current = 1;
      lineActivatedAtRef.current = 0;

      let rafId = 0;
      let lastFrameTs = 0;

const tick = (ts: number) => {
  rafId = requestAnimationFrame(tick);

  const lineEls = lineElsRef.current;

  if (!container || lineEls.length === 0) return;
  if (isAppBackgrounded()) return;

  const frameBudgetMs = frameBudgetRef.current;

  if (frameBudgetMs > 0 && ts - lastFrameTs < frameBudgetMs) return;

  lastFrameTs = ts;

  const time = getCurrentTime();
  const activeTime = getActiveLyricTime(time);
  const visualTime = getVisualTime();
  const currentLines = linesRef.current;
  const currentFeatures = getCurrentFeatures();
  const flooredFeatures = buildFlooredFeatures(currentFeatures);

  const idx = findActiveIndex(currentLines, activeTime);
  const prev = activeRef.current;

  if (idx !== activeRef.current) {
    activeRef.current = idx;
    lineActivatedAtRef.current = visualTime;
    visualProgressRef.current = 0;

    if (idx >= 0 && idx < lineEls.length) {
      const el = lineEls[idx];
      const top = getCenteredLyricScrollTop(container, el);
      const now = performance.now();

      if (!manualScrollDetachedRef.current) {
        const start = container.scrollTop;
        const target = top;
        cancelAutoScrollAnimation();
        const autoScrollToken = autoScrollTokenRef.current;

        let current = start;

        const animateScroll = () => {
          if (
            manualScrollDetachedRef.current ||
            autoScrollTokenRef.current !== autoScrollToken
          ) {
            autoScrollRafRef.current = null;
            return;
          }

          current += (target - current) * 0.085;

          container.scrollTop = current;

          if (Math.abs(target - current) > 0.5) {
            autoScrollRafRef.current = requestAnimationFrame(animateScroll);
          } else {
            autoScrollRafRef.current = null;
          }
        };

        autoScrollRafRef.current = requestAnimationFrame(animateScroll);

        lastScrollTsRef.current = now;
      }
    } else if (idx === -1 && !manualScrollDetachedRef.current) {
      cancelAutoScrollAnimation();
      container.scrollTo({ top: 0, behavior: 'auto' });
    }

    applyVisualStates(idx, prev);
  }

  
  if (idx !== -1) {
    applyProgressTick(idx, visualTime, flooredFeatures);
  }
};

      rafId = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafId);
        cancelAutoScrollAnimation();
        container.removeEventListener('wheel', markManualScroll);
        container.removeEventListener('touchmove', markManualScroll);
        clearUserScrollTimeout();
      };
    }, [lines, motionHints, targetFramerate, unlockFramerate]);

return (
  <div className="relative flex-1 overflow-hidden">
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-40 bg-gradient-to-b from-black via-black/75 to-transparent backdrop-blur-md" />

    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-40 bg-gradient-to-t from-black via-black/75 to-transparent backdrop-blur-md" />

    <div
      ref={containerRef}
      data-user-scrolling={isUserScrolling ? 'true' : 'false'}
      className="relative h-full overflow-y-auto px-[clamp(20px,4vw,56px)] py-[clamp(88px,14vh,156px)] scrollbar-hide"
    >
      <div className="flex flex-col items-center gap-3">
        {lines.map((line, i) => {
          const nextLine = lines[i + 1];
          const gap = nextLine ? nextLine.time - line.time : 0;

          const isInterlude =
            gap > 5 &&
            i === activeRef.current;

          const isPlaceholder =
            'isPlaceholder' in line && line.isPlaceholder;

          const displayText =
            line.text.trim().length === 0
              ? '♪♪♪'
              : line.text;

          const isPauseDisplay =
            displayText === '♪♪♪';

          const totalAnimatedChars = Array.from(displayText).filter(
            (char) => !/^\s+$/.test(char),
          ).length;

          return (
            <div
              key={`${line.time}-${i}-${isPlaceholder ? 'ph' : 'lyric'}`}
              className={`lyric-line group relative flex w-full max-w-[min(100%,880px)] justify-center py-2.5 text-center text-[clamp(28px,3.8vw,48px)] font-bold tracking-tight antialiased text-white/22 transition-all duration-700 ease-[var(--ease-apple)] will-change-transform ${
                isPauseDisplay
                  ? 'opacity-55 scale-[0.99] data-[state=active]:opacity-100 data-[state=active]:scale-[1.01] data-[state=past-near]:opacity-72 data-[state=past-near]:scale-[0.992] data-[state=past]:opacity-46 data-[state=past]:scale-[0.985] data-[state=next-near]:opacity-62 data-[state=next-near]:scale-[0.99] data-[state=next]:opacity-26 data-[state=next]:scale-[0.98]'
                  : 'cursor-pointer px-4 opacity-38 scale-[0.974] data-[state=active]:opacity-100 data-[state=active]:scale-[1.055] data-[state=past-near]:opacity-78 data-[state=past-near]:scale-[0.992] data-[state=past]:opacity-48 data-[state=past]:scale-[0.982] data-[state=next-near]:opacity-66 data-[state=next-near]:scale-[0.99] data-[state=next]:opacity-28 data-[state=next]:scale-[0.972]'
              }`}
              style={{
                textRendering: 'optimizeLegibility',
                ['--lyric-progress' as string]: '0%',
                ['--lyric-progress-value' as string]: '0',
                ['--lyric-tail-start' as string]: '0',
                ['--lyric-tail-end' as string]: '0',
                ['--lyric-cursor-start' as string]: '0',
                ['--lyric-cursor-end' as string]: '0',
                ['--lyric-cursor-opacity' as string]: '0',
                filter: isUserScrolling ? 'blur(0px)' : undefined,
                ...(isPauseDisplay
                  ? { cursor: 'default' }
                  : {}),
              }}
              data-char-count={
                isPauseDisplay
                  ? undefined
                  : totalAnimatedChars
              }
              onClick={() => {
                if (!isPauseDisplay) {
                  manualScrollDetachedRef.current = false;

                  if (i === activeRef.current) {
                    const container =
                      containerRef.current;

                    const el =
                      lineElsRef.current[i];

                    if (container && el) {
                      const top =
                        getCenteredLyricScrollTop(
                          container,
                          el,
                        );

                      container.scrollTo({
                        top,
                        behavior: 'smooth',
                      });
                    }
                  } else {
                    seek(line.time, true, true);
                  }
                }
              }}
            >
              <div
                className={
                  isPauseDisplay
                    ? 'flex w-28 flex-col items-center'
                    : 'flex w-full flex-col items-center'
                }
              >
                {isPauseDisplay ? (
                  <span
                    className="note-gradient-text text-center text-transparent"
                    style={{
                      ['--note-gradient-delay' as string]:
                        getPauseNoteAnimationDelay(
                          line.time,
                        ),

                      ['--note-gradient-duration' as string]:
                        `${noteGradientDurationSec}s`,
                    }}
                  >
                    {displayText}
                  </span>
                ) : (
                  <span
                    className="relative block text-center transition-[filter] duration-500"
                    style={{
                      filter: isUserScrolling
                        ? 'none'
                        : 'drop-shadow(0 0 10px rgba(255,255,255,0.14))',
                    }}
                  >
                    <span
                      className="relative block whitespace-pre-wrap"
                      style={{
                        clipPath:
                          'inset(0 0 0 var(--lyric-progress))',

                        WebkitClipPath:
                          'inset(0 0 0 var(--lyric-progress))',
                      }}
                    >
                        <span className="inline whitespace-pre-wrap bg-[linear-gradient(90deg,rgba(255,255,255,0)_0%,rgba(255,255,255,0.92)_52%,rgba(255,255,255,0)_100%)] bg-clip-text text-transparent [filter:drop-shadow(0_0_16px_rgba(255,255,255,0.42))]">
                          {displayText}
                        </span>
                      </span>
                    </span>
                  )}
                  {isPauseDisplay ? (
                    <div className="mt-3 h-[3px] w-28 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="pause-progress-bar h-full rounded-full bg-white/70 transition-[width] duration-150 ease-linear"
                        style={{ width: '0%' }}
                      />
                    </div>
                  ) : null}
                </div>
                {isInterlude && (
  <div className="flex justify-center py-8">
    <div className="flex items-center gap-3 opacity-60">
      <div className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
      <div className="h-2.5 w-2.5 rounded-full bg-white animate-pulse [animation-delay:150ms]" />
      <div className="h-2.5 w-2.5 rounded-full bg-white animate-pulse [animation-delay:300ms]" />
    </div>
  </div>
)}
              </div>
            );
          })}
        </div>
        <div className="h-[48vh]" />
      </div>
    </div>
);
},
);

void SyncedLyricsWithProgress;

/* ── Synced Lyrics ─ CSS data-state + DOM scroll, 0 re-renders */

export const SyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => (
  <ReleaseSyncedLyrics lines={lines} />
));

/* ── Plain Lyrics ─────────────────────────────────────────── */

const PlainLyrics = React.memo(({ text }: { text: string }) => (
  <div className="h-full min-h-0 overflow-y-auto px-2 py-16 pl-[14vw] pr-[8vw] scrollbar-hide">
    <div className="mx-auto flex min-h-full max-w-[1100px] flex-col justify-center gap-3">
      <div className="w-full whitespace-pre-wrap text-center text-[clamp(24px,3vw,38px)] font-semibold leading-[1.72] tracking-tight text-white/64">
        {text}
      </div>
    </div>
  </div>
));

const StaticSyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => {
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const displayLines = useMemo(() => buildDisplayLinesWithPausePlaceholders(lines), [lines]);
  const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);

  return (
    <div className="flex-1 overflow-y-auto px-[clamp(20px,4vw,56px)] py-[clamp(88px,14vh,156px)] scrollbar-hide">
      <div className="flex flex-col items-center gap-3">
        {displayLines.map((line, i) => {
          const displayText = line.text.trim().length === 0 ? PAUSE_MARKER : line.text;
          const isPauseDisplay = displayText === PAUSE_MARKER;
          const noteGradientDelay = getPauseNoteAnimationDelay(line.time);

          return (
            <div
              key={`${line.time}-${i}-static`}
              className={
                isPauseDisplay
                  ? 'flex w-full justify-center py-4 opacity-75'
                  : 'flex w-full max-w-[min(100%,880px)] justify-center py-2.5 text-center'
              }
            >
              {isPauseDisplay ? (
                <div className="flex w-28 flex-col items-center">
                  <span
                    className="note-gradient-text text-center text-transparent"
                    style={{
                      ['--note-gradient-delay' as string]: noteGradientDelay,
                      ['--note-gradient-duration' as string]: `${noteGradientDurationSec}s`,
                    }}
                  >
                    {displayText}
                  </span>
                  <div className="mt-3 h-[3px] w-28 rounded-full bg-white/[0.12]" />
                </div>
              ) : (
                <span className="block text-[clamp(26px,3.2vw,42px)] font-bold tracking-tight text-white/58">
                  {displayText}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="h-[46vh]" />
    </div>
  );
});

/* ── Lyrics Panel (fullscreen, 50/50) ─────────────────────── */

function getLyricsSearchPrefill(
  track: Track | null | undefined,
  manualQuery: { artist: string; title: string } | null,
) {
  const parsed = splitArtistTitle(track?.title ?? '');
  return {
    artist: manualQuery?.artist || (parsed ? parsed[0] : track?.user?.username || ''),
    title: manualQuery?.title || (parsed ? parsed[1] : track?.title || ''),
  };
}

type ResolvedLyricsData = {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
} | null;

function hasRenderableLyrics(lyrics: ResolvedLyricsData) {
  return Boolean(lyrics?.synced?.length || lyrics?.plain);
}

type CommunitySyncSource = 'genius' | 'soundcloud';

type CommunitySyncLine = {
  kind: 'lyric' | 'pause';
  text: string;
  time: number | null;
};

type CommunitySyncSession = {
  plainLyrics: string;
  lines: CommunitySyncLine[];
  activeIndex: number;
  source: CommunitySyncSource;
};

type CommunitySyncTrackMeta = {
  trackUrn: string;
  artistName: string;
  trackName: string;
  durationSec: number;
};

function isCommunitySyncSource(source: LyricsSource | null | undefined): source is CommunitySyncSource {
  return source === 'genius' || source === 'soundcloud';
}

function canCreateCommunitySync(
  lyrics: ResolvedLyricsData,
): lyrics is { plain: string; source: CommunitySyncSource; synced: null } {
  return shouldRenderPlainLyrics(lyrics) && isCommunitySyncSource(lyrics.source);
}

function splitCommunitySyncLines(plainLyrics: string): string[] {
  const lines = String(plainLyrics || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0 ? lines : [];
}

function normalizeCommunitySyncComparableText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createCommunitySyncLyricLine(text: string, time: number | null = null): CommunitySyncLine {
  return {
    kind: 'lyric',
    text,
    time,
  };
}

function createCommunitySyncPauseLine(time: number): CommunitySyncLine {
  return {
    kind: 'pause',
    text: '',
    time,
  };
}

function createCommunitySyncSession(
  plainLyrics: string,
  source: CommunitySyncSource,
): CommunitySyncSession | null {
  const lines = splitCommunitySyncLines(plainLyrics);
  if (lines.length === 0) return null;

  return {
    plainLyrics,
    lines: lines.map((line) => createCommunitySyncLyricLine(line)),
    activeIndex: -1,
    source,
  };
}

function createCommunitySyncSessionFromDraft(
  draft: CommunityLyricsDraft,
): CommunitySyncSession | null {
  const lines = splitCommunitySyncLines(draft.plainLyrics);
  if (lines.length === 0) return null;

  const nextLines: CommunitySyncLine[] = [];
  let plainIndex = 0;

  for (const syncedLine of draft.syncedLyrics) {
    if (isPauseMarkerText(syncedLine.text)) {
      nextLines.push(createCommunitySyncPauseLine(syncedLine.time));
      continue;
    }

    const nextPlainLine = lines[plainIndex];
    if (nextPlainLine) {
      const normalizedSynced = normalizeCommunitySyncComparableText(syncedLine.text);
      const normalizedPlain = normalizeCommunitySyncComparableText(nextPlainLine);
      if (normalizedSynced === normalizedPlain || !normalizedSynced) {
        nextLines.push(createCommunitySyncLyricLine(nextPlainLine, syncedLine.time));
        plainIndex += 1;
        continue;
      }

      nextLines.push(createCommunitySyncLyricLine(nextPlainLine, syncedLine.time));
      plainIndex += 1;
      continue;
    }

    nextLines.push(createCommunitySyncLyricLine(syncedLine.text, syncedLine.time));
  }

  while (plainIndex < lines.length) {
    nextLines.push(createCommunitySyncLyricLine(lines[plainIndex]));
    plainIndex += 1;
  }

  const firstPendingIndex = nextLines.findIndex((line) => line.time === null);
  const hasStampedLines = nextLines.some((line) => typeof line.time === 'number');

  return {
    plainLyrics: draft.plainLyrics,
    lines: nextLines,
    activeIndex:
      !hasStampedLines
        ? -1
        : firstPendingIndex >= 0
          ? firstPendingIndex
          : Math.max(Math.min(nextLines.length - 1, 0), 0),
    source: draft.source,
  };
}

function toCommunitySyncDraft(
  trackMeta: CommunitySyncTrackMeta,
  session: CommunitySyncSession,
): CommunityLyricsDraft {
  return {
    trackUrn: trackMeta.trackUrn,
    artistName: trackMeta.artistName,
    trackName: trackMeta.trackName,
    durationSec: trackMeta.durationSec,
    plainLyrics: session.plainLyrics,
    syncedLyrics: session.lines.flatMap((line) => {
      return typeof line.time === 'number'
        ? [{ time: line.time, text: line.kind === 'pause' ? '' : line.text }]
        : [];
    }),
    createdAt: new Date().toISOString(),
    source: session.source,
  };
}

const COMMUNITY_SYNC_MIN_GAP_SEC = 0.001;

function formatCommunitySyncTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

  const totalMilliseconds = Math.round(safe * 1000);

  const minutes = Math.floor(totalMilliseconds / 60000);
  const wholeSeconds = Math.floor(totalMilliseconds / 1000) % 60;
  const milliseconds = totalMilliseconds % 1000;

  return `${String(minutes).padStart(2, '0')}:${String(
    wholeSeconds,
  ).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function serializeCommunitySyncedLyrics(lines: LyricLine[]): string {
  return lines
    .map((line) => `[${formatCommunitySyncTimestamp(line.time)}]${line.text}`)
    .join('\n');
}

function isCommunitySyncSessionComplete(session: CommunitySyncSession | null): boolean {
  return Boolean(
    session && session.lines.length > 0 && session.lines.every((line) => typeof line.time === 'number'),
  );
}

function parseCommunitySyncTimestampInput(value: string): number | null {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,3}):([0-5]\d)(?::|[.,])(\d{1,3})$/);
  if (!match) return null;

  const [, minutes, seconds, milliseconds] = match;
  return Number(minutes) * 60 + Number(seconds) + Number(milliseconds.padEnd(3, '0')) / 1000;
}

function roundCommunitySyncTimestamp(seconds: number): number {
  return Number(Math.max(0, seconds).toFixed(3));
}

function hasCommunitySyncStampedLines(lines: CommunitySyncLine[]): boolean {
  return lines.some((line) => typeof line.time === 'number');
}

function resolveCommunitySyncActiveIndex(
  lines: CommunitySyncLine[],
  preferredIndex: number,
): number {
  if (lines.length === 0 || !hasCommunitySyncStampedLines(lines)) return -1;
  return Math.max(0, Math.min(preferredIndex, lines.length - 1));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function findCommunitySyncPreviousStampedIndex(
  lines: CommunitySyncLine[],
  startIndex: number,
): number {
  for (let index = Math.min(startIndex, lines.length - 1); index >= 0; index -= 1) {
    if (typeof lines[index]?.time === 'number') return index;
  }

  return -1;
}

function findCommunitySyncNextStampedIndex(lines: CommunitySyncLine[], startIndex: number): number {
  for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
    if (typeof lines[index]?.time === 'number') return index;
  }

  return -1;
}

function findCommunitySyncNextPendingIndex(lines: CommunitySyncLine[], startIndex: number): number {
  for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
    if (lines[index]?.time === null) return index;
  }

  return -1;
}

function getCommunitySyncTimeBounds(lines: CommunitySyncLine[], index: number) {
  const previousIndex = findCommunitySyncPreviousStampedIndex(lines, index - 1);
  const nextIndex = findCommunitySyncNextStampedIndex(lines, index + 1);

  return {
    previousTime: previousIndex >= 0 ? (lines[previousIndex]?.time ?? null) : null,
    nextTime: nextIndex >= 0 ? (lines[nextIndex]?.time ?? null) : null,
  };
}

function getStampedCommunitySyncTime(
  currentTime: number,
  previousTime: number | null,
  nextTime: number | null,
): number {
  const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const minimum = previousTime === null ? 0 : previousTime + COMMUNITY_SYNC_MIN_GAP_SEC;
  const maximum =
    nextTime === null
      ? Number.POSITIVE_INFINITY
      : Math.max(minimum, nextTime - COMMUNITY_SYNC_MIN_GAP_SEC);
  return roundCommunitySyncTimestamp(Math.min(Math.max(safeCurrentTime, minimum), maximum));
}

function getCommunitySyncPlaybackIndex(
  lines: CommunitySyncLine[],
  currentTime: number,
  fallbackIndex: number,
): number {
  const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  let firstStampedIndex = -1;
  let firstStampedTime: number | null = null;
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const lineTime = lines[index]?.time;
    if (typeof lineTime !== 'number') continue;
    if (firstStampedIndex < 0) {
      firstStampedIndex = index;
      firstStampedTime = lineTime;
    }
    if (lineTime <= safeCurrentTime + 0.02) {
      activeIndex = index;
      continue;
    }
    break;
  }

  if (activeIndex >= 0) return activeIndex;
  if (firstStampedIndex >= 0) {
    if (firstStampedTime !== null && safeCurrentTime + 0.02 < firstStampedTime) return -1;
    return firstStampedIndex;
  }
  if (fallbackIndex < 0) return -1;
  return Math.max(0, Math.min(fallbackIndex, lines.length - 1));
}

function getCommunitySyncStampTargetIndex(session: CommunitySyncSession): number {
  if (session.lines.length === 0) return -1;
  if (session.activeIndex < 0) {
    return findCommunitySyncNextPendingIndex(session.lines, 0);
  }
  const activeLine = session.lines[Math.max(0, Math.min(session.activeIndex, session.lines.length - 1))];
  if (!activeLine) return -1;
  if (activeLine.time === null) return Math.max(0, Math.min(session.activeIndex, session.lines.length - 1));

  const nextPendingIndex = findCommunitySyncNextPendingIndex(session.lines, session.activeIndex + 1);
  if (nextPendingIndex >= 0) return nextPendingIndex;

  return -1;
}

function getCommunitySyncPauseInsertIndex(session: CommunitySyncSession): number {
  if (session.lines.length === 0) return 0;
  if (session.activeIndex < 0) return 0;
  const activeLine = session.lines[Math.max(0, Math.min(session.activeIndex, session.lines.length - 1))];
  if (!activeLine || activeLine.time === null) {
    return Math.max(0, Math.min(session.activeIndex, session.lines.length));
  }

  const nextPendingIndex = findCommunitySyncNextPendingIndex(session.lines, session.activeIndex + 1);
  if (nextPendingIndex >= 0) return nextPendingIndex;

  return Math.min(session.activeIndex + 1, session.lines.length);
}

/* ── Lyrics Search Modal ──────────────────────────────────── */

const LyricsSearchModal = React.memo(
  ({
    isOpen,
    onClose,
    initialArtist = '',
    initialTitle = '',
    onSearch,
    isSearching = false,
    resultState = 'idle',
    resultSource = null,
  }: {
    isOpen: boolean;
    onClose: () => void;
    initialArtist?: string;
    initialTitle?: string;
    onSearch: (artist: string, title: string) => void;
    isSearching?: boolean;
    resultState?: 'idle' | 'loading' | 'found' | 'not_found';
    resultSource?: LyricsSource | null;
  }) => {
    const [artist, setArtist] = useState(initialArtist);
    const [title, setTitle] = useState(initialTitle);
    const { t } = useTranslation();

    useEffect(() => {
      if (isOpen) {
        setArtist(initialArtist);
        setTitle(initialTitle);
      }
    }, [isOpen, initialArtist, initialTitle]);

    if (!isOpen) return null;

    return typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-xl transition-opacity duration-300"
            onClick={onClose}
          >
            <div
              className="relative w-[min(560px,calc(100vw-3rem))] rounded-[28px] border border-white/10 bg-[#101012]/98 p-8 shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-zoom-in"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={onClose}
                className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/50 transition-all hover:bg-white/20 hover:text-white/80 outline-none"
              >
                <X size={20} />
              </button>

              <h2 className="mb-6 text-[18px] font-bold text-white/92">
                {t('track.manualSearch', 'Manual Search')}
              </h2>

              <div className="mb-5 rounded-[18px] border border-white/[0.08] bg-white/[0.04] px-4 py-3 backdrop-blur-md">
                {resultState === 'loading' ? (
                  <div className="flex items-center gap-2 text-[13px] text-white/62">
                    <Loader2 size={14} className="animate-spin" />
                    <span>{t('track.lyricsSearchLoading')}</span>
                  </div>
                ) : resultState === 'found' ? (
                  <div className="flex items-center gap-2 text-[13px] text-white/72">
                    <span className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-white/50">
                      {resultSource ? SOURCE_LABELS[resultSource] : t('track.lyrics')}
                    </span>
                    <span>{t('track.lyricsSearchFound')}</span>
                  </div>
                ) : resultState === 'not_found' ? (
                  <div className="text-[13px] text-white/46">{t('track.lyricsSearchNotFound')}</div>
                ) : (
                  <div className="text-[13px] text-white/38">{t('track.lyricsSearchIdle')}</div>
                )}
              </div>

              <div className="space-y-3 mb-6">
                <input
                  type="text"
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder={t('track.artist', 'Artist')}
                  className="w-full bg-white/10 px-4 py-3 rounded-[14px] text-white text-[14px] outline-none border border-white/10 focus:border-white/30 placeholder:text-white/30 transition-colors"
                  autoFocus
                />
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('track.title', 'Title')}
                  className="w-full bg-white/10 px-4 py-3 rounded-[14px] text-white text-[14px] outline-none border border-white/10 focus:border-white/30 placeholder:text-white/30 transition-colors"
                />
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-full text-[13px] font-medium text-white/50 hover:text-white hover:bg-white/10 transition-colors outline-none"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => onSearch(artist, title)}
                  disabled={isSearching || !artist.trim() || !title.trim()}
                  className="px-6 py-2.5 rounded-full text-[13px] font-bold bg-white/20 hover:bg-white/30 text-white transition-colors outline-none disabled:cursor-default disabled:opacity-45"
                >
                  {t('track.search', 'Search')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;
  },
);

const CommunitySyncLiveClock = React.memo(
  ({ syncedCount, totalLines }: { syncedCount: number; totalLines: number }) => {
    const [currentTime, setCurrentTime] = useState(() => getCurrentTime());

    useEffect(() => {
      const tick = () => setCurrentTime(getCurrentTime());
      tick();
      const intervalId = window.setInterval(tick, 90);
      return () => window.clearInterval(intervalId);
    }, []);

    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/[0.22] px-3 py-1.5 text-[11px] font-medium text-white/68 shadow-[0_12px_34px_rgba(0,0,0,0.26)] backdrop-blur-xl">
        <span className="tabular-nums">{formatTime(currentTime)}</span>
        <span className="h-1 w-1 rounded-full bg-white/16" />
        <span className="tabular-nums text-white/42">
          {syncedCount}/{totalLines}
        </span>
      </div>
    );
  },
);

const CommunitySyncTimestampChip = React.memo(
  ({
    value,
    onCommit,
  }: {
    value: number;
    onCommit: (nextTime: number) => void;
  }) => {
    const [editing, setEditing] = useState(false);
    const [draftValue, setDraftValue] = useState(() => formatCommunitySyncTimestamp(value));
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      if (!editing) {
        setDraftValue(formatCommunitySyncTimestamp(value));
      }
    }, [editing, value]);

    useEffect(() => {
      if (!editing) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    }, [editing]);

    const cancelEditing = useCallback(() => {
      setDraftValue(formatCommunitySyncTimestamp(value));
      setEditing(false);
    }, [value]);

    const submitEditing = useCallback(() => {
      const parsed = parseCommunitySyncTimestampInput(draftValue);
      if (parsed == null) {
        cancelEditing();
        return;
      }

      onCommit(parsed);
      setEditing(false);
    }, [cancelEditing, draftValue, onCommit]);

    const sharedClassName =
      'inline-flex h-7 min-w-[82px] items-center justify-center rounded-full border border-white/[0.08] bg-black/[0.18] px-2.5 text-[10px] font-semibold tabular-nums text-white/52 shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-200 hover:border-white/[0.12] hover:bg-black/[0.26] hover:text-white/78';

    if (editing) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={draftValue}
          inputMode="numeric"
          spellCheck={false}
          aria-label="Edit lyric timestamp"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={submitEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitEditing();
              return;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              cancelEditing();
            }
          }}
          className={`${sharedClassName} w-[82px] outline-none ring-1 ring-white/[0.14]`}
        />
      );
    }

    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        className={sharedClassName}
      >
        {formatCommunitySyncTimestamp(value)}
      </button>
    );
  },
);

const CommunitySyncEditor = React.memo(
  ({
    session,
    onSyncLine,
    onInsertPause,
    onUndo,
    onPublish,
    publishPending,
    onSeekLine,
    onUpdateTimestamp,
    onCancel,
    t,
  }: {
    session: CommunitySyncSession;
    onSyncLine: () => void;
    onInsertPause: () => void;
    onUndo: () => void;
    onPublish: () => void;
    publishPending: boolean;
    onSeekLine: (index: number) => void;
    onUpdateTimestamp: (index: number, nextTime: number) => void;
    onCancel: () => void;
    t: TFunction;
  }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const syncedCount = session.lines.filter((line) => typeof line.time === 'number').length;
    const canPublish = isCommunitySyncSessionComplete(session);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const activeLine = container.querySelector<HTMLElement>(
        `[data-sync-line-index="${session.activeIndex}"]`,
      );
      activeLine?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [session.activeIndex]);

    return (
      <div
        className="relative mx-auto flex h-full w-full max-w-[960px] flex-col overflow-hidden animate-fade-in-up"
      >
        <div className="flex items-start justify-between gap-4 px-[clamp(8px,1.4vw,18px)] pt-3 pb-2">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
              {t('track.communitySyncMode', 'Sync mode')}
            </div>
            <div className="mt-1 text-[12px] text-white/40">
              {t('track.communitySyncModeHint', 'Отмечайте строки прямо по ходу трека.')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CommunitySyncLiveClock syncedCount={syncedCount} totalLines={session.lines.length} />
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-[12px] font-medium text-white/58 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white/84"
            >
              {t('track.communitySyncExit', 'Выйти')}
            </button>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[880px] flex-wrap items-center justify-center gap-2 px-4 pb-4 text-[11px] text-white/34">
          {[
            ['SPACE', t('track.communitySyncHintNext', 'следующая строка')],
            ['BACKSPACE', t('track.communitySyncHintUndo', 'отменить последнюю')],
            ['ESC', t('track.communitySyncHintCancel', 'выйти без сохранения')],
          ].map(([key, label]) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 backdrop-blur-md"
            >
              <span className="font-semibold text-white/54">{key}</span>
              <span>{label}</span>
            </span>
          ))}
        </div>

        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto px-[clamp(20px,4vw,56px)] pb-8 scrollbar-hide"
        >
          <div className="mx-auto flex max-w-[880px] flex-col gap-2 pt-6">
            {session.lines.map((line, index) => {
              const timestamp = line.time;
              const canSeekToLine = typeof timestamp === 'number';
              const hasActiveLine = session.activeIndex >= 0;
              const distance = hasActiveLine ? index - session.activeIndex : 0;
              const isActive = hasActiveLine && distance === 0;
              const isPast = hasActiveLine && distance < 0;
              const isPauseLine = line.kind === 'pause';
              const stateClassName = !hasActiveLine
                ? 'opacity-[0.58] scale-[0.98] text-white/[0.62]'
                : isActive
                  ? 'opacity-100 scale-[1.08] text-white [text-shadow:0_0_34px_rgba(255,255,255,0.2)]'
                  : isPast
                    ? distance === -1
                      ? 'opacity-[0.72] scale-[0.995] text-white/[0.78]'
                      : 'opacity-[0.42] scale-[0.97] text-white/[0.48]'
                    : distance === 1
                      ? 'opacity-[0.78] scale-[0.995] text-white/[0.84]'
                      : 'opacity-[0.46] scale-[0.97] text-white/[0.54]';

              return (
                <div
                  key={`${index}-${line.kind}-${line.text}-${line.time ?? 'pending'}`}
                  data-sync-line-index={index}
                  onClick={canSeekToLine ? () => onSeekLine(index) : undefined}
                  className={`relative flex w-full items-center justify-center px-[72px] py-3 text-center text-[clamp(24px,3vw,42px)] font-bold tracking-tight transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    canSeekToLine ? 'cursor-pointer' : 'cursor-default'
                  } ${stateClassName}`}
                >
                  {timestamp !== null ? (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2">
                      <CommunitySyncTimestampChip
                        value={timestamp}
                        onCommit={(nextTime) => onUpdateTimestamp(index, nextTime)}
                      />
                    </div>
                  ) : null}
                  {isPauseLine ? (
                    <span className="block min-h-[1.15em] w-full select-none whitespace-pre-wrap text-center">
                      {'\u00A0'}
                    </span>
                  ) : (
                    <span className="block whitespace-pre-wrap text-center">{line.text}</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="h-[34vh]" />
        </div>

        <div className="px-[clamp(20px,4vw,56px)] pb-[clamp(132px,18vh,172px)] pt-4">
          <div className="mx-auto flex max-w-[880px] flex-wrap items-center justify-between gap-3 rounded-[28px] border border-white/[0.08] bg-[rgba(8,8,10,0.3)] px-4 py-4 shadow-[0_28px_90px_rgba(0,0,0,0.34)] backdrop-blur-[26px]">
            <div className="text-[12px] text-white/42">
              {t('track.communitySyncProgress', 'Строка {{current}} из {{total}}')
                .replace(
                  '{{current}}',
                  String(
                    session.activeIndex < 0
                      ? 0
                      : Math.min(session.activeIndex + 1, session.lines.length),
                  ),
                )
                .replace('{{total}}', String(session.lines.length))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={onUndo}
                disabled={syncedCount === 0}
                className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white disabled:cursor-default disabled:opacity-38"
              >
                {t('track.communitySyncUndo', 'Отменить')}
              </button>
              <button
                type="button"
                onClick={onInsertPause}
                className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.05] px-4 text-[12px] font-medium text-white/66 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.09] hover:text-white"
              >
                {t('track.communitySyncPause', 'Пауза')}
              </button>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={onSyncLine}
                  className={`inline-flex h-10 items-center rounded-full px-5 text-[12px] font-semibold transition-all duration-300 ${
                    canPublish
                      ? 'border border-white/[0.08] bg-white/[0.05] text-white/66 hover:border-white/[0.12] hover:bg-white/[0.09] hover:text-white'
                      : 'border border-white/[0.1] bg-white/[0.12] text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)]'
                  }`}
                >
                  {t('track.communitySyncNextButton', 'Следующая строка')}
                </button>
                <div
                  className={`overflow-hidden rounded-full transition-[max-width,opacity,margin,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    canPublish
                      ? 'ml-2 max-w-[156px] opacity-100 translate-x-0'
                      : 'ml-0 max-w-0 opacity-0 translate-x-3 pointer-events-none'
                  }`}
                >
                  <button
                    type="button"
                    onClick={onPublish}
                    disabled={publishPending}
                    className={`inline-flex h-10 w-[156px] items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-300 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)] disabled:cursor-default disabled:opacity-60 ${
                      canPublish ? 'translate-x-0 opacity-100 delay-75' : 'translate-x-3 opacity-0 delay-0'
                    }`}
                  >
                    {publishPending ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 size={13} className="animate-spin" />
                        <span>{t('track.communitySyncPublishing', 'Публикация...')}</span>
                      </span>
                    ) : (
                      t('track.communitySyncPublish', 'Опубликовать')
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

const CommunitySyncPublishConfirm = React.memo(
  ({
    open,
    pending,
    onClose,
    onConfirm,
    t,
    trackName,
    artistName,
    albumName,
    duration,
    onTrackNameChange,
    onArtistNameChange,
    onAlbumNameChange,
    onDurationChange,
  }: {
    open: boolean;
    pending: boolean;
    onClose: () => void;
    onConfirm: () => void;
    t: TFunction;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: string;
    onTrackNameChange: (value: string) => void;
    onArtistNameChange: (value: string) => void;
    onAlbumNameChange: (value: string) => void;
    onDurationChange: (value: string) => void;
  }) => {
    if (!open || typeof document === 'undefined') return null;

    return createPortal(
      <div
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/72 backdrop-blur-[18px]"
        onClick={pending ? undefined : onClose}
      >
        <div
          className="w-[min(92vw,560px)] rounded-[30px] border border-white/[0.08] bg-[rgba(12,12,16,0.82)] px-6 py-6 shadow-[0_42px_160px_rgba(0,0,0,0.64)] backdrop-blur-[30px] animate-fade-in-up"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
            {t('track.communitySyncPublishConfirmLabel', 'Подтверждение')}
          </div>
          <div className="mt-3 text-[22px] font-semibold tracking-tight text-white/92">
            {t(
              'track.communitySyncPublishConfirmTitle',
              'Проверьте синхронизацию перед публикацией',
            )}
          </div>
          <div className="mt-3 text-[13px] leading-6 text-white/54">
            {t(
              'track.communitySyncPublishConfirmText',
              'После отправки синхронизацию нельзя будет изменить через LRCLIB API. Если всё звучит точно, можно публиковать.',
            )}
          </div>

          <div className="mt-6 space-y-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncTrackName', 'Track Name')}
              </label>
              <input
                type="text"
                value={trackName}
                onChange={(e) => onTrackNameChange(e.target.value)}
                disabled={pending}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncArtistName', 'Artist Name')}
              </label>
              <input
                type="text"
                value={artistName}
                onChange={(e) => onArtistNameChange(e.target.value)}
                disabled={pending}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncAlbumName', 'Album Name')}
              </label>
              <input
                type="text"
                value={albumName}
                onChange={(e) => onAlbumNameChange(e.target.value)}
                disabled={pending}
                placeholder={t('track.communitySyncAlbumNamePlaceholder', 'Optional')}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncDuration', 'Duration (seconds)')}
              </label>
              <input
                type="number"
                value={duration}
                onChange={(e) => onDurationChange(e.target.value)}
                disabled={pending}
                min="0"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white disabled:cursor-default disabled:opacity-38"
            >
              {t('common.cancel', 'Отменить')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)] disabled:cursor-default disabled:opacity-38"
            >
              {pending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={13} className="animate-spin" />
                  <span>{t('track.communitySyncPublishing', 'Публикация...')}</span>
                </span>
              ) : (
                t('track.communitySyncPublishNow', 'Опубликовать')
              )}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  },
);

export const LyricsPanel = React.memo(
  ({
    forceOpen = false,
    panelClassName = '',
    panelStyle,
    live = true,
  }: {
    forceOpen?: boolean;
    panelClassName?: string;
    panelStyle?: React.CSSProperties;
    live?: boolean;
  }) => {
    const open = useLyricsStore((s) => s.open);
    const visible = forceOpen || open;
    const interactiveVisible = visible && live;
    const close = useLyricsStore((s) => s.close);
    const openAnimation = useFullscreenPanelStore((s) => s.openAnimation);
    const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
    const track = usePlayerStore((s) => s.currentTrack);
    const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
    const { t } = useTranslation();
const artworkColor = useArtworkColor(track?.artwork_url ?? null);

const [isEditing, setIsEditing] = useState(false);

const manualQueryRef = useRef(
  new Map<string, LyricsSearchQuery>(),
);

const [manualQuery, setManualQuery] = useState<TrackScopedLyricsSearchQuery | null>(null);

const [editArtist, setEditArtist] = useState('');
const [editTitle, setEditTitle] = useState('');
const [isResizingSplit, setIsResizingSplit] = useState(false);
const splitLayoutRef = useRef<HTMLDivElement>(null);
const splitDraggingRef = useRef(false);

    const trackUrn = track?.urn ?? null;
    const activeManualQuery = getPreferredTrackLyricsSearchQuery(trackUrn, manualQuery, manualQueryRef);
    const reqArtist = activeManualQuery ? activeManualQuery.artist : (track?.user.username ?? '');
    const reqTitle = activeManualQuery ? activeManualQuery.title : (track?.title ?? '');
    const manualLyricsRef = useRef(
  new Map<string, ManualLyricsCacheEntry>(),
);
    const autoLyricsRef = useRef(
  new Map<string, LyricsResult>(),
);
    const {
      data: lyrics,
      generatedFromPlain,
      } = useResolvedLyrics(
        interactiveVisible,
        track,
        reqArtist,
        reqTitle,
        getTrackDurationMs(track),
        manualLyricsRef,
        activeManualQuery,
        autoLyricsRef,
      );
const warmupEnabled =
  interactiveVisible && generatedFromPlain;
    useAudioTextWarmup(
      warmupEnabled,
      track,
      reqArtist,
      reqTitle,
      lyrics,
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset editor state only on track switch
useEffect(() => {
  if (!trackUrn) {
    setManualQuery(null);
    return;
  }

  const savedManualQuery = manualQueryRef.current.get(trackUrn) ?? null;
  setManualQuery(
    savedManualQuery ? buildTrackScopedLyricsSearchQuery(trackUrn, savedManualQuery) : null,
  );
  setIsEditing(false);
}, [trackUrn]);

    useEffect(() => {
      if (!interactiveVisible) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [interactiveVisible, close]);

    useEffect(() => {
      if (!isResizingSplit) return;

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };
    }, [isResizingSplit]);

    useEffect(() => {
      if (!interactiveVisible && splitDraggingRef.current) {
        splitDraggingRef.current = false;
        setIsResizingSplit(false);
      }
    }, [interactiveVisible]);

    if (!visible || !track) return null;

    const backgroundArtSources = getTrackBackgroundArtworkSources(track);
    const rootClassName = forceOpen
      ? `fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#08080a] ${openAnimation === 'fromMiniPlayer' ? 'animate-fullscreen-from-player' : ''} ${closeAnimation === 'toMiniPlayer' ? 'animate-fullscreen-to-player' : ''} ${panelClassName}`.trim()
      : 'fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]';

    return (
      <>
      <div className={rootClassName} style={panelStyle}>
        <FullscreenBackground
          key={`${track.urn}-bg`}
          artworkSources={backgroundArtSources}
          trackKey={track.urn}
          color={artworkColor}
        />

        <div className="absolute top-6 left-6 z-20 pointer-events-none">
          <StreamQualityBadge
            quality={track.streamQuality}
            codec={track.streamCodec}
            access={track.access}
            className="backdrop-blur-sm"
          />
        </div>

        {/* Close */}
        <div
          className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2"
          data-tauri-drag-region
        >
          <button
            type="button"
            onClick={() => {
              useLyricsStore.setState({ open: false, communitySyncStage: 'idle' });
              useFullscreenPanelStore.getState().setOpenAnimation('default');
              useFullscreenPanelStore.getState().setTransitionDirection('toArtwork');
              useFullscreenPanelStore.getState().setMode('artwork');
              setTimeout(
                () => useFullscreenPanelStore.getState().setTransitionDirection('none'),
                500,
              );
              useArtworkStore.setState({ open: true });
            }}
            className="h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-white/45 hover:text-white/80 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
          >
            <Maximize2 size={14} />
            <span>{t('nav.fullscreen', 'Fullscreen')}</span>
          </button>
          <button
            type="button"
            onClick={close}
            className="w-9 h-9 rounded-full flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
          >
            <X size={18} />
          </button>
        </div>

        {/* 50/50 */}
        <div
          ref={splitLayoutRef}
          className={`relative z-10 grid flex-1 min-h-0 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${isResizingSplit ? 'select-none' : ''} ${
            forceOpen ? 'lyrics-fullscreen-layout' : ''
          }`}
          style={{
            isolation: 'isolate',
            gridTemplateColumns: forceOpen ? '0% 1fr' : '30% 70%',
          }}
        >
          <div className={`min-w-0 min-h-0 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            forceOpen ? 'player-column-compact' : ''
          }`}>
            <TrackColumn key={track.urn} track={track} />
          </div>

          {/* Divider */}
            <div
              className={`absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                forceOpen ? 'opacity-0 pointer-events-none' : `transition-colors duration-150 ${
                isResizingSplit ? 'bg-white/20' : 'bg-white/[0.04] group-hover/splitter:bg-white/10'
              }`
              }`}
            />
            <div
              className={`absolute left-1/2 top-1/2 flex h-14 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                forceOpen ? 'opacity-0 pointer-events-none' : `duration-150 ${
                isResizingSplit
                  ? 'border-white/18 bg-white/[0.12] shadow-[0_0_20px_rgba(255,255,255,0.08)]'
                  : 'border-white/[0.08] bg-white/[0.04] group-hover/splitter:border-white/14 group-hover/splitter:bg-white/[0.08]'
              }`
              }`}
            >
              <div className="flex flex-col gap-1.5">
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
              </div>
            </div>
          </div>

          {/* Right: lyrics */}
          <div className={`min-w-0 min-h-0 flex flex-col relative transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            forceOpen ? 'lyrics-fullscreen-active' : ''
          }`}>
            {isEditing ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 px-12 animate-fade-in-up">
                <h3 className="text-white/80 font-bold mb-2">
                  {t('track.manualSearch', 'Manual Search')}
                </h3>
                <input
                  value={editArtist}
                  onChange={(e) => setEditArtist(e.target.value)}
                  placeholder={t('track.artist')}
                  className="w-full max-w-[280px] bg-white/10 px-4 py-2.5 rounded-xl text-white text-[14px] outline-none border border-transparent focus:border-white/20 placeholder:text-white/30"
                />
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder={t('track.title')}
                  className="w-full max-w-[280px] bg-white/10 px-4 py-2.5 rounded-xl text-white text-[14px] outline-none border border-transparent focus:border-white/20 placeholder:text-white/30"
                />
                <div className="flex gap-3 mt-4">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="px-5 py-2 rounded-full text-[13px] font-medium text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    {t('common.back')}
                  </button>
                  <button
                    type="button"
                      onClick={() => {
                        const query = {
                          artist: editArtist.trim(),
                          title: editTitle.trim(),
                        };
                        if (!trackUrn || !query.artist || !query.title) return;

                        manualQueryRef.current.set(trackUrn, query);
                        setManualQuery(buildTrackScopedLyricsSearchQuery(trackUrn, query));

                        setIsEditing(false);
                      }}
                    className="px-6 py-2 rounded-full text-[13px] font-bold bg-white/20 hover:bg-white/30 text-white transition-colors"
                  >
                    {t('track.search', 'Search')}
                  </button>
                </div>
              </div>
            ) : shouldRenderSyncedLyrics(lyrics) ? (
              <>
                <LyricsSourceBadge
                  source={lyrics.source}
                  onSearch={() => {
                    const parsed = splitArtistTitle(track?.title ?? '');
                    setEditArtist(
                      activeManualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                    );
                    setEditTitle(
                      activeManualQuery?.title || (parsed ? parsed[1] : track?.title || ''),
                    );
                    setIsEditing(true);
                  }}
                />
                {interactiveVisible ? (
<StaticSyncedLyrics lines={lyrics.synced} />
                ) : (
                  <StaticSyncedLyrics lines={lyrics.synced} />
                )}
              </>
            ) : shouldRenderPlainLyrics(lyrics) ? (
              <>
                <LyricsSourceBadge
                  source={lyrics.source}
                  onSearch={() => {
                    const parsed = splitArtistTitle(track?.title ?? '');
                    setEditArtist(
                      activeManualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                    );
                    setEditTitle(
                      activeManualQuery?.title || (parsed ? parsed[1] : track?.title || ''),
                    );
                    setIsEditing(true);
                  }}
                />
                <PlainLyrics text={lyrics.plain} />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 px-12 text-center relative">
                <button
                  type="button"
                  onClick={() => {
                    const parsed = splitArtistTitle(track?.title ?? '');
                    setEditArtist(
                      activeManualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                    );
                    setEditTitle(
                      activeManualQuery?.title || (parsed ? parsed[1] : track?.title || ''),
                    );
                    setIsEditing(true);
                  }}
                  className="w-12 h-12 flex items-center justify-center rounded-full text-white/40 hover:text-white/70 hover:bg-white/10 transition-all"
                >
                  <Search size={18} />
                </button>
              </div>
            )}
          </div>
      </div>

      {live && visualizerFullscreen && <FullscreenVisualizer />}
    </>
  );
},
);

/* ── Artwork Fullscreen Panel ─────────────────────────────── */

export const ArtworkPanel = React.memo(
  ({
    forceOpen = false,
    panelClassName = '',
    panelStyle,
    live = true,
  }: {
    forceOpen?: boolean;
    panelClassName?: string;
    panelStyle?: React.CSSProperties;
    live?: boolean;
  }) => {
    const { t } = useTranslation();
    const open = useArtworkStore((s) => s.open);
    const visible = forceOpen || open;
    const interactiveVisible = visible && live;
    const setOpen = useArtworkStore((s) => s.setOpen);
    const openLyrics = useLyricsStore((s) => s.openPanel);
    const openAnimation = useFullscreenPanelStore((s) => s.openAnimation);
    const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
    const track = usePlayerStore((s) => s.currentTrack);
    const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
    const artworkColor = useArtworkColor(track?.artwork_url ?? null);
    const {
      artworkLightboxOpen,
      artworkLightboxSource,
      artworkLightboxAnchorRect,
      artworkLightboxSourceElement,
      openArtworkLightbox,
      closeArtworkLightbox,
      handleArtworkLightboxExited,
    } = useArtworkLightboxState();

    useEffect(() => {
      if (!interactiveVisible) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [interactiveVisible, setOpen]);

    if (!visible || !track) return null;

    const backgroundArtSources = getTrackBackgroundArtworkSources(track);
    const rootClassName = forceOpen
      ? `fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#08080a] ${openAnimation === 'fromMiniPlayer' ? 'animate-fullscreen-from-player' : ''} ${closeAnimation === 'toMiniPlayer' ? 'animate-fullscreen-to-player' : ''} ${panelClassName}`.trim()
      : 'fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]';

    return (
      <>
        <div className={rootClassName} style={panelStyle}>
          <FullscreenBackground
            key={`${track.urn}-bg`}
            artworkSources={backgroundArtSources}
            trackKey={track.urn}
            color={artworkColor}
          />

          <div className="absolute top-6 left-6 z-20 pointer-events-none">
            <StreamQualityBadge
              quality={track.streamQuality}
              codec={track.streamCodec}
              access={track.access}
              className="backdrop-blur-sm"
            />
          </div>

          {/* Close */}
          <div
            className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2"
            data-tauri-drag-region
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openLyrics();
              }}
              className="h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-white/45 hover:text-white/80 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
            >
              <MicVocal size={14} />
              <span>{t('track.lyrics')}</span>
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
            >
              <X size={18} />
            </button>
          </div>

          {/* Centered single column */}
          <div
            className="relative z-10 flex-1 flex items-center justify-center min-h-0"
            style={{ isolation: 'isolate' }}
          >
            <TrackColumn
              key={track.urn}
              track={track}
              maxArt="max-w-[600px]"
              onOpenArtworkLightbox={(sourceElement) =>
                openArtworkLightbox('track-column', sourceElement)
              }
            />
          </div>

          {live && visualizerFullscreen && <FullscreenVisualizer />}
        </div>

        <ArtworkLightbox
          track={track}
          open={artworkLightboxOpen}
          source={artworkLightboxSource}
          anchorRect={artworkLightboxAnchorRect}
          sourceElement={artworkLightboxSourceElement}
          onAfterClose={handleArtworkLightboxExited}
          onClose={closeArtworkLightbox}
        />
      </>
    );
  },
);

/** Imperative API so NowPlayingBar can open without prop drilling */
export const artworkPanelApi = {
  open: () => useArtworkStore.getState().setOpen(true),
  openFromMiniPlayer: () => useArtworkStore.getState().openFromMiniPlayer(),
  close: () => useArtworkStore.getState().setOpen(false),
};

let pendingMiniPlayerLyricsActionId = 0;

export const lyricsPanelApi = {
  openFromMiniPlayer: () => {
    pendingMiniPlayerLyricsActionId += 1;
    artworkPanelApi.openFromMiniPlayer();
  },
};

const CompactLyricsDockTransport = React.memo(({ track }: { track: Track }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prevTrack = usePlayerStore((s) => s.prev);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const nextLocked = useTrackSwitchCooldown(TRACK_SWITCH_NEXT_SCOPE);
  const prevLocked = useTrackSwitchCooldown(TRACK_SWITCH_PREV_SCOPE);

  const compactCtrl =
    'flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/58 transition-all duration-200 outline-none hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white active:scale-[0.97] disabled:cursor-default disabled:text-white/28';
  const compactAccentCtrl = (active: boolean) =>
    active
      ? `${compactCtrl} theme-accent-soft text-white/96 hover:text-white/96`
      : compactCtrl;

  const handleOpenInSoundCloud = useCallback(() => {
    void (async () => {
      const permalink = await resolveTrackPermalink(track);
      if (!permalink) return;
      await openExternal(permalink);
    })();
  }, [track]);

return (
  <div className="flex items-center gap-2 pl-2.5">
    <AddToPlaylistDialog trackUrn={track.urn}>
      <button type="button" className={compactCtrl}>
        <ListPlus size={16} />
      </button>
    </AddToPlaylistDialog>

    <FullscreenLikeButton track={track} compact />

    <button
      type="button"
      onClick={toggleShuffle}
      className={compactAccentCtrl(shuffle)}
    >
      {shuffleIcon16}
    </button>

    <button
      type="button"
      onClick={prevTrack}
      disabled={prevLocked}
      className={compactCtrl}
    >
      <SkipBack size={18} fill="currentColor" />
    </button>

    <button
      type="button"
      onClick={togglePlay}
      className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black shadow-[0_14px_32px_rgba(255,255,255,0.16)] transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] outline-none"
    >
      {isPlaying ? pauseBlack18 : playBlack18}
    </button>

    <button
      type="button"
      onClick={next}
      disabled={nextLocked}
      className={compactCtrl}
    >
      <SkipForward size={18} fill="currentColor" />
    </button>

    <button
      type="button"
      onClick={toggleRepeat}
      className={compactAccentCtrl(repeat !== 'off')}
    >
      {repeat === 'one'
        ? repeat1Icon16
        : repeatIcon16}
    </button>

    <FullscreenDislikeButton track={track} compact />

    <button
      type="button"
      onClick={handleOpenInSoundCloud}
      className={compactCtrl}
    >
      <ExternalLink size={16} />
    </button>
  </div>
);
});

const LyricsMiniPlayerDock = ({
  track,
  color,
  openAnimation,
  closeAnimation,
  hideArtwork,
  forceCollapsed = false,
  onOpenArtworkLightbox,
}: {
  track: Track;
  color: [number, number, number];
  openAnimation: 'default' | 'fromMiniPlayer';
  closeAnimation: 'none' | 'toMiniPlayer';
  hideArtwork: boolean;
  forceCollapsed?: boolean;
  onOpenArtworkLightbox: (sourceElement: HTMLElement | null) => void;
}) => {
  const { t } = useTranslation();
  const controlsCollapsed = useSettingsStore((s) => s.lyricsMiniPlayerControlsCollapsed);
  const setControlsCollapsed = useSettingsStore((s) => s.setLyricsMiniPlayerControlsCollapsed);
  const effectiveControlsCollapsed = forceCollapsed || controlsCollapsed;
  const [r, g, b] = color;
  const dockAnimationClass =
    closeAnimation === 'toMiniPlayer'
      ? 'animate-lyrics-mini-player-out'
      : openAnimation === 'fromMiniPlayer'
        ? 'animate-lyrics-mini-player-in'
        : 'animate-lyrics-mini-player-in';

  return (
    <div
      className={`lyrics-mini-player-dock ${dockAnimationClass}`}
      style={{ width: 'min(420px, calc(100vw - 32px))' }}
    >
      <div
        className="lyrics-mini-player-shell group/lyrics-mini-player relative overflow-hidden rounded-[30px] border border-white/[0.12] bg-black/[0.28] p-4 text-white shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_0_1px_rgba(255,255,255,0.03)_inset]"
        style={{ backdropFilter: 'blur(30px) saturate(1.38)' }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.035)_18%,rgba(255,255,255,0.015)_100%)]" />
        <div
          className="pointer-events-none absolute inset-0 opacity-85"
          style={{
            background: `
              radial-gradient(circle at 12% 88%, rgba(${r}, ${g}, ${b}, 0.24) 0%, transparent 46%),
              radial-gradient(circle at 82% 14%, rgba(255,255,255,0.08) 0%, transparent 38%)
            `,
          }}
        />
        <div className="pointer-events-none absolute inset-px rounded-[29px] border border-white/[0.06]" />
        {!forceCollapsed ? (
          <button
            type="button"
            onClick={() => setControlsCollapsed(!controlsCollapsed)}
            title={
              controlsCollapsed
                ? t('track.showMiniPlayerControls', 'Show controls')
                : t('track.hideMiniPlayerControls', 'Hide controls')
            }
            aria-label={
              controlsCollapsed
                ? t('track.showMiniPlayerControls', 'Show controls')
                : t('track.hideMiniPlayerControls', 'Hide controls')
            }
            className="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-black/[0.24] text-white/54 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-md transition-all duration-200 ease-[var(--ease-apple)] hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white/88 focus-visible:opacity-100 focus-visible:outline-none group-hover/lyrics-mini-player:opacity-100"
          >
            {controlsCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : null}

        <div className="lyrics-mini-player-content relative">
          <div className="lyrics-mini-player-header flex items-start gap-4">
            <LyricsMiniPlayerArtwork
              track={track}
              controlsCollapsed={effectiveControlsCollapsed}
              hideArtwork={hideArtwork}
              onOpenArtworkLightbox={onOpenArtworkLightbox}
            />

            <div className="min-w-0 flex-1 pt-1">
              <AdaptiveTrackTitle
                text={track.title}
                baseSize={18}
                minSize={14}
                step={0.1}
                className="truncate text-[18px] font-semibold leading-tight text-white/92"
              />
              <p className="mt-1 truncate text-[13px] font-medium text-white/46">
                {track.user.username}
              </p>

              <div className="mb-1 flex justify-end">
                <ProgressTime />
              </div>

              <div className="-mt-1">
                <ProgressSlider />
              </div>
            </div>
          </div>

          <div
            className={`overflow-hidden transition-[max-height,opacity,transform,margin] duration-300 ease-[var(--ease-apple)] ${
              effectiveControlsCollapsed
                ? 'mt-0 max-h-0 translate-y-2 opacity-0 pointer-events-none'
                : 'mt-4 max-h-[180px] translate-y-0 opacity-100'
            }`}
          >
            <div className="lyrics-mini-player-transport flex items-center justify-between gap-3">
              <CompactLyricsDockTransport track={track} />
            </div>

            <div className="lyrics-mini-player-volume mt-4 rounded-[20px] border border-white/[0.06] bg-black/[0.16] px-6.5 py-2.5">
              <FullscreenVolumeSlider />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const LyricsMiniPlayerArtwork = React.memo(
  ({
    track,
    controlsCollapsed,
    hideArtwork,
    onOpenArtworkLightbox,
  }: {
    track: Track;
    controlsCollapsed: boolean;
    hideArtwork: boolean;
    onOpenArtworkLightbox: (sourceElement: HTMLElement | null) => void;
  }) => {
  const { t } = useTranslation();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const previewArtSources = useMemo(
    () =>
      uniqueArtworkSources([
        ...getTrackArtworkSources(track, 't200x200'),
        ...getTrackArtworkSources(track, 't500x500'),
      ]),
    [track.artwork_url, track.user.avatar_url],
  );
  const displayArtSources = useMemo(
    () =>
      uniqueArtworkSources([
        ...getTrackArtworkSources(track, 't500x500'),
        ...getTrackArtworkSources(track, 't200x200'),
      ]),
    [track.artwork_url, track.user.avatar_url],
  );
  const previewArtSourcesKey = previewArtSources.join('|');
  const displayArtSourcesKey = displayArtSources.join('|');
  const { currentSrc: previewArtSrc, handleError: handlePreviewArtError } = useFallbackImageSource(
    previewArtSources,
    `${track.urn}:lyrics-mini-preview`,
  );
  const { currentSrc: displayArtSrc, handleError: handleDisplayArtError } = useFallbackImageSource(
    displayArtSources,
    `${track.urn}:lyrics-mini-display`,
  );
  const [loaded, setLoaded] = useState(false);
  const artworkFrameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLoaded(false);
  }, [track.urn, previewArtSourcesKey, displayArtSourcesKey]);

  useEffect(() => {
    const urls = displayArtSources.slice(0, 2);
    const preloadedImages: HTMLImageElement[] = [];

    for (const [index, url] of urls.entries()) {
      const img = new window.Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = index === 0 ? 'high' : 'auto';
      img.src = url;
      preloadedImages.push(img);
    }

    return () => {
      for (const img of preloadedImages) {
        img.src = '';
      }
    };
  }, [displayArtSourcesKey, track.urn]);

  const hasArtwork = Boolean(previewArtSrc || displayArtSrc);

  return (
    <div
      className={`group/lyrics-mini-art relative h-[88px] w-[88px] shrink-0 overflow-hidden rounded-[24px] ring-1 ring-white/[0.1] shadow-[0_16px_36px_rgba(0,0,0,0.35)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        controlsCollapsed ? '' : 'cursor-zoom-in hover:scale-[1.025]'
      }`}
    >
      {hasArtwork ? (
        <>
          <div
            ref={artworkFrameRef}
            className="absolute inset-0 overflow-hidden rounded-[24px]"
          >
            {hideArtwork ? (
              <div className="absolute inset-0 rounded-[24px] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" />
            ) : (
              <>
                <img
                  key={`${track.urn}-lyrics-mini-preview-${previewArtSrc ?? displayArtSrc ?? 'fallback'}`}
                  src={previewArtSrc || displayArtSrc || ''}
                  alt=""
                  className={`absolute inset-0 h-full w-full object-cover scale-105 transition-[opacity,transform,filter] duration-500 ease-[var(--ease-apple)] ${
                    loaded ? 'opacity-0' : 'opacity-100'
                  } ${
                    controlsCollapsed
                      ? ''
                      : 'group-hover/lyrics-mini-art:scale-[1.08] group-hover/lyrics-mini-art:blur-[6px] group-hover/lyrics-mini-art:brightness-[0.72]'
                  }`}
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                  onError={handlePreviewArtError}
                />
                <img
                  key={`${track.urn}-lyrics-mini-display-${displayArtSrc ?? previewArtSrc ?? 'fallback'}`}
                  src={displayArtSrc || previewArtSrc || ''}
                  alt={track.title}
                  className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform,filter] duration-500 ease-[var(--ease-apple)] ${
                    loaded ? 'opacity-100' : 'opacity-0'
                  } ${
                    controlsCollapsed
                      ? ''
                      : 'group-hover/lyrics-mini-art:scale-[1.03] group-hover/lyrics-mini-art:blur-[6px] group-hover/lyrics-mini-art:brightness-[0.72]'
                  }`}
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                  onLoad={() => setLoaded(true)}
                  onError={() => {
                    setLoaded(false);
                    handleDisplayArtError();
                  }}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white/[0.06]">
          <MicVocal size={28} className="text-white/18" />
        </div>
      )}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0)_45%,rgba(0,0,0,0.14)_100%)]" />
      {controlsCollapsed && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 ease-[var(--ease-apple)] group-hover/lyrics-mini-player:bg-black/[0.18] group-hover/lyrics-mini-player:opacity-100 focus-visible:bg-black/[0.18] focus-visible:opacity-100 focus-visible:outline-none"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-black shadow-[0_12px_28px_rgba(0,0,0,0.24)] transition-transform duration-200 ease-[var(--ease-apple)] group-hover/lyrics-mini-player:scale-100 scale-[0.92]">
            {isPlaying ? pauseBlack18 : playBlack18}
          </span>
        </button>
      )}
      {!controlsCollapsed && !hideArtwork && (
        <button
          type="button"
          onClick={() => onOpenArtworkLightbox(artworkFrameRef.current)}
          aria-label={t('track.viewArtwork', 'View')}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/lyrics-mini-art:bg-black/[0.18] group-hover/lyrics-mini-art:opacity-100 focus-visible:bg-black/[0.18] focus-visible:opacity-100 focus-visible:outline-none"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/18 bg-white/[0.16] text-white/92 shadow-[0_14px_36px_rgba(0,0,0,0.26)] backdrop-blur-md transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] scale-[0.9] group-hover/lyrics-mini-art:scale-100">
            <Eye size={16} />
          </span>
        </button>
      )}
    </div>
  );
});

const FullscreenLyricsMiniPlayerOverlay = React.memo(
  ({
    track,
    color,
    openAnimation,
    closeAnimation,
    hideArtwork,
    forceCollapsed = false,
    onOpenArtworkLightbox,
  }: {
    track: Track;
    color: [number, number, number];
    openAnimation: 'default' | 'fromMiniPlayer';
    closeAnimation: 'none' | 'toMiniPlayer';
    hideArtwork: boolean;
    forceCollapsed?: boolean;
    onOpenArtworkLightbox: (sourceElement: HTMLElement | null) => void;
  }) => {
    if (typeof document === 'undefined') return null;
    const overlayAnimationClass =
      closeAnimation === 'toMiniPlayer' ? 'animate-fullscreen-to-player' : '';

    return createPortal(
      <div className={`pointer-events-none fixed inset-0 z-[68] ${overlayAnimationClass}`.trim()}>
        <div
          className="pointer-events-auto absolute"
          style={{
            left: 'clamp(20px, 3vw, 40px)',
            bottom: 'clamp(20px, 3vh, 40px)',
          }}
        >
          <LyricsMiniPlayerDock
            track={track}
            color={color}
            openAnimation={openAnimation}
            closeAnimation={closeAnimation}
            hideArtwork={hideArtwork}
            forceCollapsed={forceCollapsed}
            onOpenArtworkLightbox={onOpenArtworkLightbox}
          />
        </div>
      </div>,
      document.body,
    );
  },
);

const FullscreenLyricsColumn = React.memo(
  ({
    lyrics,
    warmupEnabled,
    suppressFallback,
  }: {
    lyrics: ResolvedLyricsData;
    warmupEnabled: boolean;
    motionHints: ReturnType<typeof getLyricMotionHintsForTrack>;
    pseudoSynced: boolean;
    hintLabel: string | null;
    suppressFallback: boolean;
  }) => {
    return (
      <div
        className="relative mx-auto flex h-full w-full max-w-[960px] flex-col overflow-hidden"
        style={{ transform: 'translateX(-30px)' }}
      >
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          {suppressFallback ? (
            <div className="flex-1" />
          ) : shouldRenderSyncedLyrics(lyrics) ? (
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {warmupEnabled ? (
                <StaticSyncedLyrics lines={lyrics.synced} />
              ) : (
                <SyncedLyricsWithPlaceholders lines={lyrics.synced} />
              )}
            </div>
          ) : shouldRenderPlainLyrics(lyrics) ? (
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              <PlainLyrics text={lyrics.plain} />
            </div>
          ) : lyrics?.synced ? (
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              <StaticSyncedLyrics lines={lyrics.synced} />
            </div>
          ) : (
            <div className="flex-1" />
          )}
        </div>
      </div>
    );
  },
);

const FullscreenPanels = React.memo(() => {
  const mode = useFullscreenPanelStore((s) => s.mode);
  const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
  const openAnimation = useFullscreenPanelStore((s) => s.openAnimation);
  const open = useLyricsStore((s) => s.open);
  const setCommunitySyncStageInStore = useLyricsStore((s) => s.setCommunitySyncStage);
  const track = usePlayerStore((s) => s.currentTrack);
  const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
  const lyricsMiniPlayerControlsCollapsed = useSettingsStore((s) => s.lyricsMiniPlayerControlsCollapsed);
  const setLyricsMiniPlayerControlsCollapsed = useSettingsStore(
    (s) => s.setLyricsMiniPlayerControlsCollapsed,
  );
  const artworkColor = useArtworkColor(track?.artwork_url ?? null);
  const { t } = useTranslation();
  const communityDraft = useCommunityLyricsDraftStore((s) =>
    track?.urn ? (s.draftsByTrackUrn[track.urn] ?? null) : null,
  );
  const saveCommunityDraft = useCommunityLyricsDraftStore((s) => s.saveDraft);
  const removeCommunityDraft = useCommunityLyricsDraftStore((s) => s.removeDraft);
  const {
    artworkLightboxOpen,
    artworkLightboxSource,
    artworkLightboxAnchorRect,
    artworkLightboxSourceArtworkHidden,
    artworkLightboxSourceElement,
    openArtworkLightbox,
    closeArtworkLightbox,
    handleArtworkLightboxExited,
  } = useArtworkLightboxState('lyrics-mini-player');
  const isLyrics = mode === 'lyrics';
  const closingToMiniPlayer = closeAnimation === 'toMiniPlayer';
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const manualQueryRef = useRef(new Map<string, LyricsSearchQuery>());
  const [manualQuery, setManualQuery] = useState<TrackScopedLyricsSearchQuery | null>(null);
  const [submittedSearchQuery, setSubmittedSearchQuery] =
    useState<TrackScopedLyricsSearchQuery | null>(null);
  const [showNotFoundHint, setShowNotFoundHint] = useState(false);
  const [lyricsSessionRequested, setLyricsSessionRequested] = useState(false);
  const [isTrackLyricsPending, setIsTrackLyricsPending] = useState(false);
  const [communitySyncStage, setCommunitySyncStage] = useState<CommunitySyncStage>('idle');
  const [communitySyncSession, setCommunitySyncSession] = useState<CommunitySyncSession | null>(
    null,
  );
  const [communityPublishPending, setCommunityPublishPending] = useState(false);
  const [communityPublishedLyricsByTrack, setCommunityPublishedLyricsByTrack] = useState<
    Record<string, LyricsResult>
  >({});
  const [communityPublishEditTrackName, setCommunityPublishEditTrackName] = useState('');
  const [communityPublishEditArtistName, setCommunityPublishEditArtistName] = useState('');
  const [communityPublishEditAlbumName, setCommunityPublishEditAlbumName] = useState('');
  const [communityPublishEditDuration, setCommunityPublishEditDuration] = useState('');
  const notFoundHintTimeoutRef = useRef<number | null>(null);
  const pendingLyricsActionAfterLoadRef = useRef(false);
  const pendingManualSearchResolveRef = useRef(false);
  const pendingTrackAutoOpenRef = useRef(false);
  const skipNextArtworkToLyricsSharedTransitionRef = useRef(false);
  const handledMiniPlayerRequestRef = useRef(0);
  const communitySyncSessionRef = useRef<CommunitySyncSession | null>(null);
  const miniPlayerCollapsedBeforeCommunityFlowRef = useRef<boolean | null>(null);
  const prevTrackUrnRef = useRef<string | null>(null);
  const trackUrn = track?.urn ?? null;
  const isTrackSwitchingFrame =
    prevTrackUrnRef.current !== null && prevTrackUrnRef.current !== trackUrn;
  const activeManualQuery = getPreferredTrackLyricsSearchQuery(trackUrn, manualQuery, manualQueryRef);
  const activeSubmittedSearchQuery =
    submittedSearchQuery && submittedSearchQuery.trackUrn === trackUrn
      ? submittedSearchQuery
      : null;

  const reqArtist = activeManualQuery ? activeManualQuery.artist : (track?.user?.username ?? '');
  const reqTitle = activeManualQuery ? activeManualQuery.title : (track?.title ?? '');
  const manualLyricsRef = useRef(
  new Map<string, ManualLyricsCacheEntry>(),
);
  const autoLyricsRef = useRef(
  new Map<string, LyricsResult>(),
);
  const {
    data: lyrics,
    isLoading,
    pseudoSynced,
    generatedFromPlain,
} = useResolvedLyrics(
  mode !== 'none',
  track,
  reqArtist,
  reqTitle,
  getTrackDurationMs(track),
  manualLyricsRef,
  activeManualQuery,
  autoLyricsRef,
);
  const manualSearchResultQuery = useQuery({
    queryKey: [
      'lyrics-manual-search',
      LYRICS_SEARCH_QUERY_VERSION,
      trackUrn,
      activeSubmittedSearchQuery?.artist ?? null,
      activeSubmittedSearchQuery?.title ?? null,
    ],
    queryFn: () =>
      searchLyrics(
        trackUrn!,
        activeSubmittedSearchQuery!.artist,
        activeSubmittedSearchQuery!.title,
        getLyricsSearchOptions(
          track,
          activeSubmittedSearchQuery!.artist,
          activeSubmittedSearchQuery!.title,
          getTrackDurationMs(track),
        ),
      ),
    enabled: mode !== 'none' && !!trackUrn && !!activeSubmittedSearchQuery,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 1,
  });
  const displayedLyrics =
    trackUrn && communityPublishedLyricsByTrack[trackUrn]
      ? communityPublishedLyricsByTrack[trackUrn]
      : lyrics;
  const warmupEnabled = Boolean(mode !== 'none' && generatedFromPlain && !displayedLyrics?.synced);
  const { motionHints, hintLabel } = useAudioTextWarmup(
    warmupEnabled,
    track,
    reqArtist,
    reqTitle,
    displayedLyrics,
  );
  const hasLyrics = hasRenderableLyrics(displayedLyrics);
  const lyricsStageActive = isLyrics && hasLyrics;
  const searchPrefill = useMemo(
    () => getLyricsSearchPrefill(track, activeManualQuery),
    [track, activeManualQuery],
  );
  const communitySyncTrackMeta = useMemo<CommunitySyncTrackMeta | null>(() => {
    if (!trackUrn || !track) return null;

    return {
      trackUrn,
      artistName: searchPrefill.artist.trim() || track.user?.username || '',
      trackName: searchPrefill.title.trim() || track.title || '',
      durationSec: track.duration > 0 ? track.duration / 1000 : 0,
    };
  }, [searchPrefill.artist, searchPrefill.title, track, trackUrn]);
  const searchResultState: 'idle' | 'loading' | 'found' | 'not_found' =
    activeSubmittedSearchQuery === null
      ? 'idle'
      : manualSearchResultQuery.isLoading
        ? 'loading'
        : manualSearchResultQuery.data
          ? 'found'
          : 'not_found';
  const suppressLyricsFallback =
    lyricsSessionRequested && (isTrackLyricsPending || isTrackSwitchingFrame) && !hasLyrics;
  const suppressLyricsStage = suppressLyricsFallback || isTrackSwitchingFrame;
  const hideMiniPlayerArtwork =
    artworkLightboxSource === 'lyrics-mini-player' && artworkLightboxSourceArtworkHidden;
  const canCreateCommunitySyncForTrack = canCreateCommunitySync(displayedLyrics);
  const communityDraftSession = useMemo(
    () => (communityDraft ? createCommunitySyncSessionFromDraft(communityDraft) : null),
    [communityDraft],
  );
  const communityDraftTotalLines = communityDraftSession ? communityDraftSession.lines.length : 0;
  const communityDraftReadyToPublish =
    communityDraftTotalLines > 0 &&
    Boolean(communityDraft && communityDraft.syncedLyrics.length >= communityDraftTotalLines);
  const canRetryCommunityDraft = Boolean(communityDraft && !displayedLyrics?.synced?.length);
  const communityFlowActive = communitySyncStage !== 'idle';
  const showCommunityActionButton = lyricsStageActive && !communityFlowActive;
  const communityActionLabel = canRetryCommunityDraft
    ? communityDraftReadyToPublish
      ? t('track.communitySyncOpenSavedButton', 'Открыть сохранённую синхронизацию')
      : t('track.communitySyncResumeButton', 'Продолжить сохранённую синхронизацию')
    : canCreateCommunitySyncForTrack
      ? t('track.communitySyncCreateButton', 'Создать синхронизацию')
      : null;
  const clearNotFoundHint = useCallback(() => {
    if (notFoundHintTimeoutRef.current !== null) {
      window.clearTimeout(notFoundHintTimeoutRef.current);
      notFoundHintTimeoutRef.current = null;
    }
    setShowNotFoundHint(false);
  }, []);

  const showNotFoundBubble = useCallback(() => {
    clearNotFoundHint();
    setShowNotFoundHint(true);
    notFoundHintTimeoutRef.current = window.setTimeout(() => {
      setShowNotFoundHint(false);
      notFoundHintTimeoutRef.current = null;
    }, 3000);
  }, [clearNotFoundHint]);

  const restartFinishedCommunitySyncTrack = useCallback(() => {
    const player = usePlayerStore.getState();
    if (!player.currentTrack || player.isPlaying) return;

    const duration = getDuration();
    if (!(duration > 0)) return;
    if (getCurrentTime() < Math.max(0, duration - 0.45)) return;

    player.resume();
  }, []);

  const resetCommunitySyncFlow = useCallback((restartTrackIfFinished = false) => {
    setCommunitySyncStage('idle');
    setCommunitySyncSession(null);
    setCommunityPublishPending(false);
    if (restartTrackIfFinished) {
      restartFinishedCommunitySyncTrack();
    }
  }, [restartFinishedCommunitySyncTrack]);

  useEffect(() => {
    communitySyncSessionRef.current = communitySyncSession;
  }, [communitySyncSession]);

  useEffect(() => {
    if (communityFlowActive) {
      if (miniPlayerCollapsedBeforeCommunityFlowRef.current === null) {
        miniPlayerCollapsedBeforeCommunityFlowRef.current = lyricsMiniPlayerControlsCollapsed;
      }
      if (!lyricsMiniPlayerControlsCollapsed) {
        setLyricsMiniPlayerControlsCollapsed(true);
      }
      return;
    }

    const previousCollapsedState = miniPlayerCollapsedBeforeCommunityFlowRef.current;
    if (previousCollapsedState === null) return;

    miniPlayerCollapsedBeforeCommunityFlowRef.current = null;
    if (lyricsMiniPlayerControlsCollapsed !== previousCollapsedState) {
      setLyricsMiniPlayerControlsCollapsed(previousCollapsedState);
    }
  }, [
    communityFlowActive,
    lyricsMiniPlayerControlsCollapsed,
    setLyricsMiniPlayerControlsCollapsed,
  ]);

  useEffect(
    () => () => {
      const previousCollapsedState = miniPlayerCollapsedBeforeCommunityFlowRef.current;
      if (previousCollapsedState === null) return;

      const settings = useSettingsStore.getState();
      if (settings.lyricsMiniPlayerControlsCollapsed !== previousCollapsedState) {
        settings.setLyricsMiniPlayerControlsCollapsed(previousCollapsedState);
      }
    },
    [],
  );

  useEffect(() => {
    setCommunitySyncStageInStore(communitySyncStage);
  }, [communitySyncStage, setCommunitySyncStageInStore]);

  useEffect(() => () => setCommunitySyncStageInStore('idle'), [setCommunitySyncStageInStore]);

  useEffect(() => {
    if (communitySyncStage !== 'sync') return;

    const syncEditorToPlayback = () => {
      const currentSession = communitySyncSessionRef.current;
      if (!currentSession || currentSession.lines.length === 0) return;

      const nextActiveIndex = getCommunitySyncPlaybackIndex(
        currentSession.lines,
        getCurrentTime(),
        currentSession.activeIndex,
      );

      if (nextActiveIndex === currentSession.activeIndex) return;

      setCommunitySyncSession((session) => {
        if (!session) return session;

        const resolvedIndex = getCommunitySyncPlaybackIndex(
          session.lines,
          getCurrentTime(),
          session.activeIndex,
        );

        if (resolvedIndex === session.activeIndex) return session;
        return {
          ...session,
          activeIndex: resolvedIndex,
        };
      });
    };

    syncEditorToPlayback();
    const intervalId = window.setInterval(syncEditorToPlayback, 90);
    return () => window.clearInterval(intervalId);
  }, [communitySyncStage]);

  const startCommunitySync = useCallback(() => {
    if (!track || !canCreateCommunitySyncForTrack) return;

    const session = createCommunitySyncSession(displayedLyrics.plain, displayedLyrics.source);
    if (!session) {
      toast.error(t('track.communitySyncNoLines', 'Не удалось подготовить строки для синхронизации'));
      return;
    }

    setIsSearchModalOpen(false);
    setCommunitySyncSession(session);
    setCommunitySyncStage('sync');
  }, [canCreateCommunitySyncForTrack, displayedLyrics, t, track]);

  const handleCommunityAction = useCallback(() => {
    if (canRetryCommunityDraft) {
      if (!communityDraft) return;

      const session = createCommunitySyncSessionFromDraft(communityDraft);
      if (!session) {
        toast.error(t('track.communitySyncNoLines', 'Не удалось подготовить строки для синхронизации'));
        return;
      }

      setIsSearchModalOpen(false);
      setCommunitySyncSession(session);
      setCommunitySyncStage('sync');
      return;
    }

    startCommunitySync();
  }, [
    canRetryCommunityDraft,
    communityDraft,
    startCommunitySync,
    t,
  ]);

  const closeCommunitySyncWithoutSave = useCallback(() => {
    resetCommunitySyncFlow(true);
  }, [resetCommunitySyncFlow]);

  const dismissCommunityPublishConfirm = useCallback(() => {
    setCommunitySyncStage('sync');
  }, []);

  const persistCommunitySyncDraft = useCallback((session: CommunitySyncSession) => {
    if (!communitySyncTrackMeta) return;

    if (!hasCommunitySyncStampedLines(session.lines)) {
      removeCommunityDraft(communitySyncTrackMeta.trackUrn);
      return;
    }

    saveCommunityDraft({
      ...toCommunitySyncDraft(communitySyncTrackMeta, session),
      createdAt: new Date().toISOString(),
    });
  }, [communitySyncTrackMeta, removeCommunityDraft, saveCommunityDraft]);

  const handleCommunitySyncLine = useCallback(() => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession) return;
    const targetIndex = getCommunitySyncStampTargetIndex(currentSession);
    if (targetIndex < 0 || targetIndex >= currentSession.lines.length) return;

    const { previousTime, nextTime } = getCommunitySyncTimeBounds(currentSession.lines, targetIndex);
    const nextLines = currentSession.lines.map((line, index) =>
      index === targetIndex
        ? {
            ...line,
            time: getStampedCommunitySyncTime(getCurrentTime(), previousTime, nextTime),
          }
        : line,
    );
    const nextPendingIndex = findCommunitySyncNextPendingIndex(nextLines, targetIndex + 1);

    const nextSession: CommunitySyncSession = {
      ...currentSession,
      lines: nextLines,
      activeIndex: nextPendingIndex >= 0 ? nextPendingIndex : targetIndex,
    };

    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [persistCommunitySyncDraft]);

  const handleCommunitySyncUndo = useCallback(() => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession) return;

    const activeLine = currentSession.lines[currentSession.activeIndex];
    const targetIndex =
      currentSession.activeIndex < 0
        ? findCommunitySyncNextStampedIndex(currentSession.lines, 0)
        : activeLine && typeof activeLine.time === 'number'
          ? currentSession.activeIndex
          : findCommunitySyncPreviousStampedIndex(currentSession.lines, currentSession.activeIndex - 1);

    if (targetIndex < 0) return;

    const targetLine = currentSession.lines[targetIndex];
    const nextLines =
      targetLine?.kind === 'pause'
        ? currentSession.lines.filter((_, index) => index !== targetIndex)
        : currentSession.lines.map((line, index) =>
            index === targetIndex
              ? {
                  ...line,
                  time: null,
                }
              : line,
          );

    const nextSession = {
      ...currentSession,
      lines: nextLines,
      activeIndex: resolveCommunitySyncActiveIndex(
        nextLines,
        Math.max(0, Math.min(targetIndex, nextLines.length - 1)),
      ),
    };

    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [persistCommunitySyncDraft]);

  const handleCommunitySyncInsertPause = useCallback(() => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession) return;

    const insertIndex = getCommunitySyncPauseInsertIndex(currentSession);
    const { previousTime, nextTime } = getCommunitySyncTimeBounds(currentSession.lines, insertIndex);
    const pauseLine = createCommunitySyncPauseLine(
      getStampedCommunitySyncTime(getCurrentTime(), previousTime, nextTime),
    );
    const nextLines = [
      ...currentSession.lines.slice(0, insertIndex),
      pauseLine,
      ...currentSession.lines.slice(insertIndex),
    ];

    const nextSession = {
      ...currentSession,
      lines: nextLines,
      activeIndex: Math.max(0, Math.min(insertIndex + 1, nextLines.length - 1)),
    };

    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [persistCommunitySyncDraft]);

  const handleCommunityTimestampCommit = useCallback((index: number, nextTime: number) => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession || index < 0 || index >= currentSession.lines.length) return;

    const { previousTime, nextTime: followingTime } = getCommunitySyncTimeBounds(
      currentSession.lines,
      index,
    );
    const resolvedTime = getStampedCommunitySyncTime(nextTime, previousTime, followingTime);

    const nextSession = {
      ...currentSession,
      lines: currentSession.lines.map((line, lineIndex) =>
        lineIndex === index
          ? {
              ...line,
              time: resolvedTime,
            }
          : line,
      ),
      activeIndex: index,
    };

    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [persistCommunitySyncDraft]);

  const handleCommunitySyncSeekLine = useCallback((index: number) => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession || index < 0 || index >= currentSession.lines.length) return;

    const targetTime = currentSession.lines[index]?.time;
    if (typeof targetTime !== 'number') return;

    seek(targetTime, true, true);
    setCommunitySyncSession((session) =>
      session && session.activeIndex !== index
        ? {
            ...session,
            activeIndex: index,
          }
        : session,
    );
  }, []);

  const handleCommunityPublishRequest = useCallback(() => {
    if (!isCommunitySyncSessionComplete(communitySyncSessionRef.current)) return;
    if (!communitySyncTrackMeta) return;
    
    setCommunityPublishEditTrackName(communitySyncTrackMeta.trackName);
    setCommunityPublishEditArtistName(communitySyncTrackMeta.artistName);
    setCommunityPublishEditAlbumName('');
    setCommunityPublishEditDuration(String(Math.round(communitySyncTrackMeta.durationSec)));
    setCommunitySyncStage('confirm');
  }, [communitySyncTrackMeta]);

  const handleCommunityPublishConfirm = useCallback(async () => {
    const currentSession = communitySyncSessionRef.current;
    if (!communitySyncTrackMeta || !currentSession || !isCommunitySyncSessionComplete(currentSession)) {
      return;
    }

    const draft = {
      ...toCommunitySyncDraft(communitySyncTrackMeta, currentSession),
      createdAt: new Date().toISOString(),
    };

    const durationSec = parseInt(communityPublishEditDuration) || 0;

    setCommunityPublishPending(true);
    try {
      await invoke('lrclib_publish_lyrics', {
        artistName: communityPublishEditArtistName,
        trackName: communityPublishEditTrackName,
        duration: durationSec,
        plainLyrics: draft.plainLyrics,
        syncedLyrics: serializeCommunitySyncedLyrics(draft.syncedLyrics),
        albumName: communityPublishEditAlbumName || null,
      });

      removeCommunityDraft(draft.trackUrn);
      setCommunityPublishedLyricsByTrack((current) => ({
        ...current,
        [draft.trackUrn]: {
          plain: draft.plainLyrics,
          synced: draft.syncedLyrics,
          source: 'lrclib',
        },
      }));
      resetCommunitySyncFlow(true);
      toast.success(
        t('track.communitySyncPublished', 'Синхронизация опубликована в LRCLIB'),
      );
    } catch (error) {
      saveCommunityDraft(draft);
      setCommunitySyncStage('sync');
      toast.error(t('track.communitySyncPublishFailed', 'Не удалось опубликовать синхронизацию'), {
        description: t(
          'track.communitySyncPublishFailedDesc',
          'Синхронизация сохранена локально. Вы сможете отправить её позже.',
        ),
      });
      console.error('LRCLIB publish failed', error);
    } finally {
      setCommunityPublishPending(false);
    }
  }, [
    communitySyncTrackMeta,
    communityPublishEditArtistName,
    communityPublishEditTrackName,
    communityPublishEditAlbumName,
    communityPublishEditDuration,
    removeCommunityDraft,
    resetCommunitySyncFlow,
    saveCommunityDraft,
    t,
  ]);

  useEffect(() => {
    if (communitySyncStage === 'idle') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (isEditableKeyboardTarget(event.target)) return;

      if (communitySyncStage === 'sync') {
        if (event.code === 'Space') {
          event.preventDefault();
          handleCommunitySyncLine();
          return;
        }
        if (event.code === 'Backspace') {
          event.preventDefault();
          handleCommunitySyncUndo();
          return;
        }
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        if (communitySyncStage === 'sync') {
          closeCommunitySyncWithoutSave();
          return;
        }
        dismissCommunityPublishConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    closeCommunitySyncWithoutSave,
    communitySyncStage,
    dismissCommunityPublishConfirm,
    handleCommunitySyncLine,
    handleCommunitySyncUndo,
  ]);

  const openLyricsMode = useCallback(() => {
    const applyModeChange = () => {
      clearNotFoundHint();
      setLyricsSessionRequested(true);
      setIsTrackLyricsPending(false);
      pendingTrackAutoOpenRef.current = false;
      setIsSearchModalOpen(false);
      useArtworkStore.setState({ open: false });
      useFullscreenPanelStore.getState().setMode('lyrics');
      useLyricsStore.setState({ open: true, communitySyncStage: 'idle' });
    };

    const fullscreenState = useFullscreenPanelStore.getState();
    const skipArtworkSharedTransition = skipNextArtworkToLyricsSharedTransitionRef.current;
    skipNextArtworkToLyricsSharedTransitionRef.current = false;

    if (fullscreenState.mode === 'artwork' && !skipArtworkSharedTransition) {
      runDocumentViewTransition(applyModeChange);
      return;
    }

    applyModeChange();
  }, [clearNotFoundHint]);

  const openSearchModal = useCallback(() => {
    clearNotFoundHint();
    setIsSearchModalOpen(true);
  }, [clearNotFoundHint]);

  const closeLyricsModeManually = useCallback(() => {
    const applyModeChange = () => {
      clearNotFoundHint();
      setLyricsSessionRequested(false);
      setIsTrackLyricsPending(false);
      setIsSearchModalOpen(false);
      resetCommunitySyncFlow(true);
      pendingLyricsActionAfterLoadRef.current = false;
      pendingManualSearchResolveRef.current = false;
      pendingTrackAutoOpenRef.current = false;
      useLyricsStore.setState({ open: false, communitySyncStage: 'idle' });
      useFullscreenPanelStore.getState().setMode('artwork');
      useArtworkStore.setState({ open: true });
    };

    runDocumentViewTransition(applyModeChange);
  }, [clearNotFoundHint, resetCommunitySyncFlow]);

  const handleManualSearch = useCallback((artist: string, title: string) => {
    if (!trackUrn) return;
    const nextQuery = { artist: artist.trim(), title: title.trim() };
    if (!nextQuery.artist || !nextQuery.title) return;
    pendingManualSearchResolveRef.current = true;
    setSubmittedSearchQuery(buildTrackScopedLyricsSearchQuery(trackUrn, nextQuery));
  }, [trackUrn]);

  const handleLyricsAction = useCallback(() => {
    clearNotFoundHint();
    setLyricsSessionRequested(true);
    if (suppressLyricsFallback) {
      pendingLyricsActionAfterLoadRef.current = true;
      setIsTrackLyricsPending(true);
      return;
    }
    if (hasLyrics) {
      pendingLyricsActionAfterLoadRef.current = false;
      setIsTrackLyricsPending(false);
      openLyricsMode();
      return;
    }
    if (isLoading) {
      pendingLyricsActionAfterLoadRef.current = true;
      setIsTrackLyricsPending(true);
      return;
    }
    pendingLyricsActionAfterLoadRef.current = false;
    setIsTrackLyricsPending(false);
    showNotFoundBubble();
  }, [
    clearNotFoundHint,
    hasLyrics,
    isLoading,
    openLyricsMode,
    showNotFoundBubble,
    suppressLyricsFallback,
  ]);

  useEffect(() => {
    if (!trackUrn || mode === 'none') {
      if (!trackUrn) {
        setManualQuery(null);
      }
      return;
    }

    const savedManualQuery = manualQueryRef.current.get(trackUrn) ?? null;
    setManualQuery(
      savedManualQuery ? buildTrackScopedLyricsSearchQuery(trackUrn, savedManualQuery) : null,
    );
  }, [mode, trackUrn]);

  useEffect(() => {
    if (mode !== 'none') return;

    setLyricsSessionRequested(false);
    setIsTrackLyricsPending(false);
    resetCommunitySyncFlow(true);
    setManualQuery(null);
    setSubmittedSearchQuery(null);
    setIsSearchModalOpen(false);
    clearNotFoundHint();
    pendingLyricsActionAfterLoadRef.current = false;
    pendingManualSearchResolveRef.current = false;
    pendingTrackAutoOpenRef.current = false;
    skipNextArtworkToLyricsSharedTransitionRef.current = false;
  }, [mode, clearNotFoundHint, resetCommunitySyncFlow]);

  useEffect(() => {
    if (closeAnimation !== 'toMiniPlayer') return;

    setLyricsSessionRequested(false);
    setIsTrackLyricsPending(false);
    resetCommunitySyncFlow(true);
    setManualQuery(null);
    setSubmittedSearchQuery(null);
    setIsSearchModalOpen(false);
    clearNotFoundHint();
    pendingLyricsActionAfterLoadRef.current = false;
    pendingManualSearchResolveRef.current = false;
    pendingTrackAutoOpenRef.current = false;
    skipNextArtworkToLyricsSharedTransitionRef.current = false;
  }, [clearNotFoundHint, closeAnimation, resetCommunitySyncFlow]);

  useEffect(() => {
    const nextUrn = track?.urn ?? null;
    const prevUrn = prevTrackUrnRef.current;

    if (closeAnimation === 'toMiniPlayer') {
      prevTrackUrnRef.current = nextUrn;
      return;
    }

    if (nextUrn && nextUrn !== prevUrn) {
      const savedManualQuery = manualQueryRef.current.get(nextUrn) ?? null;
      setManualQuery(
        savedManualQuery ? buildTrackScopedLyricsSearchQuery(nextUrn, savedManualQuery) : null,
      );
      resetCommunitySyncFlow();
      setSubmittedSearchQuery(null);
      setIsSearchModalOpen(false);
      clearNotFoundHint();
      pendingLyricsActionAfterLoadRef.current = false;
      pendingManualSearchResolveRef.current = false;
      skipNextArtworkToLyricsSharedTransitionRef.current = false;

      const cachedManualLyricsForNewTrack = getCachedManualLyrics(
        manualLyricsRef,
        nextUrn,
        savedManualQuery,
      );
      const cachedAutoLyricsForNewTrack =
        !savedManualQuery ? (autoLyricsRef.current.get(nextUrn) ?? null) : null;
      const cachedLyricsForNewTrack = cachedManualLyricsForNewTrack ?? cachedAutoLyricsForNewTrack;
      const hasImmediateLyrics = Boolean(cachedLyricsForNewTrack);

      if (lyricsSessionRequested) {
        if (hasImmediateLyrics) {
          openLyricsMode();
        }
        pendingTrackAutoOpenRef.current = false;
        setIsTrackLyricsPending(false);
      } else {
        pendingTrackAutoOpenRef.current = false;
        setIsTrackLyricsPending(false);
      }
    }

    prevTrackUrnRef.current = nextUrn;
  }, [
    track?.urn,
    clearNotFoundHint,
    closeAnimation,
    lyricsSessionRequested,
    openLyricsMode,
    resetCommunitySyncFlow,
  ]);

  useEffect(() => {
    return () => clearNotFoundHint();
  }, [clearNotFoundHint]);

  useEffect(() => {
    if (track?.urn && !isLoading) {
      setIsTrackLyricsPending(false);
    }
  }, [track?.urn, isLoading]);

  useEffect(() => {
    if (mode === 'none' || closeAnimation !== 'none') return;
    if (!pendingLyricsActionAfterLoadRef.current) return;
    if (isLoading || isTrackSwitchingFrame) return;

    pendingLyricsActionAfterLoadRef.current = false;
    setIsTrackLyricsPending(false);

    if (hasLyrics) {
      openLyricsMode();
      return;
    }

    if (lyricsSessionRequested) {
      showNotFoundBubble();
    }
  }, [
    closeAnimation,
    hasLyrics,
    isLoading,
    isTrackSwitchingFrame,
    lyricsSessionRequested,
    mode,
    openLyricsMode,
    showNotFoundBubble,
  ]);

  useEffect(() => {
    if (!pendingManualSearchResolveRef.current) return;
    if (activeSubmittedSearchQuery === null || manualSearchResultQuery.isLoading || isTrackSwitchingFrame) {
      return;
    }

    pendingManualSearchResolveRef.current = false;

    if (!trackUrn || !manualSearchResultQuery.data) {
      return;
    }

    const resolvedQuery = {
      artist: activeSubmittedSearchQuery.artist,
      title: activeSubmittedSearchQuery.title,
    };

    manualQueryRef.current.set(trackUrn, resolvedQuery);
    manualLyricsRef.current.set(trackUrn, {
      ...resolvedQuery,
      lyrics: manualSearchResultQuery.data,
    });
    setManualQuery(buildTrackScopedLyricsSearchQuery(trackUrn, resolvedQuery));
    setSubmittedSearchQuery(null);
    openLyricsMode();
  }, [
    activeSubmittedSearchQuery,
    isTrackSwitchingFrame,
    manualSearchResultQuery.data,
    manualSearchResultQuery.isLoading,
    openLyricsMode,
    trackUrn,
  ]);

  useEffect(() => {
    if (
      mode !== 'lyrics' ||
      closeAnimation !== 'none' ||
      !lyricsSessionRequested ||
      isLoading ||
      !hasLyrics
    ) {
      return;
    }
    if (!open) {
      useLyricsStore.setState({ open: true, communitySyncStage: 'idle' });
    }
  }, [closeAnimation, hasLyrics, isLoading, mode, open, lyricsSessionRequested]);

  useEffect(() => {
    if (mode !== 'artwork' || openAnimation !== 'fromMiniPlayer') return;
    if (handledMiniPlayerRequestRef.current === pendingMiniPlayerLyricsActionId) return;
    handledMiniPlayerRequestRef.current = pendingMiniPlayerLyricsActionId;
    skipNextArtworkToLyricsSharedTransitionRef.current = true;
    handleLyricsAction();
  }, [handleLyricsAction, mode, openAnimation]);

  if (mode === 'none' || !track) return null;

  const backgroundArtSources = getTrackBackgroundArtworkSources(track);
  const animClass =
    closeAnimation === 'toMiniPlayer'
      ? 'animate-fullscreen-to-player'
      : openAnimation === 'fromMiniPlayer'
        ? 'animate-fullscreen-from-player'
        : 'animate-fade-in-up';

  return (
    <>
      <div
        className={`fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#08080a] ${animClass}`}
        style={{ pointerEvents: closingToMiniPlayer ? 'none' : 'auto' }}
      >
      <FullscreenBackground
        key={`${track.urn}-bg`}
        artworkSources={backgroundArtSources}
        trackKey={track.urn}
        color={artworkColor}
      />

      <div className="absolute left-6 top-6 z-20 flex max-w-[min(380px,calc(100vw-3rem))] flex-col items-start gap-2 pointer-events-none">
        <StreamQualityBadge
          quality={track.streamQuality}
          codec={track.streamCodec}
          access={track.access}
          className="backdrop-blur-sm"
        />
        {showCommunityActionButton && communityActionLabel ? (
          <button
            type="button"
            onClick={handleCommunityAction}
            className="pointer-events-auto inline-flex min-h-9 items-center rounded-full border border-white/[0.08] bg-[rgba(12,12,16,0.38)] px-3.5 py-2 text-left text-[11px] font-medium text-white/70 shadow-[0_18px_40px_rgba(0,0,0,0.24)] backdrop-blur-[20px] transition-all duration-300 hover:border-white/[0.14] hover:bg-[rgba(18,18,24,0.52)] hover:text-white hover:shadow-[0_0_26px_rgba(255,255,255,0.08)]"
          >
            {communityActionLabel}
          </button>
        ) : null}
      </div>

      {/* Header */}
      <div
        className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2"
        data-tauri-drag-region
      >
        {lyricsStageActive ? (
          <>
            {!communityFlowActive ? (
              <>
                {lyrics ? (
                  <span className="inline-flex h-9 items-center rounded-full border border-white/[0.06] bg-white/[0.04] px-3 text-[10px] font-semibold text-white/20">
                    {SOURCE_LABELS[lyrics.source]}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={openSearchModal}
                  className="relative h-9 w-9 rounded-full flex items-center justify-center text-white/52 hover:text-white/82 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
                >
                  <Search size={14} />
                </button>
                <button
                  type="button"
                  onClick={closeLyricsModeManually}
                  className="h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-white/45 hover:text-white/80 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
                >
                  <Maximize2 size={14} />
                  <span>{t('nav.fullscreen')}</span>
                </button>
              </>
            ) : null}
          </>
        ) : (
          <div className="relative flex flex-col items-end">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openSearchModal}
                className="relative h-9 w-9 rounded-full flex items-center justify-center text-white/52 hover:text-white/82 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
              >
                <Search size={14} />
                {isLoading ? (
                  <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-black/38 text-white/65 shadow-[0_4px_18px_rgba(0,0,0,0.24)] backdrop-blur-sm">
                    <Loader2 size={10} className="animate-spin" />
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={handleLyricsAction}
                className={`h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold transition-all duration-200 cursor-pointer outline-none ${
                  lyricsSessionRequested
                    ? 'bg-white/[0.08] text-white/88 shadow-[0_8px_28px_rgba(0,0,0,0.18)]'
                    : 'text-white/58 hover:text-white/84 hover:bg-white/[0.08]'
                }`}
              >
                <MicVocal size={14} />
                <span>{t('track.lyrics')}</span>
              </button>
            </div>
            <div
              className={`pointer-events-none absolute right-0 top-full mt-2 transition-all duration-300 ${
                showNotFoundHint ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
              }`}
            >
              <div className="rounded-full border border-white/[0.12] bg-black/42 px-3 py-1.5 text-[11px] font-medium text-white/72 shadow-[0_10px_35px_rgba(0,0,0,0.34)] backdrop-blur-md whitespace-nowrap">
                {t('track.lyricsNotFoundHint', 'Try searching on Genius.com')}
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => useFullscreenPanelStore.getState().beginClose()}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
        >
          <X size={18} />
        </button>
      </div>

      <div className="relative z-10 flex-1 min-h-0" style={{ isolation: 'isolate' }}>
        {lyricsStageActive ? (
          <div className="mx-auto flex h-full w-full max-w-[min(1240px,calc(100vw-2rem))] items-center justify-center px-[clamp(20px,4vw,72px)] pb-[clamp(44px,8vh,96px)]">
            <div className="h-full min-h-0 w-full">
              {/* artwork mode: column width scales with viewport height — */}
              {/* clamps between 280px (very short windows) and 640px (4K). */}
              {/* Reserves ~460px for title + slider + controls + panel + */}
              {/* gaps + fullscreen header. If still not enough, the column */}
              {(communitySyncStage === 'sync' || communitySyncStage === 'confirm') &&
              communitySyncSession ? (
                <CommunitySyncEditor
                  session={communitySyncSession}
                  onSyncLine={handleCommunitySyncLine}
                  onInsertPause={handleCommunitySyncInsertPause}
                  onUndo={handleCommunitySyncUndo}
                  onPublish={handleCommunityPublishRequest}
                  publishPending={communityPublishPending}
                  onSeekLine={handleCommunitySyncSeekLine}
                  onUpdateTimestamp={handleCommunityTimestampCommit}
                  onCancel={closeCommunitySyncWithoutSave}
                  t={t}
                />
              ) : (
                <FullscreenLyricsColumn
                  lyrics={lyrics}
                  warmupEnabled={warmupEnabled}
                  motionHints={warmupEnabled ? motionHints : []}
                  pseudoSynced={pseudoSynced}
                  hintLabel={hintLabel}
                  suppressFallback={suppressLyricsStage}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 items-center justify-center">
            <TrackColumn
              key={track.urn}
              track={track}
              maxArt="max-w-[min(640px,max(280px,calc(100vh-460px)))]"
              onOpenArtworkLightbox={(sourceElement) =>
                openArtworkLightbox('track-column', sourceElement)
              }
            />
          </div>
        )}
      </div>

      {visualizerFullscreen && <FullscreenVisualizer />}
      </div>

      {lyricsStageActive && (
        <FullscreenLyricsMiniPlayerOverlay
          track={track}
          color={artworkColor}
          openAnimation={openAnimation}
          closeAnimation={closeAnimation}
          hideArtwork={hideMiniPlayerArtwork}
          forceCollapsed={communityFlowActive}
          onOpenArtworkLightbox={(sourceElement) =>
            openArtworkLightbox('lyrics-mini-player', sourceElement)
          }
        />
      )}

      <ArtworkLightbox
        track={track}
        open={artworkLightboxOpen}
        source={artworkLightboxSource}
        anchorRect={artworkLightboxAnchorRect}
        sourceElement={artworkLightboxSourceElement}
        onAfterClose={handleArtworkLightboxExited}
        onClose={closeArtworkLightbox}
      />

      <CommunitySyncPublishConfirm
        open={communitySyncStage === 'confirm'}
        pending={communityPublishPending}
        onClose={dismissCommunityPublishConfirm}
        onConfirm={() => {
          void handleCommunityPublishConfirm();
        }}
        t={t}
        trackName={communityPublishEditTrackName}
        artistName={communityPublishEditArtistName}
        albumName={communityPublishEditAlbumName}
        duration={communityPublishEditDuration}
        onTrackNameChange={setCommunityPublishEditTrackName}
        onArtistNameChange={setCommunityPublishEditArtistName}
        onAlbumNameChange={setCommunityPublishEditAlbumName}
        onDurationChange={setCommunityPublishEditDuration}
      />

      <LyricsSearchModal
        isOpen={isSearchModalOpen}
        onClose={() => {
          pendingManualSearchResolveRef.current = false;
          setIsSearchModalOpen(false);
        }}
        initialArtist={searchPrefill.artist}
        initialTitle={searchPrefill.title}
        onSearch={handleManualSearch}
        isSearching={Boolean(isSearchModalOpen && searchResultState === 'loading')}
        resultState={searchResultState}
        resultSource={manualSearchResultQuery.data?.source ?? null}
      />
    </>
  );
});

export { FullscreenPanels };

