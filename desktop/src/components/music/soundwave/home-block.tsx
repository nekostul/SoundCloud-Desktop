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
  type RecommendResult,
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

const HOME_WAVE_QUEUE_TARGET = 24;
const HOME_WAVE_BASE_FETCH_LIMIT = 14;
const HOME_WAVE_REFINEMENT_FETCH_LIMIT = 10;
const HOME_WAVE_REFINEMENT_SEED_LIMIT = 4;

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

function getTrackId(track: Track | null | undefined): string {
  return String(track?.urn?.split(':').pop() ?? '');
}

function buildWaveTrackFingerprint(track: Track): Set<string> {
  const text = `${track.genre || ''} ${track.tag_list || ''} ${track.title || ''} ${track.user?.username || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return new Set();

  return new Set(
    text
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function computeTrackCoherenceScore(track: Track, anchors: Track[]): number {
  if (anchors.length === 0) return 0;

  const trackArtist = track.user?.username?.toLowerCase().trim() || '';
  const trackGenre = (track.genre || '').toLowerCase().trim();
  const trackTokens = buildWaveTrackFingerprint(track);
  let score = 0;

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const weight = index === anchors.length - 1 ? 1.35 : 0.9;
    const anchorArtist = anchor.user?.username?.toLowerCase().trim() || '';
    const anchorGenre = (anchor.genre || '').toLowerCase().trim();
    const anchorTokens = buildWaveTrackFingerprint(anchor);

    if (trackGenre && anchorGenre && trackGenre === anchorGenre) {
      score += 2.4 * weight;
    }

    if (trackArtist && anchorArtist && trackArtist === anchorArtist) {
      score += 1.2 * weight;
    }

    let overlap = 0;
    for (const token of trackTokens) {
      if (anchorTokens.has(token)) overlap += 1;
    }
    score += Math.min(4, overlap) * 0.4 * weight;
  }

  return score;
}

function pickRefinementSeeds(tracks: Track[], mode: SoundWaveMode): Track[] {
  const pool = dedupeTracksByUrn(tracks).slice(
    0,
    mode === 'diverse' ? HOME_WAVE_REFINEMENT_SEED_LIMIT + 1 : HOME_WAVE_REFINEMENT_SEED_LIMIT,
  );

  if (mode === 'diverse' || pool.length <= 2) return pool.slice(0, HOME_WAVE_REFINEMENT_SEED_LIMIT);

  return [pool[0], ...pool.slice(Math.max(1, pool.length - 2))].slice(0, HOME_WAVE_REFINEMENT_SEED_LIMIT);
}

async function buildWaveQueueFromSeeds(
  seedTracks: Track[],
  languages: string[],
  mode: SoundWaveMode,
  hideLiked: boolean,
): Promise<Track[]> {
  const seedIds = seedTracks
    .map((track) => getTrackId(track))
    .filter(Boolean)
    .slice(0, 4);
  if (seedIds.length === 0) return [];

  const seedIdSet = new Set(seedIds);
  const candidateScores = new Map<string, { rec: RecommendResult; score: number; hops: number }>();

  const mergeRecommendations = (
    recs: RecommendResult[],
    sourceBoost: number,
    hops: number,
    anchorTracks: Track[],
  ) => {
    recs.forEach((rec, index) => {
      const id = String(rec.id ?? '');
      if (!id || seedIdSet.has(id)) return;

      const existing = candidateScores.get(id);
      const rankScore = Math.max(0, sourceBoost - index * (hops === 1 ? 0.42 : 0.34));
      const similarityScore = Math.max(0, Number(rec.score || 0)) * (hops === 1 ? 1.25 : 1.6);
      const baseScore =
        rankScore +
        similarityScore +
        (existing ? 4.6 : 0) +
        (anchorTracks.length > 0 ? 1.2 : 0);

      candidateScores.set(id, {
        rec,
        hops: Math.max(existing?.hops ?? 0, hops),
        score: (existing?.score ?? 0) + baseScore,
      });
    });
  };

  const baseRecommendationGroups = await Promise.all(
    seedIds.map((seedTrackId) =>
      fetchWaveTailFromSeed(seedTrackId, {
        languages,
        mode,
        limit: HOME_WAVE_BASE_FETCH_LIMIT,
      }),
    ),
  );

  baseRecommendationGroups.forEach((group) => {
    mergeRecommendations(group, mode === 'diverse' ? 5.8 : 7.2, 1, seedTracks);
  });

  const baseHydrated = await hydrateByIds(
    Array.from(candidateScores.values())
      .sort((a, b) => b.score - a.score)
      .map(({ rec }) => rec)
      .slice(0, 48),
  );
  const baseFiltered = dedupeTracksByUrn(
    (hideLiked
      ? baseHydrated.filter((track) => !track.user_favorite && !isUrnLiked(track.urn))
      : baseHydrated
    ).filter((track) => !seedIdSet.has(getTrackId(track))),
  );

  const refinementSeeds = pickRefinementSeeds(baseFiltered, mode);
  if (refinementSeeds.length > 0) {
    const refinementGroups = await Promise.all(
      refinementSeeds.map((track) =>
        fetchWaveTailFromSeed(getTrackId(track), {
          languages,
          mode,
          limit: HOME_WAVE_REFINEMENT_FETCH_LIMIT,
        }),
      ),
    );

    refinementGroups.forEach((group, index) => {
      mergeRecommendations(group, mode === 'diverse' ? 6.4 : 9.1, 2, [refinementSeeds[index]]);
    });
  }

  const scoredHydrated = await hydrateByIds(
    Array.from(candidateScores.values())
      .sort((a, b) => b.score - a.score)
      .map(({ rec }) => rec)
      .slice(0, 64),
  );

  const filtered = dedupeTracksByUrn(
    (hideLiked
      ? scoredHydrated.filter((track) => !track.user_favorite && !isUrnLiked(track.urn))
      : scoredHydrated
    ).filter((track) => !seedIdSet.has(getTrackId(track))),
  );

  if (filtered.length === 0) return [];

  const ordered: Track[] = [];
  const remaining = [...filtered];
  const anchors = dedupeTracksByUrn(seedTracks).slice(0, 3);

  while (remaining.length > 0 && ordered.length < HOME_WAVE_QUEUE_TARGET) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const track = remaining[index];
      const id = getTrackId(track);
      const candidate = candidateScores.get(id);
      if (!candidate) continue;

      let score = candidate.score + computeTrackCoherenceScore(track, anchors);
      const lastAnchor = anchors[anchors.length - 1];
      const sameArtistAsLast =
        lastAnchor?.user?.username &&
        track.user?.username &&
        lastAnchor.user.username.trim().toLowerCase() === track.user.username.trim().toLowerCase();
      if (sameArtistAsLast) {
        score -= mode === 'diverse' ? 2.8 : 1.5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const [nextTrack] = remaining.splice(bestIndex, 1);
    ordered.push(nextTrack);
    anchors.push(nextTrack);
    if (anchors.length > 3) anchors.shift();
  }

  return ordered;
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

  if (!isAuthenticated) return null;

  return (
    <section
      className="relative rounded-3xl overflow-hidden glass-featured select-none"
      style={{
        boxShadow:
          '0 0 0 1px rgba(255,255,255,0.04) inset, 0 10px 60px rgba(0,0,0,0.45), 0 0 60px var(--color-accent-glow)',
        borderColor: 'rgba(255,255,255,0.08)',
        contain: 'layout style paint',
        transform: 'translateZ(0)',
      }}
    >
      <AmbientLayer particleCount={6} blur={25} intensity={0.35} />

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
              style={{
                overflow: 'hidden',
                maxWidth: 32,
                width: 32,
                opacity: 1,
                transform: 'translateX(0) scale(1)',
                marginLeft: 0,
                marginRight: 0,
                pointerEvents: 'auto',
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
          style={{
            overflow: 'hidden',
            maxHeight: 'none',
            opacity: 1,
            transform: 'translateY(0) scaleY(1) translateZ(0)',
            marginTop: 0,
            pointerEvents: 'auto',
            transformOrigin: 'top center',
            contain: 'layout style paint',
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
