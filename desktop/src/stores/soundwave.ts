import { create } from 'zustand';
import { api } from '../lib/api';
import { type FeedItem, fetchAllLikedTracks, type Playlist } from '../lib/hooks';
import { initLikedUrns } from '../lib/likes';
import {
  blockSoundWaveTrackForToday,
  filterSoundWaveTracks,
  markSoundWaveTrackPlayed,
} from '../lib/soundwave-freshness';
import { buildWaveQueueFromPlayerContext, dedupeTracksByUrn } from '../lib/soundwave-queue';
import { hydrateByIds, type RecommendResult, type SoundWaveMode } from '../lib/soundwave';
import type { TrackLanguageProfile } from '../lib/language-detection';
import { useDislikesStore } from './dislikes';
import { type Track, usePlayerStore } from './player';
import { useSettingsStore } from './settings';

export interface SoundWavePreset {
  name: string;
  icon: string;
  tags?: string[];
  mode?: 'favorite' | 'discover' | 'popular';
  palette?: string;
  timeHours?: number[];
}

export interface SoundWaveLaunchContext {
  kind: 'playlist' | 'artist';
  key: string;
  title?: string;
  subtitle?: string;
}

type SoundWaveContinuationStrategy = 'preset-batch' | 'contextual-tail';
export type MoodLabel = 'energetic' | 'happy' | 'calm' | 'sad';

export const ACTIVITY_PRESETS: Record<string, SoundWavePreset> = {
  wakeup: {
    name: 'Просыпаюсь',
    icon: 'sun',
    tags: ['morning'],
    timeHours: [5, 6, 7, 8, 9],
  },
  commute: {
    name: 'В дороге',
    icon: 'car',
    tags: ['commute'],
    timeHours: [7, 8, 9, 17, 18, 19],
  },
  work: {
    name: 'Работаю',
    icon: 'laptop',
    tags: ['focus'],
    timeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
  },
  workout: {
    name: 'Тренируюсь',
    icon: 'dumbbell',
    tags: ['workout'],
    timeHours: [6, 7, 8, 17, 18, 19, 20],
  },
  sleep: {
    name: 'Засыпаю',
    icon: 'moon',
    tags: ['sleep'],
    timeHours: [21, 22, 23, 0, 1, 2, 3],
  },
};

export const MOOD_PRESETS: Record<string, SoundWavePreset> = {
  energetic: { name: 'Бодрое', icon: 'zap', tags: ['energetic'], palette: 'energetic' },
  happy: { name: 'Весёлое', icon: 'music', tags: ['happy'], palette: 'happy' },
  calm: { name: 'Спокойное', icon: 'waves', tags: ['calm'], palette: 'calm' },
  sad: { name: 'Грустное', icon: 'frown', tags: ['sad'], palette: 'sad' },
};

export const CHARACTER_PRESETS: Record<string, SoundWavePreset> = {
  favorite: { name: 'Любимое', icon: 'heart', mode: 'favorite' },
  discover: { name: 'Незнакомое', icon: 'sparkles', mode: 'discover' },
  popular: { name: 'Популярное', icon: 'zap', mode: 'popular' },
};

type StartupStageKey =
  | 'idle'
  | 'preset'
  | 'init'
  | 'likes'
  | 'explore'
  | 'batch'
  | 'done'
  | 'caching';

interface HistoryResponse {
  collection: Array<{ scTrackId: string }>;
}

interface SoundWaveState {
  isActive: boolean;
  isSuspended: boolean;
  continuationStrategy: SoundWaveContinuationStrategy | null;
  isInitialLoading: boolean;
  startupProgress: number;
  startupVisible: boolean;
  startupStage: StartupStageKey;
  currentPreset: SoundWavePreset | null;
  launchContext: SoundWaveLaunchContext | null;
  seedTracks: Track[];
  explorePool: Track[];
  genreWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  playedUrns: Set<string>;
  heardUrns: Set<string>;
  heardUrnRank: Map<string, number>;
  sessionPositive: (number | number[])[];
  sessionNegative: (number | number[])[];
  detectedLanguages: TrackLanguageProfile[];
  languageProfilesMap: Map<number, TrackLanguageProfile>;
  suspendedQueue: Track[] | null;
  suspendedQueueIndex: number;
  setStartupProgress: (progress: number, visible?: boolean, stage?: StartupStageKey) => void;

