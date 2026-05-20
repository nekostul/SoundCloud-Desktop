import { type Track, usePlayerStore } from '../stores/player';
import { detectLanguage } from './language-detection';
import { isUrnLiked } from './likes';
import {
  fetchWaveTailFromSeed,
  hydrateByIds,
  type RecommendResult,
  type SoundWaveMode,
} from './soundwave';

const HOME_WAVE_QUEUE_TARGET = 24;
const HOME_WAVE_BASE_FETCH_LIMIT = 12;
const HOME_WAVE_REFINEMENT_FETCH_LIMIT = 8;
const HOME_WAVE_REFINEMENT_SEED_LIMIT = 4;

const HIGH_ENERGY_TOKENS = new Set([
  'rage',
  'drift',
  'phonk',
  'trap',
  'drill',
  'club',
  'edm',
  'bass',
  'dance',
  'hyperpop',
  'hype',
  'jersey',
]);

const LOW_ENERGY_TOKENS = new Set([
  'ambient',
  'piano',
  'sleep',
  'calm',
  'acoustic',
  'lofi',
  'lo-fi',
  'mellow',
  'soft',
  'instrumental',
  'relax',
  'dream',
]);

const SCENE_CLUSTERS: Record<string, string[]> = {
  cloudrap: ['cloud', 'cloudrap', 'sadtrap', 'emo', 'gloomy'],
  phonk: ['phonk', 'drift', 'memphis', 'cowbell'],
  trap: ['trap', 'drill', 'rage', 'jersey', 'pluggnb'],
  electronic: ['edm', 'techno', 'house', 'trance', 'electro', 'dance'],
  ambient: ['ambient', 'drone', 'sleep', 'meditation', 'atmospheric'],
  indie: ['indie', 'alternative', 'shoegaze', 'dream'],
  pop: ['pop', 'radio', 'mainstream'],
  rap: ['rap', 'hiphop', 'hip-hop', 'boom', 'bap'],
};

type WaveLanguageProfile = {
  primary: string | null;
  confidence: number;
  mixed: boolean;
};

type WaveTrackProfile = {
  id: string;
  artistKey: string | null;
  genreKey: string | null;
  tokenSet: Set<string>;
  sceneSet: Set<string>;
  energy: number;
  bpm: number | null;
  language: WaveLanguageProfile;
};

type RankedWaveTrack = Track & {
  _waveScore: number;
  _waveSafe: number;
  _waveDiscovery: number;
  _waveProfile: WaveTrackProfile;
};

const waveTrackProfileCache = new Map<string, WaveTrackProfile>();

function getTrackId(track: Track | null | undefined): string {
  return String(track?.urn?.split(':').pop() ?? '');
}

function normalizeTrackText(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 80);
}

function buildWaveTrackProfile(track: Track): WaveTrackProfile {
  const cached = waveTrackProfileCache.get(track.urn);
  if (cached) return cached;

  const id = getTrackId(track);
  const tokenSet = new Set(
    normalizeTrackText(
      [
        track.genre || '',
        track.tag_list || '',
        track.title || '',
        track.description || '',
        track.user?.username || '',
      ].join(' '),
    ),
  );
  const sceneSet = new Set<string>();

  for (const [scene, cues] of Object.entries(SCENE_CLUSTERS)) {
    if (cues.some((cue) => tokenSet.has(cue))) {
      sceneSet.add(scene);
    }
  }

  const bpm = typeof track.bpm === 'number' && Number.isFinite(track.bpm) ? track.bpm : null;
  const language = inferWaveTrackLanguage(track, tokenSet);
  const profile: WaveTrackProfile = {
    id,
    artistKey: track.user?.urn?.trim() || track.user?.username?.trim().toLowerCase() || null,
    genreKey: track.genre?.trim().toLowerCase() || null,
    tokenSet,
    sceneSet,
    bpm,
    energy: estimateTrackEnergy(tokenSet, bpm),
    language,
  };

  waveTrackProfileCache.set(track.urn, profile);
  return profile;
}

