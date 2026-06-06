import { create } from 'zustand';
import { api } from '../lib/api';
import { type FeedItem, fetchAllLikedTracks, type Playlist } from '../lib/hooks';
import type { TrackLanguageProfile } from '../lib/language-detection';
import { initLikedUrns } from '../lib/likes';
import { hydrateByIds, type RecommendResult, type SoundWaveMode } from '../lib/soundwave';
import {
  collapseVariations,
  dedupeWaveQueue,
  isVariationSuppressed,
  registerPlayedForSuppression,
  resetVariationSuppression,
} from '../lib/soundwave-canonical';
import {
  blockSoundWaveTrackForToday,
  filterSoundWaveTracks,
  markSoundWaveTrackPlayed,
} from '../lib/soundwave-freshness';
import {
  buildWaveQueueFromPlayerContext,
  buildWaveQueueFromSeeds,
  dedupeTracksByUrn,
} from '../lib/soundwave-queue';
import { useDislikesStore } from './dislikes';
import { type Track, usePlayerStore } from './player';
import { useSettingsStore } from './settings';
import {
  pickPersonalizedSeedTracks,
  rankWaveCandidates,
  useSoundWaveProfileStore,
} from './soundwave-profile';

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
  isQueueRefilling: boolean;
  isTrackFlowLaunching: boolean;
  queueRefillReason: string | null;
  continuationStrategy: SoundWaveContinuationStrategy | null;
  isInitialLoading: boolean;
  startupProgress: number;
  startupVisible: boolean;
  startupStage: StartupStageKey;
  currentPreset: SoundWavePreset | null;
  launchContext: SoundWaveLaunchContext | null;
  seedTracks: Track[];
  explorePool: Track[];
  flowManagedUrns: Set<string>;
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
  suspendedFlowManagedUrns: string[];
  setStartupProgress: (progress: number, visible?: boolean, stage?: StartupStageKey) => void;
  setQueueRefilling: (value: boolean, reason?: string | null) => void;
  setTrackFlowLaunching: (value: boolean) => void;
  setManagedUpcomingTracks: (tracks: Track[]) => void;

  init: () => Promise<void>;
  start: (preset: SoundWavePreset) => Promise<void>;
  startFromQueue: (options: {
    queue: Track[];
    seedTracks?: Track[];
    preserveCurrentTrack?: boolean;
    preset?: SoundWavePreset | null;
    launchContext?: SoundWaveLaunchContext | null;
    continuationStrategy?: SoundWaveContinuationStrategy | null;
  }) => Promise<void>;
  stop: () => void;
  suspendForExternalPlayback: (queue: Track[], queueIndex: number) => void;
  resumeSuspendedPlayback: () => boolean;
  ingestPlayedTrackFeatures: (track: Track | null | undefined) => void;
  markTrackPlayed: (track: Track | null | undefined) => void;
  generateBatch: (options?: { startup?: boolean }) => Promise<Track[]>;
  refreshUpcomingQueue: (options?: {
    reason?: string;
    targetSize?: number;
    replaceManaged?: boolean;
  }) => Promise<Track[]>;
  recordFeedback: (track: Track, type: 'positive' | 'negative') => void;
  trainTrackMood: (track: Track, mood: MoodLabel) => void;
}

const clampProgress = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
// Адаптивный буфер: базовый запас при спокойном прослушивании, расширенный — при
// активных скипах. Пользователь буфер не видит, он живёт только внутри Flow.
const SOUNDWAVE_RADIO_BUFFER_TARGET = 12;
const SOUNDWAVE_RADIO_BUFFER_MAX = 20;
const SOUNDWAVE_RADIO_BUFFER_MIN = 10;
// Окно для оценки темпа скипов: сколько последних переходов учитываем.
const SOUNDWAVE_SKIP_WINDOW = 6;
const CONTEXTUAL_WAVE_REFRESH_TARGET = 10;
let startupProgressHideTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
let inFlightGenerateBatch: Promise<Track[]> | null = null;
let soundWaveUpcomingRefreshSeq = 0;
// Скользящее окно последних переходов: true = скип (мало прослушали), false = дослушал.
const recentSkipFlags: boolean[] = [];

