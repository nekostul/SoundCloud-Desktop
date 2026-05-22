import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isAppBackgrounded } from '../../../lib/app-visibility';
import { getCurrentTime, seek } from '../../../lib/audio';
import type { AudioFeatures } from '../../../lib/audio-analyser';
import { audioAnalyser } from '../../../lib/audio-analyser';
import { getAnimationFrameBudgetMs } from '../../../lib/framerate';
import type { LyricLine } from '../../../lib/lyrics';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';

export {
  applyLyricProgressStyle,
  buildDisplayLinesWithPausePlaceholders,
  clamp01,
  getActiveLyricTime,
  getAnimatedLineProgress,
  getLyricCharOnsetFactor,
  getMotionHintBoost,
  getMotionHintFloor,
  getPauseNoteAnimationDelay,
  getPauseNoteAnimationDurationSec,
  getRapLineBoost,
  getReactiveLyricDrive,
  getSmoothLyricTime,
  isPauseMarkerText,
  PAUSE_MARKER,
  syncLyricCharProgress,
  useAudioTextWarmup,
  type DisplayLyricLine,
  type ReleaseSyncedLyricsLayout,
} from './syncedLyricsUtils';
import {
  applyLyricProgressStyle,
  buildDisplayLinesWithPausePlaceholders,
  clamp01,
  getActiveLyricTime,
  getAnimatedLineProgress,
  getLyricCharOnsetFactor,
  getMotionHintBoost,
  getMotionHintFloor,
  getPauseNoteAnimationDelay,
  getPauseNoteAnimationDurationSec,
  getRapLineBoost,
  getReactiveLyricDrive,
  getSmoothLyricTime,
  LYRIC_CURSOR_CHAR_SPAN,
  LYRIC_TRAIL_CHAR_SPAN,
  PAUSE_MARKER,
  syncLyricCharProgress,
  type ReleaseSyncedLyricsLayout,
} from './syncedLyricsUtils';

export const SyncedLyricsWithPlaceholders = React.memo(
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

export const PlainLyrics = React.memo(({ text }: { text: string }) => (
  <div className="h-full min-h-0 overflow-y-auto px-2 py-16 pl-[14vw] pr-[8vw] scrollbar-hide">
    <div className="mx-auto flex min-h-full max-w-[1100px] flex-col justify-center gap-3">
      <div className="w-full whitespace-pre-wrap text-center text-[clamp(24px,3vw,38px)] font-semibold leading-[1.72] tracking-tight text-white/64">
        {text}
      </div>
    </div>
  </div>
));

export const StaticSyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => {
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