function inferWaveTrackLanguage(track: Track, tokenSet: Set<string>): WaveLanguageProfile {
  const rawText = [
    track.title || '',
    track.genre || '',
    track.tag_list || '',
    track.description || '',
    track.user?.username || '',
  ].join(' ');

  const normalized = rawText.toLowerCase();
  const detected = detectLanguage(rawText);
  const cyrillicCount = rawText.match(/[\u0400-\u04FF]/g)?.length ?? 0;
  const latinCount = rawText.match(/[A-Za-z\u00C0-\u024F]/g)?.length ?? 0;
  const ukrainianCount = rawText.match(/[іїєґІЇЄҐ]/g)?.length ?? 0;
  const kazakhCount = rawText.match(/[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/g)?.length ?? 0;
  const japaneseCount = rawText.match(/[\u3040-\u30FF]/g)?.length ?? 0;
  const koreanCount = rawText.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g)?.length ?? 0;
  const chineseCount = rawText.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g)?.length ?? 0;

  const primary = detected || null;
  let confidence = 0.48;
  let mixed = false;

  if (primary === 'ru') {
    confidence = cyrillicCount > 0 ? 0.82 : 0.52;
    if (ukrainianCount > 0 || kazakhCount > 0) mixed = true;
  } else if (primary === 'uk') {
    confidence = ukrainianCount > 0 ? 0.88 : 0.54;
    mixed = cyrillicCount > ukrainianCount + 10;
  } else if (primary === 'kk') {
    confidence = kazakhCount > 0 ? 0.9 : 0.5;
    mixed = cyrillicCount > kazakhCount + 10;
  } else if (primary === 'ja') {
    confidence = japaneseCount > 0 ? 0.9 : 0.56;
    mixed = chineseCount > 0;
  } else if (primary === 'ko') {
    confidence = koreanCount > 0 ? 0.9 : 0.56;
  } else if (primary === 'zh') {
    confidence = chineseCount > 0 ? 0.88 : 0.56;
    mixed = japaneseCount > 0;
  } else if (primary === 'en') {
    confidence = latinCount > 0 ? 0.66 : 0.4;
    const hasStrongOtherLanguage =
      cyrillicCount > 0 || japaneseCount > 0 || koreanCount > 0 || chineseCount > 0;
    mixed = hasStrongOtherLanguage;
  } else {
    confidence = rawText.trim().length >= 8 ? 0.58 : 0.38;
  }

  if (
    primary === 'en' &&
    !mixed &&
    tokenSet.size > 0 &&
    ['ru', 'uk', 'kk'].some((code) => normalized.includes(` ${code} `))
  ) {
    mixed = true;
  }

  return {
    primary,
    confidence,
    mixed,
  };
}

function estimateTrackEnergy(tokens: Set<string>, bpm: number | null): number {
  let energy = 0.48;

  if (bpm) {
    energy += Math.max(-0.12, Math.min(0.26, (bpm - 105) / 180));
  }

  let highHits = 0;
  let lowHits = 0;

  for (const token of tokens) {
    if (HIGH_ENERGY_TOKENS.has(token)) highHits += 1;
    if (LOW_ENERGY_TOKENS.has(token)) lowHits += 1;
  }

  energy += Math.min(0.28, highHits * 0.06);
  energy -= Math.min(0.28, lowHits * 0.06);

  return Math.max(0.06, Math.min(1, energy));
}

function computeSetOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }

  return overlap / Math.max(Math.min(a.size, b.size), 1);
}

function computeProfileSimilarity(a: WaveTrackProfile, b: WaveTrackProfile): number {
  const genreMatch = a.genreKey && b.genreKey && a.genreKey === b.genreKey ? 0.24 : 0;
  const artistMatch = a.artistKey && b.artistKey && a.artistKey === b.artistKey ? 0.1 : 0;
  const tokenOverlap = computeSetOverlap(a.tokenSet, b.tokenSet) * 0.34;
  const sceneOverlap = computeSetOverlap(a.sceneSet, b.sceneSet) * 0.22;
  const energySimilarity = (1 - Math.min(1, Math.abs(a.energy - b.energy))) * 0.2;
  const bpmSimilarity =
    a.bpm && b.bpm ? (1 - Math.min(1, Math.abs(a.bpm - b.bpm) / 48)) * 0.1 : 0;
  const languageSimilarity =
    a.language.primary && b.language.primary && a.language.primary === b.language.primary ? 0.08 : 0;

  return Math.max(
    0,
    Math.min(
      1.25,
      genreMatch + artistMatch + tokenOverlap + sceneOverlap + energySimilarity + bpmSimilarity + languageSimilarity,
    ),
  );
}