function recordSkipSignal(isSkip: boolean) {
  recentSkipFlags.push(isSkip);
  if (recentSkipFlags.length > SOUNDWAVE_SKIP_WINDOW) recentSkipFlags.shift();
}

function getRecentSkipRatio() {
  if (recentSkipFlags.length === 0) return 0;
  const skips = recentSkipFlags.reduce((acc, flag) => acc + (flag ? 1 : 0), 0);
  return skips / recentSkipFlags.length;
}

function resetSkipSignals() {
  recentSkipFlags.length = 0;
}

// Целевой размер буфера, масштабируется от доли скипов в последнем окне:
// спокойно слушает → MIN..TARGET, агрессивно скипает → вплоть до MAX.
export function getAdaptiveRadioBufferTarget() {
  const ratio = getRecentSkipRatio();
  const span = SOUNDWAVE_RADIO_BUFFER_MAX - SOUNDWAVE_RADIO_BUFFER_TARGET;
  const target = Math.round(SOUNDWAVE_RADIO_BUFFER_TARGET + span * ratio);
  return Math.max(SOUNDWAVE_RADIO_BUFFER_MIN, Math.min(SOUNDWAVE_RADIO_BUFFER_MAX, target));
}

// Раннее пополнение: запускаем refill, как только осталась ~половина запаса,
// а не дожидаемся опустошения. При активных скипах порог поднимается вместе с буфером.
export function getAdaptiveRefillThreshold() {
  return Math.max(5, Math.round(getAdaptiveRadioBufferTarget() * 0.5));
}

// Критически низкий буфер — разрешаем параллельный refill, чтобы серия скипов
// не упёрлась в single-flight и воспроизведение не остановилось.
export const SOUNDWAVE_CRITICAL_BUFFER = 3;

function isTrackPlayable(track: Track | null | undefined): track is Track {
  return Boolean(track?.urn && track.title && track.user?.username && track.access !== 'blocked');
}

function collectQueueHead(queue: Track[], queueIndex: number, fallbackTrack: Track | null = null): Track[] {
  if (queueIndex >= 0) {
    return queue.slice(0, queueIndex + 1).filter(isTrackPlayable);
  }
  return fallbackTrack ? [fallbackTrack] : [];
}

function collectUpcomingQueueEntries(queue: Track[], queueIndex: number) {
  const entries: Array<{ track: Track; absIdx: number }> = [];
  const startIndex = Math.max(0, queueIndex + 1);

  for (let absIdx = startIndex; absIdx < queue.length; absIdx += 1) {
    const track = queue[absIdx];
    if (isTrackPlayable(track)) {
      entries.push({ track, absIdx });
    }
  }

  return entries;
}

function collectManagedUpcomingTracks(queue: Track[], queueIndex: number, managedUrns: Set<string>) {
  return collectUpcomingQueueEntries(queue, queueIndex)
    .map((entry) => entry.track)
    .filter((track) => managedUrns.has(track.urn));
}

function collectManualUpcomingEntries(queue: Track[], queueIndex: number, managedUrns: Set<string>) {
  return collectUpcomingQueueEntries(queue, queueIndex).filter(
    (entry) => !managedUrns.has(entry.track.urn),
  );
}

function collectManualUpcomingTracks(queue: Track[], queueIndex: number, managedUrns: Set<string>) {
  return collectManualUpcomingEntries(queue, queueIndex, managedUrns).map((entry) => entry.track);
}

function takeRadioBuffer(tracks: Track[], stage: string, limit = SOUNDWAVE_RADIO_BUFFER_TARGET) {
  return dedupeWaveQueue(dedupeTracksByUrn(tracks.filter(isTrackPlayable)), {
    stage,
  }).slice(0, Math.max(1, Math.min(limit, SOUNDWAVE_RADIO_BUFFER_MAX)));
}

