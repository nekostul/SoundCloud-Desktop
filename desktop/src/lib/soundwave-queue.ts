import { type Track, usePlayerStore } from '../stores/player';
import {
  fetchWaveTailFromSeed,
  hydrateByIds,
  type SoundWaveMode,
  trackIdFromTrack,
} from './soundwave';
import {
  canonicalScore,
  collapseVariations,
  dedupeWaveQueue,
  hasSameWork,
  isSameWork,
  isVariationSuppressed,
} from './soundwave-canonical';
import {
  filterSoundWaveTracks,
  getSoundWaveBlockedUrns,
  getSoundWaveRecentUrns,
  getTrackIdFromUrn,
} from './soundwave-freshness';

const HOME_WAVE_QUEUE_TARGET = 24;
const RELATED_ANCHOR_LIMIT = 4;

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

export function createInitialSoundWaveQueue(seedTracks: Track[], mode: SoundWaveMode): Track[] {
  const unique = dedupeWaveQueue(
    filterSoundWaveTracks(dedupeTracksByUrn(seedTracks), {
      minTracks: 1,
      includeRecentIfNeeded: true,
    }),
    { stage: 'initial-seeds' },
  );
  if (unique.length === 0) return [];

  const initialCount = mode === 'diverse' ? Math.min(4, unique.length) : Math.min(3, unique.length);
  return unique.slice(0, Math.max(1, initialCount));
}

function idsFromUrns(urns: Iterable<string>): string[] {
  return [...urns].map(getTrackIdFromUrn).filter(Boolean);
}

function buildRecentTracksFromQueue(queueTracks: Track[]): Track[] {
  return dedupeTracksByUrn(queueTracks.filter((track) => !!track?.urn).slice(-4)).reverse();
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
  const targetSize = Math.max(1, context?.targetSize ?? HOME_WAVE_QUEUE_TARGET);
  const queueTracks = dedupeTracksByUrn(context?.queueTracks ?? []);
  const anchors = dedupeTracksByUrn([...(context?.recentTracks ?? []), ...seedTracks]).filter(
    (track) => !!track?.urn,
  );

  if (anchors.length === 0) return [];

  const queueUrns = new Set(queueTracks.map((track) => track.urn).filter(Boolean));
  const antiRepeatUrns = new Set([
    ...getSoundWaveBlockedUrns(),
    ...getSoundWaveRecentUrns(),
    ...queueUrns,
  ]);
  const excludeTrackIds = idsFromUrns(antiRepeatUrns);
  const recentTrackIds = idsFromUrns(anchors.map((track) => track.urn));
  const selected: Track[] = [];
  const selectedUrns = new Set<string>();
  const anchorLimit =
    mode === 'diverse' ? RELATED_ANCHOR_LIMIT : Math.max(2, RELATED_ANCHOR_LIMIT - 1);

  for (const anchor of anchors.slice(0, anchorLimit)) {
    const anchorId = trackIdFromTrack(anchor);
    if (!anchorId) continue;

    const recs = await fetchWaveTailFromSeed(anchorId, {
      languages,
      mode,
      limit: Math.max(targetSize * 2, 24),
      excludeTrackIds: [...excludeTrackIds, ...idsFromUrns(selectedUrns)],
      recentTrackIds,
    });

    const tracks = collapseVariations(
      filterSoundWaveTracks(await hydrateByIds(recs), {
        hideLiked,
        excludeUrns: new Set([...antiRepeatUrns, ...selectedUrns]),
        minTracks: Math.min(6, targetSize),
        includeRecentIfNeeded: true,
      }),
      { stage: 'tail-anchor' },
    );

    for (const track of tracks) {
      if (!track?.urn || selectedUrns.has(track.urn)) continue;
      if (hasSameWork(queueTracks, track) || isVariationSuppressed(track)) {
        continue;
      }

      const duplicateIndex = selected.findIndex((candidate) => isSameWork(candidate, track));
      if (duplicateIndex >= 0) {
        const existing = selected[duplicateIndex];
        if (canonicalScore(track) > canonicalScore(existing)) {
          selectedUrns.delete(existing.urn);
          selected[duplicateIndex] = track;
          selectedUrns.add(track.urn);
        }
        continue;
      }

      selected.push(track);
      selectedUrns.add(track.urn);
      if (selected.length >= targetSize) {
        return dedupeWaveQueue(selected, { stage: 'tail-final' });
      }
    }
  }

  return dedupeWaveQueue(selected, { stage: 'tail-final' });
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
    const startIndex = Math.max(0, queueIndex - 3);
    for (let index = queueIndex; index >= startIndex; index -= 1) {
      const track = queue[index];
      if (track?.urn) {
        recentTracks.push(track);
      }
    }
  }

  const contextRecentTracks = dedupeTracksByUrn([
    currentTrack,
    ...recentTracks,
    ...buildRecentTracksFromQueue(queue.slice(0, queueIndex + 1)),
  ]);

  const protectedQueueTracks = queueIndex >= 0 ? queue.slice(0, queueIndex + 1) : [currentTrack];

  return buildWaveQueueFromSeeds(contextRecentTracks, opts.languages, opts.mode, opts.hideLiked, {
    queueTracks: protectedQueueTracks,
    recentTracks: contextRecentTracks,
    targetSize: opts.targetSize,
  });
}