function computeWeightedSeedSimilarity(
  profile: WaveTrackProfile,
  seeds: WaveTrackProfile[],
  weights: number[],
): number {
  if (seeds.length === 0) return 0;

  let best = 0;
  let weightedSum = 0;
  let totalWeight = 0;

  seeds.forEach((seed, index) => {
    const weight = weights[index] ?? Math.max(0.5, 1 - index * 0.12);
    const similarity = computeProfileSimilarity(profile, seed);
    best = Math.max(best, similarity * Math.min(weight, 1.45));
    weightedSum += similarity * weight;
    totalWeight += weight;
  });

  const average = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return Math.max(best * 0.9, average);
}

function evaluateWaveLanguage(
  profile: WaveLanguageProfile,
  selectedLanguages: string[],
): { allowed: boolean; score: number } {
  if (selectedLanguages.length === 0) {
    return {
      allowed: true,
      score: profile.primary && profile.confidence >= 0.45 ? 0.94 + profile.confidence * 0.08 : 0.72,
    };
  }

  if (selectedLanguages.length === 1) {
    const target = selectedLanguages[0];
    if (profile.primary !== target) return { allowed: false, score: 0 };
    if (profile.confidence < 0.46) return { allowed: false, score: 0 };
    if (profile.mixed && profile.confidence < 0.78) return { allowed: false, score: 0 };
    return { allowed: true, score: 1.16 + Math.min(profile.confidence, 1) * 0.16 };
  }

  if (profile.primary && selectedLanguages.includes(profile.primary) && profile.confidence >= 0.4) {
    return { allowed: true, score: 1.02 + Math.min(profile.confidence, 1) * 0.12 };
  }

  return { allowed: false, score: 0 };
}

function computeDiscoveryScore(
  profile: WaveTrackProfile,
  seedProfiles: WaveTrackProfile[],
  anchorSimilarity: number,
  seedAffinity: number,
): number {
  const highestSeedSimilarity =
    seedProfiles.length > 0
      ? Math.max(...seedProfiles.map((seed) => computeProfileSimilarity(profile, seed)))
      : 0;
  const familiar = Math.max(anchorSimilarity, seedAffinity, highestSeedSimilarity);
  const sceneNovelty = profile.sceneSet.size > 0 ? 0.12 : 0;
  return Math.max(0, Math.min(1.05, (1 - Math.min(familiar, 1)) * 0.72 + sceneNovelty + 0.2));
}

function pickRefinementSeeds(tracks: Track[], mode: SoundWaveMode): Track[] {
  const pool = dedupeTracksByUrn(tracks).slice(
    0,
    mode === 'diverse' ? HOME_WAVE_REFINEMENT_SEED_LIMIT + 1 : HOME_WAVE_REFINEMENT_SEED_LIMIT,
  );

  if (mode === 'diverse' || pool.length <= 2) {
    return pool.slice(0, HOME_WAVE_REFINEMENT_SEED_LIMIT);
  }

  return [pool[0], ...pool.slice(Math.max(1, pool.length - 2))].slice(
    0,
    HOME_WAVE_REFINEMENT_SEED_LIMIT,
  );
}

function mergeRecommendations(
  target: Map<string, { rec: RecommendResult; score: number; hits: number }>,
  recs: RecommendResult[],
  sourceBoost: number,
  anchorWeight: number,
) {
  recs.forEach((rec, index) => {
    const id = String(rec.id ?? '');
    if (!id) return;

    const rankScore = Math.max(0, sourceBoost - index * 0.26);
    const recommendationScore = Math.max(0, Number(rec.score || 0)) * 1.42;
    const current = target.get(id);
    const nextScore =
      rankScore * anchorWeight +
      recommendationScore * anchorWeight +
      (current ? 1.8 : 0);

    target.set(id, {
      rec,
      hits: (current?.hits ?? 0) + 1,
      score: (current?.score ?? 0) + nextScore,
    });
  });
}