function buildRadioQueue(opts: {
  queueHead: Track[];
  manualUpcoming: Track[];
  flowUpcoming: Track[];
  stage: string;
}) {
  const protectedUrns = new Set(
    [...opts.queueHead, ...opts.manualUpcoming].map((track) => track.urn).filter(Boolean),
  );
  const merged = dedupeWaveQueue(
    dedupeTracksByUrn([...opts.queueHead, ...opts.manualUpcoming, ...opts.flowUpcoming]),
    {
      stage: `${opts.stage}:merged`,
      protectedUrns,
    },
  );
  const managedUpcoming = merged
    .filter((track) => track?.urn && !protectedUrns.has(track.urn))
    .slice(0, SOUNDWAVE_RADIO_BUFFER_MAX);
  const nextQueue = dedupeWaveQueue(
    dedupeTracksByUrn([...opts.queueHead, ...opts.manualUpcoming, ...managedUpcoming]),
    {
      stage: opts.stage,
      protectedUrns,
    },
  );

  return { nextQueue, managedUpcoming };
}

function extractPlaylistTracks(
  input: { collection?: Playlist[] } | Playlist[] | null | undefined,
): Track[] {
  const collection = Array.isArray(input) ? input : (input?.collection ?? []);
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
  const filtered = filterSoundWaveTracks(dedupeTracksByUrn(tracks), {
    hideLiked: opts.hideLiked,
    excludeUrns: new Set([...opts.playedUrns, ...getDislikedUrns()]),
    minTracks: Math.min(8, opts.limit),
    includeRecentIfNeeded: true,
  });
  return collapseVariations(filtered, { stage: 'native-batch' })
    .filter((track) => !isVariationSuppressed(track))
    .slice(0, opts.limit);
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
  isQueueRefilling: false,
  isTrackFlowLaunching: false,
  queueRefillReason: null,
  continuationStrategy: null,
  isInitialLoading: false,
  startupProgress: 0,
  startupVisible: false,
  startupStage: 'idle',
  currentPreset: null,
  launchContext: null,
  seedTracks: [],
  explorePool: [],
  flowManagedUrns: new Set(),
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
  suspendedFlowManagedUrns: [],

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

  setQueueRefilling: (value, reason = null) => {
    set({
      isQueueRefilling: value,
      queueRefillReason: value ? (reason ?? get().queueRefillReason) : null,
    });
  },

  setTrackFlowLaunching: (value) => {
    set({ isTrackFlowLaunching: value });
  },

  setManagedUpcomingTracks: (tracks) => {
    set({
      flowManagedUrns: new Set(tracks.map((track) => track.urn).filter(Boolean)),
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
    const sessionSeedTracks = pickPersonalizedSeedTracks(get().seedTracks, { limit: 12 });

    set({
      isActive: true,
      isSuspended: false,
      isQueueRefilling: false,
      isTrackFlowLaunching: false,
      queueRefillReason: null,
      continuationStrategy: 'preset-batch',
      currentPreset: preset,
      launchContext: null,
      flowManagedUrns: new Set(),
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      suspendedFlowManagedUrns: [],
      startupVisible: true,
      startupProgress: Math.max(get().startupProgress, 82),
      startupStage: 'batch',
    });
    useSoundWaveProfileStore.getState().startSession({
      presetKey: preset.name,
      launchSource: 'preset',
      seedTracks: sessionSeedTracks,
    });

    try {
      const batch = await generateBatch({ startup: true });
      const finalBatch = dedupeWaveQueue(batch, { stage: 'start-final' });
      const radioQueue = takeRadioBuffer(
        finalBatch,
        'start-radio',
        SOUNDWAVE_RADIO_BUFFER_MAX,
      );
      if (radioQueue.length > 0) {
        get().setManagedUpcomingTracks(radioQueue.slice(1));
        useSoundWaveProfileStore.getState().recordWaveQueue(radioQueue, 'preset-start');
        usePlayerStore.getState().play(radioQueue[0], radioQueue, 'soundwave');
        set({ startupVisible: true, startupProgress: 100, startupStage: 'done' });
        scheduleStartupHide(set);
      } else {
        useSoundWaveProfileStore.getState().finishSession();
        set({
          isActive: false,
          continuationStrategy: null,
          startupVisible: false,
          startupProgress: 0,
          startupStage: 'idle',
        });
      }
    } catch (error) {
      console.error('[SoundWave] Start failed', error);
      useSoundWaveProfileStore.getState().finishSession();
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
    continuationStrategy = 'contextual-tail',
  }) => {
    const currentTrack = preserveCurrentTrack ? usePlayerStore.getState().currentTrack : null;
    const queueInput = currentTrack?.urn ? dedupeTracksByUrn([currentTrack, ...queue]) : queue;
    let normalizedQueue = filterSoundWaveTracks(queueInput.filter(isTrackPlayable), {
      minTracks: 1,
      includeRecentIfNeeded: true,
    });
    if (currentTrack?.urn && !normalizedQueue.some((track) => track.urn === currentTrack.urn)) {
      normalizedQueue = [currentTrack, ...normalizedQueue];
    }
    normalizedQueue = dedupeWaveQueue(normalizedQueue, {
      stage: 'start-from-queue-final',
      protectedUrns:
        preserveCurrentTrack && currentTrack?.urn ? new Set([currentTrack.urn]) : undefined,
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
    const sessionSeedTracks = pickPersonalizedSeedTracks(
      seedTracks.length > 0 ? seedTracks : normalizedQueue,
      { limit: 12 },
    );

    set({
      isActive: true,
      isSuspended: false,
      isQueueRefilling: false,
      isTrackFlowLaunching: false,
      queueRefillReason: null,
      continuationStrategy,
      currentPreset: preset,
      launchContext,
      flowManagedUrns: new Set(),
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      suspendedFlowManagedUrns: [],
      startupVisible: restartInPlace ? get().startupVisible : false,
      startupProgress: restartInPlace ? get().startupProgress : 0,
      startupStage: restartInPlace ? 'idle' : 'done',
      seedTracks: seedTracks.length > 0 ? dedupeTracksByUrn(seedTracks) : get().seedTracks,
    });
    if (!restartInPlace) {
      useSoundWaveProfileStore.getState().startSession({
        presetKey: preset?.name ?? null,
        launchSource: launchContext?.kind ?? continuationStrategy ?? 'queue',
        seedTracks: sessionSeedTracks,
      });
    }

    const player = usePlayerStore.getState();
    if (preserveCurrentTrack && player.currentTrack) {
      const currentTrackIndex = currentTrack?.urn
        ? normalizedQueue.findIndex((track) => track.urn === currentTrack.urn)
        : -1;
      const queueHead = collectQueueHead(player.queue, player.queueIndex, player.currentTrack);
      const hiddenSeed =
        currentTrackIndex >= 0 ? normalizedQueue.slice(currentTrackIndex + 1) : normalizedQueue;
      const { nextQueue, managedUpcoming } = buildRadioQueue({
        queueHead,
        manualUpcoming: [],
        flowUpcoming: takeRadioBuffer(
          hiddenSeed,
          'start-from-queue-preserve-radio',
          SOUNDWAVE_RADIO_BUFFER_MAX,
        ),
        stage: 'start-from-queue-preserve-final',
      });
      get().setManagedUpcomingTracks(managedUpcoming);
      if (managedUpcoming.length > 0) {
        useSoundWaveProfileStore
          .getState()
          .recordWaveQueue(managedUpcoming, continuationStrategy ?? 'queue-start');
      }
      player.replaceQueueKeepingCurrent(nextQueue, 'soundwave');
      return;
    }

    const radioQueue = takeRadioBuffer(
      normalizedQueue,
      'start-from-queue-radio',
      SOUNDWAVE_RADIO_BUFFER_MAX,
    );
    if (radioQueue.length === 0) return;

    get().setManagedUpcomingTracks(radioQueue.slice(1));
    useSoundWaveProfileStore
      .getState()
      .recordWaveQueue(radioQueue, continuationStrategy ?? 'queue-start');
    player.play(radioQueue[0], radioQueue, 'soundwave');
  },

  stop: () => {
    useSoundWaveProfileStore.getState().finishSession();
    resetSkipSignals();
    if (startupProgressHideTimer) {
      clearTimeout(startupProgressHideTimer);
      startupProgressHideTimer = null;
    }
    resetVariationSuppression();
    set({
      isActive: false,
      isSuspended: false,
      isQueueRefilling: false,
      isTrackFlowLaunching: false,
      queueRefillReason: null,
      continuationStrategy: null,
      startupVisible: false,
      startupProgress: 0,
      startupStage: 'idle',
      currentPreset: null,
      launchContext: null,
      flowManagedUrns: new Set(),
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      detectedLanguages: [],
      languageProfilesMap: new Map(),
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      suspendedFlowManagedUrns: [],
    });
  },

  suspendForExternalPlayback: (queue, queueIndex) => {
    if (!get().isActive || get().isSuspended || !queue.length) return;

    const safeIndex = Math.max(0, Math.min(queueIndex, queue.length - 1));
    set({
      isSuspended: true,
      isQueueRefilling: false,
      isTrackFlowLaunching: false,
      queueRefillReason: null,
      startupStage: 'caching',
      suspendedQueue: queue.map((track) => ({ ...track })),
      suspendedQueueIndex: safeIndex,
      suspendedFlowManagedUrns: [...get().flowManagedUrns],
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
      isQueueRefilling: false,
      isTrackFlowLaunching: false,
      queueRefillReason: null,
      startupStage: 'done',
      flowManagedUrns: new Set(get().suspendedFlowManagedUrns),
      suspendedQueue: null,
      suspendedQueueIndex: -1,
      suspendedFlowManagedUrns: [],
    });
    return true;
  },

  ingestPlayedTrackFeatures: () => {},

  markTrackPlayed: (track) => {
    if (!track?.urn) return;
    markSoundWaveTrackPlayed(track);
    registerPlayedForSuppression(track);
    set((state) => {
      if (state.playedUrns.has(track.urn)) return {};
      const playedUrns = new Set(state.playedUrns);
      playedUrns.add(track.urn);
      return { playedUrns };
    });
  },

  refreshUpcomingQueue: async (options) => {
    const reason = options?.reason || 'manual';
    const targetSize = Math.max(
      1,
      Math.min(
        SOUNDWAVE_RADIO_BUFFER_MAX,
        options?.targetSize ?? getAdaptiveRadioBufferTarget(),
      ),
    );
    const replaceManaged = Boolean(options?.replaceManaged);
    const { isActive, isSuspended, continuationStrategy, flowManagedUrns } = get();
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
    const queueHead = collectQueueHead(queue, queueIndex, currentTrack);
    const manualUpcoming = collectManualUpcomingTracks(queue, queueIndex, flowManagedUrns);
    const existingManaged = replaceManaged
      ? []
      : collectManagedUpcomingTracks(queue, queueIndex, flowManagedUrns);
    if (!replaceManaged && existingManaged.length >= targetSize) {
      return existingManaged;
    }
    const settings = useSettingsStore.getState();
    const mode = resolveSoundWaveMode(get().currentPreset);

    const candidates =
      continuationStrategy === 'contextual-tail'
        ? await buildWaveQueueFromPlayerContext({
            languages: settings.soundwaveLanguages,
            mode,
            hideLiked: settings.soundwaveHideLiked,
            targetSize: Math.max(CONTEXTUAL_WAVE_REFRESH_TARGET, targetSize + 4),
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

    const protectedUrns = new Set(
      [...queueHead, ...manualUpcoming].map((track) => track.urn).filter(Boolean),
    );
    const nextManaged = takeRadioBuffer(
      [
        ...existingManaged,
        ...candidates.filter((track) => track?.urn && !protectedUrns.has(track.urn)),
      ],
      `refresh-buffer:${reason}`,
      targetSize,
    ).filter((track) => !protectedUrns.has(track.urn));

    if (nextManaged.length === 0 && existingManaged.length === 0) return [];

    const { nextQueue, managedUpcoming } = buildRadioQueue({
      queueHead,
      manualUpcoming,
      flowUpcoming: nextManaged,
      stage: `refresh-final:${reason}`,
    });
    const previousManagedUrns = new Set(
      collectManagedUpcomingTracks(queue, queueIndex, flowManagedUrns)
        .map((track) => track.urn)
        .filter(Boolean),
    );
    const appendedTracks = managedUpcoming.filter((track) => !previousManagedUrns.has(track.urn));

    if (appendedTracks.length > 0) {
      useSoundWaveProfileStore
        .getState()
        .recordWaveQueue(
          appendedTracks,
          continuationStrategy === 'contextual-tail' ? 'contextual-tail' : 'preset-refill',
        );
    }
    get().setManagedUpcomingTracks(managedUpcoming);
    usePlayerStore.getState().replaceQueueKeepingCurrent(nextQueue, 'soundwave');
    return managedUpcoming;
  },

  recordFeedback: (track, type) => {
    if (!track?.urn) return;
    if (type === 'negative') {
      recordSkipSignal(true);
      blockSoundWaveTrackForToday(track);
      set((state) => {
        const playedUrns = new Set(state.playedUrns);
        playedUrns.add(track.urn);
        return { playedUrns };
      });
      return;
    }

    recordSkipSignal(false);
    get().markTrackPlayed(track);
  },

  trainTrackMood: (track, mood) => {
    useSoundWaveProfileStore.getState().recordMoodPreference(track, mood);
  },

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
      const personalizedSeeds = pickPersonalizedSeedTracks(seedTracks, {
        limit: mode === 'diverse' ? 12 : 9,
        excludeUrns: playedUrns,
      });
      const seedTail =
        personalizedSeeds.length > 0
          ? await buildWaveQueueFromSeeds(
              personalizedSeeds,
              settings.soundwaveLanguages,
              mode,
              settings.soundwaveHideLiked,
              {
                recentTracks: personalizedSeeds.slice(0, 4),
                targetSize: Math.max(limit * 2, 28),
              },
            )
          : [];
      let homeTracks = await fetchNativeHomeTracks(limit * 2, mode);

      if (homeTracks.length === 0) {
        homeTracks =
          currentPreset?.mode === 'favorite'
            ? [...personalizedSeeds, ...seedTracks, ...explorePool]
            : [...explorePool, ...personalizedSeeds, ...seedTracks];
      }

      const pool = dedupeTracksByUrn([
        ...seedTail,
        ...homeTracks,
        ...explorePool,
        ...personalizedSeeds,
      ]);
      const finalizedPool = finalizeNativeTracks(pool, {
        playedUrns,
        hideLiked: settings.soundwaveHideLiked,
        limit: Math.max(limit * 3, 48),
      });
      const ranked = rankWaveCandidates(finalizedPool, { limit, mode });
      return ranked.length > 0 ? ranked : finalizedPool.slice(0, limit);
    };

    inFlightGenerateBatch = runGenerate().finally(() => {
      inFlightGenerateBatch = null;
    });

    return inFlightGenerateBatch;
  },
}));

export function isSoundWaveManagedTrack(track: Track | null | undefined) {
  return Boolean(track?.urn && useSoundWaveStore.getState().flowManagedUrns.has(track.urn));
}

export function getSoundWaveManagedUpcomingTracks(
  queue = usePlayerStore.getState().queue,
  queueIndex = usePlayerStore.getState().queueIndex,
) {
  return collectManagedUpcomingTracks(
    queue,
    queueIndex,
    useSoundWaveStore.getState().flowManagedUrns,
  );
}

export function getSoundWaveManagedBufferCount(
  queue = usePlayerStore.getState().queue,
  queueIndex = usePlayerStore.getState().queueIndex,
) {
  return getSoundWaveManagedUpcomingTracks(queue, queueIndex).length;
}

export function getSoundWaveVisibleQueueEntries(
  queue = usePlayerStore.getState().queue,
  queueIndex = usePlayerStore.getState().queueIndex,
) {
  return collectManualUpcomingEntries(queue, queueIndex, useSoundWaveStore.getState().flowManagedUrns);
}

export function getSoundWaveVisibleQueueTracks(
  queue = usePlayerStore.getState().queue,
  queueIndex = usePlayerStore.getState().queueIndex,
) {
  return getSoundWaveVisibleQueueEntries(queue, queueIndex).map((entry) => entry.track);
}

export function replaceSoundWaveVisibleQueue(manualUpcoming: Track[], stage = 'manual-queue') {
  const player = usePlayerStore.getState();
  const currentTrack = player.currentTrack;
  if (!currentTrack) return [];

  const queueHead = collectQueueHead(player.queue, player.queueIndex, currentTrack);
  const managedUpcoming = getSoundWaveManagedUpcomingTracks(player.queue, player.queueIndex);
  const { nextQueue, managedUpcoming: nextManaged } = buildRadioQueue({
    queueHead,
    manualUpcoming,
    flowUpcoming: managedUpcoming,
    stage,
  });

  useSoundWaveStore.getState().setManagedUpcomingTracks(nextManaged);
  usePlayerStore.getState().replaceQueueKeepingCurrent(nextQueue, 'soundwave');
  return nextQueue;
}
