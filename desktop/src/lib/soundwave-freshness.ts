import type { Track } from '../stores/player';
import { isUrnLiked } from './likes';

const STORAGE_KEY = 'soundwave-native-freshness-v1';
const RECENT_TTL_MS = 1000 * 60 * 60 * 6;

type FreshnessStorage = {
  day: string;
  blockedUrns: string[];
  playedAt: Record<string, number>;
};

function localDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyStorage(): FreshnessStorage {
  return { day: localDayKey(), blockedUrns: [], playedAt: {} };
}

function readStorage(): FreshnessStorage {
  if (typeof localStorage === 'undefined') return emptyStorage();

  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || 'null',
    ) as Partial<FreshnessStorage> | null;
    if (!parsed || parsed.day !== localDayKey()) return emptyStorage();

    return {
      day: parsed.day,
      blockedUrns: Array.isArray(parsed.blockedUrns)
        ? parsed.blockedUrns.filter((urn): urn is string => typeof urn === 'string')
        : [],
      playedAt:
        parsed.playedAt && typeof parsed.playedAt === 'object' && !Array.isArray(parsed.playedAt)
          ? Object.fromEntries(
              Object.entries(parsed.playedAt).filter(([, value]) => typeof value === 'number'),
            )
          : {},
    };
  } catch {
    return emptyStorage();
  }
}

function writeStorage(value: FreshnessStorage) {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {}
}

export function resetSoundWaveFreshness() {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function getTrackIdFromUrn(value: string | null | undefined): string {
  if (!value) return '';
  return value.split(':').pop()?.trim() || '';
}

export function markSoundWaveTrackPlayed(track: Track | null | undefined) {
  if (!track?.urn) return;

  const storage = readStorage();
  storage.playedAt[track.urn] = Date.now();
  writeStorage(storage);
}

export function blockSoundWaveTrackForToday(track: Track | null | undefined) {
  if (!track?.urn) return;

  const storage = readStorage();
  if (!storage.blockedUrns.includes(track.urn)) {
    storage.blockedUrns.push(track.urn);
  }
  storage.playedAt[track.urn] = Date.now();
  writeStorage(storage);
}

export function getSoundWaveBlockedUrns(): Set<string> {
  return new Set(readStorage().blockedUrns);
}

export function getSoundWaveRecentUrns(ttlMs = RECENT_TTL_MS): Set<string> {
  const now = Date.now();
  const storage = readStorage();
  return new Set(
    Object.entries(storage.playedAt)
      .filter(([, playedAt]) => now - playedAt < ttlMs)
      .map(([urn]) => urn),
  );
}

export function filterSoundWaveTracks(
  tracks: Track[],
  opts: {
    excludeUrns?: Iterable<string>;
    hideLiked?: boolean;
    minTracks?: number;
    includeRecentIfNeeded?: boolean;
  } = {},
): Track[] {
  const blocked = getSoundWaveBlockedUrns();
  const recent = getSoundWaveRecentUrns();
  const excluded = new Set(opts.excludeUrns ?? []);
  const seen = new Set<string>();

  const filterWithRecent = (allowRecent: boolean) => {
    const result: Track[] = [];
    seen.clear();

    for (const track of tracks) {
      if (!track?.urn || seen.has(track.urn)) continue;
      if (track.access === 'blocked') continue;
      if (blocked.has(track.urn) || excluded.has(track.urn)) continue;
      if (!allowRecent && recent.has(track.urn)) continue;
      if (opts.hideLiked && (track.user_favorite || isUrnLiked(track.urn))) continue;

      seen.add(track.urn);
      result.push(track);
    }

    return result;
  };

  const strict = filterWithRecent(false);
  if (!opts.includeRecentIfNeeded) return strict;
  if (strict.length >= (opts.minTracks ?? 1)) return strict;

  return filterWithRecent(true);
}