function filterPlayableTracks(tracks: Track[], hideLiked: boolean): Track[] {
  return tracks.filter((track) => {
    if (!track?.urn || track.access === 'blocked') return false;
    if (!hideLiked) return true;
    return !track.user_favorite && !isUrnLiked(track.urn);
  });
}

function buildRankedWaveTracks(
  tracks: Track[],
  candidateScores: Map<string, { rec: RecommendResult; score: number; hits: number }>,
  seedProfiles: WaveTrackProfile[],
  recentProfiles: WaveTrackProfile[],
  selectedLanguages: string[],
  mode: SoundWaveMode,
): RankedWaveTrack[] {
  return tracks
    .map((track) => {
      const id = getTrackId(track);
      const candidate = candidateScores.get(id);
      if (!candidate) return null;

      const profile = buildWaveTrackProfile(track);
      const languageFit = evaluateWaveLanguage(profile.language, selectedLanguages);
      if (!languageFit.allowed) return null;

      const anchorSimilarity = computeWeightedSeedSimilarity(
        profile,
        recentProfiles.length > 0 ? recentProfiles : seedProfiles,
        [1.45, 1.14, 0.88, 0.72],
      );
      const seedAffinity = computeWeightedSeedSimilarity(profile, seedProfiles, [1.3, 1.08, 0.86, 0.72]);
      const continuity = computeWeightedSeedSimilarity(
        profile,
        recentProfiles.length > 0 ? recentProfiles : seedProfiles,
        [1.62, 1.16, 0.82],
      );
      const discovery = computeDiscoveryScore(profile, seedProfiles, anchorSimilarity, seedAffinity);
      const mixedPenalty = profile.language.mixed ? 0.75 : 0;
      const unknownPenalty = profile.language.primary ? 0 : 0.65;

      const safeScore =
        anchorSimilarity * 0.42 + continuity * 0.26 + seedAffinity * 0.22 + languageFit.score * 0.1;

      const totalScore =
        candidate.score * 2.55 +
        anchorSimilarity * 4.9 +
        continuity * 3.9 +
        seedAffinity * 3.1 +
        languageFit.score * 2.25 +
        discovery * (mode === 'diverse' ? 1.15 : 0.42) -
        mixedPenalty -
        unknownPenalty;

      return {
        ...track,
        _waveDiscovery: discovery,
        _waveProfile: profile,
        _waveSafe: safeScore,
        _waveScore: totalScore,
      } as RankedWaveTrack;
    })
    .filter((track): track is RankedWaveTrack => Boolean(track))
    .sort((a, b) => b._waveScore - a._waveScore);
}