  init: () => Promise<void>;
  start: (preset: SoundWavePreset) => Promise<void>;
  startFromQueue: (options: {
    queue: Track[];
    seedTracks?: Track[];
    preserveCurrentTrack?: boolean;
    preset?: SoundWavePreset | null;
    launchContext?: SoundWaveLaunchContext | null;
  }) => Promise<void>;
  stop: () => void;
  suspendForExternalPlayback: (queue: Track[], queueIndex: number) => void;
  resumeSuspendedPlayback: () => boolean;
  ingestPlayedTrackFeatures: (track: Track | null | undefined) => void;
  markTrackPlayed: (track: Track | null | undefined) => void;
  generateBatch: (options?: { startup?: boolean }) => Promise<Track[]>;
  refreshUpcomingQueue: (options?: { reason?: string; targetSize?: number }) => Promise<Track[]>;
  recordFeedback: (track: Track, type: 'positive' | 'negative') => void;
  trainTrackMood: (track: Track, mood: MoodLabel) => void;
}

const clampProgress = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const CONTEXTUAL_WAVE_REFRESH_TARGET = 22;
let startupProgressHideTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
let inFlightGenerateBatch: Promise<Track[]> | null = null;
let soundWaveUpcomingRefreshSeq = 0;

function isTrackPlayable(track: Track | null | undefined): track is Track {
  return Boolean(track?.urn && track.title && track.user?.username && track.access !== 'blocked');
}

function extractPlaylistTracks(
  input: { collection?: Playlist[] } | Playlist[] | null | undefined,
): Track[] {
  const collection = Array.isArray(input) ? input : input?.collection ?? [];
  return collection.flatMap((playlist) => playlist.tracks ?? []).filter(isTrackPlayable);
}

function extractFeedTracks(input: { collection?: FeedItem[] } | null | undefined): Track[] {
  const collection = input?.collection ?? [];
  const tracks: Track[] = [];

  for (const item of collection) {
    const origin = item.origin;
    if (!origin) continue;

    if (Array.isArray(origin.tracks)) {
      tracks.push(...origin.tracks.filter(isTrackPlayable));
    } else if (isTrackPlayable(origin)) {
      tracks.push(origin);
    }
  }

  return tracks;
}

function resolveSoundWaveMode(preset: SoundWavePreset | null): SoundWaveMode {
  if (preset?.mode === 'discover' || useSettingsStore.getState().soundwaveMode === 'diverse') {
    return 'diverse';
  }
  return 'similar';
}

function getDislikedUrns(): Set<string> {
  return new Set(useDislikesStore.getState().dislikedTrackUrns);
}

function finalizeNativeTracks(
  tracks: Track[],
  opts: {
    playedUrns: Set<string>;
    hideLiked: boolean;
    limit: number;
  },
): Track[] {
  return filterSoundWaveTracks(dedupeTracksByUrn(tracks), {
    hideLiked: opts.hideLiked,
    excludeUrns: new Set([...opts.playedUrns, ...getDislikedUrns()]),
    minTracks: Math.min(8, opts.limit),
    includeRecentIfNeeded: true,
  }).slice(0, opts.limit);
}

async function fetchNativeHomeTracks(limit: number, mode: SoundWaveMode): Promise<Track[]> {
  const qs = new URLSearchParams({ limit: String(limit), mode });
  const recs = await api<RecommendResult[]>(`/recommendations?${qs}`, {
    quietHttpErrors: true,
  }).catch(() => [] as RecommendResult[]);
  return hydrateByIds(recs);
}

