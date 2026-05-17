import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  pauseBlack14,
  playBlack14,
  RefreshCw,
  Search,
  Sparkles,
} from '../../../lib/icons';
import { isUrnLiked } from '../../../lib/likes';
import {
  fetchWaveTailFromSeed,
  hydrateByIds,
  type SoundWaveMode,
  useSoundWave,
  useSoundWaveSearch,
} from '../../../lib/soundwave';
import { useAuthStore } from '../../../stores/auth';
import type { Track } from '../../../stores/player';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';
import { CHARACTER_PRESETS, useSoundWaveStore } from '../../../stores/soundwave';
import { AmbientLayer } from './ambient';
import { RecommendationsHeader, SearchHeader } from './headers';
import { HideLikedToggle } from './hide-liked-toggle';
import { LanguageFilter } from './language-filter';
import { ModeToggle } from './mode-toggle';
import { RecommendationsStrip, SkeletonStrip } from './strip';
import { WaveTrackHeader } from './track-header';
import { useInfiniteWave } from './use-infinite-wave';
import { VibeSearchBar, type VibeSearchBarHandle } from './vibe-search-bar';
import { LiveWaveform } from './waveform';

/**
 * Fetch more wave recommendations seeded by the last track the user is
 * currently listening to. This is what makes the wave infinite — we keep
 * asking "what's similar to where we are now?".
 */
async function fetchWaveTail(
  languages: string[],
  mode: SoundWaveMode,
  hideLiked: boolean,
): Promise<Track[]> {
  const q = usePlayerStore.getState().queue;
  const last = q.length > 0 ? q[q.length - 1] : null;
  if (!last) return [];
  const trackId = String(last.urn.split(':').pop() ?? '');
  if (!trackId) return [];

  const recs = await fetchWaveTailFromSeed(trackId, { languages, mode });
  if (!recs.length) return [];
  const tracks = await hydrateByIds(recs);
  return hideLiked ? tracks.filter((t) => !t.user_favorite && !isUrnLiked(t.urn)) : tracks;
}

const HOME_WAVE_COLLAPSE_MS = 520;

function dedupeTracksByUrn(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];

  for (const track of tracks) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    unique.push(track);
  }

  return unique;
}

async function buildWaveQueueFromSeeds(
  seedTracks: Track[],
  languages: string[],
  mode: SoundWaveMode,
  hideLiked: boolean,
): Promise<Track[]> {
  const seedIds = seedTracks
    .map((track) => String(track.urn.split(':').pop() ?? ''))
    .filter(Boolean)
    .slice(0, 4);
  if (seedIds.length === 0) return [];

  const recs = (
    await Promise.all(
      seedIds.map((seedTrackId) =>
        fetchWaveTailFromSeed(seedTrackId, {
          languages,
          mode,
          limit: 12,
        }),
      ),
    )
  ).flat();

  const seedIdSet = new Set(seedIds);
  const uniqueRecs = recs.filter((rec, index, arr) => {
    const id = String(rec.id ?? '');
    if (!id || seedIdSet.has(id)) return false;
    return arr.findIndex((candidate) => String(candidate.id ?? '') === id) === index;
  });
  if (uniqueRecs.length === 0) return [];

  const hydrated = await hydrateByIds(uniqueRecs.slice(0, 40));
  const filtered = hideLiked
    ? hydrated.filter((track) => !track.user_favorite && !isUrnLiked(track.urn))
    : hydrated;

  return dedupeTracksByUrn(filtered);
}