function orderTracksForContinuity(
  tracks: RankedWaveTrack[],
  anchors: WaveTrackProfile[],
  mode: SoundWaveMode,
  limit: number,
): RankedWaveTrack[] {
  const remaining = [...tracks];
  const recentAnchors = [...anchors].slice(0, 3);
  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  const ordered: RankedWaveTrack[] = [];

  while (remaining.length > 0 && ordered.length < limit) {
    const explorationTurn =
      mode === 'diverse' ? ordered.length > 0 && ordered.length % 3 === 2 : ordered.length > 0 && ordered.length % 5 === 4;

    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const scanLimit = Math.min(remaining.length, 28);

    for (let index = 0; index < scanLimit; index += 1) {
      const track = remaining[index];
      const profile = track._waveProfile;
      const continuity = computeWeightedSeedSimilarity(profile, recentAnchors, [1.65, 1.18, 0.82]);
      const lastAnchor = recentAnchors[recentAnchors.length - 1];
      const sameArtistAsLast =
        Boolean(profile.artistKey && lastAnchor?.artistKey && profile.artistKey === lastAnchor.artistKey);
      const artistPenalty = profile.artistKey ? (artistCounts.get(profile.artistKey) ?? 0) * 1.2 : 0;
      const genrePenalty = profile.genreKey ? (genreCounts.get(profile.genreKey) ?? 0) * 0.68 : 0;
      const energyJumpPenalty = lastAnchor
        ? Math.max(0, Math.abs(profile.energy - lastAnchor.energy) - 0.28) * 3.2
        : 0;
      const repeatPenalty = sameArtistAsLast ? (mode === 'diverse' ? 3.2 : 2.1) : 0;
      const rankPenalty = index * 0.04;

      const safeScore =
        track._waveScore +
        continuity * 2.35 +
        track._waveSafe * 1.28 -
        artistPenalty -
        genrePenalty -
        energyJumpPenalty -
        repeatPenalty -
        rankPenalty;

      const discoveryScore =
        track._waveScore * 0.78 +
        continuity * 1.25 +
        track._waveDiscovery * 3.05 -
        artistPenalty * 0.82 -
        genrePenalty * 0.62 -
        energyJumpPenalty * 0.72 -
        repeatPenalty * 0.78 -
        rankPenalty;

      const effectiveScore =
        explorationTurn && track._waveSafe >= 0.42 ? discoveryScore : safeScore;

      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestIndex = index;
      }
    }

    const [selected] = remaining.splice(bestIndex, 1);
    ordered.push(selected);
    recentAnchors.push(selected._waveProfile);
    if (recentAnchors.length > 3) recentAnchors.shift();

    if (selected._waveProfile.artistKey) {
      artistCounts.set(
        selected._waveProfile.artistKey,
        (artistCounts.get(selected._waveProfile.artistKey) ?? 0) + 1,
      );
    }

    if (selected._waveProfile.genreKey) {
      genreCounts.set(
        selected._waveProfile.genreKey,
        (genreCounts.get(selected._waveProfile.genreKey) ?? 0) + 1,
      );
    }
  }

  return ordered;
}

function buildRecentTracksFromQueue(queueTracks: Track[]): Track[] {
  return dedupeTracksByUrn(queueTracks.filter((track) => !!track?.urn).slice(-3)).reverse();
}

export function dedupeTracksByUrn(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];

  for (const track of tracks) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    unique.push(track);
  }

  return unique;
}

export function createInitialSoundWaveQueue(
  seedTracks: Track[],
  mode: SoundWaveMode,
): Track[] {
  const unique = dedupeTracksByUrn(seedTracks).filter((track) => track.access !== 'blocked');
  if (unique.length === 0) return [];

  const initialCount = mode === 'diverse' ? Math.min(4, unique.length) : Math.min(3, unique.length);
  return unique.slice(0, Math.max(1, initialCount));
}

