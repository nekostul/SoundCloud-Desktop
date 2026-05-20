import { useQuery } from '@tanstack/react-query';
import type { Track } from '../stores/player';
import { fetchMediaJson } from './media-proxy';

export interface WaveformSamples {
  values: number[];
  height: number;
}

interface ScWaveformJson {
  width: number;
  height: number;
  samples: number[];
}

const waveformPromiseCache = new Map<string, Promise<WaveformSamples | null>>();
const waveformDataCache = new Map<string, WaveformSamples | null>();

/** Convert SC's PNG waveform URL (`_m.png`) to the JSON variant (`_m.json`). */
function normalizeWaveformUrl(raw: string): string | null {
  if (!raw) return null;
  // Modern field: "https://wave.sndcdn.com/XXXX_m.png" → swap extension to .json.
  // Legacy field already ends in .json.
  return raw.replace(/\.png(\?.*)?$/i, '.json$1').replace(/^http:\/\//i, 'https://');
}

async function fetchWaveform(rawUrl: string): Promise<WaveformSamples> {
  const url = normalizeWaveformUrl(rawUrl);
  if (!url) throw new Error('Invalid waveform url');

  const json = await fetchMediaJson<ScWaveformJson>(url, {
    accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
    timeoutMs: 8000,
  });

  if (!Array.isArray(json.samples) || json.samples.length === 0) {
    throw new Error('waveform: empty samples');
  }
  return { values: json.samples, height: json.height || 140 };
}

export async function getTrackWaveform(track: Track | null): Promise<WaveformSamples | null> {
  const rawUrl = track?.waveform_url ?? null;
  if (!rawUrl) return null;

  if (waveformDataCache.has(rawUrl)) {
    return waveformDataCache.get(rawUrl) ?? null;
  }

  const existing = waveformPromiseCache.get(rawUrl);
  if (existing) {
    return existing;
  }

  const request = fetchWaveform(rawUrl)
    .then((waveform) => {
      waveformDataCache.set(rawUrl, waveform);
      return waveform;
    })
    .catch(() => {
      waveformDataCache.set(rawUrl, null);
      return null;
    })
    .finally(() => {
      waveformPromiseCache.delete(rawUrl);
    });

  waveformPromiseCache.set(rawUrl, request);
  return request;
}

/** Fetch + cache a track's raw SC waveform JSON. 30-min cache per track URN. */
export function useTrackWaveform(track: Track | null) {
  const rawUrl = track?.waveform_url ?? null;
  return useQuery({
    queryKey: ['waveform', rawUrl],
    enabled: !!rawUrl,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
    retry: false,
    queryFn: () => getTrackWaveform(track),
  });
}
