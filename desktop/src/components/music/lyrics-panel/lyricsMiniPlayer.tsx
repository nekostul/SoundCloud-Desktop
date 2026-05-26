import { ChevronDown, ChevronUp } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ExternalLink,
  Eye,
  ListPlus,
  MicVocal,
  pauseBlack18,
  playBlack18,
  repeat1Icon16,
  repeatIcon16,
  SkipBack,
  SkipForward,
  shuffleIcon16,
} from '../../../lib/icons';
import type { getLyricMotionHintsForTrack } from '../../../lib/lyrics';
import {
  TRACK_SWITCH_NEXT_SCOPE,
  TRACK_SWITCH_PREV_SCOPE,
  useTrackSwitchCooldown,
} from '../../../lib/useTrackSwitchCooldown';
import { useFullscreenPanelStore } from '../../../stores/lyrics';
import type { Track } from '../../../stores/player';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';
import { ProgressSlider, ProgressTime } from '../../layout/NowPlayingBar';
import { AdaptiveTrackTitle } from '../../ui/AdaptiveTrackTitle';
import { AddToPlaylistDialog } from '../AddToPlaylistDialog';
import {
  FullscreenDislikeButton,
  FullscreenLikeButton,
  FullscreenVolumeSlider,
  getTrackArtworkSources,
  openExternal,
  resolveTrackPermalink,
  uniqueArtworkSources,
  useFallbackImageSource,
} from './artwork';
import {
  type ResolvedLyricsData,
  shouldRenderPlainLyrics,
  shouldRenderSyncedLyrics,
} from './lyricsData';
import { PlainLyrics, StaticSyncedLyrics, SyncedLyricsWithPlaceholders } from './syncedLyrics';

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
    active ? `${compactCtrl} theme-accent-soft text-white/96 hover:text-white/96` : compactCtrl;

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

      <button type="button" onClick={toggleShuffle} className={compactAccentCtrl(shuffle)}>
        {shuffleIcon16}
      </button>

      <button type="button" onClick={prevTrack} disabled={prevLocked} className={compactCtrl}>
        <SkipBack size={18} fill="currentColor" />
      </button>

      <button
        type="button"
        onClick={togglePlay}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black shadow-[0_14px_32px_rgba(255,255,255,0.16)] transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] outline-none"
      >
        {isPlaying ? pauseBlack18 : playBlack18}
      </button>

      <button type="button" onClick={next} disabled={nextLocked} className={compactCtrl}>
        <SkipForward size={18} fill="currentColor" />
      </button>

      <button type="button" onClick={toggleRepeat} className={compactAccentCtrl(repeat !== 'off')}>
        {repeat === 'one' ? repeat1Icon16 : repeatIcon16}
      </button>

      <FullscreenDislikeButton track={track} compact />

      <button type="button" onClick={handleOpenInSoundCloud} className={compactCtrl}>
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
  const navigate = useNavigate();
  const controlsCollapsed = useSettingsStore((s) => s.lyricsMiniPlayerControlsCollapsed);
  const setControlsCollapsed = useSettingsStore((s) => s.setLyricsMiniPlayerControlsCollapsed);
  const effectiveControlsCollapsed = forceCollapsed || controlsCollapsed;
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [r, g, b] = color;
  const dockAnimationClass =
    closeAnimation === 'toMiniPlayer'
      ? 'animate-lyrics-mini-player-out'
      : openAnimation === 'fromMiniPlayer'
        ? 'animate-lyrics-mini-player-in'
        : 'animate-lyrics-mini-player-in';
  const openTrackPage = useCallback(() => {
    useFullscreenPanelStore.getState().beginClose();
    navigate(`/track/${encodeURIComponent(track.urn)}`);
  }, [navigate, track.urn]);
  const openArtistPage = useCallback(() => {
    useFullscreenPanelStore.getState().beginClose();
    navigate(`/user/${encodeURIComponent(track.user.urn)}`);
  }, [navigate, track.user.urn]);
  const handleTrackTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLParagraphElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTrackPage();
    },
    [openTrackPage],
  );

  useEffect(() => {
    const blockLyricsScrollUnderMiniPlayer = (event: WheelEvent) => {
      const dock = dockRef.current;
      if (!dock) return;

      const rect = dock.getBoundingClientRect();
      const isOverDock =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!isOverDock) return;

      if (event.cancelable) {
        event.preventDefault();
      }

      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-lyrics-mini-player-volume="true"]')) {
        event.stopPropagation();
      }
    };

    window.addEventListener('wheel', blockLyricsScrollUnderMiniPlayer, {
      capture: true,
      passive: false,
    });

    return () => {
      window.removeEventListener('wheel', blockLyricsScrollUnderMiniPlayer, true);
    };
  }, []);

  return (
    <div
      ref={dockRef}
      data-lyrics-mini-player="true"
      className={`lyrics-mini-player-dock ${dockAnimationClass}`}
      onWheel={(event) => {
        event.stopPropagation();
        if (event.cancelable) {
          event.preventDefault();
        }
      }}
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
                role="link"
                tabIndex={0}
                onClick={openTrackPage}
                onKeyDown={handleTrackTitleKeyDown}
                className="truncate text-[18px] font-semibold leading-tight text-white/92 transition-colors hover:text-white focus-visible:text-white focus-visible:outline-none cursor-pointer"
              />
              <button
                type="button"
                onClick={openArtistPage}
                className="mt-1 block max-w-full truncate text-[13px] font-medium text-white/46 transition-colors hover:text-white/72 focus-visible:text-white/72 focus-visible:outline-none cursor-pointer"
                title={track.user.username}
              >
                {track.user.username}
              </button>

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
    const { currentSrc: previewArtSrc, handleError: handlePreviewArtError } =
      useFallbackImageSource(previewArtSources, `${track.urn}:lyrics-mini-preview`);
    const { currentSrc: displayArtSrc, handleError: handleDisplayArtError } =
      useFallbackImageSource(displayArtSources, `${track.urn}:lyrics-mini-display`);
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
            <div ref={artworkFrameRef} className="absolute inset-0 overflow-hidden rounded-[24px]">
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
  },
);

export const FullscreenLyricsMiniPlayerOverlay = React.memo(
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

export const FullscreenLyricsColumn = React.memo(
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