export async function buildWaveQueueFromSeeds(
  seedTracks: Track[],
  languages: string[],
  mode: SoundWaveMode,
  hideLiked: boolean,
  context?: {
    queueTracks?: Track[];
    recentTracks?: Track[];
    targetSize?: number;
  },
): Promise<Track[]> {
  const anchorTracks = dedupeTracksByUrn([
    ...(context?.recentTracks ?? []),
    ...seedTracks,
  ]).filter((track) => track.access !== 'blocked');
  const primaryAnchors = anchorTracks.slice(0, 4);
  const seedIds = primaryAnchors.map((track) => getTrackId(track)).filter(Boolean).slice(0, 4);
  if (seedIds.length === 0) return [];

  const queueTracks = dedupeTracksByUrn(context?.queueTracks ?? []);
  const existingQueueIds = new Set(queueTracks.map((track) => getTrackId(track)).filter(Boolean));
  const recentTrackIds = primaryAnchors.map((track) => getTrackId(track)).filter(Boolean);
  const seedIdSet = new Set(seedIds);
  const candidateScores = new Map<string, { rec: RecommendResult; score: number; hits: number }>();

  const anchorWeights = [1.52, 1.18, 0.92, 0.74];
  const baseRecommendationGroups = await Promise.all(
    primaryAnchors.map((track, index) =>
      fetchWaveTailFromSeed(getTrackId(track), {
        languages,
        mode,
        limit: HOME_WAVE_BASE_FETCH_LIMIT,
        excludeTrackIds: [...existingQueueIds, ...seedIds],
        recentTrackIds,
      }).then((recs) => ({ recs, index })),
    ),
  );

  baseRecommendationGroups.forEach(({ recs, index }) => {
    mergeRecommendations(
      candidateScores,
      recs.filter((rec) => !seedIdSet.has(String(rec.id ?? ''))),
      mode === 'diverse' ? 5.6 : 7.1,
      anchorWeights[index] ?? 0.7,
    );
  });

  const baseHydrated = await hydrateByIds(
    Array.from(candidateScores.values())
      .sort((a, b) => b.score - a.score)
      .map(({ rec }) => rec)
      .slice(0, 54),
  );

  const baseFiltered = dedupeTracksByUrn(
    filterPlayableTracks(baseHydrated, hideLiked).filter((track) => {
      const id = getTrackId(track);
      return Boolean(id) && !seedIdSet.has(id) && !existingQueueIds.has(id);
    }),
  );

  const refinementSeeds = pickRefinementSeeds(baseFiltered, mode);
  if (refinementSeeds.length > 0) {
    const refinementGroups = await Promise.all(
      refinementSeeds.map((track, index) =>
        fetchWaveTailFromSeed(getTrackId(track), {
          languages,
          mode,
          limit: HOME_WAVE_REFINEMENT_FETCH_LIMIT,
          excludeTrackIds: [...existingQueueIds, ...seedIds],
          recentTrackIds,
        }).then((recs) => ({ recs, index })),
      ),
    );

    refinementGroups.forEach(({ recs, index }) => {
      mergeRecommendations(
        candidateScores,
        recs.filter((rec) => !seedIdSet.has(String(rec.id ?? ''))),
        mode === 'diverse' ? 6.2 : 8.8,
        0.96 - index * 0.1,
      );
    });
  }

  const scoredHydrated = await hydrateByIds(
    Array.from(candidateScores.values())
      .sort((a, b) => b.score - a.score)
      .map(({ rec }) => rec)
      .slice(0, 72),
  );

  const filtered = dedupeTracksByUrn(
    filterPlayableTracks(scoredHydrated, hideLiked).filter((track) => {
      const id = getTrackId(track);
      return Boolean(id) && !seedIdSet.has(id) && !existingQueueIds.has(id);
    }),
  );

  if (filtered.length === 0) return [];

  const seedProfiles = primaryAnchors.map((track) => buildWaveTrackProfile(track));
  const recentProfiles = buildRecentTracksFromQueue(context?.recentTracks ?? primaryAnchors).map((track) =>
    buildWaveTrackProfile(track),
  );
  const ranked = buildRankedWaveTracks(filtered, candidateScores, seedProfiles, recentProfiles, languages, mode);
  if (ranked.length === 0) return [];

  const ordered = orderTracksForContinuity(
    ranked,
    recentProfiles.length > 0 ? recentProfiles : seedProfiles,
    mode,
    context?.targetSize ?? HOME_WAVE_QUEUE_TARGET,
  );

  return ordered.map((track) => track as Track);
}

export async function buildWaveQueueFromPlayerContext(opts: {
  languages: string[];
  mode: SoundWaveMode;
  hideLiked: boolean;
  targetSize?: number;
}): Promise<Track[]> {
  const { currentTrack, queue, queueIndex } = usePlayerStore.getState();
  if (!currentTrack) return [];

  const recentTracks: Track[] = [];
  if (queueIndex >= 0) {
    const startIndex = Math.max(0, queueIndex - 2);
    for (let index = queueIndex; index >= startIndex; index -= 1) {
      const track = queue[index];
      if (track?.urn) {
        recentTracks.push(track);
      }
    }
  }

  const contextRecentTracks = dedupeTracksByUrn([currentTrack, ...recentTracks]);

  return buildWaveQueueFromSeeds(contextRecentTracks, opts.languages, opts.mode, opts.hideLiked, {
    queueTracks: queue,
    recentTracks: contextRecentTracks,
    targetSize: opts.targetSize,
  });
}