export const SoundWaveBlock = React.memo(function SoundWaveBlock() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const selectedLanguages = useSettingsStore((s) => s.soundwaveLanguages);
  const setSelectedLanguages = useSettingsStore((s) => s.setSoundwaveLanguages);
  const mode = useSettingsStore((s) => s.soundwaveMode);
  const hideLiked = useSettingsStore((s) => s.soundwaveHideLiked);
  const setHideLiked = useSettingsStore((s) => s.setSoundwaveHideLiked);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queueSource = usePlayerStore((s) => s.queueSource);
  const isWaveActive = useSoundWaveStore((s) => s.isActive);
  const isWaveSuspended = useSoundWaveStore((s) => s.isSuspended);
  const startFromQueue = useSoundWaveStore((s) => s.startFromQueue);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStartingWave, setIsStartingWave] = useState(false);
  const [activeQuery, setActiveQuery] = useState('');
  const searchRef = useRef<VibeSearchBarHandle>(null);
  const waveSettingsKeyRef = useRef<string | null>(null);

  const stableLanguages = useMemo(() => [...selectedLanguages].sort(), [selectedLanguages]);

  const { data, isLoading, isFetching, refetch } = useSoundWave({
    enabled: isAuthenticated,
    languages: stableLanguages,
    mode,
    hideLiked,
  });

  const {
    data: searchData,
    isLoading: searchLoading,
    isFetching: searchFetching,
  } = useSoundWaveSearch({ q: activeQuery, languages: stableLanguages });

  const recTracks = useMemo(() => data?.tracks ?? [], [data]);
  const searchTracks = useMemo(() => searchData?.tracks ?? [], [searchData]);

  const isSearchMode = activeQuery.length >= 2;
  const tracks = isSearchMode ? searchTracks : recTracks;
  const searchBusy = searchLoading || searchFetching;

  const waveTrack = currentTrack ?? tracks[0] ?? null;
  const isCurrent = !!currentTrack && waveTrack?.urn === currentTrack.urn;
  const waveSessionPreset =
    mode === 'diverse' ? CHARACTER_PRESETS.discover : CHARACTER_PRESETS.favorite;
  const isWaveQueue = isWaveActive && queueSource === 'soundwave' && !!currentTrack;

  const fetchMore = useCallback(
    () => fetchWaveTail(stableLanguages, mode, hideLiked),
    [stableLanguages, mode, hideLiked],
  );

  useInfiniteWave({
    enabled: isAuthenticated && !isSearchMode,
    tracks: recTracks,
    fetchMore,
  });

  const handleSubmitSearch = useCallback((q: string) => {
    setActiveQuery(q);
  }, []);

  const handleClearSearch = useCallback(() => {
    searchRef.current?.clear();
    setActiveQuery('');
  }, []);

  if (!isAuthenticated) return null;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setTimeout(() => setIsRefreshing(false), 350);
    }
  };

  const restartWaveFromTrack = useCallback(
    async (anchorTrack: Track) => {
      const tail = await buildWaveQueueFromSeeds([anchorTrack], stableLanguages, mode, hideLiked);
      await startFromQueue({
        queue: dedupeTracksByUrn([anchorTrack, ...tail]),
        seedTracks: [anchorTrack],
        preserveCurrentTrack: true,
        preset: waveSessionPreset,
      });
    },
    [stableLanguages, mode, hideLiked, startFromQueue, waveSessionPreset],
  );

  const handlePlayAll = async () => {
    if (isStartingWave) return;

    if (isWaveQueue) {
      if (isPlaying) {
        usePlayerStore.getState().pause();
      } else {
        usePlayerStore.getState().resume();
      }
      return;
    }

    const activeAnchorTrack = isPlaying && currentTrack ? currentTrack : null;
    const recommendationSeeds = recTracks.slice(0, mode === 'diverse' ? 4 : 3);
    if (!activeAnchorTrack && recommendationSeeds.length === 0) return;

    setIsStartingWave(true);
    try {
      if (activeAnchorTrack) {
        await restartWaveFromTrack(activeAnchorTrack);
        return;
      }

      const queue = await buildWaveQueueFromSeeds(
        recommendationSeeds,
        stableLanguages,
        mode,
        hideLiked,
      );
      if (queue.length === 0) return;

      await startFromQueue({
        queue,
        seedTracks: recommendationSeeds,
        preset: waveSessionPreset,
      });
    } finally {
      setIsStartingWave(false);
    }
  };

  useEffect(() => {
    const nextKey = JSON.stringify({
      languages: stableLanguages,
      mode,
      hideLiked,
    });
    const prevKey = waveSettingsKeyRef.current;
    waveSettingsKeyRef.current = nextKey;

    if (prevKey === null || prevKey === nextKey) return;
    if (!isWaveQueue || !currentTrack || isStartingWave) return;

    setIsStartingWave(true);
    void restartWaveFromTrack(currentTrack).finally(() => {
      setIsStartingWave(false);
    });
  }, [
    stableLanguages,
    mode,
    hideLiked,
    isWaveQueue,
    currentTrack,
    isStartingWave,
    restartWaveFromTrack,
  ]);

  const canStartWave = isWaveQueue || (isPlaying && !!currentTrack) || recTracks.length > 0;
  const playAllLabel = isWaveQueue
    ? isPlaying
      ? t('soundwave.pausePlayback')
      : t('soundwave.resumePlayback')
    : t('soundwave.playAll');
  const playAllIcon = isStartingWave ? (
    <RefreshCw size={12} className="animate-spin" />
  ) : isWaveQueue && isPlaying ? (
    pauseBlack14
  ) : (
    playBlack14
  );

  const spinning = isRefreshing || isFetching;
  const showCold = !isSearchMode && !isLoading && recTracks.length === 0;
  const showSearchEmpty = isSearchMode && !searchBusy && searchTracks.length === 0;
  const isDetailsCollapsed = isWaveActive && !isWaveSuspended && queueSource === 'soundwave';
  const isRefreshHidden = isWaveActive && !isWaveSuspended && queueSource === 'soundwave';

  return (
    <section
      className="relative rounded-3xl overflow-hidden glass-featured select-none"
      style={{
        boxShadow:
          '0 0 0 1px rgba(255,255,255,0.04) inset, 0 10px 60px rgba(0,0,0,0.45), 0 0 60px var(--color-accent-glow)',
        borderColor: 'rgba(255,255,255,0.08)',
      }}
    >
      <AmbientLayer particleCount={10} blur={35} intensity={0.5} reactive />

      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          // Top mostly transparent so the music-reactive aurora + drifting
          // particles from <AmbientLayer> are actually visible. Keeps a
          // soft darken at the bottom for legibility of the "Play all" /
          // controls strip there.
          background:
            'linear-gradient(180deg, rgba(8,8,10,0.12) 0%, rgba(8,8,10,0.08) 45%, rgba(8,8,10,0.6) 100%)',
          contain: 'strict',
        }}
      />

      <div className="relative p-6 flex flex-col gap-5" style={{ isolation: 'isolate' }}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="relative w-10 h-10 rounded-2xl flex items-center justify-center shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--color-accent), rgba(255,255,255,0.12))',
                boxShadow: '0 0 24px var(--color-accent-glow), inset 0 1px 0 rgba(255,255,255,0.2)',
              }}
            >
              <AudioLines size={18} style={{ color: 'var(--color-accent-contrast)' }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="soundwave-title text-[20px] font-bold tracking-tight leading-none">
                  SoundWave
                </h2>
                <span
                  className="relative overflow-hidden inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.12em] px-2 py-[3px] rounded-full text-white/90"
                  style={{
                    background:
                      'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.06))',
                    border: '1px solid var(--color-accent-glow)',
                  }}
                >
                  <Sparkles size={9} style={{ color: 'var(--color-accent)' }} />
                  AI
                </span>
              </div>
              <p className="text-[11.5px] text-white/50 mt-1 truncate">{t('soundwave.tagline')}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <ModeToggle />
            <LanguageFilter selected={selectedLanguages} onChange={setSelectedLanguages} />
            <div
              aria-hidden={isRefreshHidden}
              style={{
                overflow: 'hidden',
                maxWidth: isRefreshHidden ? 0 : 32,
                width: isRefreshHidden ? 0 : 32,
                opacity: isRefreshHidden ? 0 : 1,
                transform: isRefreshHidden ? 'translateX(10px) scale(0.88)' : 'translateX(0) scale(1)',
                marginLeft: isRefreshHidden ? -4 : 0,
                marginRight: isRefreshHidden ? -4 : 0,
                pointerEvents: isRefreshHidden ? 'none' : 'auto',
                transition: [
                  'max-width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                  'width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                  'opacity 280ms cubic-bezier(0.22, 1, 0.36, 1)',
                  'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                  'margin-left 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                  'margin-right 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                ].join(', '),
                willChange: 'max-width, width, opacity, transform, margin-left, margin-right',
              }}
            >
              <button
                type="button"
                onClick={handleRefresh}
                disabled={spinning}
                className="flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.1] hover:border-white/[0.14] transition-colors duration-200 text-white/70 hover:text-white/95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('soundwave.refresh')}
              >
                <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
              </button>
            </div>
            <HideLikedToggle value={hideLiked} onChange={setHideLiked} />
            <button
              type="button"
              onClick={() => void handlePlayAll()}
              disabled={!canStartWave || isStartingWave}
              className="flex items-center gap-2 pl-2.5 pr-4 h-10 rounded-full font-semibold text-[13px] transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] hover:scale-[1.03]"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-accent-contrast)',
                boxShadow:
                  '0 6px 22px var(--color-accent-glow), inset 0 1px 0 rgba(255,255,255,0.25)',
              }}
              title={playAllLabel}
            >
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.9)' }}
              >
                {playAllIcon}
              </span>
              {playAllLabel}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {waveTrack ? (
            <WaveTrackHeader
              track={waveTrack}
              queue={tracks.length ? tracks : [waveTrack]}
              isCurrent={isCurrent}
            />
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-xl bg-white/[0.04] ring-1 ring-white/[0.06] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-white/90 leading-tight">
                  {t('soundwave.idleTitle')}
                </p>
                <p className="text-[12px] text-white/45 mt-0.5 truncate">
                  {t('soundwave.idleSub')}
                </p>
              </div>
            </div>
          )}

          <LiveWaveform track={waveTrack} isCurrent={isCurrent} />
        </div>

        <div
          aria-hidden={isDetailsCollapsed}
          style={{
            overflow: 'hidden',
            maxHeight: isDetailsCollapsed ? 0 : 560,
            opacity: isDetailsCollapsed ? 0 : 1,
            transform: isDetailsCollapsed ? 'translateY(-18px) scaleY(0.96)' : 'translateY(0) scaleY(1)',
            filter: isDetailsCollapsed ? 'blur(10px)' : 'blur(0px)',
            marginTop: isDetailsCollapsed ? -8 : 0,
            pointerEvents: isDetailsCollapsed ? 'none' : 'auto',
            transformOrigin: 'top center',
            transition: [
              `max-height ${HOME_WAVE_COLLAPSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              'opacity 380ms cubic-bezier(0.22, 1, 0.36, 1)',
              'transform 520ms cubic-bezier(0.22, 1, 0.36, 1)',
              'filter 420ms cubic-bezier(0.22, 1, 0.36, 1)',
              'margin-top 520ms cubic-bezier(0.22, 1, 0.36, 1)',
            ].join(', '),
            willChange: 'max-height, opacity, transform, filter, margin-top',
          }}
        >
          <div className="flex flex-col gap-5 pt-0.5">
            <VibeSearchBar
              ref={searchRef}
              onSubmit={handleSubmitSearch}
              onClear={handleClearSearch}
              loading={searchBusy}
              active={isSearchMode}
            />

            <div className="min-h-[280px]">
              {isSearchMode ? (
                <>
                  <SearchHeader
                    query={activeQuery}
                    count={searchTracks.length}
                    onClear={handleClearSearch}
                  />
                  {searchBusy ? (
                    <SkeletonStrip />
                  ) : showSearchEmpty ? (
                    <EmptyState
                      icon={<Search size={16} style={{ color: 'var(--color-accent)' }} />}
                      title={t('soundwave.searchEmptyTitle')}
                      desc={t('soundwave.searchEmptyDesc')}
                    />
                  ) : (
                    <RecommendationsStrip tracks={searchTracks} />
                  )}
                </>
              ) : (
                <>
                  <RecommendationsHeader />
                  {isLoading ? (
                    <SkeletonStrip />
                  ) : showCold ? (
                    <EmptyState
                      icon={<Sparkles size={18} style={{ color: 'var(--color-accent)' }} />}
                      title={t('soundwave.coldTitle')}
                      desc={t('soundwave.coldDesc')}
                    />
                  ) : (
                    <RecommendationsStrip tracks={recTracks} />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});

/** Stateless "nothing here yet" card used for both cold-start and no-search-results. */
const EmptyState = React.memo(function EmptyState({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="relative py-6 px-5 rounded-2xl bg-white/[0.025] border border-white/[0.05] flex items-center gap-4">
      <div
        className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.04))',
          border: '1px solid var(--color-accent-glow)',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-white/90">{title}</p>
        <p className="text-[11.5px] text-white/45 mt-0.5">{desc}</p>
      </div>
    </div>
  );
});
