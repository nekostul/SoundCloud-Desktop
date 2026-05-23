import { invoke } from '@tauri-apps/api/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getCurrentTime, getDuration, seek } from '../../lib/audio';
import {
  Loader2,
  Maximize2,
  MicVocal,
  Search,
  X,
} from '../../lib/icons';
import type { LyricsResult } from '../../lib/lyrics';
import {
  LYRICS_SEARCH_QUERY_VERSION,
  saveLyricsResultToCache,
  searchLyrics,
  searchLrclibSyncedLyricsByUploadMetadata,
  splitArtistTitle,
} from '../../lib/lyrics';
import { useCommunityLyricsDraftStore } from '../../stores/communityLyricsDrafts';
import {
  type CommunitySyncStage,
  useArtworkStore,
  useFullscreenPanelStore,
  useLyricsStore,
} from '../../stores/lyrics';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import {
  ArtworkLightbox,
  FullscreenBackground,
  FullscreenVisualizer,
  getTrackBackgroundArtworkSources,
  LyricsSourceBadge,
  runDocumentViewTransition,
  TrackColumn,
  useArtworkColor,
  useArtworkLightboxState,
} from './lyrics-panel/artwork';
import {
  canCreateCommunitySync,
  CommunitySyncEditor,
  CommunitySyncPublishConfirm,
  type CommunitySyncSession,
  type CommunitySyncTrackMeta,
  createCommunitySyncPauseLine,
  createCommunitySyncSession,
  createCommunitySyncSessionFromDraft,
  findCommunitySyncNextPendingIndex,
  findCommunitySyncNextStampedIndex,
  findCommunitySyncPreviousStampedIndex,
  getCommunitySyncPauseInsertIndex,
  getCommunitySyncPlaybackIndex,
  getCommunitySyncStampTargetIndex,
  getCommunitySyncTimeBounds,
  getStampedCommunitySyncTime,
  hasCommunitySyncStampedLines,
  isCommunitySyncSessionComplete,
  isEditableKeyboardTarget,
  resolveCommunitySyncActiveIndex,
  serializeCommunitySyncedLyrics,
  toCommunitySyncDraft,
} from './lyrics-panel/communitySync';
import { LyricsSearchModal } from './lyrics-panel/LyricsSearchModal';
import {
  FullscreenLyricsColumn,
  FullscreenLyricsMiniPlayerOverlay,
} from './lyrics-panel/lyricsMiniPlayer';
import {
  buildTrackScopedLyricsSearchQuery,
  getCachedManualLyrics,
  getLyricsSearchOptions,
  getLyricsSearchPrefill,
  getPreferredTrackLyricsSearchQuery,
  getTrackDurationMs,
  hasRenderableLyrics,
  type LyricsSearchQuery,
  type ManualLyricsCacheEntry,
  shouldRenderPlainLyrics,
  shouldRenderSyncedLyrics,
  type TrackScopedLyricsSearchQuery,
  useResolvedLyrics,
} from './lyrics-panel/lyricsData';
import { SOURCE_LABELS } from './lyrics-panel/sourceLabels';
import {
  PlainLyrics,
  StaticSyncedLyrics,
  useAudioTextWarmup,
} from './lyrics-panel/syncedLyrics';
import { StreamQualityBadge } from './StreamQualityBadge';

export { SyncedLyrics } from './lyrics-panel/syncedLyrics';

/* ── Source Badge ─────────────────────────────────────────── */

