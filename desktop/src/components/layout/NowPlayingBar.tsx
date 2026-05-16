import * as Slider from '@radix-ui/react-slider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Volume, Volume2, VolumeX } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { artworkPanelApi, lyricsPanelApi } from '../../components/music/LyricsPanel';
import { api, getTrackComments } from '../../lib/api';
import { isAppBackgrounded } from '../../lib/app-visibility';
import { useArtworkGradientPalette } from '../../lib/artwork-palette';
import {
  ARTWORK_SURFACE_BACKGROUND_POSITION,
  ARTWORK_SURFACE_BACKGROUND_REPEAT,
  ARTWORK_SURFACE_BACKGROUND_SIZE,
  buildArtworkSurfaceVisual,
} from '../../lib/artwork-surface';
import {
  getPlaybackBufferSnapshot,
  getCurrentTime,
  getDuration,
  getSmoothCurrentTime,
  handlePrev,
  seek,
  subscribePlaybackBuffer,
  subscribe,
} from '../../lib/audio';
import { updateDiscordLyric } from '../../lib/discord';
import { art, formatTime } from '../../lib/formatters';
import { cancelAnimationFrameImmediate, requestAnimationFrameImmediate } from '../../lib/framerate';
import { invalidateAllLikesCache } from '../../lib/hooks';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import { ARTWORK_CROSSFADE_MS, useCrossfadeBackground } from '../../lib/useCrossfadeBackground';
import {
  audioLines16,
  Ban,
  Heart,
  listMusic16,
  MicVocal,
  pauseBlack20,
  playBlack20,
  repeat1Icon16,
  repeatIcon16,
  SlidersHorizontal,
  shuffleIcon16,
  skipBack20,
  skipForward20,
} from '../../lib/icons';
import { optimisticToggleLike } from '../../lib/likes';
import { LYRICS_SEARCH_QUERY_VERSION, searchLyrics } from '../../lib/lyrics';
import { useDislikesStore } from '../../stores/dislikes';
import { useArtworkStore, useFullscreenPanelStore, useLyricsStore } from '../../stores/lyrics';
import { type Track, usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { type MoodLabel, useSoundWaveStore } from '../../stores/soundwave';
import { EqualizerPanel } from '../music/EqualizerPanel';
import { PlaybackSpeedPresets } from '../music/PlaybackSpeedPresets';
import { StreamQualityBadge } from '../music/StreamQualityBadge';

/* ── Download Progress Panel ────────────────────────────────── */

/* ── Progress Slider ─────────────────────────────────────────── */

export const ProgressSlider = React.memo(() => {
  const { t } = useTranslation();
  const duration = useSyncExternalStore(subscribe, getDuration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrackUrn = usePlayerStore((s) => s.currentTrack?.urn);
  const playbackBuffer = useSyncExternalStore(subscribePlaybackBuffer, getPlaybackBufferSnapshot);
  const lyricsOpen = useLyricsStore((s) => s.open);
  const artworkOpen = useArtworkStore((s) => s.open);

  const isFullscreenOverlayOpen = lyricsOpen || artworkOpen;
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);

  const { data: comments } = useQuery({
    queryKey: ['comments', currentTrackUrn],
    queryFn: () => getTrackComments(currentTrackUrn!),
    enabled: false,
    staleTime: 60 * 60 * 1000,
  });

  const [dragging, setDragging] = useState(false);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);
  const [dragValue, setDragValue] = useState(0);
  const [syncedValue, setSyncedValue] = useState(0);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [hideDurationTooltip, setHideDurationTooltip] = useState(false);

  const draggingRef = useRef(false);
  const dragRafRef = useRef<number | null>(null);
  const pendingDragValueRef = useRef<number | null>(null);
  const bufferedFillRef = useRef<HTMLDivElement | null>(null);
  const bufferedRatioRef = useRef(0);
  const bufferedRafRef = useRef<number | null>(null);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const progressDotRef = useRef<HTMLDivElement | null>(null);
  const sliderRootRef = useRef<HTMLDivElement | null>(null);
  const sliderTrackRef = useRef<HTMLSpanElement | null>(null);
  const progressTooltipRef = useRef<HTMLDivElement | null>(null);
  const durationTooltipRef = useRef<HTMLDivElement | null>(null);
  const durationRef = useRef(duration);
  const liveValueRef = useRef(0);

  const paintProgressFill = useCallback((value: number) => {
    liveValueRef.current = value;
    const safeDuration = durationRef.current;
    const ratio = safeDuration > 0 ? Math.max(0, Math.min(value / safeDuration, 1)) : 0;
    const percent = `${ratio * 100}%`;
    if (progressFillRef.current) {
      progressFillRef.current.style.transform = `scaleX(${ratio})`;
    }
    if (progressDotRef.current) {
      progressDotRef.current.style.left = percent;
      progressDotRef.current.style.transform =
        ratio <= 0.02 ? 'translateX(0)' : ratio >= 0.98 ? 'translateX(-100%)' : 'translateX(-50%)';
    }
    if (progressTooltipRef.current) {
      progressTooltipRef.current.style.left = percent;
      progressTooltipRef.current.style.transform =
        ratio <= 0.08 ? 'translateX(0)' : ratio >= 0.92 ? 'translateX(-100%)' : 'translateX(-50%)';
      progressTooltipRef.current.textContent = formatTime(value);
    }
  }, []);

  useEffect(() => {
    durationRef.current = duration;
    paintProgressFill(dragging ? dragValue : syncedValue);
  }, [dragValue, dragging, duration, paintProgressFill, syncedValue]);

  useEffect(() => {
    liveValueRef.current = 0;
    paintProgressFill(0);
    setSyncedValue(0);
  }, [currentTrackUrn, paintProgressFill]);

  // Keep slider state in sync without competing DOM mutations
  useEffect(() => {
    let rafId: number;

    const loop = () => {
      rafId = requestAnimationFrameImmediate(loop);
      if (draggingRef.current || isAppBackgrounded()) {
        return;
      }

      paintProgressFill(isPlaying ? getSmoothCurrentTime() : getCurrentTime());
    };

    rafId = requestAnimationFrameImmediate(loop);
    const unsub = subscribe(() => {
      if (!draggingRef.current) {
        const nextValue = getCurrentTime();
        paintProgressFill(nextValue);
        setSyncedValue((previousValue) =>
          Math.abs(previousValue - nextValue) < 0.05 ? previousValue : nextValue,
        );
      }
    });

    return () => {
      cancelAnimationFrameImmediate(rafId);
      unsub();
    };
  }, [isPlaying, paintProgressFill]);

  const displayValue = dragging ? dragValue : syncedValue;
  const seekableLimit = duration > 0 ? Math.max(0, duration - 0.15) : Number.POSITIVE_INFINITY;
  const seekDisabled = duration <= 0;
  const hoverPreviewEnabled = duration > 0;
  const bufferedRatio =
    playbackBuffer.progress != null
      ? Math.max(0, Math.min(playbackBuffer.progress, 1))
      : playbackBuffer.fullyCached
        ? 1
        : null;
  const bufferedPercent = bufferedRatio != null ? bufferedRatio * 100 : null;
  const roundedBufferedPercent =
    bufferedPercent == null
      ? null
      : playbackBuffer.fullyCached || bufferedPercent >= 99.95
        ? 100
        : Math.min(99, Math.max(1, Math.round(bufferedPercent)));
  const stateLabel = playbackBuffer.fullyCached
    ? null
    : roundedBufferedPercent != null
      ? playbackBuffer.phase === 'loading'
        ? t('player.loadingStreamProgress', 'Loading {{progress}}%', {
            progress: roundedBufferedPercent,
          })
        : t('player.cachingStreamProgress', 'Caching {{progress}}%', {
            progress: roundedBufferedPercent,
          })
      : playbackBuffer.phase === 'loading'
        ? t('player.loadingStream', 'Loading track')
        : playbackBuffer.phase === 'buffering'
          ? t('player.bufferingStream', 'Buffering')
          : !playbackBuffer.seekUnlocked
            ? t('player.seekLocked', 'Seek locked')
            : t('player.cachingStream', 'Caching track');
  const progressRatio = duration > 0 ? Math.max(0, Math.min(displayValue / duration, 1)) : 0;
  const sliderAssistVisible = (hoverPercent !== null || dragging) && hoverPreviewEnabled;
  const durationTooltipTransform = 'translateX(-100%)';
  const hoverPreviewRect =
    layoutRevision >= 0
      ? (sliderTrackRef.current?.getBoundingClientRect() ??
        sliderRootRef.current?.getBoundingClientRect() ??
        null)
      : null;
  const hoverPreviewTop = hoverPreviewRect ? Math.max(8, hoverPreviewRect.top - 34) : 0;
  const sliderRect = hoverPreviewRect;
  const flushPendingDragValue = useCallback(() => {
    dragRafRef.current = null;
    if (pendingDragValueRef.current == null) return;
    const nextValue = pendingDragValueRef.current;
    paintProgressFill(nextValue);
    setDragValue(nextValue);
    pendingDragValueRef.current = null;
  }, [paintProgressFill]);

  const showHoverPreview = sliderAssistVisible;
  const showHoverTooltips = showHoverPreview && !isFullscreenOverlayOpen;

  useEffect(() => {
    if (bufferedRafRef.current != null) {
      cancelAnimationFrame(bufferedRafRef.current);
      bufferedRafRef.current = null;
    }

    if (bufferedRatio == null) {
      bufferedRatioRef.current = 0;
      if (bufferedFillRef.current) {
        bufferedFillRef.current.style.transform = 'scaleX(0)';
      }
      return;
    }

    const target = Math.max(0, Math.min(bufferedRatio, 1));
    if (target <= bufferedRatioRef.current) {
      bufferedRatioRef.current = target;
      if (bufferedFillRef.current) {
        bufferedFillRef.current.style.transform = `scaleX(${target})`;
      }
      return;
    }

    const step = () => {
      const current = bufferedRatioRef.current;
      const delta = target - current;
      if (delta <= 0.0015) {
        bufferedRatioRef.current = target;
        if (bufferedFillRef.current) {
          bufferedFillRef.current.style.transform = `scaleX(${target})`;
        }
        bufferedRafRef.current = null;
        return;
      }

      const next = current + Math.max(delta * 0.16, 0.0035);
      bufferedRatioRef.current = Math.min(next, target);
      if (bufferedFillRef.current) {
        bufferedFillRef.current.style.transform = `scaleX(${bufferedRatioRef.current})`;
      }
      bufferedRafRef.current = requestAnimationFrame(step);
    };

    bufferedRafRef.current = requestAnimationFrame(step);

    return () => {
      if (bufferedRafRef.current != null) {
        cancelAnimationFrame(bufferedRafRef.current);
        bufferedRafRef.current = null;
      }
    };
  }, [bufferedRatio]);

  const onValueChange = useCallback(
    ([v]: number[]) => {
      if (seekDisabled) return;
      pendingDragValueRef.current = Math.min(v, seekableLimit);
      if (dragRafRef.current == null) {
        dragRafRef.current = requestAnimationFrame(flushPendingDragValue);
      }
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
    },
    [flushPendingDragValue, seekDisabled, seekableLimit],
  );

  const onValueCommit = useCallback(
    ([v]: number[]) => {
      if (seekDisabled) return;
      const nextValue = Math.min(v, seekableLimit);
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      pendingDragValueRef.current = null;
      paintProgressFill(nextValue);
      setDragValue(nextValue);
      seek(nextValue, true, true);
      draggingRef.current = false;
      setDragging(false);
      setSyncedValue(nextValue);
    },
    [paintProgressFill, seekDisabled, seekableLimit],
  );

  useEffect(() => {
    return () => {
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setLayoutRevision((v) => v + 1);
    const handleResize = () => setLayoutRevision((v) => v + 1);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setLayoutRevision((v) => v + 1);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!seekDisabled) return;
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingDragValueRef.current = null;
    draggingRef.current = false;
    paintProgressFill(0);
    setDragging(false);
    setHoverPercent(null);
  }, [paintProgressFill, seekDisabled]);

  useEffect(() => {
    if (!showHoverTooltips) {
      setHideDurationTooltip(false);
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const firstRect = progressTooltipRef.current?.getBoundingClientRect();
      const secondRect = durationTooltipRef.current?.getBoundingClientRect();
      if (!firstRect || !secondRect) {
        setHideDurationTooltip(false);
        return;
      }

      const shouldHide = firstRect.right >= secondRect.left - 1;
      setHideDurationTooltip((prev) => (prev === shouldHide ? prev : shouldHide));
    });

    return () => cancelAnimationFrame(frameId);
  }, [showHoverTooltips, displayValue, duration, progressRatio]);

  // Markers (little dots) on the track
  const markers = React.useMemo(() => {
    if (!comments || !duration) return null;
    return comments
      .filter((c) => c.timestamp != null)
      .map((c) => {
        const left = (c.timestamp! / (duration * 1000)) * 100;
        return (
          <div
            key={c.id}
            className="absolute top-1/2 -translate-y-1/2 w-0.5 h-0.5 rounded-full pointer-events-none bg-white/10"
            style={{ left: `${left}%` }}
          />
        );
      });
  }, [comments, duration]);

  return (
    <div className="relative w-full group/slider z-20">
      <Slider.Root
        ref={sliderRootRef}
        onPointerDownCapture={(e) => {
          if (!seekDisabled) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (!seekDisabled) return;
          e.preventDefault();
        }}
        onPointerEnter={(e) => {
          if (!hoverPreviewEnabled) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const percent = (e.clientX - rect.left) / rect.width;
          setHoverPercent(Math.max(0, Math.min(1, percent)));
        }}
        onPointerMove={(e) => {
          if (!hoverPreviewEnabled) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const percent = (e.clientX - rect.left) / rect.width;
          setHoverPercent(Math.max(0, Math.min(1, percent)));
        }}
        onPointerLeave={() => {
          setHoverPercent(null);
        }}
        aria-disabled={seekDisabled}
        className={`relative flex items-start w-full h-[10px] select-none touch-none group/slider ${
          seekDisabled ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'
        }`}
        value={[displayValue]}
        max={duration || 1}
        step={0.1}
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
      >
        <Slider.Track
          ref={sliderTrackRef}
          className={`relative grow h-[3px] rounded-full overflow-hidden transition-all duration-200 ease-[var(--ease-apple)] ${
            seekDisabled ? '' : 'group-hover/slider:h-[4px]'
          }`}
        >
          <div className="absolute inset-0 bg-white/[0.08]" />
          {bufferedPercent != null ? (
            <div
              ref={bufferedFillRef}
              className="absolute inset-y-0 left-0 rounded-full bg-white/[0.14] will-change-transform"
              style={{
                width: '100%',
                transform: `scaleX(${bufferedRatio})`,
                transformOrigin: 'left center',
              }}
            />
          ) : playbackBuffer.phase !== 'ready' && !playbackBuffer.fullyCached ? (
            <div className="absolute inset-y-0 left-0 w-[22%] rounded-full bg-white/[0.12] animate-pulse" />
          ) : null}

          <div
            ref={progressFillRef}
            className={`absolute h-full rounded-full will-change-transform transition-colors duration-150 ease-linear ${
              showHoverPreview ? 'bg-white' : 'theme-accent-progress theme-accent-animated'
            }`}
            style={{
              width: '100%',
              transform: 'scaleX(0)',
              transformOrigin: 'left center',
            }}
          />

          {markers}
        </Slider.Track>

        {stateLabel && !isFullscreenOverlayOpen && (
          <div className="absolute top-[14px] right-0 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/65 backdrop-blur-md">
            {stateLabel}
          </div>
        )}

        <Slider.Thumb className="hidden" />
      </Slider.Root>
      {!seekDisabled &&
        sliderRect &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[355] transition-opacity duration-200 ease-[var(--ease-apple)]"
            style={{
              top: sliderRect.top + sliderRect.height / 2,
              left: sliderRect.left,
              width: sliderRect.width,
              opacity: showHoverPreview ? 1 : 0,
            }}
          >
            <div
              ref={progressDotRef}
              className="absolute top-0"
              style={{
                left: '0%',
                transform: 'translateX(0)',
              }}
            >
              <div
                className="h-2.5 w-2.5 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.32)] transition-transform duration-200 ease-[var(--ease-apple)]"
                style={{
                  transform: `translateY(-50%) scale(${showHoverPreview ? 1 : 0.72})`,
                }}
              />
            </div>
          </div>,
          document.body,
        )}
      {!isFullscreenOverlayOpen &&
        hoverPreviewRect &&
        createPortal(
          <>
            <div
              className="pointer-events-none fixed z-[360] transition-[opacity,transform] duration-200 ease-[var(--ease-apple)]"
              style={{
                top: hoverPreviewTop,
                left: hoverPreviewRect.left,
                width: hoverPreviewRect.width,
                opacity: showHoverTooltips ? 1 : 0,
                transform: `translateY(${showHoverTooltips ? '0px' : '6px'}) scale(${showHoverTooltips ? 1 : 0.94})`,
              }}
            >
              <div
                ref={progressTooltipRef}
                className="absolute rounded-xl border border-white/10 bg-black/80 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm"
                style={{
                  left: '0%',
                  transform: 'translateX(0)',
                }}
              >
                {formatTime(displayValue)}
              </div>
            </div>
            <div
              ref={durationTooltipRef}
              className="pointer-events-none fixed z-[360] rounded-xl border border-white/10 bg-black/80 px-2 py-1 text-[10px] font-medium text-white/75 backdrop-blur-sm transition-[opacity,transform] duration-200 ease-[var(--ease-apple)]"
              style={{
                top: hoverPreviewTop,
                left: hoverPreviewRect.right,
                opacity: showHoverTooltips && !hideDurationTooltip ? 1 : 0,
                transform: `${durationTooltipTransform} translateY(${showHoverTooltips && !hideDurationTooltip ? '0px' : '6px'}) scale(${showHoverTooltips && !hideDurationTooltip ? 1 : 0.94})`,
              }}
            >
              {formatTime(duration || 0)}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
});

/* ── Volume Slider ───────────────────────────────────────────── */

const VolumeSlider = React.memo(({ className = '' }: { className?: string }) => {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  return (
    <div className={`relative ${className}`}>
      <Slider.Root
        className="relative flex items-center h-5 w-full cursor-pointer group select-none touch-none"
        value={[volume]}
        max={100}
        step={1}
        onValueChange={([v]) => setVolume(v)}
        onKeyDown={(e) => {
          // Prevent slider from reacting to Left/Right, let event bubble to global binds
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault();
        }}
        onWheel={(e) => {
          if (e.cancelable) {
            e.preventDefault();
          }
          setVolume(Math.max(0, Math.min(100, volume + (e.deltaY < 0 ? 1 : -1))));
        }}
      >
        <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover:h-[4px] transition-all duration-150">
          <Slider.Range className="absolute h-full rounded-full bg-white/60" />
        </Slider.Track>
        <Slider.Thumb className="block w-2.5 h-2.5 rounded-full bg-white transition-all duration-150 outline-none scale-0 opacity-0 group-hover:scale-100 group-hover:opacity-100" />
      </Slider.Root>
    </div>
  );
});

/* ── Volume button ───────────────────────────────────────────── */

const ControlVolumeBtn = React.memo(({ size = 'default' }: { size?: 'default' | 'sm' }) => {
  const volume = usePlayerStore((s) => s.volume);
  const volumeBeforeMute = usePlayerStore((s) => s.volumeBeforeMute);
  const setVolume = usePlayerStore((s) => s.setVolume);

  const s = size === 'sm' ? 'w-9 h-9' : 'w-10 h-10';

  return (
    <button
      type="button"
      onClick={() => setVolume(volume > 0 ? 0 : volumeBeforeMute)}
      className={`${s} rounded-full flex items-center justify-center transition-all duration-150 ease-[var(--ease-apple)] cursor-pointer hover:bg-white/[0.04] ${
        volume === 0 ? 'text-accent' : 'text-white/40 hover:text-white/70'
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
  );
});

/* ── Volume % label ──────────────────────────────────────────── */

/* ── Progress Time (updates once per second) ─────────────────── */

export const ProgressTime = React.memo(() => {
  const duration = useSyncExternalStore(subscribe, getDuration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentRef = useRef<HTMLSpanElement | null>(null);
  const durationRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let rafId: number;

    const paint = () => {
      if (currentRef.current) {
        currentRef.current.textContent = formatTime(
          Math.floor(isPlaying ? getSmoothCurrentTime() : getCurrentTime()),
        );
      }
      if (durationRef.current) {
        durationRef.current.textContent = formatTime(duration);
      }
    };

    paint();
    rafId = requestAnimationFrameImmediate(function loop() {
      if (!isAppBackgrounded()) {
        paint();
      }
      rafId = requestAnimationFrameImmediate(loop);
    });

    const unsub = subscribe(() => {
      paint();
    });

    return () => {
      cancelAnimationFrameImmediate(rafId);
      unsub();
    };
  }, [isPlaying]);

  return (
    <div className="flex items-center gap-1.5">
      <span ref={currentRef} className="text-[11px] text-white/50 tabular-nums font-medium">
        {formatTime(Math.floor(getCurrentTime()))}
      </span>
      <span className="text-[11px] text-white/20">/</span>
      <span ref={durationRef} className="text-[11px] text-white/30 tabular-nums font-medium">
        {formatTime(duration)}
      </span>
    </div>
  );
});

/* ── Like button ─────────────────────────────────────────────── */

function LikeButton({ trackUrn }: { trackUrn: string }) {
  const qc = useQueryClient();

  const { data: trackData } = useQuery({
    queryKey: ['track', trackUrn],
    queryFn: () => api<Track>(`/tracks/${encodeURIComponent(trackUrn)}`),
    enabled: !!trackUrn,
    staleTime: 30_000,
  });

  const [liked, setLiked] = useState<boolean | null>(null);
  const prevUrn = useRef(trackUrn);

  if (prevUrn.current !== trackUrn) {
    prevUrn.current = trackUrn;
    setLiked(null);
  }

  const isLiked = liked ?? trackData?.user_favorite ?? false;

  const toggle = async () => {
    const next = !isLiked;
    setLiked(next);
    if (trackData) optimisticToggleLike(qc, trackData, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(trackUrn)}`, {
        method: next ? 'POST' : 'DELETE',
      });
      qc.invalidateQueries({ queryKey: ['track', trackUrn, 'favoriters'] });
    } catch {
      setLiked(!next);
      if (trackData) optimisticToggleLike(qc, trackData, !next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
        isLiked ? 'text-accent' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
    </button>
  );
}

/* ── Dislike (Block) button ──────────────────────────────────── */

function DislikeButton({ trackUrn }: { trackUrn: string }) {
  const isDisliked = useDislikesStore((s) => s.dislikedTrackUrns.includes(trackUrn));
  const toggle = useDislikesStore((s) => s.toggleDislike);
  const next = usePlayerStore((s) => s.next);
  const { t } = useTranslation();

  const handleToggle = () => {
    toggle(trackUrn);
    if (!isDisliked) {
      const sw = useSoundWaveStore.getState();
      const currentTrack = usePlayerStore.getState().currentTrack;
      if (sw.isActive && currentTrack && currentTrack.urn === trackUrn) {
        sw.recordFeedback(currentTrack, 'negative');
      }
      next();
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={t('track.dislike', "Don't play this track")}
      className={`w-9 h-9 flex items-center justify-center shrink-0 transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
        isDisliked
          ? 'text-red-500 hover:text-red-400 opacity-100'
          : 'text-white/20 hover:text-red-400/80 opacity-0 group-hover/trackinfo:opacity-100 w-8 h-8 rounded-full overflow-hidden flex items-center justify-center'
      }`}
    >
      <Ban size={14} />
    </button>
  );
}

/* ── Mood correction button ──────────────────────────────────── */

const MOOD_OPTIONS: Array<{ mood: MoodLabel; key: string }> = [
  { mood: 'energetic', key: 'track.moodEnergetic' },
  { mood: 'happy', key: 'track.moodHappy' },
  { mood: 'calm', key: 'track.moodCalm' },
  { mood: 'sad', key: 'track.moodSad' },
];

const MOOD_POPOVER_GAP_PX = 8;
const MOOD_POPOVER_EDGE_PADDING_PX = 10;
const MOOD_POPOVER_WIDTH_PX = 240;
const MOOD_POPOVER_MIN_WIDTH_PX = 136;

type MoodPopoverPosition = {
  top: number;
  left: number;
  width: number;
};

function MoodCorrectionButton({ track }: { track: Track }) {
  const { t } = useTranslation();
  const trainTrackMood = useSoundWaveStore((s) => s.trainTrackMood);
  const initWave = useSoundWaveStore((s) => s.init);
  const [open, setOpen] = useState(false);
  const [pendingMood, setPendingMood] = useState<MoodLabel | null>(null);
  const [sending, setSending] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<MoodPopoverPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset local mood UI only on track switch
  useEffect(() => {
    setOpen(false);
    setPendingMood(null);
    setSending(false);
  }, [track.urn]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const node = rootRef.current;
      const popoverNode = popoverRef.current;
      if (!node) return;
      const target = event.target as Node;
      if (!node.contains(target) && !popoverNode?.contains(target)) {
        setOpen(false);
        setPendingMood(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setPendingMood(null);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }

    const recalcPlacement = () => {
      const node = rootRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const maxWidth = Math.max(
        MOOD_POPOVER_MIN_WIDTH_PX,
        viewportWidth - MOOD_POPOVER_EDGE_PADDING_PX * 2,
      );
      const width = Math.min(MOOD_POPOVER_WIDTH_PX, maxWidth);

      let left = rect.right + MOOD_POPOVER_GAP_PX;
      if (left + width > viewportWidth - MOOD_POPOVER_EDGE_PADDING_PX) {
        left = rect.left - MOOD_POPOVER_GAP_PX - width;
      }

      left = Math.min(
        Math.max(left, MOOD_POPOVER_EDGE_PADDING_PX),
        viewportWidth - MOOD_POPOVER_EDGE_PADDING_PX - width,
      );

      const estimatedHeight = pendingMood ? 158 : 136;
      const halfHeight = estimatedHeight / 2;
      const top = Math.min(
        Math.max(rect.top + rect.height / 2, MOOD_POPOVER_EDGE_PADDING_PX + halfHeight),
        viewportHeight - MOOD_POPOVER_EDGE_PADDING_PX - halfHeight,
      );

      setPopoverPosition({ top, left, width });
    };

    recalcPlacement();
    window.addEventListener('resize', recalcPlacement);

    return () => {
      window.removeEventListener('resize', recalcPlacement);
    };
  }, [open, pendingMood]);

  const confirmMood = async () => {
    if (!pendingMood || sending) return;
    setSending(true);
    try {
      await initWave();
      trainTrackMood(track, pendingMood);
      setOpen(false);
      setPendingMood(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (!next) {
              setPendingMood(null);
            }
            return next;
          });
        }}
        title={t('track.moodCorrection', 'Correct mood')}
        className={`w-9 h-9 flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
          open
            ? 'text-accent opacity-100'
            : 'text-white/20 hover:text-accent opacity-0 group-hover/trackinfo:opacity-100 w-8 h-8 rounded-full overflow-hidden flex items-center justify-center'
        }`}
      >
        <Sparkles size={14} />
      </button>

      {open &&
        popoverPosition &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[340] -translate-y-1/2 rounded-2xl border border-white/10 bg-[#121214] p-3 shadow-2xl shadow-black/60"
            style={{
              top: popoverPosition.top,
              left: popoverPosition.left,
              width: popoverPosition.width,
            }}
          >
            {!pendingMood ? (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-white/50">
                  {t('track.moodChoose', 'Choose the correct mood')}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {MOOD_OPTIONS.map((option) => (
                    <button
                      key={option.mood}
                      type="button"
                      onClick={() => setPendingMood(option.mood)}
                      className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-white/80 transition-all hover:bg-white/[0.08] hover:text-white"
                    >
                      {t(option.key)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <p className="text-[11px] font-semibold text-white/80">
                  {t('track.moodConfirmPrompt', {
                    mood: t(
                      MOOD_OPTIONS.find((option) => option.mood === pendingMood)?.key ||
                        'track.moodEnergetic',
                    ),
                  })}
                </p>
                <p className="text-[10px] text-white/45">
                  {t('track.moodConfirmHint', 'This will train SoundWave recommendations.')}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={confirmMood}
                    disabled={sending}
                    className="flex-1 rounded-xl theme-accent-fill theme-accent-animated px-2.5 py-2 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('track.moodConfirmYes', 'Yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingMood(null)}
                    disabled={sending}
                    className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-white/70 transition-all hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('track.moodConfirmNo', 'No')}
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ── Isolated control buttons ────────────────────────────────── */

const btnClass = (active: boolean, size: 'default' | 'sm') =>
  `${size === 'sm' ? 'w-9 h-9' : 'w-10 h-10'} rounded-full flex items-center justify-center transition-all duration-150 ease-[var(--ease-apple)] cursor-pointer hover:bg-white/[0.04] ${
    active ? 'text-accent' : 'text-white/40 hover:text-white/70'
  }`;

const PlayPauseBtn = React.memo(() => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  return (
    <button
      type="button"
      onClick={togglePlay}
      className="w-9 h-9 rounded-full bg-white/90 flex items-center justify-center text-black hover:bg-white hover:scale-105 active:scale-95 transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer mx-1"
    >
      {isPlaying ? pauseBlack20 : playBlack20}
    </button>
  );
});

const ShuffleBtn = React.memo(() => {
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  return (
    <button type="button" onClick={toggleShuffle} className={btnClass(shuffle, 'sm')}>
      {shuffleIcon16}
    </button>
  );
});

const RepeatBtn = React.memo(() => {
  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  return (
    <button type="button" onClick={toggleRepeat} className={btnClass(repeat !== 'off', 'sm')}>
      {repeat === 'one' ? repeat1Icon16 : repeatIcon16}
    </button>
  );
});

const PrevBtn = React.memo(() => {
  const [locked, setLocked] = useState(false);

  const handleLockedPrev = () => {
    if (locked) return;

    setLocked(true);

    handlePrev();

    setTimeout(() => {
      setLocked(false);
    }, 1000);
  };

  return (
    <button
      type="button"
      onClick={handleLockedPrev}
      disabled={locked}
      className={`${btnClass(false, 'default')} ${locked ? 'opacity-40 cursor-default' : ''}`}
    >
      {skipBack20}
    </button>
  );
});

const NextBtn = React.memo(() => {
  const next = usePlayerStore((s) => s.next);

  const [locked, setLocked] = useState(false);

  const handleNext = () => {
    if (locked) return;

    setLocked(true);

    next();

    setTimeout(() => {
      setLocked(false);
    }, 1000);
  };

  return (
    <button
      type="button"
      onClick={handleNext}
      disabled={locked}
      className={`${btnClass(false, 'default')} ${locked ? 'opacity-40 cursor-default' : ''}`}
    >
      {skipForward20}
    </button>
  );
});

const QueueBtn = React.memo(({ onClick, active }: { onClick: () => void; active: boolean }) => (
  <button type="button" onClick={onClick} className={btnClass(active, 'sm')}>
    {listMusic16}
  </button>
));

const LyricsBtn = React.memo(() => {
  const open = useLyricsStore((s) => s.open);
  const artworkOpen = useArtworkStore((s) => s.open);
  const isActive = open || artworkOpen;
  return (
    <button
      type="button"
      onClick={() => {
        if (isActive) {
          useFullscreenPanelStore.getState().beginClose();
        } else {
          lyricsPanelApi.openFromMiniPlayer();
        }
      }}
      className={btnClass(isActive, 'sm')}
    >
      <MicVocal size={16} />
    </button>
  );
});

/* ── Playback Speed ──────────────────────────────────────────── */

const PlaybackTuningMenu = React.memo(({ disabled = false }: { disabled?: boolean }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const node = rootRef.current;
      if (!node) return;
      const target = event.target as Node;
      if (!node.contains(target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div
        className={`absolute bottom-full left-0 z-[40] mb-3 w-[320px] max-w-[calc(100vw-40px)] origin-bottom-left transition-all duration-200 ease-[var(--ease-apple)] ${
          open
            ? 'pointer-events-auto visible translate-y-0 opacity-100'
            : 'pointer-events-none invisible translate-y-2 opacity-0'
        }`}
        aria-hidden={!open}
      >
        <div className="overflow-hidden rounded-[22px] border border-white/[0.14] bg-[#101012]/96 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-lg">
          <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/[0.06] to-transparent pointer-events-none" />
          <div className="relative space-y-2.5">
            <div className="flex items-center gap-2 px-0.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/55">
                <SlidersHorizontal size={14} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/68">
                  {t('player.soundTuning', 'Sound tuning')}
                </p>
                <p className="text-[10px] text-white/28">
                  {t(
                    'player.playbackSpeedPresetHint',
                    'Speed stays active between tracks and after restart.',
                  )}
                </p>
              </div>
            </div>
            <PlaybackSpeedPresets variant="panel" />
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-expanded={open}
        aria-label={
          open
            ? t('player.soundTuningClose', 'Close sound tuning')
            : t('player.soundTuningOpen', 'Open sound tuning')
        }
        title={
          open
            ? t('player.soundTuningClose', 'Close sound tuning')
            : t('player.soundTuningOpen', 'Open sound tuning')
        }
        onClick={() => setOpen((value) => !value)}
        className={btnClass(open, 'sm')}
      >
        <SlidersHorizontal size={16} />
      </button>
    </div>
  );
});

const VolumeControlCluster = React.memo(() => (
  <div className="flex shrink-0 items-center gap-1">
    <ControlVolumeBtn size="sm" />
    <VolumeSlider className="w-[120px] max-[1400px]:w-[96px] max-[1220px]:w-[76px]" />
  </div>
));

const EqBtn = React.memo(() => {
  const eqEnabled = useSettingsStore((s) => s.eqEnabled);
  return (
    <EqualizerPanel>
      <button type="button" className={btnClass(eqEnabled, 'sm')}>
        {audioLines16}
      </button>
    </EqualizerPanel>
  );
});

/* ── Track Info (left section) ───────────────────────────────── */

const TrackInfo = React.memo(() => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const artwork200 = art(currentTrack?.artwork_url, 't200x200');
  const artwork500 = art(currentTrack?.artwork_url, 't500x500');
  const artworkOriginal = artwork500 ? artwork500.replace('t500x500', 'original') : null;
  const [artLoaded, setArtLoaded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const prevUrnRef = useRef<string | null>(currentTrack?.urn ?? null);

  useEffect(() => {
    const nextUrn = currentTrack?.urn ?? null;
    if (prevUrnRef.current !== nextUrn) {
      prevUrnRef.current = nextUrn;
      setArtLoaded(false);
      setArtFailed(false);
    }
  }, [currentTrack?.urn]);

  useEffect(() => {
    if (!currentTrack || !artwork500) return;

    const urls = [artwork500, artworkOriginal].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    );
    const preloaded: HTMLImageElement[] = [];

    for (const [index, url] of urls.entries()) {
      const img = new window.Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = index === 0 ? 'high' : 'auto';
      img.src = url;
      preloaded.push(img);
    }

    return () => {
      for (const img of preloaded) {
        img.src = '';
      }
    };
  }, [currentTrack?.urn, artwork500, artworkOriginal]);

  if (!currentTrack) {
    return (
      <div className="flex items-center gap-3.5 w-full min-w-0">
        <p className="text-[13px] text-white/15">{t('player.notPlaying')}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3.5 w-full min-w-0">
      <div
        className="relative w-16 h-16 rounded-[14px] shrink-0 overflow-hidden cursor-pointer shadow-xl shadow-black/40 ring-1 ring-white/[0.06] hover:ring-white/[0.12] transition-all duration-200 group/art -ml-1"
        onClick={() => artworkPanelApi.openFromMiniPlayer()}
      >
        {artwork500 ? (
          <>
            <img
              key={`${currentTrack.urn}-artwork-low`}
              src={artwork200 || artwork500}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className={`absolute inset-0 w-full h-full object-cover scale-110 transition-opacity duration-300 ${
                artLoaded && !artFailed ? 'opacity-0' : 'opacity-100'
              }`}
            />
            <img
              key={`${currentTrack.urn}-artwork-high`}
              src={artwork500}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              onLoad={() => {
                setArtLoaded(true);
                setArtFailed(false);
              }}
              onError={() => {
                setArtFailed(true);
              }}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
                artLoaded && !artFailed ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </>
        ) : (
          <div className="w-full h-full bg-white/[0.04]" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 group-hover/art:bg-black/40 group-hover/art:opacity-100 transition-all duration-200">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-white">
            <path
              d="M3 7V3h4M11 3h4v4M15 11v4h-4M7 15H3v-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center">
          <StreamQualityBadge
            quality={currentTrack.streamQuality}
            codec={currentTrack.streamCodec}
            access={currentTrack.access}
          />
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <p
            className="text-[13px] text-white/90 truncate font-medium cursor-pointer hover:text-white leading-tight transition-colors"
            onClick={() => navigate(`/track/${encodeURIComponent(currentTrack.urn)}`)}
          >
            {currentTrack.title}
          </p>
          {currentTrack.access === 'preview' && (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-400/90 px-1.5 py-px rounded">
              {t('track.preview')}
            </span>
          )}
        </div>
        <p
          className="text-[11px] text-white/35 truncate mt-1 cursor-pointer hover:text-white/55 transition-colors"
          onClick={() => navigate(`/user/${encodeURIComponent(currentTrack.user.urn)}`)}
        >
          {currentTrack.user.username}
        </p>
      </div>
      <div className="flex items-center -mr-2">
        <LikeButton trackUrn={currentTrack.urn} />
        <DislikeButton trackUrn={currentTrack.urn} />
        <MoodCorrectionButton track={currentTrack} />
      </div>
    </div>
  );
});

/* ── Background glow ─────────────────────────────────────────── */

const BackgroundGlow = React.memo(() => {
  const artworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url);
  const artwork = art(artworkUrl, 't200x200');

  if (!artwork) return null;
  return (
    <div
      className="absolute inset-0 opacity-[0.02] blur-lg pointer-events-none"
      style={{
        backgroundImage: `url(${artwork})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        contain: 'strict',
        transform: 'translateZ(0)',
        willChange: 'opacity',
      }}
    />
  );
});

/* ── Global Discord Lyrics Syncer ────────────────────────────── */

const DiscordLyricsSyncer = React.memo(() => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const discordRpc = useSettingsStore((s) => s.discordRpc);
  const discordRpcMode = useSettingsStore((s) => s.discordRpcMode);
  const lyricsSyncEnabled = discordRpc && discordRpcMode === 'text';

  const { data: lyrics } = useQuery({
    queryKey: [
      'lyrics',
      LYRICS_SEARCH_QUERY_VERSION,
      currentTrack?.urn,
      currentTrack?.user.username,
      currentTrack?.title,
    ],
    queryFn: () =>
      searchLyrics(currentTrack!.urn, currentTrack!.user.username, currentTrack!.title, {
        uploaderUsername: currentTrack!.user.username,
        originalTitle: currentTrack!.title,
        durationMs: currentTrack!.duration,
        genre: currentTrack!.genre ?? null,
        tagList: currentTrack!.tag_list ?? null,
        description: currentTrack!.description ?? null,
        createdAt: currentTrack!.created_at ?? null,
        artworkUrl: currentTrack!.artwork_url ?? null,
      }),
    enabled: lyricsSyncEnabled && !!currentTrack?.urn,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });

  useEffect(() => {
    if (!lyricsSyncEnabled || !lyrics?.synced) {
      updateDiscordLyric(null);
      return;
    }

    let lastUpdateTime = 0;
    const unsub = subscribe(() => {
      const now = Date.now();
      if (now - lastUpdateTime < 500) return; // Throttle to every 500ms
      lastUpdateTime = now;

      const t = getCurrentTime();
      let activeText: string | null = null;

      for (let i = lyrics.synced!.length - 1; i >= 0; i--) {
        if (t >= lyrics.synced![i].time) {
          activeText = lyrics.synced![i].text;
          break;
        }
      }

      updateDiscordLyric(activeText);
    });

    return unsub;
  }, [lyrics, lyricsSyncEnabled]);

  return null;
});

/* ── NowPlayingBar ───────────────────────────────────────────── */

export const NowPlayingBar = React.memo(
  ({ onQueueToggle, queueOpen }: { onQueueToggle: () => void; queueOpen: boolean }) => {
    const isMobile = useIsMobile();
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const togglePlay = usePlayerStore((s) => s.togglePlay);
    const currentArtworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url ?? null);
    const lyricsOpen = useLyricsStore((s) => s.open);
    const artworkOpen = useArtworkStore((s) => s.open);
    const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
    const visualizerPlaybar = useSettingsStore((s) => s.visualizerPlaybar);
    const artworkGradientPalette = useArtworkGradientPalette(currentArtworkUrl);
    const isFullscreenOverlayOpen = lyricsOpen || artworkOpen;
    const desktopBarOffset = sidebarCollapsed ? 66 : 210;
    const dockVisual = useMemo(
      () => (artworkGradientPalette ? buildArtworkSurfaceVisual(artworkGradientPalette) : null),
      [artworkGradientPalette],
    );
    const {
      baseValue: dockBaseBackground,
      overlayValue: dockOverlayBackground,
      overlayVisible: dockOverlayVisible,
    } = useCrossfadeBackground(dockVisual?.background ?? '', ARTWORK_CROSSFADE_MS);

    const desktopDockStyle = useMemo(() => {
      if (isMobile) return undefined;

      return {
        marginLeft: `${desktopBarOffset}px`,
      };
    }, [isMobile, desktopBarOffset]);

    return (
      <div
        className={`shrink-0 relative group/trackinfo ${isMobile ? 'h-[72px]' : 'pointer-events-none'}`}
      >
        <DiscordLyricsSyncer />
        {!isFullscreenOverlayOpen && <BackgroundGlow />}

        {visualizerPlaybar && !isMobile && !isFullscreenOverlayOpen}

        <div
          className={`relative z-10 ${isMobile ? '' : 'pointer-events-none'}`}
          style={{ isolation: 'isolate' }}
        >
          <div
            className={
              isMobile
                ? 'h-[72px] flex items-center px-5 gap-3 relative'
                : 'pointer-events-auto relative min-h-[88px] overflow-hidden grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 pl-3.5 pr-4 pt-2 pb-2 mr-3 mb-4 rounded-[18px] bg-black/40 backdrop-blur-lg border border-white/[0.04] transition-[margin] duration-200 ease-[var(--ease-apple)]'
            }
            style={desktopDockStyle}
          >
            {!isMobile && dockVisual ? (
              <div
                className="pointer-events-none absolute inset-0 z-0"
                style={{
                  background: dockBaseBackground || dockVisual.background,
                  backgroundSize: ARTWORK_SURFACE_BACKGROUND_SIZE,
                  backgroundPosition: ARTWORK_SURFACE_BACKGROUND_POSITION,
                  backgroundRepeat: ARTWORK_SURFACE_BACKGROUND_REPEAT,
                }}
              />
            ) : null}
            {!isMobile && dockOverlayBackground ? (
              <div
                className="pointer-events-none absolute inset-0 z-0 transition-opacity ease-[var(--ease-apple)]"
                style={{
                  background: dockOverlayBackground,
                  backgroundSize: ARTWORK_SURFACE_BACKGROUND_SIZE,
                  backgroundPosition: ARTWORK_SURFACE_BACKGROUND_POSITION,
                  backgroundRepeat: ARTWORK_SURFACE_BACKGROUND_REPEAT,
                  opacity: dockOverlayVisible ? 1 : 0,
                  transitionDuration: `${ARTWORK_CROSSFADE_MS}ms`,
                  willChange: 'opacity',
                }}
              />
            ) : null}
            <div className="absolute top-[-1px] left-0 right-0 z-20">
              {!isMobile && <ProgressSlider />}
            </div>
            {/* Left: track info */}
            <div className="w-full min-w-0 max-w-[320px]">
              <TrackInfo />
            </div>

            {!isMobile ? (
              <>
                {/* Center: controls */}
                <div className="flex min-w-0 flex-col items-center justify-self-center gap-0.5">
                  <div className="flex items-center gap-0.5">
                    <ShuffleBtn />
                    <PrevBtn />
                    <PlayPauseBtn />
                    <NextBtn />
                    <RepeatBtn />
                  </div>
                </div>

                {/* Right: tuning + volume + actions */}
                <div className="flex w-full min-w-0 max-w-[760px] flex-wrap items-center justify-end justify-self-end gap-x-1.5 gap-y-1">
                  <PlaybackTuningMenu disabled={isFullscreenOverlayOpen} />
                  <EqBtn />
                  <LyricsBtn />
                  <QueueBtn onClick={onQueueToggle} active={queueOpen} />
                  <VolumeControlCluster />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-black"
                >
                  {isPlaying ? pauseBlack20 : playBlack20}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);
