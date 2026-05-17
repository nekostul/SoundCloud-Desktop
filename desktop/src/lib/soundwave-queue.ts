import { type Track } from '../stores/player';
import { isUrnLiked } from './likes';
import {
  fetchWaveTailFromSeed,
  hydrateByIds,
  type RecommendResult,
  type SoundWaveMode,
} from './soundwave';

const HOME_WAVE_QUEUE_TARGET = 24;
const HOME_WAVE_BASE_FETCH_LIMIT = 14;
const HOME_WAVE_REFINEMENT_FETCH_LIMIT = 10;
const HOME_WAVE_REFINEMENT_SEED_LIMIT = 4;

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

  return [pool[0], ...pool.slice(Math.max(1, pool.length - 2))].slice(
    0,
    HOME_WAVE_REFINEMENT_SEED_LIMIT,
  );
}

export async function buildWaveQueueFromSeeds(
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