function scheduleStartupHide(set: (state: Partial<SoundWaveState>) => void) {
  if (startupProgressHideTimer) clearTimeout(startupProgressHideTimer);
  startupProgressHideTimer = setTimeout(() => {
    set({ startupVisible: false, startupProgress: 0, startupStage: 'idle' });
    startupProgressHideTimer = null;
  }, 520);
}

export const useSoundWaveStore = create<SoundWaveState>((set, get) => ({
  isActive: false,
  isSuspended: false,
  continuationStrategy: null,
  isInitialLoading: false,
  startupProgress: 0,
  startupVisible: false,
  startupStage: 'idle',
  currentPreset: null,
  launchContext: null,
  seedTracks: [],
  explorePool: [],
  genreWeights: {},
  artistWeights: {},
  playedUrns: new Set(),
  heardUrns: new Set(),
  heardUrnRank: new Map(),
  sessionPositive: [],
  sessionNegative: [],
  detectedLanguages: [],
  languageProfilesMap: new Map(),
  suspendedQueue: null,
  suspendedQueueIndex: -1,

  setStartupProgress: (progress, visible = true, stage) => {
    if (startupProgressHideTimer) {
      clearTimeout(startupProgressHideTimer);
      startupProgressHideTimer = null;
    }
    set({
      startupProgress: clampProgress(progress),
      startupVisible: visible,
      ...(stage ? { startupStage: stage } : {}),
    });
  },

  init: async () => {
    if (get().seedTracks.length > 0 || get().explorePool.length > 0) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      set({
        isInitialLoading: true,
        startupVisible: true,
        startupStage: 'init',
        startupProgress: Math.max(get().startupProgress, 10),
      });

      try {
        set({ startupStage: 'likes', startupProgress: 28 });
        const [likes, feed, likedPlaylists, history] = await Promise.all([
          fetchAllLikedTracks(200).catch(() => [] as Track[]),
          api<{ collection: FeedItem[] }>('/me/feed?limit=80', { quietHttpErrors: true }).catch(
            () => ({ collection: [] }),
          ),
          api<{ collection: Playlist[] } | Playlist[]>('/me/likes/playlists?limit=50', {
            quietHttpErrors: true,
          }).catch(() => ({ collection: [] })),
          api<HistoryResponse>('/history?limit=200&offset=0', { quietHttpErrors: true }).catch(
            () => ({ collection: [] }),
          ),
        ]);

        const seedTracks = likes.filter(isTrackPlayable);
        if (seedTracks.length > 0) initLikedUrns(seedTracks);

        set({ startupStage: 'explore', startupProgress: 58 });
        const explorePool = filterSoundWaveTracks(
          dedupeTracksByUrn([...extractFeedTracks(feed), ...extractPlaylistTracks(likedPlaylists)]),
          { includeRecentIfNeeded: true, minTracks: 1 },
        );

        const heardUrnRank = new Map<string, number>();
        history.collection?.forEach((entry, index) => {
          if (entry.scTrackId && !heardUrnRank.has(entry.scTrackId)) {
            heardUrnRank.set(entry.scTrackId, index);
          }
        });

        set({
          seedTracks,
          explorePool,
          heardUrns: new Set(heardUrnRank.keys()),
          heardUrnRank,
          isInitialLoading: false,
          startupProgress: Math.max(get().startupProgress, 74),
        });
      } catch (error) {
        console.error('[SoundWave] Native init failed', error);
        set({
          isInitialLoading: false,
          startupProgress: 0,
          startupVisible: false,
          startupStage: 'idle',
        });
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  },

  start: async (preset) => {
    const { init, generateBatch, stop } = get();
    stop();
    set({ startupVisible: true, startupProgress: 8, startupStage: 'preset' });
    await init();

    set({
      isActive: true,
      isSuspended: false,
      continuationStrategy: 'preset-batch',
      currentPreset: preset,
      launchContext: null,
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      startupVisible: true,
      startupProgress: Math.max(get().startupProgress, 82),
      startupStage: 'batch',
    });

    try {
      const batch = await generateBatch({ startup: true });
      if (batch.length > 0) {
        usePlayerStore.getState().play(batch[0], batch, 'soundwave');
        set({ startupVisible: true, startupProgress: 100, startupStage: 'done' });
        scheduleStartupHide(set);
      } else {
        set({ startupVisible: false, startupProgress: 0, startupStage: 'idle' });
      }
    } catch (error) {
      console.error('[SoundWave] Start failed', error);
      set({
        isActive: false,
        continuationStrategy: null,
        startupVisible: false,
        startupProgress: 0,
        startupStage: 'idle',
      });
    }
  },

  startFromQueue: async ({
    queue,
    seedTracks = [],
    preserveCurrentTrack = false,
    preset = null,
    launchContext = null,
  }) => {
    const normalizedQueue = filterSoundWaveTracks(queue.filter(isTrackPlayable), {
      minTracks: 1,
      includeRecentIfNeeded: true,
    });
    if (normalizedQueue.length === 0) return;

    const { init, stop } = get();
    const restartInPlace = preserveCurrentTrack && get().isActive;

    if (startupProgressHideTimer) {
      clearTimeout(startupProgressHideTimer);
      startupProgressHideTimer = null;
    }

    if (!restartInPlace) {
      stop();
      set({ startupVisible: true, startupProgress: 8, startupStage: 'preset' });
    }

    await init();

    set({
      isActive: true,
      isSuspended: false,
      continuationStrategy: 'contextual-tail',
      currentPreset: preset,
      launchContext,
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      startupVisible: restartInPlace ? get().startupVisible : false,
      startupProgress: restartInPlace ? get().startupProgress : 0,
      startupStage: restartInPlace ? 'idle' : 'done',
      seedTracks: seedTracks.length > 0 ? dedupeTracksByUrn(seedTracks) : get().seedTracks,
    });

    const player = usePlayerStore.getState();
    if (preserveCurrentTrack && player.currentTrack) {
      player.replaceQueueKeepingCurrent(normalizedQueue, 'soundwave');
      return;
    }

    player.play(normalizedQueue[0], normalizedQueue, 'soundwave');
  },

  stop: () => {
    if (startupProgressHideTimer) {
      clearTimeout(startupProgressHideTimer);
      startupProgressHideTimer = null;
    }
    set({
      isActive: false,
      isSuspended: false,
      continuationStrategy: null,
      startupVisible: false,
      startupProgress: 0,
      startupStage: 'idle',
      currentPreset: null,
      launchContext: null,
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      detectedLanguages: [],
      languageProfilesMap: new Map(),
      suspendedQueue: null,
      suspendedQueueIndex: -1,
    });
  },

  suspendForExternalPlayback: (queue, queueIndex) => {
    if (!get().isActive || get().isSuspended || !queue.length) return;

    const safeIndex = Math.max(0, Math.min(queueIndex, queue.length - 1));
    set({
      isSuspended: true,
      startupStage: 'caching',
      suspendedQueue: queue.map((track) => ({ ...track })),
      suspendedQueueIndex: safeIndex,
    });
  },

  resumeSuspendedPlayback: () => {
    const { isActive, isSuspended, suspendedQueue, suspendedQueueIndex } = get();
    if (!isActive || !isSuspended || !suspendedQueue?.length) return false;

    const safeIndex = Math.max(0, Math.min(suspendedQueueIndex, suspendedQueue.length - 1));
    const resumeTrack = suspendedQueue[safeIndex];
    if (!resumeTrack) return false;

    usePlayerStore.getState().play(resumeTrack, suspendedQueue, 'soundwave');
    set({
      isSuspended: false,
      startupStage: 'done',
      suspendedQueue: null,
      suspendedQueueIndex: -1,
    });
    return true;
  },

  ingestPlayedTrackFeatures: () => {},

  markTrackPlayed: (track) => {
    if (!track?.urn) return;
    markSoundWaveTrackPlayed(track);
    set((state) => {
      if (state.playedUrns.has(track.urn)) return {};
      const playedUrns = new Set(state.playedUrns);
      playedUrns.add(track.urn);
      return { playedUrns };
    });
  },

  refreshUpcomingQueue: async (options) => {
    const reason = options?.reason || 'manual';
    const targetSize = Math.max(8, options?.targetSize ?? CONTEXTUAL_WAVE_REFRESH_TARGET);
    const { isActive, isSuspended, continuationStrategy } = get();
    const player = usePlayerStore.getState();
    const { currentTrack, queue, queueIndex, queueSource } = player;

    if (
      !isActive ||
      isSuspended ||
      !continuationStrategy ||
      queueSource !== 'soundwave' ||
      !currentTrack ||
      queueIndex < 0
    ) {
      return [];
    }

    const requestId = ++soundWaveUpcomingRefreshSeq;
    const anchorUrn = currentTrack.urn;
    const queueHead = queue.slice(0, queueIndex + 1);
    const settings = useSettingsStore.getState();
    const mode = resolveSoundWaveMode(get().currentPreset);

    const tail =
      continuationStrategy === 'contextual-tail'
        ? await buildWaveQueueFromPlayerContext({
            languages: settings.soundwaveLanguages,
            mode,
            hideLiked: settings.soundwaveHideLiked,
            targetSize,
          })
        : await get().generateBatch();

    const latestPlayer = usePlayerStore.getState();
    if (
      requestId !== soundWaveUpcomingRefreshSeq ||
      latestPlayer.queueSource !== 'soundwave' ||
      latestPlayer.currentTrack?.urn !== anchorUrn
    ) {
      console.log(`[SoundWave] Dropped stale native refresh: reason=${reason}`);
      return [];
    }

    if (tail.length === 0) return [];

    const nextQueue = dedupeTracksByUrn([...queueHead, ...tail]);
    usePlayerStore.getState().replaceQueueKeepingCurrent(nextQueue, 'soundwave');
    return tail;
  },

  recordFeedback: (track, type) => {
    if (!track?.urn) return;
    if (type === 'negative') {
      blockSoundWaveTrackForToday(track);
      set((state) => {
        const playedUrns = new Set(state.playedUrns);
        playedUrns.add(track.urn);
        return { playedUrns };
      });
      return;
    }

    get().markTrackPlayed(track);
  },

  trainTrackMood: () => {},

  generateBatch: async (options) => {
    if (inFlightGenerateBatch) return inFlightGenerateBatch;

    const runGenerate = async (): Promise<Track[]> => {
      const startup = Boolean(options?.startup);
      if (startup) {
        set({
          startupVisible: true,
          startupProgress: Math.max(get().startupProgress, 86),
          startupStage: 'batch',
        });
      }

      const { seedTracks, explorePool, playedUrns, currentPreset } = get();
      const settings = useSettingsStore.getState();
      const limit = settings.soundwaveHideLiked ? 36 : 24;
      const mode = resolveSoundWaveMode(currentPreset);
      let tracks = await fetchNativeHomeTracks(limit * 2, mode);

      if (tracks.length === 0) {
        tracks =
          currentPreset?.mode === 'favorite'
            ? [...seedTracks, ...explorePool]
            : [...explorePool, ...seedTracks];
      }

      return finalizeNativeTracks(tracks, {
        playedUrns,
        hideLiked: settings.soundwaveHideLiked,
        limit,
      });
    };

    inFlightGenerateBatch = runGenerate().finally(() => {
      inFlightGenerateBatch = null;
    });

    return inFlightGenerateBatch;
  },
}));
