import * as Slider from '@radix-ui/react-slider';
import { useQuery } from '@tanstack/react-query';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getTrackComments } from '../../../lib/api';
import { isAppBackgrounded } from '../../../lib/app-visibility';
import {
  getPlaybackBufferSnapshot,
  getCurrentTime,
  getDuration,
  getSmoothCurrentTime,
  seek,
  subscribePlaybackBuffer,
  subscribe,
} from '../../../lib/audio';
import { formatTime } from '../../../lib/formatters';
import { useArtworkStore, useLyricsStore } from '../../../stores/lyrics';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';

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
  const [sliderValue, setSliderValue] = useState(0);
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
    paintProgressFill(dragging ? dragValue : liveValueRef.current);
  }, [dragValue, dragging, duration, paintProgressFill]);

  useEffect(() => {
    liveValueRef.current = 0;
    paintProgressFill(0);
    setSliderValue(0);
  }, [currentTrackUrn, paintProgressFill]);

  // Keep slider state in sync without competing DOM mutations
  useEffect(() => {
    let rafId: number;

    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (draggingRef.current || isAppBackgrounded()) {
        return;
      }

      const currentValue = isPlaying ? getSmoothCurrentTime() : getCurrentTime();
      paintProgressFill(currentValue);
      // Синхронизируем слайдер со значением, чтобы он не "зависал"
      if (!draggingRef.current && Math.abs(currentValue - sliderValue) > 0.1) {
        setSliderValue(currentValue);
      }
    };

    rafId = requestAnimationFrame(loop);
    const unsub = subscribe(() => {
      if (!draggingRef.current) {
        const nextValue = getCurrentTime();
        paintProgressFill(nextValue);
        if (Math.abs(nextValue - sliderValue) > 0.1) {
          setSliderValue(nextValue);
        }
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      unsub();
    };
  }, [isPlaying, paintProgressFill, sliderValue]);

  const displayValue = dragging ? dragValue : liveValueRef.current;
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
      setSliderValue(nextValue);
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

  useEffect(() => {
    if (!showHoverPreview && !showHoverTooltips) return;
    paintProgressFill(dragging ? dragValue : liveValueRef.current);
  }, [dragValue, dragging, paintProgressFill, showHoverPreview, showHoverTooltips]);

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
        value={[dragging ? dragValue : sliderValue]}
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
                transform: `scaleX(${bufferedRatio}) translateZ(0)`,
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
              transform: 'scaleX(0) translateZ(0)',
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
        showHoverPreview &&
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
        showHoverTooltips &&
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


export const ProgressTime = React.memo(() => {
  const duration = useSyncExternalStore(subscribe, getDuration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentRef = useRef<HTMLSpanElement | null>(null);
  const durationRef = useRef<HTMLSpanElement | null>(null);
  const lastCurrentSecondRef = useRef<number | null>(null);
  const lastDurationRef = useRef<number | null>(null);

  useEffect(() => {
    let rafId: number;

    const paint = () => {
      const currentSecond = Math.floor(isPlaying ? getSmoothCurrentTime() : getCurrentTime());
      if (currentRef.current && lastCurrentSecondRef.current !== currentSecond) {
        lastCurrentSecondRef.current = currentSecond;
        currentRef.current.textContent = formatTime(currentSecond);
      }
      if (durationRef.current && lastDurationRef.current !== duration) {
        lastDurationRef.current = duration;
        durationRef.current.textContent = formatTime(duration);
      }
    };

    paint();
    if (isPlaying) {
      rafId = requestAnimationFrame(function loop() {
        if (!isAppBackgrounded()) {
          paint();
        }
        rafId = requestAnimationFrame(loop);
      });
    }

    const unsub = subscribe(() => {
      paint();
    });

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      unsub();
    };
  }, [duration, isPlaying]);

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

