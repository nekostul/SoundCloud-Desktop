import { useQuery } from '@tanstack/react-query';
import type { Track } from '../stores/player';
import { api } from './api';
import { filterSoundWaveTracks, getTrackIdFromUrn } from './soundwave-freshness';

export interface RecommendResult {
  id: string | number;
  source?: string;
  payload?: Record<string, unknown>;
}

const SW_STALE_MS = 0;
const SW_GC_MS = 1000 * 60 * 5;
const hydratedTrackCache = new Map<string, Track | null>();
const hydratedTrackPromiseCache = new Map<string, Promise<Track | null>>();

function normLanguages(langs: string[] | undefined): string | undefined {
  if (!langs || langs.length === 0) return undefined;
  return [...langs].sort().join(',');
}

function isTrackPayload(value: unknown): value is Track {
  const track = value as Track;
  return Boolean(track?.urn && track.title && track.user?.username);
}

export async function hydrateByIds(recs: RecommendResult[]): Promise<Track[]> {
  const results = await Promise.all(
    recs.map(async (rec) => {
      if (isTrackPayload(rec.payload)) return rec.payload;

      const id = String(rec.id || '').trim();
      if (!id) return null;

      const urn = id.startsWith('soundcloud:tracks:') ? id : `soundcloud:tracks:${id}`;
      return hydrateTrackByUrn(urn);
    }),
  );

  return results.filter((track): track is Track => track !== null);
}

async function hydrateTrackByUrn(urn: string): Promise<Track | null> {
  if (hydratedTrackCache.has(urn)) {
    return hydratedTrackCache.get(urn) ?? null;
  }

  const existingPromise = hydratedTrackPromiseCache.get(urn);
  if (existingPromise) {
    return existingPromise;
  }

  const request = api<Track>(`/tracks/${encodeURIComponent(urn)}`)
    .catch(() => null as Track | null)
    .then((track) => {
      hydratedTrackCache.set(urn, track);
      hydratedTrackPromiseCache.delete(urn);
      return track;
    });

  hydratedTrackPromiseCache.set(urn, request);
  return request;
}

export type SoundWaveMode = 'similar' | 'diverse';

export function useSoundWave(opts: {
  enabled?: boolean;
  languages?: string[];
  limit?: number;
  mode?: SoundWaveMode;
  hideLiked?: boolean;
}) {
  const limit = opts.limit ?? 24;
  const languages = normLanguages(opts.languages);
  const mode: SoundWaveMode = opts.mode ?? 'similar';
  const hideLiked = !!opts.hideLiked;

  return useQuery({
    queryKey: ['soundwave', 'native', limit, languages ?? 'all', mode, hideLiked],
    enabled: opts.enabled !== false,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: String(limit), mode });
      if (languages) qs.set('languages', languages);

      const recs = await api<RecommendResult[]>(`/recommendations?${qs}`).catch(
        () => [] as RecommendResult[],
      );
      const hydrated = await hydrateByIds(recs);
      const tracks = filterSoundWaveTracks(hydrated, {
        hideLiked,
        minTracks: Math.min(8, limit),
        includeRecentIfNeeded: true,
      }).slice(0, limit);

      return { tracks, recs };
    },
  });
}

export function useSoundWaveSearch(opts: { q: string; languages?: string[]; limit?: number }) {
  const q = opts.q.trim();
  const limit = opts.limit ?? 24;
  const languages = normLanguages(opts.languages);

  return useQuery({
    queryKey: ['soundwave', 'native-search', q, limit, languages ?? 'all'],
    enabled: q.length >= 2,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ q, limit: String(limit) });
      if (languages) qs.set('languages', languages);

      const recs = await api<RecommendResult[]>(
        `/recommendations/search?${qs}`,
        { timeoutMs: 30_000 },
      ).catch(() => [] as RecommendResult[]);
      const tracks = filterSoundWaveTracks(await hydrateByIds(recs), {
        minTracks: Math.min(8, limit),
        includeRecentIfNeeded: true,
      }).slice(0, limit);

      return { tracks, recs };
    },
  });
}

export function useSoundWaveSimilar(opts: {
  trackId: string | undefined;
  limit?: number;
  diversity?: number;
}) {
  const trackId = opts.trackId;
  const limit = opts.limit ?? 24;
  const diversity = Math.max(0, Math.min(1, opts.diversity ?? 0));

  return useQuery({
    queryKey: ['soundwave', 'native-similar', trackId, limit, diversity],
    enabled: !!trackId,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (diversity > 0) qs.set('diversity', diversity.toFixed(2));

      const recs = await api<RecommendResult[]>(
        `/recommendations/similar/${encodeURIComponent(trackId!)}?${qs}`,
      ).catch(() => [] as RecommendResult[]);
      const tracks = filterSoundWaveTracks(await hydrateByIds(recs), {
        minTracks: Math.min(8, limit),
        includeRecentIfNeeded: true,
      }).slice(0, limit);

      return { tracks, recs };
    },
  });
}

export async function fetchWaveTailFromSeed(
  seedTrackId: string,
  opts: {
    languages?: string[];
    mode: SoundWaveMode;
    limit?: number;
    excludeTrackIds?: string[];
    recentTrackIds?: string[];
  },
): Promise<RecommendResult[]> {
  const qs = new URLSearchParams({
    limit: String(opts.limit ?? 20),
    mode: opts.mode,
  });
  const languages = normLanguages(opts.languages);
  if (languages) qs.set('languages', languages);

  const exclude = [...new Set(opts.excludeTrackIds?.map((value) => value.trim()).filter(Boolean))];
  const recent = [...new Set(opts.recentTrackIds?.map((value) => value.trim()).filter(Boolean))];
  if (exclude.length) qs.set('exclude', exclude.join(','));
  if (recent.length) qs.set('recent', recent.join(','));

  return api<RecommendResult[]>(
    `/recommendations/wave/${encodeURIComponent(seedTrackId)}?${qs}`,
  ).catch(() => [] as RecommendResult[]);
}

export function trackIdFromTrack(track: Track | null | undefined): string {
  return getTrackIdFromUrn(track?.urn);
}
