import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { describeTrackWork, type WorkIdentity } from '../lib/soundwave-canonical';
import { tauriStorage } from '../lib/tauri-storage';
import type { Track } from './player';

type WaveMode = 'similar' | 'diverse';

type WaveEntityProfile = {
  affinity: number;
  positive: number;
  negative: number;
  likes: number;
  playlistAdds: number;
  fullListens: number;
  quickSkips: number;
  lastPositiveAt: number;
  lastNegativeAt: number;
  waveAppearances: number;
};

type WaveTrackProfile = {
  snapshot: Track | null;
  workIdentity: WorkIdentity | null;
  genreKeys: string[];
  sourceKeys: string[];
  totalStarts: number;
  waveStarts: number;
  waveAppearances: number;
  fullListens: number;
  nearFullListens: number;
  quickSkips: number;
  midSkips: number;
  replays: number;
  likes: number;
  playlistAdds: number;
  explicitDislikes: number;
  confirmedRejects: number;
  interestScore: number;
  blockedUntil: number;
  lastStartedAt: number;
  lastPlayedAt: number;
  lastCompletedAt: number;
  lastSkippedAt: number;
  lastRecommendedAt: number;
  lastInteractionAt: number;
};

type RecentWaveExposure = {
  urn: string;
  workKey: string;
  artistKeys: string[];
  sourceKey: string;
  at: number;
};

type WaveSessionSummary = {
  id: string;
  startedAt: number;
  lastEventAt: number;
  presetKey: string | null;
  launchSource: string | null;
  seedUrns: string[];
  plays: number;
  skips: number;
  likes: number;
  playlistAdds: number;
  discoveries: number;
};

type PlaybackResultInput = {
  playedSeconds: number;
  durationSeconds?: number;
  fromWave?: boolean;
  naturalEnd?: boolean;
};

type PlaybackStartInput = {
  fromWave?: boolean;
};

type SoundWaveProfileState = {
  trackProfiles: Record<string, WaveTrackProfile>;
  artistProfiles: Record<string, WaveEntityProfile>;
  genreProfiles: Record<string, WaveEntityProfile>;
  sourceProfiles: Record<string, WaveEntityProfile>;
  recentWaveExposure: RecentWaveExposure[];
  sessionHistory: WaveSessionSummary[];
  activeSessionId: string | null;
  startSession: (meta?: {
    presetKey?: string | null;
    launchSource?: string | null;
    seedTracks?: Track[];
  }) => void;
  finishSession: () => void;
  recordWaveQueue: (tracks: Track[], sourceKey?: string) => void;
  recordPlaybackStart: (track: Track | null | undefined, opts?: PlaybackStartInput) => void;
  recordPlaybackResult: (track: Track | null | undefined, opts: PlaybackResultInput) => void;
  recordTrackLiked: (track: Track | null | undefined, liked: boolean) => void;
  recordTrackAddedToPlaylistUrns: (urns: string[]) => void;
  recordTrackDisliked: (track: Track | null | undefined) => void;
  clearTrackBlock: (urn: string) => void;
  resetProfile: () => void;
  recordMoodPreference: (
    track: Track | null | undefined,
    mood: 'energetic' | 'happy' | 'calm' | 'sad',
  ) => void;
};