/* ── Lyrics Panel (fullscreen, 50/50) ─────────────────────── */

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
  const queryClient = useQueryClient();
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
  const [communityLyricsOverrideByTrack, setCommunityLyricsOverrideByTrack] = useState<
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
  const communitySyncTimingRef = useRef<{
    trackUrn: string | null;
    time: number;
    cursorIndex: number;
    holdUntil: number;
  } | null>(null);
  const miniPlayerCollapsedBeforeCommunityFlowRef = useRef<boolean | null>(null);
  const prevTrackUrnRef = useRef<string | null>(null);
  const trackUrn = track?.urn ?? null;
  const setCommunitySyncTimingReference = useCallback(
    (time: number, cursorIndex: number) => {
      communitySyncTimingRef.current = {
        trackUrn,
        time: Number.isFinite(time) ? Math.max(0, time) : 0,
        cursorIndex,
        holdUntil: Date.now() + 1800,
      };
    },
    [trackUrn],
  );
  const getCommunitySyncTimestampSource = useCallback(() => {
    const playbackTime = getCurrentTime();
    const timingRef = communitySyncTimingRef.current;
    if (!timingRef || timingRef.trackUrn !== trackUrn) {
      return playbackTime;
    }

    if (Date.now() > timingRef.holdUntil) {
      communitySyncTimingRef.current = null;
      return playbackTime;
    }

    if (playbackTime > timingRef.time + 0.35 || Math.abs(playbackTime - timingRef.time) <= 0.08) {
      communitySyncTimingRef.current = {
        ...timingRef,
        time: playbackTime,
      };
      return playbackTime;
    }

    return timingRef.time;
  }, [trackUrn]);
  const seekCommunitySyncPlayback = useCallback(
    (time: number, cursorIndex: number) => {
      const targetTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      setCommunitySyncTimingReference(targetTime, cursorIndex);
      seek(targetTime, true, true);
    },
    [setCommunitySyncTimingReference],
  );
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
    trackUrn && communityLyricsOverrideByTrack[trackUrn]
      ? communityLyricsOverrideByTrack[trackUrn]
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
  const hasFailedLocalCommunityLyrics = Boolean(
    communityDraft && displayedLyrics?.source === 'local' && displayedLyrics.synced?.length,
  );
  const canRetryCommunityDraft = Boolean(
    communityDraft && (!displayedLyrics?.synced?.length || hasFailedLocalCommunityLyrics),
  );
  const communityFlowActive = communitySyncStage !== 'idle';
  const showCommunityActionButton = lyricsStageActive && !communityFlowActive;
  const communityActionLabel = hasFailedLocalCommunityLyrics
    ? t('track.communitySyncContinueEditingButton', 'Продолжить редактирование')
    : canRetryCommunityDraft
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
    communitySyncSessionRef.current = null;
    communitySyncTimingRef.current = null;
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
    communitySyncTimingRef.current = null;
  }, [trackUrn]);

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
      const playbackTime = getCommunitySyncTimestampSource();

      const nextActiveIndex = getCommunitySyncPlaybackIndex(
        currentSession.lines,
        playbackTime,
        currentSession.activeIndex,
      );

      if (nextActiveIndex === currentSession.activeIndex) return;

      setCommunitySyncSession((session) => {
        if (!session) return session;

        const resolvedIndex = getCommunitySyncPlaybackIndex(
          session.lines,
          getCommunitySyncTimestampSource(),
          session.activeIndex,
        );

        if (resolvedIndex === session.activeIndex) return session;
        const nextSession = {
          ...session,
          activeIndex: resolvedIndex,
        };
        communitySyncSessionRef.current = nextSession;
        return nextSession;
      });
    };

    syncEditorToPlayback();
    const intervalId = window.setInterval(syncEditorToPlayback, 90);
    return () => window.clearInterval(intervalId);
  }, [communitySyncStage, getCommunitySyncTimestampSource]);

  const startCommunitySync = useCallback(() => {
    if (!track || !canCreateCommunitySyncForTrack) return;

    const session = createCommunitySyncSession(displayedLyrics.plain, displayedLyrics.source);
    if (!session) {
      toast.error(t('track.communitySyncNoLines', 'Не удалось подготовить строки для синхронизации'));
      return;
    }

    setIsSearchModalOpen(false);
    communitySyncSessionRef.current = session;
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
      communitySyncSessionRef.current = session;
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
    const timestampSource = getCommunitySyncTimestampSource();
    const nextLines = currentSession.lines.map((line, index) =>
      index === targetIndex
        ? {
            ...line,
            time: getStampedCommunitySyncTime(timestampSource, previousTime, nextTime),
          }
        : line,
    );
    const nextPendingIndex = findCommunitySyncNextPendingIndex(nextLines, targetIndex + 1);

    const nextSession: CommunitySyncSession = {
      ...currentSession,
      lines: nextLines,
      activeIndex: nextPendingIndex >= 0 ? nextPendingIndex : targetIndex,
    };

    communitySyncSessionRef.current = nextSession;
    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [getCommunitySyncTimestampSource, persistCommunitySyncDraft]);

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
    const restoreIndex = findCommunitySyncPreviousStampedIndex(nextLines, targetIndex - 1);
    const restoreTime =
      restoreIndex >= 0 && typeof nextLines[restoreIndex]?.time === 'number'
        ? nextLines[restoreIndex].time
        : 0;

    const nextSession = {
      ...currentSession,
      lines: nextLines,
      activeIndex: restoreIndex >= 0 ? restoreIndex : resolveCommunitySyncActiveIndex(nextLines, -1),
    };

    communitySyncSessionRef.current = nextSession;
    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
    seekCommunitySyncPlayback(restoreTime, nextSession.activeIndex);
  }, [persistCommunitySyncDraft, seekCommunitySyncPlayback]);

  const handleCommunitySyncInsertPause = useCallback(() => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession) return;

    const insertIndex = getCommunitySyncPauseInsertIndex(currentSession);
    const { previousTime, nextTime } = getCommunitySyncTimeBounds(currentSession.lines, insertIndex);
    const pauseLine = createCommunitySyncPauseLine(
      getStampedCommunitySyncTime(getCommunitySyncTimestampSource(), previousTime, nextTime),
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

    communitySyncSessionRef.current = nextSession;
    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [getCommunitySyncTimestampSource, persistCommunitySyncDraft]);

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

    communitySyncSessionRef.current = nextSession;
    setCommunitySyncSession(nextSession);
    persistCommunitySyncDraft(nextSession);
  }, [persistCommunitySyncDraft]);

  const handleCommunitySyncSeekLine = useCallback((index: number) => {
    const currentSession = communitySyncSessionRef.current;
    if (!currentSession || index < 0 || index >= currentSession.lines.length) return;

    const targetTime = currentSession.lines[index]?.time;
    if (typeof targetTime !== 'number') return;

    seekCommunitySyncPlayback(targetTime, index);
    setCommunitySyncSession((session) => {
      if (!session || session.activeIndex === index) return session;
      const nextSession = {
        ...session,
        activeIndex: index,
      };
      communitySyncSessionRef.current = nextSession;
      return nextSession;
    });
  }, [seekCommunitySyncPlayback]);

  const handleCommunityPublishRequest = useCallback(() => {
    if (!isCommunitySyncSessionComplete(communitySyncSessionRef.current)) return;
    if (!communitySyncTrackMeta) return;
    
    setCommunityPublishEditTrackName(communitySyncTrackMeta.trackName);
    setCommunityPublishEditArtistName(communitySyncTrackMeta.artistName);
    setCommunityPublishEditAlbumName('');
    setCommunityPublishEditDuration(String(Math.round(communitySyncTrackMeta.durationSec)));
    setCommunitySyncStage('confirm');
  }, [communitySyncTrackMeta]);

  const applyCommunityLyricsResult = useCallback(
    (
      trackUrnForLyrics: string,
      result: LyricsResult,
      extraQueries: LyricsSearchQuery[] = [],
    ) => {
      setCommunityLyricsOverrideByTrack((current) => ({
        ...current,
        [trackUrnForLyrics]: result,
      }));

      if (trackUrnForLyrics === trackUrn && activeManualQuery) {
        manualLyricsRef.current.set(trackUrnForLyrics, {
          ...activeManualQuery,
          lyrics: result,
        });
      } else {
        autoLyricsRef.current.set(trackUrnForLyrics, result);
      }

      const queries = [{ artist: reqArtist, title: reqTitle }, ...extraQueries];
      for (const query of queries) {
        queryClient.setQueryData(
          ['lyrics', LYRICS_SEARCH_QUERY_VERSION, trackUrnForLyrics, query.artist, query.title],
          result,
        );
      }

      void saveLyricsResultToCache(trackUrnForLyrics, result).catch((error) => {
        console.error('Failed to save community lyrics cache', error);
      });
    },
    [activeManualQuery, queryClient, reqArtist, reqTitle, trackUrn],
  );

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
    const uploadQuery = {
      artist: communityPublishEditArtistName.trim(),
      title: communityPublishEditTrackName.trim(),
    };

    setCommunityPublishPending(true);
    try {
      await invoke('lrclib_publish_lyrics', {
        artistName: uploadQuery.artist,
        trackName: uploadQuery.title,
        duration: durationSec,
        plainLyrics: draft.plainLyrics,
        syncedLyrics: serializeCommunitySyncedLyrics(draft.syncedLyrics),
        albumName: communityPublishEditAlbumName || null,
      });

      const uploadedLyrics = await searchLrclibSyncedLyricsByUploadMetadata(
        uploadQuery.artist,
        uploadQuery.title,
        durationSec,
      );
      const publishedLyrics: LyricsResult =
        uploadedLyrics ?? {
          plain: draft.plainLyrics,
          synced: draft.syncedLyrics,
          source: 'lrclib',
        };

      removeCommunityDraft(draft.trackUrn);
      applyCommunityLyricsResult(draft.trackUrn, publishedLyrics, [uploadQuery]);
      resetCommunitySyncFlow(true);
      toast.success(
        t('track.communitySyncPublished', 'Синхронизация опубликована в LRCLIB'),
      );
    } catch (error) {
      const localLyrics: LyricsResult = {
        plain: draft.plainLyrics,
        synced: draft.syncedLyrics,
        source: 'local',
      };

      saveCommunityDraft(draft);
      applyCommunityLyricsResult(draft.trackUrn, localLyrics, [uploadQuery]);
      resetCommunitySyncFlow(true);
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
    applyCommunityLyricsResult,
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
    setCommunityLyricsOverrideByTrack((current) => {
      if (!current[trackUrn]) return current;
      const next = { ...current };
      delete next[trackUrn];
      return next;
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
                {displayedLyrics ? (
                  <span className="inline-flex h-9 items-center rounded-full border border-white/[0.06] bg-white/[0.04] px-3 text-[10px] font-semibold text-white/20">
                    {SOURCE_LABELS[displayedLyrics.source]}
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
                  lyrics={displayedLyrics}
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

