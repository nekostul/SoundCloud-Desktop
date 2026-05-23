import { type Track, usePlayerStore } from '../stores/player';
import { fetchWaveTailFromSeed, hydrateByIds, trackIdFromTrack, type SoundWaveMode } from './soundwave';
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

export function createInitialSoundWaveQueue(
  seedTracks: Track[],
  mode: SoundWaveMode,
): Track[] {
  const unique = filterSoundWaveTracks(dedupeTracksByUrn(seedTracks), {
    minTracks: 1,
    includeRecentIfNeeded: true,
  });
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
  const anchors = dedupeTracksByUrn([
    ...(context?.recentTracks ?? []),
    ...seedTracks,
  ]).filter((track) => track.access !== 'blocked');

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
  const anchorLimit = mode === 'diverse' ? RELATED_ANCHOR_LIMIT : Math.max(2, RELATED_ANCHOR_LIMIT - 1);

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

    const tracks = filterSoundWaveTracks(await hydrateByIds(recs), {
      hideLiked,
      excludeUrns: new Set([...antiRepeatUrns, ...selectedUrns]),
      minTracks: Math.min(6, targetSize),
      includeRecentIfNeeded: true,
    });

    for (const track of tracks) {
      if (!track?.urn || selectedUrns.has(track.urn)) continue;
      selected.push(track);
      selectedUrns.add(track.urn);
      if (selected.length >= targetSize) return selected;
    }
  }

  return selected;
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

  return buildWaveQueueFromSeeds(contextRecentTracks, opts.languages, opts.mode, opts.hideLiked, {
    queueTracks: queue,
    recentTracks: contextRecentTracks,
    targetSize: opts.targetSize,
  });
}