const STORAGE_KEY = 'sc-soundwave-profile-v1';
const MAX_TRACK_PROFILES = 1600;
const MAX_RECENT_EXPOSURES = 240;
const MAX_SESSION_HISTORY = 40;
const QUICK_SKIP_SECS = 10;
const QUICK_SKIP_RATIO = 0.12;
const NEAR_FULL_RATIO = 0.75;
const FULL_LISTEN_RATIO = 0.92;
const REPLAY_WINDOW_MS = 1000 * 60 * 60 * 6;
const RECENT_REPEAT_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;
const QUICK_SKIP_BLOCK_MS = 1000 * 60 * 60 * 24 * 30;
const EXPLICIT_BLOCK_MS = 1000 * 60 * 60 * 24 * 180;
const MAX_TRACK_INTEREST = 180;
const MIN_TRACK_INTEREST = -220;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function nowTs() {
  return Date.now();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTagList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/["']/g, ' ')
    .split(/[\s,;#/]+/g)
    .map(normalizeText)
    .filter((value) => value.length >= 3);
}

function extractGenreKeys(track: Track): string[] {
  return [...new Set([normalizeText(track.genre ?? ''), ...splitTagList(track.tag_list)])].filter(
    Boolean,
  );
}

function createEntityProfile(): WaveEntityProfile {
  return {
    affinity: 0,
    positive: 0,
    negative: 0,
    likes: 0,
    playlistAdds: 0,
    fullListens: 0,
    quickSkips: 0,
    lastPositiveAt: 0,
    lastNegativeAt: 0,
    waveAppearances: 0,
  };
}

function createTrackProfile(
  track: Track | null,
  workIdentity: WorkIdentity | null,
  genreKeys: string[],
): WaveTrackProfile {
  return {
    snapshot: track ? { ...track } : null,
    workIdentity,
    genreKeys,
    sourceKeys: [],
    totalStarts: 0,
    waveStarts: 0,
    waveAppearances: 0,
    fullListens: 0,
    nearFullListens: 0,
    quickSkips: 0,
    midSkips: 0,
    replays: 0,
    likes: 0,
    playlistAdds: 0,
    explicitDislikes: 0,
    confirmedRejects: 0,
    interestScore: 0,
    blockedUntil: 0,
    lastStartedAt: 0,
    lastPlayedAt: 0,
    lastCompletedAt: 0,
    lastSkippedAt: 0,
    lastRecommendedAt: 0,
    lastInteractionAt: 0,
  };
}

function cloneTrackProfile(profile: WaveTrackProfile): WaveTrackProfile {
  return {
    ...profile,
    snapshot: profile.snapshot ? { ...profile.snapshot, user: { ...profile.snapshot.user } } : null,
    workIdentity: profile.workIdentity
      ? { ...profile.workIdentity, artists: [...profile.workIdentity.artists] }
      : null,
    genreKeys: [...profile.genreKeys],
    sourceKeys: [...profile.sourceKeys],
  };
}

function dedupeStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean);
}

function resolveTrackDurationSeconds(track: Track | null | undefined, durationSeconds?: number) {
  if (Number.isFinite(durationSeconds) && (durationSeconds ?? 0) > 0) {
    return Number(durationSeconds);
  }
  if (track?.duration && track.duration > 0) return track.duration / 1000;
  return 0;
}

function computeListenRatio(playedSeconds: number, durationSeconds: number, naturalEnd: boolean) {
  if (naturalEnd) return 1;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return clamp(playedSeconds / durationSeconds, 0, 1.2);
}

function recomputeInterestScore(profile: WaveTrackProfile) {
  const positive =
    profile.fullListens * 4.8 +
    profile.nearFullListens * 2.6 +
    profile.replays * 5.4 +
    profile.likes * 9 +
    profile.playlistAdds * 10.5;
  const negative =
    profile.quickSkips * 9.5 +
    profile.midSkips * 3.2 +
    profile.explicitDislikes * 18 +
    profile.confirmedRejects * 14;
  const appearancePenalty = Math.max(0, profile.waveAppearances - 3) * 1.4;

  profile.interestScore = clamp(
    positive - negative - appearancePenalty,
    MIN_TRACK_INTEREST,
    MAX_TRACK_INTEREST,
  );
}

function adjustEntity(
  map: Record<string, WaveEntityProfile>,
  keys: string[],
  delta: {
    affinity?: number;
    positive?: number;
    negative?: number;
    likes?: number;
    playlistAdds?: number;
    fullListens?: number;
    quickSkips?: number;
    waveAppearances?: number;
  },
  timestamp: number,
) {
  for (const key of dedupeStrings(keys)) {
    const current = map[key] ? { ...map[key] } : createEntityProfile();
    current.affinity = clamp(current.affinity + (delta.affinity ?? 0), -140, 140);
    current.positive += delta.positive ?? 0;
    current.negative += delta.negative ?? 0;
    current.likes += delta.likes ?? 0;
    current.playlistAdds += delta.playlistAdds ?? 0;
    current.fullListens += delta.fullListens ?? 0;
    current.quickSkips += delta.quickSkips ?? 0;
    current.waveAppearances += delta.waveAppearances ?? 0;
    if ((delta.affinity ?? 0) > 0 || (delta.positive ?? 0) > 0) current.lastPositiveAt = timestamp;
    if ((delta.affinity ?? 0) < 0 || (delta.negative ?? 0) > 0) current.lastNegativeAt = timestamp;
    map[key] = current;
  }
}

function ensureTrackProfile(
  state: Pick<SoundWaveProfileState, 'trackProfiles'>,
  track: Track | null | undefined,
) {
  const urn = track?.urn ?? '';
  if (!urn) return null;

  const current = state.trackProfiles[urn];
  const workIdentity = track ? describeTrackWork(track) : (current?.workIdentity ?? null);
  const genreKeys = track ? extractGenreKeys(track) : (current?.genreKeys ?? []);

  if (current) {
    const next = cloneTrackProfile(current);
    if (track) {
      next.snapshot = { ...track, user: { ...track.user } };
      next.workIdentity = workIdentity;
      next.genreKeys = dedupeStrings([...next.genreKeys, ...genreKeys]);
    }
    state.trackProfiles[urn] = next;
    return next;
  }

  const created = createTrackProfile(
    track ? { ...track, user: { ...track.user } } : null,
    workIdentity,
    genreKeys,
  );
  state.trackProfiles[urn] = created;
  return created;
}

function ensureTrackProfileByUrn(state: Pick<SoundWaveProfileState, 'trackProfiles'>, urn: string) {
  if (!urn) return null;
  const current = state.trackProfiles[urn];
  if (current) {
    const next = cloneTrackProfile(current);
    state.trackProfiles[urn] = next;
    return next;
  }
  const created = createTrackProfile(null, null, []);
  state.trackProfiles[urn] = created;
  return created;
}

function pruneState(state: SoundWaveProfileState) {
  state.recentWaveExposure = state.recentWaveExposure
    .slice(-MAX_RECENT_EXPOSURES)
    .filter((_, index, all) => index >= Math.max(0, all.length - MAX_RECENT_EXPOSURES));

  state.sessionHistory = state.sessionHistory.slice(-MAX_SESSION_HISTORY);

  const entries = Object.entries(state.trackProfiles);
  if (entries.length <= MAX_TRACK_PROFILES) return state;

  entries.sort(([, a], [, b]) => {
    const scoreA = a.interestScore + Math.min(60, (a.lastInteractionAt || 0) / 10_000_000);
    const scoreB = b.interestScore + Math.min(60, (b.lastInteractionAt || 0) / 10_000_000);
    return scoreB - scoreA;
  });

  state.trackProfiles = Object.fromEntries(entries.slice(0, MAX_TRACK_PROFILES));
  return state;
}

function createSession(meta?: {
  presetKey?: string | null;
  launchSource?: string | null;
  seedTracks?: Track[];
}): WaveSessionSummary {
  const timestamp = nowTs();
  return {
    id: `wave-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: timestamp,
    lastEventAt: timestamp,
    presetKey: meta?.presetKey ?? null,
    launchSource: meta?.launchSource ?? null,
    seedUrns: dedupeStrings((meta?.seedTracks ?? []).map((track) => track.urn)).slice(0, 12),
    plays: 0,
    skips: 0,
    likes: 0,
    playlistAdds: 0,
    discoveries: 0,
  };
}

function touchSession(
  state: Pick<SoundWaveProfileState, 'sessionHistory' | 'activeSessionId'>,
  update: (session: WaveSessionSummary) => void,
) {
  if (!state.activeSessionId) return;
  const index = state.sessionHistory.findIndex((session) => session.id === state.activeSessionId);
  if (index < 0) return;
  const next = { ...state.sessionHistory[index] };
  update(next);
  next.lastEventAt = nowTs();
  state.sessionHistory[index] = next;
}

function getArtistAffinity(state: SoundWaveProfileState, workIdentity: WorkIdentity | null) {
  const keys = workIdentity?.artists ?? [];
  if (keys.length === 0) return 0;
  const total = keys.reduce((sum, key) => sum + (state.artistProfiles[key]?.affinity ?? 0), 0);
  return total / keys.length;
}

function getGenreAffinity(state: SoundWaveProfileState, genreKeys: string[]) {
  if (genreKeys.length === 0) return 0;
  const total = genreKeys.reduce((sum, key) => sum + (state.genreProfiles[key]?.affinity ?? 0), 0);
  return total / genreKeys.length;
}

function getRecentArtistPenalty(state: SoundWaveProfileState, artistKeys: string[]) {
  if (artistKeys.length === 0) return 0;
  const recent = state.recentWaveExposure.slice(-10);
  let hits = 0;
  for (const entry of recent) {
    if (artistKeys.some((artistKey) => entry.artistKeys.includes(artistKey))) hits += 1;
  }
  return hits * 2.8;
}

function getRecentWorkPenalty(state: SoundWaveProfileState, workKey: string) {
  if (!workKey) return 0;
  const recent = state.recentWaveExposure.slice(-18);
  const hits = recent.filter((entry) => entry.workKey === workKey).length;
  return hits * 8;
}

function getTrackRepeatPenalty(profile: WaveTrackProfile | null, timestamp: number) {
  if (!profile) return 0;
  if (profile.blockedUntil > timestamp) return 10_000;

  const sincePlayed =
    profile.lastPlayedAt > 0 ? timestamp - profile.lastPlayedAt : Number.POSITIVE_INFINITY;
  if (sincePlayed < 1000 * 60 * 30) return 26;
  if (sincePlayed < 1000 * 60 * 60 * 6) return 18;
  if (sincePlayed < RECENT_REPEAT_WINDOW_MS) return 9;

  const smartRepeatPenalty =
    profile.interestScore >= 24 ? Math.max(0, 6 - profile.fullListens * 0.4) : 10;
  return smartRepeatPenalty + Math.max(0, profile.waveAppearances - 2) * 1.8;
}

function computeExplorationBoost(
  profile: WaveTrackProfile | null,
  artistAffinity: number,
  genreAffinity: number,
  mode: WaveMode,
) {
  if (!profile) {
    return mode === 'diverse' ? 20 : 14;
  }

  let boost = 0;
  if (profile.waveAppearances <= 1) boost += 7;
  if (profile.totalStarts === 0) boost += 8;
  if (profile.interestScore < 8 && (artistAffinity > 8 || genreAffinity > 6)) boost += 4;
  if (mode === 'diverse') boost += 4;
  return boost;
}

function computeCandidateScores(state: SoundWaveProfileState, track: Track, mode: WaveMode) {
  const timestamp = nowTs();
  const workIdentity = describeTrackWork(track);
  const genreKeys = extractGenreKeys(track);
  const profile = state.trackProfiles[track.urn] ?? null;
  const trackInterest = profile?.interestScore ?? 0;
  const artistAffinity = getArtistAffinity(state, workIdentity);
  const genreAffinity = getGenreAffinity(state, genreKeys);
  const sourceAffinity =
    (profile?.sourceKeys ?? []).reduce(
      (sum, key) => sum + (state.sourceProfiles[key]?.affinity ?? 0),
      0,
    ) / Math.max(1, profile?.sourceKeys.length ?? 0);
  const repeatPenalty = getTrackRepeatPenalty(profile, timestamp);
  const recentArtistPenalty = getRecentArtistPenalty(state, workIdentity.artists);
  const recentWorkPenalty = getRecentWorkPenalty(state, workIdentity.workKey);
  const explorationBoost = computeExplorationBoost(profile, artistAffinity, genreAffinity, mode);
  const exploitScore =
    trackInterest * 1.1 + artistAffinity * 0.9 + genreAffinity * 0.75 + sourceAffinity * 0.35;
  const exploreScore =
    explorationBoost +
    Math.max(0, artistAffinity) * 0.35 +
    Math.max(0, genreAffinity) * 0.25 -
    repeatPenalty * 0.25;
  const candidateScore =
    exploitScore +
    explorationBoost * 0.45 -
    repeatPenalty -
    recentArtistPenalty -
    recentWorkPenalty;

  return {
    track,
    candidateScore,
    exploitScore,
    exploreScore,
    blocked: repeatPenalty >= 10_000,
  };
}

function sanitizeRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function createEmptyProfileSnapshot() {
  return {
    trackProfiles: {},
    artistProfiles: {},
    genreProfiles: {},
    sourceProfiles: {},
    recentWaveExposure: [],
    sessionHistory: [],
    activeSessionId: null,
  } satisfies Pick<
    SoundWaveProfileState,
    | 'trackProfiles'
    | 'artistProfiles'
    | 'genreProfiles'
    | 'sourceProfiles'
    | 'recentWaveExposure'
    | 'sessionHistory'
    | 'activeSessionId'
  >;
}

export const useSoundWaveProfileStore = create<SoundWaveProfileState>()(
  persist(
    (set) => ({
      ...createEmptyProfileSnapshot(),

      startSession: (meta) =>
        set((state) => {
          const session = createSession(meta);
          return {
            ...state,
            activeSessionId: session.id,
            sessionHistory: [...state.sessionHistory, session].slice(-MAX_SESSION_HISTORY),
          };
        }),

      finishSession: () => set({ activeSessionId: null }),

      recordWaveQueue: (tracks, sourceKey = 'wave') =>
        set((state) => {
          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const timestamp = nowTs();

          for (const track of tracks) {
            if (!track?.urn) continue;
            const profile = ensureTrackProfile(next, track);
            if (!profile || !profile.workIdentity) continue;

            profile.waveAppearances += 1;
            profile.lastRecommendedAt = timestamp;
            profile.lastInteractionAt = timestamp;
            if (!profile.sourceKeys.includes(sourceKey)) {
              profile.sourceKeys.push(sourceKey);
            }

            next.recentWaveExposure.push({
              urn: track.urn,
              workKey: profile.workIdentity.workKey,
              artistKeys: [...profile.workIdentity.artists],
              sourceKey,
              at: timestamp,
            });

            adjustEntity(
              next.artistProfiles,
              profile.workIdentity.artists,
              { waveAppearances: 1 },
              timestamp,
            );
            adjustEntity(next.genreProfiles, profile.genreKeys, { waveAppearances: 1 }, timestamp);
            adjustEntity(next.sourceProfiles, [sourceKey], { waveAppearances: 1 }, timestamp);
          }

          touchSession(next, (session) => {
            session.discoveries += tracks.length;
          });

          return pruneState(next);
        }),

      recordPlaybackStart: (track, opts) =>
        set((state) => {
          if (!track?.urn) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const profile = ensureTrackProfile(next, track);
          if (!profile) return state;

          const timestamp = nowTs();
          if (
            profile.lastCompletedAt > 0 &&
            timestamp - profile.lastCompletedAt < REPLAY_WINDOW_MS
          ) {
            profile.replays += 1;
          }

          profile.totalStarts += 1;
          if (opts?.fromWave) profile.waveStarts += 1;
          profile.lastStartedAt = timestamp;
          profile.lastInteractionAt = timestamp;
          recomputeInterestScore(profile);

          if (opts?.fromWave && !next.activeSessionId) {
            const session = createSession({ launchSource: 'auto-resume', seedTracks: [track] });
            next.activeSessionId = session.id;
            next.sessionHistory.push(session);
          }

          touchSession(next, () => {});
          return pruneState(next);
        }),

      recordPlaybackResult: (track, opts) =>
        set((state) => {
          if (!track?.urn) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const profile = ensureTrackProfile(next, track);
          if (!profile) return state;

          const timestamp = nowTs();
          const durationSeconds = resolveTrackDurationSeconds(track, opts.durationSeconds);
          const playedSeconds = Math.max(0, opts.playedSeconds || 0);
          const ratio = computeListenRatio(
            playedSeconds,
            durationSeconds,
            Boolean(opts.naturalEnd),
          );
          const quickSkipThreshold = Math.max(QUICK_SKIP_SECS, durationSeconds * QUICK_SKIP_RATIO);

          profile.lastPlayedAt = timestamp;
          profile.lastInteractionAt = timestamp;

          if (ratio >= FULL_LISTEN_RATIO || opts.naturalEnd) {
            profile.fullListens += 1;
            profile.lastCompletedAt = timestamp;
            adjustEntity(
              next.artistProfiles,
              profile.workIdentity?.artists ?? [],
              { affinity: 4.8, positive: 1, fullListens: 1 },
              timestamp,
            );
            adjustEntity(
              next.genreProfiles,
              profile.genreKeys,
              { affinity: 2.6, positive: 1, fullListens: 1 },
              timestamp,
            );
            adjustEntity(
              next.sourceProfiles,
              profile.sourceKeys,
              { affinity: opts.fromWave ? 2.2 : 1.2, positive: opts.fromWave ? 1 : 0 },
              timestamp,
            );
            touchSession(next, (session) => {
              session.plays += 1;
            });
          } else if (ratio >= NEAR_FULL_RATIO) {
            profile.nearFullListens += 1;
            adjustEntity(
              next.artistProfiles,
              profile.workIdentity?.artists ?? [],
              { affinity: 2.8, positive: 1 },
              timestamp,
            );
            adjustEntity(
              next.genreProfiles,
              profile.genreKeys,
              { affinity: 1.8, positive: 1 },
              timestamp,
            );
            adjustEntity(
              next.sourceProfiles,
              profile.sourceKeys,
              { affinity: opts.fromWave ? 1.6 : 0.9 },
              timestamp,
            );
            touchSession(next, (session) => {
              session.plays += 1;
            });
          } else if (playedSeconds <= quickSkipThreshold || ratio <= QUICK_SKIP_RATIO) {
            profile.quickSkips += 1;
            profile.lastSkippedAt = timestamp;
            adjustEntity(
              next.artistProfiles,
              profile.workIdentity?.artists ?? [],
              { affinity: -6.2, negative: 1, quickSkips: 1 },
              timestamp,
            );
            adjustEntity(
              next.genreProfiles,
              profile.genreKeys,
              { affinity: -2.4, negative: 1, quickSkips: 1 },
              timestamp,
            );
            adjustEntity(
              next.sourceProfiles,
              profile.sourceKeys,
              { affinity: opts.fromWave ? -2.6 : -1.2, negative: opts.fromWave ? 1 : 0 },
              timestamp,
            );
            touchSession(next, (session) => {
              session.skips += 1;
            });

            if (profile.quickSkips >= 2 && profile.waveAppearances >= 2) {
              profile.confirmedRejects += 1;
              profile.blockedUntil = Math.max(
                profile.blockedUntil,
                timestamp + QUICK_SKIP_BLOCK_MS,
              );
            }
          } else {
            profile.midSkips += 1;
            profile.lastSkippedAt = timestamp;
            adjustEntity(
              next.artistProfiles,
              profile.workIdentity?.artists ?? [],
              { affinity: -1.8, negative: 1 },
              timestamp,
            );
            adjustEntity(
              next.genreProfiles,
              profile.genreKeys,
              { affinity: -0.9, negative: 1 },
              timestamp,
            );
            adjustEntity(
              next.sourceProfiles,
              profile.sourceKeys,
              { affinity: opts.fromWave ? -0.9 : -0.35 },
              timestamp,
            );
            touchSession(next, (session) => {
              session.skips += 1;
            });
          }

          recomputeInterestScore(profile);
          return pruneState(next);
        }),

      recordTrackLiked: (track, liked) =>
        set((state) => {
          if (!liked || !track?.urn) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const profile = ensureTrackProfile(next, track);
          if (!profile) return state;

          const timestamp = nowTs();
          profile.likes += 1;
          profile.lastInteractionAt = timestamp;
          recomputeInterestScore(profile);

          adjustEntity(
            next.artistProfiles,
            profile.workIdentity?.artists ?? [],
            { affinity: 9, positive: 1, likes: 1 },
            timestamp,
          );
          adjustEntity(
            next.genreProfiles,
            profile.genreKeys,
            { affinity: 4.2, positive: 1, likes: 1 },
            timestamp,
          );
          adjustEntity(
            next.sourceProfiles,
            profile.sourceKeys,
            { affinity: 2.5, likes: 1 },
            timestamp,
          );

          touchSession(next, (session) => {
            session.likes += 1;
          });

          return pruneState(next);
        }),

      recordTrackAddedToPlaylistUrns: (urns) =>
        set((state) => {
          if (urns.length === 0) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const timestamp = nowTs();
          const uniqueUrns = dedupeStrings(urns);

          for (const urn of uniqueUrns) {
            const profile = ensureTrackProfileByUrn(next, urn);
            if (!profile) continue;

            profile.playlistAdds += 1;
            profile.lastInteractionAt = timestamp;
            recomputeInterestScore(profile);

            adjustEntity(
              next.artistProfiles,
              profile.workIdentity?.artists ?? [],
              { affinity: 10.5, positive: 1, playlistAdds: 1 },
              timestamp,
            );
            adjustEntity(
              next.genreProfiles,
              profile.genreKeys,
              { affinity: 5.2, positive: 1, playlistAdds: 1 },
              timestamp,
            );
            adjustEntity(
              next.sourceProfiles,
              profile.sourceKeys,
              { affinity: 2.9, playlistAdds: 1 },
              timestamp,
            );
          }

          touchSession(next, (session) => {
            session.playlistAdds += uniqueUrns.length;
          });

          return pruneState(next);
        }),

      recordTrackDisliked: (track) =>
        set((state) => {
          if (!track?.urn) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const profile = ensureTrackProfile(next, track);
          if (!profile) return state;

          const timestamp = nowTs();
          profile.explicitDislikes += 1;
          profile.blockedUntil = Math.max(profile.blockedUntil, timestamp + EXPLICIT_BLOCK_MS);
          profile.lastSkippedAt = timestamp;
          profile.lastInteractionAt = timestamp;
          recomputeInterestScore(profile);

          adjustEntity(
            next.artistProfiles,
            profile.workIdentity?.artists ?? [],
            { affinity: -12.5, negative: 1 },
            timestamp,
          );
          adjustEntity(
            next.genreProfiles,
            profile.genreKeys,
            { affinity: -4.8, negative: 1 },
            timestamp,
          );
          adjustEntity(
            next.sourceProfiles,
            profile.sourceKeys,
            { affinity: -4.2, negative: 1 },
            timestamp,
          );

          touchSession(next, (session) => {
            session.skips += 1;
          });

          return pruneState(next);
        }),

      clearTrackBlock: (urn) =>
        set((state) => {
          const current = state.trackProfiles[urn];
          if (!current) return state;
          return {
            ...state,
            trackProfiles: {
              ...state.trackProfiles,
              [urn]: {
                ...cloneTrackProfile(current),
                blockedUntil: 0,
              },
            },
          };
        }),

      resetProfile: () => {
        void tauriStorage.removeItem(STORAGE_KEY);
        set(createEmptyProfileSnapshot());
      },

      recordMoodPreference: (track, mood) =>
        set((state) => {
          if (!track?.urn) return state;

          const next: SoundWaveProfileState = {
            ...state,
            trackProfiles: { ...state.trackProfiles },
            artistProfiles: { ...state.artistProfiles },
            genreProfiles: { ...state.genreProfiles },
            sourceProfiles: { ...state.sourceProfiles },
            recentWaveExposure: [...state.recentWaveExposure],
            sessionHistory: [...state.sessionHistory],
          };
          const profile = ensureTrackProfile(next, track);
          if (!profile) return state;

          const timestamp = nowTs();
          const moodBoost =
            mood === 'energetic' || mood === 'happy'
              ? { affinity: 2.2, positive: 1 }
              : { affinity: 1.6, positive: 1 };

          adjustEntity(
            next.artistProfiles,
            profile.workIdentity?.artists ?? [],
            moodBoost,
            timestamp,
          );
          adjustEntity(next.genreProfiles, profile.genreKeys, moodBoost, timestamp);
          profile.lastInteractionAt = timestamp;
          recomputeInterestScore(profile);
          return pruneState(next);
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => tauriStorage),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as Partial<SoundWaveProfileState> | undefined) ?? {};
        return {
          ...currentState,
          ...persisted,
          trackProfiles: sanitizeRecord<WaveTrackProfile>(persisted.trackProfiles),
          artistProfiles: sanitizeRecord<WaveEntityProfile>(persisted.artistProfiles),
          genreProfiles: sanitizeRecord<WaveEntityProfile>(persisted.genreProfiles),
          sourceProfiles: sanitizeRecord<WaveEntityProfile>(persisted.sourceProfiles),
          recentWaveExposure: Array.isArray(persisted.recentWaveExposure)
            ? persisted.recentWaveExposure
            : [],
          sessionHistory: Array.isArray(persisted.sessionHistory) ? persisted.sessionHistory : [],
          activeSessionId:
            typeof persisted.activeSessionId === 'string' || persisted.activeSessionId === null
              ? persisted.activeSessionId
              : null,
        };
      },
    },
  ),
);

export function getWaveTrackInterestScore(track: Track | null | undefined): number {
  if (!track?.urn) return 0;
  return useSoundWaveProfileStore.getState().trackProfiles[track.urn]?.interestScore ?? 0;
}

export function isWaveTrackBlocked(track: Track | null | undefined): boolean {
  if (!track?.urn) return false;
  const profile = useSoundWaveProfileStore.getState().trackProfiles[track.urn];
  return Boolean(profile && profile.blockedUntil > nowTs());
}

export function pickPersonalizedSeedTracks(
  baseSeeds: Track[],
  opts: {
    limit?: number;
    excludeUrns?: Iterable<string>;
  } = {},
): Track[] {
  const state = useSoundWaveProfileStore.getState();
  const limit = Math.max(1, opts.limit ?? 10);
  const excluded = new Set(opts.excludeUrns ?? []);
  const seeds: Track[] = [];
  const seen = new Set<string>();

  const pushTrack = (track: Track | null | undefined) => {
    if (
      !track?.urn ||
      excluded.has(track.urn) ||
      seen.has(track.urn) ||
      isWaveTrackBlocked(track)
    ) {
      return;
    }
    seen.add(track.urn);
    seeds.push(track);
  };

  for (const seed of baseSeeds) pushTrack(seed);

  const rankedProfiles = Object.values(state.trackProfiles)
    .filter((profile) => profile.snapshot?.urn && profile.interestScore >= 12)
    .sort((a, b) => {
      const scoreA = a.interestScore + a.playlistAdds * 4 + a.likes * 3 + a.replays * 2;
      const scoreB = b.interestScore + b.playlistAdds * 4 + b.likes * 3 + b.replays * 2;
      return scoreB - scoreA;
    });

  for (const profile of rankedProfiles) {
    pushTrack(profile.snapshot);
    if (seeds.length >= limit) break;
  }

  return seeds.slice(0, limit);
}

export function rankWaveCandidates(
  tracks: Track[],
  opts: {
    limit?: number;
    mode?: WaveMode;
  } = {},
): Track[] {
  const state = useSoundWaveProfileStore.getState();
  const limit = Math.max(1, opts.limit ?? tracks.length);
  const mode = opts.mode ?? 'similar';

  const scored = tracks
    .filter((track) => !!track?.urn)
    .map((track) => computeCandidateScores(state, track, mode))
    .filter((entry) => !entry.blocked);

  const exploit = [...scored].sort((a, b) => b.exploitScore - a.exploitScore);
  const explore = [...scored].sort((a, b) => b.exploreScore - a.exploreScore);
  const fallback = [...scored].sort((a, b) => b.candidateScore - a.candidateScore);
  const selected: Track[] = [];
  const seen = new Set<string>();
  let exploitQuota = Math.ceil(limit * 0.7);
  let exploreQuota = limit - exploitQuota;

  const takeNext = (list: typeof scored) => {
    while (list.length > 0) {
      const next = list.shift();
      if (!next || seen.has(next.track.urn)) continue;
      seen.add(next.track.urn);
      selected.push(next.track);
      return true;
    }
    return false;
  };

  while (selected.length < limit && (exploit.length > 0 || explore.length > 0)) {
    const canTakeExploit = exploitQuota > 0 && exploit.length > 0;
    const canTakeExplore = exploreQuota > 0 && explore.length > 0;

    if (canTakeExploit) {
      takeNext(exploit);
      exploitQuota -= 1;
      if (selected.length >= limit) break;
    }

    if (canTakeExplore) {
      takeNext(explore);
      exploreQuota -= 1;
    }

    if (!canTakeExploit && !canTakeExplore) break;
  }

  while (selected.length < limit && fallback.length > 0) {
    takeNext(fallback);
  }

  return selected;
}
