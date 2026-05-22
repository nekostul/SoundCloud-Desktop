import * as Slider from '@radix-ui/react-slider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Volume, Volume2, VolumeX } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import {
  getFallbackArtworkGradientPalette,
  useArtworkGradientPalette,
} from '../../../lib/artwork-palette';
import { art } from '../../../lib/formatters';
import { invalidateAllLikesCache } from '../../../lib/hooks';
import {
  TRACK_SWITCH_NEXT_SCOPE,
  TRACK_SWITCH_PREV_SCOPE,
  useTrackSwitchCooldown,
} from '../../../lib/useTrackSwitchCooldown';
import {
  Ban,
  ExternalLink,
  Eye,
  Heart,
  ListPlus,
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
} from '../../../lib/icons';
import { optimisticToggleLike, useLiked } from '../../../lib/likes';
import type { LyricsSource } from '../../../lib/lyrics';
import { useDislikesStore } from '../../../stores/dislikes';
import type { Track } from '../../../stores/player';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';
import { useSoundWaveStore } from '../../../stores/soundwave';
import { ProgressSlider, ProgressTime } from '../../layout/NowPlayingBar';
import { AddToPlaylistDialog } from '../AddToPlaylistDialog';
import { PlaybackSpeedPresets } from '../PlaybackSpeedPresets';
import { SOURCE_LABELS } from './sourceLabels';

export function uniqueArtworkSources(values: Array<string | null | undefined>): string[] {
  return values.filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
}

export type ArtworkLightboxSource = 'track-column' | 'lyrics-mini-player';

export type ArtworkLightboxRect = {
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

export function runDocumentViewTransition(update: () => void) {
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

export function useArtworkLightboxState(defaultSource: ArtworkLightboxSource = 'track-column') {
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

export function getTrackArtworkSources(track: Track | null | undefined, size: string): string[] {
  if (!track) return [];

  return uniqueArtworkSources([art(track.artwork_url, size), art(track.user.avatar_url, size)]);
}

export function getTrackBackgroundArtworkSources(track: Track | null | undefined): string[] {
  return uniqueArtworkSources([
      ...getTrackArtworkSources(track, 't200x200'),
      ...getTrackArtworkSources(track, 't500x500'),
  ]);
}

export function getTrackFullscreenArtworkSources(track: Track | null | undefined): string[] {
  return uniqueArtworkSources([
    ...getTrackArtworkSources(track, 't500x500'),
    ...getTrackArtworkSources(track, 'original'),
    ...getTrackArtworkSources(track, 't200x200'),
  ]);
}

export function useFallbackImageSource(sources: string[], resetKey: string) {
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

export const resolveTrackPermalink = async (track: Track): Promise<string | null> => {
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

export const openExternal = async (url: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

export const LyricsSourceBadge = React.memo(
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

export const FullscreenBackground = React.memo(
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

export const FullscreenVisualizer = React.memo(() => {
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

export const FullscreenLikeButton = React.memo(({ track, compact }: { track: Track; compact?: boolean }) => {
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

export const FullscreenDislikeButton = React.memo(({ track, compact }: { track: Track; compact?: boolean }) => {
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

export const FullscreenVolumeSlider = React.memo(() => {
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

export const Controls = React.memo(({ track }: { track: Track }) => {
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

export const ArtworkLightbox = React.memo(
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

export const TrackColumn = React.memo(({
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

export function useArtworkColor(artworkUrl: string | null) {
  return (
    useArtworkGradientPalette(artworkUrl)?.accent ?? getFallbackArtworkGradientPalette().accent
  );
}

