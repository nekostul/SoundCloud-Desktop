import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useAuthStore } from '../stores/auth';
import { type Track, usePlayerStore } from '../stores/player';

interface TrackListResponse {
  collection: Track[];
  next_href: string | null;
}

/* ── Global liked URNs store ─────────────────────────────── */

const _likedUrns = new Map<string, boolean>();
const _listeners = new Set<() => void>();

function notify() {
  for (const l of _listeners) l();
}

/** Sync liked URNs from loaded liked tracks (called on every useLikedTracks data change) */
export function initLikedUrns(tracks: Track[]) {
  let changed = false;
  for (const t of tracks) {
    if (!_likedUrns.has(t.urn)) {
      _likedUrns.set(t.urn, true);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Set like status for a track URN */
export function setLikedUrn(urn: string, liked: boolean) {
  if (liked) {
    _likedUrns.set(urn, true);
  } else {
    _likedUrns.delete(urn);
  }
  notify();
}

/** Check if a track URN is liked */
export function isUrnLiked(urn: string): boolean {
  return _likedUrns.has(urn);
}

export function getLikedUrnsSnapshot(): Set<string> {
  return new Set(_likedUrns.keys());
}

/** React hook — subscribes to like status for a specific URN */
export function useLiked(urn: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      _listeners.add(cb);
      return () => _listeners.delete(cb);
    },
    () => _likedUrns.has(urn),
  );
}

/* ── Optimistic toggle (TanStack Query cache) ───────────── */

export function optimisticToggleLike(qc: QueryClient, track: Track, nowLiked: boolean) {
  const wasLiked = isUrnLiked(track.urn) || Boolean(track.user_favorite);
  const authDelta = wasLiked === nowLiked ? 0 : nowLiked ? 1 : -1;
  // Update global liked URNs
  setLikedUrn(track.urn, nowLiked);

  const updateTrackLike = (item: Track): Track => {
    if (item.urn !== track.urn) return item;

    const itemWasLiked = Boolean(item.user_favorite) || wasLiked;
    const delta = itemWasLiked === nowLiked ? 0 : nowLiked ? 1 : -1;

    return {
      ...item,
      user_favorite: nowLiked,
      likes_count:
        typeof item.likes_count === 'number'
          ? Math.max(0, item.likes_count + delta)
          : item.likes_count,
      favoritings_count:
        typeof item.favoritings_count === 'number'
          ? Math.max(0, item.favoritings_count + delta)
          : item.favoritings_count,
    };
  };

  usePlayerStore.setState((state) => ({
    currentTrack: state.currentTrack ? updateTrackLike(state.currentTrack) : state.currentTrack,
    queue: state.queue.map(updateTrackLike),
    originalQueue: state.originalQueue ? state.originalQueue.map(updateTrackLike) : null,
  }));

  // Update favorites count in auth store
  const { user } = useAuthStore.getState();
  if (user && authDelta !== 0) {
    useAuthStore.setState({
      user: {
        ...user,
        public_favorites_count: Math.max(0, user.public_favorites_count + authDelta),
      },
    });
  }

  if (nowLiked) {
    for (const limit of [30, 100, 200]) {
      qc.setQueryData<{ pages: TrackListResponse[]; pageParams: unknown[] }>(
        ['me', 'likes', 'tracks', limit],
        (old) =>
          old ?? {
            pages: [{ collection: [], next_href: null }],
            pageParams: [undefined],
          },
      );
    }
  }

  // Update all liked tracks infinite queries
  qc.setQueriesData<{ pages: TrackListResponse[]; pageParams: unknown[] }>(
    { queryKey: ['me', 'likes', 'tracks'] },
    (old) => {
      if (!old?.pages) return old;
      if (nowLiked) {
        const pages = [...old.pages];
        pages[0] = {
          ...pages[0],
          collection: [
            updateTrackLike(track),
            ...pages[0].collection.filter((t) => t.urn !== track.urn),
          ],
        };
        return { ...old, pages };
      }
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          collection: page.collection.filter((t) => t.urn !== track.urn),
        })),
      };
    },
  );

  // Update single track query
  qc.setQueryData<Track>(['track', track.urn], (old) => {
    if (!old) return old;
    return updateTrackLike(old);
  });

  // Delayed refetch for single track (eventual consistency).
  // Liked tracks list is NOT invalidated — the optimistic cache update above
  // is already correct, and SC API is eventually consistent so early refetch
  // would overwrite optimistic data with stale results.
  setTimeout(() => {
    qc.invalidateQueries({ queryKey: ['track', track.urn], exact: true });
  }, 5000);
}
