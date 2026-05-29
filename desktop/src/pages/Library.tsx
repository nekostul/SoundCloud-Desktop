import { useQueries } from '@tanstack/react-query';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  toContextMenuPlaylistEntity,
  toContextMenuUserEntity,
  useContextMenuTarget,
} from '../components/context-menu/context-menu-registry';
import { AddToPlaylistDialog } from '../components/music/AddToPlaylistDialog';
import { LikeButton } from '../components/music/LikeButton';
import { ApiError, api } from '../lib/api';
import { preloadTrack } from '../lib/audio';
import { isCached } from '../lib/cache';
import { art, dur, durLong, fc } from '../lib/formatters';
import {
  fetchAllLikedTracks,
  type HistoryEntry,
  type Playlist,
  type SCUser,
  useHistory,
  useInfiniteScroll,
  useLikedTracks,
  useMyFollowings,
  useMyLikedPlaylists,
  useMyPlaylists,
} from '../lib/hooks';
import {
  Ban,
  ChevronRight,
  Clock,
  Disc3,
  Heart,
  headphones11,
  heart11,
  ListMusic,
  ListPlus,
  Loader2,
  Music,
  Play,
  pauseBlack20,
  pauseWhite14,
  playBlack20ml1,
  playWhite14,
  Search as SearchIcon,
  User,
  Users,
  X,
} from '../lib/icons';
import { filterTracksByQuery } from '../lib/track-search';
import { useMountFrameGate } from '../lib/useMountFrameGate';
import { useTrackPlay } from '../lib/useTrackPlay';
import { useAuthStore } from '../stores/auth';
import { isTrackUrn, useDislikesStore } from '../stores/dislikes';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';

const LIBRARY_TABS = ['playlists', 'likes', 'following', 'history', 'dislikes'] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number];

const LIBRARY_SECTION_STYLE: React.CSSProperties = {};

const TRACK_CACHE_STATUS = new Map<string, boolean>();
const PLAYLIST_TRACKS_CACHE = new Map<string, Track[]>();

type PlaylistTracksPage = {
  collection: Track[];
  next_href: string | null;
};

function isLibraryTab(value: string | null): value is LibraryTab {
  return value != null && LIBRARY_TABS.includes(value as LibraryTab);
}

function formatHistoryDate(dateStr: string, t: (k: string) => string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  if (d >= today) return t('library.today');
  if (d >= yesterday) return t('library.yesterday');
  return t('library.earlier');
}

function formatUserMeta(user: SCUser) {
  return [user.city, user.country].filter(Boolean).join(', ');
}

function dedupeTrackList(tracks: Track[]) {
  const seen = new Set<string>();
  const unique: Track[] = [];

  for (const track of tracks) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    unique.push(track);
  }

  return unique;
}

function getPlaylistSeedTracks(playlist: Playlist) {
  const cachedTracks = PLAYLIST_TRACKS_CACHE.get(playlist.urn);
  if (cachedTracks && cachedTracks.length > 0) return cachedTracks;
  return dedupeTrackList(playlist.tracks ?? []);
}

function getPlaylistPagination(href: string | null) {
  if (!href) return undefined;

  try {
    const url = new URL(href);
    const cursor = url.searchParams.get('cursor');
    const offset = url.searchParams.get('offset');

    return {
      cursor: cursor || undefined,
      offset: offset || undefined,
    };
  } catch {
    return undefined;
  }
}

async function fetchPlaylistTracksForPlayback(playlist: Playlist) {
  const seededTracks = getPlaylistSeedTracks(playlist);
  const totalTracks = playlist.track_count ?? seededTracks.length;

  if (seededTracks.length > 0 && seededTracks.length >= totalTracks) {
    PLAYLIST_TRACKS_CACHE.set(playlist.urn, seededTracks);
    return seededTracks;
  }

  const collectedTracks = [...seededTracks];
  let cursor: string | undefined;
  let offset: string | undefined;

  for (;;) {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    if (offset) params.set('offset', offset);

    const page = await api<PlaylistTracksPage>(
      `/playlists/${encodeURIComponent(playlist.urn)}/tracks?${params}`,
    );

    collectedTracks.push(...(page.collection ?? []));

    const nextPage = getPlaylistPagination(page.next_href);
    if (!nextPage?.cursor && !nextPage?.offset) break;

    cursor = nextPage.cursor;
    offset = nextPage.offset;
  }

  const uniqueTracks = dedupeTrackList(collectedTracks);
  PLAYLIST_TRACKS_CACHE.set(playlist.urn, uniqueTracks);
  return uniqueTracks;
}

function useTrackCachedFlag(urn: string) {
  const [cached, setCached] = useState(() => TRACK_CACHE_STATUS.get(urn) ?? false);

  useEffect(() => {
    if (TRACK_CACHE_STATUS.has(urn)) {
      setCached(TRACK_CACHE_STATUS.get(urn) ?? false);
      return;
    }

    let cancelled = false;
    void isCached(urn).then((result) => {
      TRACK_CACHE_STATUS.set(urn, result);
      if (!cancelled) setCached(result);
    });

    return () => {
      cancelled = true;
    };
  }, [urn]);

  return cached;
}

const LibraryEmptyState = React.memo(function LibraryEmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="glass-flat rounded-[28px] px-6 py-14 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-white/35">
        {icon}
      </div>
      <p className="text-[14px] font-medium text-white/72">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-white/32">
        {description}
      </p>
    </div>
  );
});

const LibrarySectionTitle = React.memo(function LibrarySectionTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="space-y-1">
        {eyebrow ? (
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
            {eyebrow}
          </div>
        ) : null}
        <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-white/94">{title}</h2>
        {description ? <p className="text-[13px] text-white/42">{description}</p> : null}
      </div>
      {action}
    </div>
  );
});

const HistoryHeaderAction = React.memo(function HistoryHeaderAction() {
  const { t } = useTranslation();
  const historyQuery = useHistory();

  if (historyQuery.entries.length === 0) return null;

  const handleClearHistory = async () => {
    await api('/history', { method: 'DELETE' });
    await historyQuery.refetch();
  };

  return (
    <button
      type="button"
      onClick={() => void handleClearHistory()}
      className="rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-white/42 transition-colors duration-200 hover:bg-red-400/12 hover:text-red-200"
    >
      {t('library.clearHistory')}
    </button>
  );
});

const LibraryMetricCard = React.memo(function LibraryMetricCard({
  icon,
  label,
  value,
  description,
  onClick,
  emphasis = false,
}: {
  icon: React.ElementType;
  label: string;
  value?: string;
  description: string;
  onClick?: () => void;
  emphasis?: boolean;
}) {
  const Icon = icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative overflow-hidden rounded-[24px] border p-4 text-left transition-all duration-300 ease-[var(--ease-apple)] ${
        emphasis
          ? 'theme-accent-soft theme-accent-animated border-white/10'
          : 'glass-flat hover:bg-white/[0.045] hover:border-white/[0.08]'
      }`}
    >
      <div className="relative flex h-full flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-black/20 text-white/70">
            <Icon size={17} />
          </div>
          <ChevronRight
            size={16}
            className="translate-x-0 text-white/25 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/55"
          />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/30">
            {label}
          </div>
          {value ? (
            <div className="text-[20px] font-semibold tracking-[-0.02em] text-white/94">
              {value}
            </div>
          ) : null}
          <p className="text-[12px] leading-relaxed text-white/45">{description}</p>
        </div>
      </div>
    </button>
  );
});

const LibraryTabButton = React.memo(function LibraryTabButton({
  label,
  count,
  isActive,
  icon,
  onClick,
}: {
  label: string;
  count?: string | null;
  isActive: boolean;
  icon: React.ElementType;
  onClick: () => void;
}) {
  const Icon = icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex items-center gap-2 whitespace-nowrap px-1 pb-3 pt-2 text-[12px] font-semibold transition-colors duration-200 ${
        isActive ? 'text-white' : 'text-white/42 hover:text-white/78'
      }`}
    >
      <Icon
        size={14}
        className={
          isActive ? 'text-[var(--color-accent)]' : 'text-white/26 group-hover:text-white/48'
        }
      />
      <span>{label}</span>
      {count ? (
        <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold text-white/35">
          {count}
        </span>
      ) : null}
      {isActive ? (
        <span className="theme-accent-progress theme-accent-animated absolute inset-x-0 bottom-0 h-[2px] rounded-full" />
      ) : null}
    </button>
  );
});

const LibraryPlaylistCard = React.memo(
  function LibraryPlaylistCard({ playlist }: { playlist: Playlist }) {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [resolvedTracks, setResolvedTracks] = useState<Track[]>(() =>
      getPlaylistSeedTracks(playlist),
    );
    const cover =
      art(playlist.artwork_url, 't300x300') ?? art(playlist.tracks?.[0]?.artwork_url, 't300x300');
    const playlistContextProps = useContextMenuTarget(
      useMemo(() => {
        const entity = toContextMenuPlaylistEntity(playlist);
        return entity ? { type: 'playlist' as const, playlist: entity } : null;
      }, [playlist]),
    );
    const creatorContextProps = useContextMenuTarget(
      useMemo(() => {
        const user = toContextMenuUserEntity(playlist.user);
        return user ? { type: 'user' as const, user } : null;
      }, [playlist.user]),
    );

    useEffect(() => {
      setResolvedTracks(getPlaylistSeedTracks(playlist));
    }, [playlist]);

    const trackUrns = useMemo(
      () => new Set(resolvedTracks.map((track) => track.urn)),
      [resolvedTracks],
    );
    const isPlayingFromThis = usePlayerStore(
      (s) => !!s.isPlaying && s.currentTrack != null && trackUrns.has(s.currentTrack.urn),
    );
    const isPausedFromThis = usePlayerStore(
      (s) => !s.isPlaying && s.currentTrack != null && trackUrns.has(s.currentTrack.urn),
    );

    const handlePlay = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (loading) return;

        const { play, pause, resume } = usePlayerStore.getState();

        if (isPlayingFromThis) {
          pause();
          return;
        }

        if (isPausedFromThis) {
          resume();
          return;
        }

        setLoading(true);
        try {
          const tracks = await fetchPlaylistTracksForPlayback(playlist);
          if (tracks.length > 0) {
            setResolvedTracks(tracks);
            play(tracks[0], tracks);
          }
        } finally {
          setLoading(false);
        }
      },
      [isPausedFromThis, isPlayingFromThis, loading, playlist],
    );

    return (
      <div
        {...playlistContextProps}
        className={`group relative overflow-hidden rounded-[26px] border p-3.5 transition-all duration-300 ease-[var(--ease-apple)] ${
          isPlayingFromThis
            ? 'theme-accent-soft theme-accent-animated'
            : 'glass-flat hover:bg-white/[0.045] hover:border-white/[0.08]'
        }`}
        onClick={() => navigate(`/playlist/${encodeURIComponent(playlist.urn)}`)}
      >
        <div className="flex items-center gap-4">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-[18px] ring-1 ring-white/[0.06]">
            {cover ? (
              <img
                src={cover}
                alt={playlist.title}
                className="h-full w-full object-cover transition-transform duration-500 ease-[var(--ease-apple)] group-hover:scale-[1.04]"
                decoding="async"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.05] to-transparent">
                <ListMusic size={22} className="text-white/15" />
              </div>
            )}
            {playlist.track_count > 0 ? (
              <div className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/80 backdrop-blur-md">
                {playlist.track_count}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/33">
                {playlist.playlist_type || 'Playlist'}
              </span>
              {playlist.genre ? (
                <span className="rounded-full border border-white/[0.06] px-2 py-0.5 text-[10px] text-white/28">
                  {playlist.genre}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[14px] font-semibold text-white/92 transition-colors duration-200 group-hover:text-white">
              {playlist.title}
            </p>
            <p
              {...creatorContextProps}
              className="mt-1 truncate text-[12px] text-white/38 transition-colors duration-200 group-hover:text-white/58"
            >
              {playlist.user?.username || 'Unknown'}
            </p>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-white/24">
              {playlist.likes_count > 0 ? (
                <span className="flex items-center gap-1">
                  {heart11}
                  {fc(playlist.likes_count)}
                </span>
              ) : null}
              {playlist.duration > 0 ? <span>{dur(playlist.duration)}</span> : null}
            </div>
          </div>

          <button
            type="button"
            onClick={(e) => void handlePlay(e)}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200 ease-[var(--ease-apple)] ${
              isPlayingFromThis
                ? 'theme-accent-fill theme-accent-animated shadow-[var(--theme-accent-shadow)]'
                : 'bg-white/[0.08] text-white/78 hover:bg-white/[0.14] hover:text-white'
            }`}
            title={isPlayingFromThis ? 'Pause' : 'Play'}
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : isPlayingFromThis ? (
              pauseWhite14
            ) : (
              <Play size={14} fill="currentColor" strokeWidth={0} className="ml-px" />
            )}
          </button>
        </div>
      </div>
    );
  },
  (prev, next) => prev.playlist.urn === next.playlist.urn,
);

const LibraryTrackRow = React.memo(
  function LibraryTrackRow({
    track,
    index,
    queue,
    onPlay,
  }: {
    track: Track;
    index: number;
    queue: Track[];
    onPlay?: () => void;
  }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { isThis, isThisPlaying, togglePlay: baseToggle } = useTrackPlay(track, queue);
    const addToQueueNext = usePlayerStore((s) => s.addToQueueNext);
    const isTrackCached = useTrackCachedFlag(track.urn);

    const togglePlay = () => {
      baseToggle();
      if (!isThis && onPlay) onPlay();
    };

    const trackContextProps = useContextMenuTarget(
      useMemo(
        () => ({
          type: 'track' as const,
          track,
          queue,
        }),
        [queue, track],
      ),
    );
    const artistContextProps = useContextMenuTarget(
      useMemo(() => {
        const user = toContextMenuUserEntity(track.user);
        return user ? { type: 'user' as const, user } : null;
      }, [track.user]),
    );

    const handleAddToQueue = (e: React.MouseEvent) => {
      e.stopPropagation();
      addToQueueNext([track]);
    };

    const cover = art(track.artwork_url, 't200x200');

    return (
      <div
        {...trackContextProps}
        className={`group relative overflow-hidden rounded-[24px] border p-3.5 transition-all duration-300 ease-[var(--ease-apple)] ${
          isThis
            ? 'theme-accent-soft theme-accent-animated'
            : 'glass-flat hover:bg-white/[0.045] hover:border-white/[0.08]'
        }`}
      >
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={togglePlay}
            onMouseEnter={() => preloadTrack(track.urn)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/20 text-white/70 transition-colors duration-200 hover:text-white"
          >
            {isThisPlaying ? (
              <div className="theme-accent-fill theme-accent-animated flex h-9 w-9 items-center justify-center rounded-full shadow-[var(--theme-accent-shadow)]">
                {pauseWhite14}
              </div>
            ) : (
              <>
                <span className="text-[12px] font-semibold tabular-nums group-hover:hidden">
                  {index + 1}
                </span>
                <span className="hidden group-hover:flex">{playWhite14}</span>
              </>
            )}
          </button>

          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[16px] ring-1 ring-white/[0.08]">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" decoding="async" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.05] to-transparent">
                <Music size={14} className="text-white/20" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p
                className={`truncate text-[14px] font-semibold transition-colors duration-200 ${
                  isThis ? 'text-[var(--color-accent)]' : 'text-white/92 hover:text-white'
                }`}
                onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
              >
                {track.title}
              </p>
              {isTrackCached ? (
                <span className="hidden rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] text-white/28 md:inline-flex">
                  Cached
                </span>
              ) : null}
            </div>
            <p
              {...artistContextProps}
              className="mt-1 truncate text-[12px] text-white/38 transition-colors duration-200 hover:text-white/62"
              onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
            >
              {track.user.username}
            </p>
          </div>

          <div className="hidden items-center gap-3 text-[11px] text-white/28 xl:flex">
            {track.playback_count != null ? (
              <span className="flex min-w-[66px] items-center gap-1.5 tabular-nums">
                {headphones11}
                {fc(track.playback_count)}
              </span>
            ) : null}
            <span className="flex min-w-[58px] items-center gap-1.5 tabular-nums">
              {heart11}
              {fc(track.favoritings_count ?? track.likes_count ?? 0)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <LikeButton track={track} />

            <AddToPlaylistDialog trackUrn={track.urn}>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full text-white/30 transition-colors duration-200 hover:bg-white/[0.08] hover:text-white/78"
                title={t('playlist.addToPlaylist')}
              >
                <ListMusic size={15} />
              </button>
            </AddToPlaylistDialog>

            <button
              type="button"
              onClick={handleAddToQueue}
              className="hidden h-9 w-9 items-center justify-center rounded-full text-white/30 transition-colors duration-200 hover:bg-white/[0.08] hover:text-white/78 sm:flex"
              title={t('player.addToQueue')}
            >
              <ListPlus size={15} />
            </button>
          </div>

          <div className="w-12 shrink-0 text-right text-[12px] font-medium tabular-nums text-white/34">
            {dur(track.duration)}
          </div>
        </div>
      </div>
    );
  },
  (prev, next) => prev.track.urn === next.track.urn && prev.index === next.index,
);

const DislikedTrackRow = React.memo(
  function DislikedTrackRow({
    track,
    index,
    queue,
    onRemoveDislike,
  }: {
    track: Track;
    index: number;
    queue: Track[];
    onRemoveDislike: (urn: string) => void;
  }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { isThis, isThisPlaying, togglePlay } = useTrackPlay(track, queue);
    const cover = art(track.artwork_url, 't200x200');

    const trackContextProps = useContextMenuTarget(
      useMemo(
        () => ({
          type: 'track' as const,
          track,
          queue,
        }),
        [queue, track],
      ),
    );
    const artistContextProps = useContextMenuTarget(
      useMemo(() => {
        const user = toContextMenuUserEntity(track.user);
        return user ? { type: 'user' as const, user } : null;
      }, [track.user]),
    );

    return (
      <div
        {...trackContextProps}
        className={`group relative overflow-hidden rounded-[24px] border p-3.5 transition-all duration-300 ease-[var(--ease-apple)] ${
          isThis
            ? 'theme-accent-soft theme-accent-animated'
            : 'glass-flat hover:bg-white/[0.045] hover:border-white/[0.08]'
        }`}
      >
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={togglePlay}
            onMouseEnter={() => preloadTrack(track.urn)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/20 text-white/70 transition-colors duration-200 hover:text-white"
          >
            {isThisPlaying ? (
              <div className="theme-accent-fill theme-accent-animated flex h-9 w-9 items-center justify-center rounded-full shadow-[var(--theme-accent-shadow)]">
                {pauseWhite14}
              </div>
            ) : (
              <>
                <span className="text-[12px] font-semibold tabular-nums group-hover:hidden">
                  {index + 1}
                </span>
                <span className="hidden group-hover:flex">{playWhite14}</span>
              </>
            )}
          </button>

          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[16px] ring-1 ring-white/[0.08]">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" decoding="async" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.05] to-transparent">
                <Music size={14} className="text-white/20" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p
              className={`truncate text-[14px] font-semibold transition-colors duration-200 ${
                isThis ? 'text-[var(--color-accent)]' : 'text-white/92 hover:text-white'
              }`}
              onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
            >
              {track.title}
            </p>
            <p
              {...artistContextProps}
              className="mt-1 truncate text-[12px] text-white/38 transition-colors duration-200 hover:text-white/62"
              onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
            >
              {track.user.username}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onRemoveDislike(track.urn)}
            className="rounded-full border border-red-400/18 bg-red-400/10 px-3 py-1.5 text-[11px] font-semibold text-red-100/85 transition-colors duration-200 hover:bg-red-400/18"
            title={t('settings.removeDislike', 'Remove Dislike')}
          >
            <span className="hidden sm:inline">
              {t('settings.removeDislike', 'Remove Dislike')}
            </span>
            <span className="sm:hidden">
              <X size={13} />
            </span>
          </button>

          <div className="w-12 shrink-0 text-right text-[12px] font-medium tabular-nums text-white/34">
            {dur(track.duration)}
          </div>
        </div>
      </div>
    );
  },
  (prev, next) => prev.track.urn === next.track.urn && prev.index === next.index,
);

const HistoryEntryRow = React.memo(function HistoryEntryRow({
  entry,
  loadingTrackId,
  onPlay,
}: {
  entry: HistoryEntry;
  loadingTrackId: string | null;
  onPlay: (entry: HistoryEntry) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="group glass-flat rounded-[24px] border p-3.5 transition-all duration-300 ease-[var(--ease-apple)] hover:bg-white/[0.045] hover:border-white/[0.08]">
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => onPlay(entry)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/20 text-white/72 transition-colors duration-200 hover:text-white"
          title={t('player.play')}
        >
          {loadingTrackId === entry.id ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <span>{playWhite14}</span>
          )}
        </button>

        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[16px] ring-1 ring-white/[0.08]">
          {entry.artworkUrl ? (
            <img
              src={entry.artworkUrl.replace('large', 't200x200')}
              alt=""
              className="h-full w-full object-cover"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.05] to-transparent">
              <Music size={14} className="text-white/20" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[14px] font-semibold text-white/92 transition-colors duration-200 hover:text-white"
            onClick={() => navigate(`/track/${encodeURIComponent(entry.scTrackId)}`)}
          >
            {entry.title}
          </p>
          <p className="mt-1 truncate text-[12px] text-white/38">{entry.artistName}</p>
        </div>

        <div className="shrink-0 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1 text-[11px] font-medium tabular-nums text-white/42">
          {new Date(entry.playedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
    </div>
  );
});

const UserCard = React.memo(function UserCard({ user }: { user: SCUser }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const avatar = art(user.avatar_url, 't300x300');
  const meta = formatUserMeta(user);
  const userContextProps = useContextMenuTarget(
    useMemo(() => {
      const contextUser = toContextMenuUserEntity(user);
      return contextUser ? { type: 'user' as const, user: contextUser } : null;
    }, [user]),
  );

  return (
    <div
      {...userContextProps}
      className="group glass-flat rounded-[28px] border p-4 transition-all duration-300 ease-[var(--ease-apple)] hover:bg-white/[0.045] hover:border-white/[0.08]"
      onClick={() => navigate(`/user/${encodeURIComponent(user.urn)}`)}
    >
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full ring-1 ring-white/[0.1]">
          {avatar ? (
            <img
              src={avatar}
              alt={user.username}
              className="h-full w-full object-cover"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/5">
              <User size={22} className="text-white/20" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15px] font-semibold text-white/92 transition-colors duration-200 group-hover:text-white">
              {user.username}
            </p>
            <ChevronRight
              size={15}
              className="shrink-0 text-white/22 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/50"
            />
          </div>
          <p className="mt-1 truncate text-[12px] text-white/34">
            {meta || t('library.followingDescription')}
          </p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-white/25">
            <span className="flex items-center gap-1">
              <Users size={11} />
              {fc(user.followers_count ?? 0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

const LibraryHero = React.memo(function LibraryHero({
  onTabLikes,
  onTabFollowing,
  onTabPlaylists,
  onTabHistory,
}: {
  onTabLikes: () => void;
  onTabFollowing: () => void;
  onTabPlaylists: () => void;
  onTabHistory: () => void;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { tracks: likedTracks } = useLikedTracks();
  const { users: followings } = useMyFollowings();
  const [shuffleLoading, setShuffleLoading] = useState(false);
  const [likedDurationMs, setLikedDurationMs] = useState<number | null>(null);
  const likedTrackUrns = useMemo(
    () => new Set(likedTracks.map((track) => track.urn)),
    [likedTracks],
  );
  const isPlayingFromLikes = usePlayerStore(
    (s) => s.isPlaying && s.currentTrack != null && likedTrackUrns.has(s.currentTrack.urn),
  );
  const isPausedFromLikes = usePlayerStore(
    (s) => !s.isPlaying && s.currentTrack != null && likedTrackUrns.has(s.currentTrack.urn),
  );

  useEffect(() => {
    let cancelled = false;

    void fetchAllLikedTracks().then((all) => {
      if (cancelled) return;
      const totalDuration = all.reduce((sum, track) => sum + (track.duration || 0), 0);
      setLikedDurationMs(totalDuration);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleShuffleLikes = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shuffleLoading) return;

    const { pause, resume } = usePlayerStore.getState();
    if (isPlayingFromLikes) {
      pause();
      return;
    }
    if (isPausedFromLikes) {
      resume();
      return;
    }

    setShuffleLoading(true);
    try {
      const all = await fetchAllLikedTracks();
      if (all.length === 0) return;

      if (!usePlayerStore.getState().shuffle) {
        usePlayerStore.setState({ shuffle: true });
      }

      const random = all[Math.floor(Math.random() * all.length)];
      usePlayerStore.getState().play(random, all);
    } finally {
      setShuffleLoading(false);
    }
  };

  if (!user) return null;

  return (
    <section className="glass-featured relative overflow-hidden rounded-[34px] border border-white/[0.08]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="theme-accent-soft absolute -left-14 top-10 h-40 w-40 rounded-full opacity-60 blur-3xl" />
        <div className="absolute right-[-54px] top-[-12px] h-48 w-48 rounded-full bg-white/[0.06] blur-3xl" />
      </div>

      <div className="relative border-b border-white/[0.06] px-6 py-6 sm:px-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.26em] text-white/34">
              <span className="theme-accent-fill theme-accent-animated h-2 w-2 rounded-full" />
              <span>{t('library.heroBadge')}</span>
            </div>
            <h1 className="greeting-gradient text-[30px] font-semibold tracking-[-0.04em] text-white">
              {t('nav.library')}
            </h1>
            <p className="max-w-2xl text-[14px] leading-relaxed text-white/48">
              {t('library.subtitle')}
            </p>
          </div>

          <div className="grid w-full max-w-[560px] grid-cols-3 rounded-full border border-white/[0.08] bg-black/18 px-5 py-3 backdrop-blur-xl">
            <div className="flex min-w-0 flex-col items-center justify-center px-4 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/25">
                {t('library.savedTracks')}
              </div>
              <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-white/92">
                {fc(user.public_favorites_count)}
              </div>
            </div>
            <div className="flex min-w-0 flex-col items-center justify-center border-l border-white/[0.08] px-4 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/25">
                {t('nav.following')}
              </div>
              <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-white/92">
                {fc(user.followings_count ?? 0)}
              </div>
            </div>
            <div className="flex min-w-0 flex-col items-center justify-center border-l border-white/[0.08] px-4 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/25">
                {t('library.likesDuration')}
              </div>
              <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-white/92">
                {likedDurationMs != null ? durLong(likedDurationMs) : '...'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="relative grid gap-4 px-6 py-6 sm:px-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(310px,0.85fr)]">
        <button
          type="button"
          onClick={onTabLikes}
          className="group relative overflow-hidden rounded-[30px] border border-white/[0.08] bg-black/16 p-5 text-left transition-transform duration-300 ease-[var(--ease-apple)] hover:-translate-y-0.5"
        >
          <div className="theme-accent-soft absolute inset-0 opacity-80" />
          <div className="relative flex h-full flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/[0.1] bg-black/18 text-white">
                  <Heart size={20} className="fill-white/15" />
                </div>
                <div>
                  <h2 className="text-[25px] font-semibold tracking-[-0.03em] text-white/95">
                    {t('library.likedTracks')}
                  </h2>
                  <p className="mt-1 text-[13px] text-white/52">
                    {t('library.likedTracksDescription')}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={(e) => void handleShuffleLikes(e)}
                disabled={shuffleLoading}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-[0_20px_40px_rgba(0,0,0,0.25)] transition-transform duration-200 hover:scale-105 disabled:opacity-60"
                title={
                  isPlayingFromLikes
                    ? t('player.pause')
                    : isPausedFromLikes
                      ? t('player.play')
                      : t('player.shuffle')
                }
              >
                {shuffleLoading ? (
                  <Loader2 size={18} className="animate-spin text-black" />
                ) : isPlayingFromLikes ? (
                  pauseBlack20
                ) : (
                  playBlack20ml1
                )}
              </button>
            </div>

            <div className="mt-auto flex items-end justify-between gap-4">
              <div className="flex -space-x-3">
                {likedTracks.slice(0, 5).map((track) => (
                  <div
                    key={track.id}
                    className="h-11 w-11 overflow-hidden rounded-full border-2 border-[#0b0b0d] bg-black/40"
                  >
                    <img
                      src={art(track.artwork_url, 'small') || ''}
                      className="h-full w-full object-cover"
                      alt=""
                    />
                  </div>
                ))}
              </div>

              <div className="text-right">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/28">
                  {t('search.tracks')}
                </div>
                <div className="mt-1 text-[20px] font-semibold tracking-[-0.03em] text-white/94">
                  {fc(user.public_favorites_count)}
                </div>
              </div>
            </div>
          </div>
        </button>

        <div className="grid gap-3">
          <button
            type="button"
            onClick={onTabFollowing}
            className="group glass-flat relative overflow-hidden rounded-[28px] border p-4 text-left transition-all duration-300 ease-[var(--ease-apple)] hover:bg-white/[0.045] hover:border-white/[0.08]"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/26">
                  {t('nav.following')}
                </div>
                <div className="text-[20px] font-semibold tracking-[-0.03em] text-white/94">
                  {fc(user.followings_count ?? 0)}
                </div>
                <p className="text-[12px] leading-relaxed text-white/42">
                  {t('library.followingDescription')}
                </p>
              </div>
              <div className="flex -space-x-3">
                {followings.slice(0, 4).map((item) => (
                  <div
                    key={item.id}
                    className="h-12 w-12 overflow-hidden rounded-full border-2 border-[#0b0b0d] bg-black/40"
                  >
                    <img
                      src={art(item.avatar_url, 'small') || ''}
                      className="h-full w-full object-cover"
                      alt=""
                    />
                  </div>
                ))}
              </div>
            </div>
          </button>

          <div className="grid gap-3 sm:grid-cols-2">
            <LibraryMetricCard
              icon={ListMusic}
              label={t('search.playlists')}
              description={t('library.playlistsDescription')}
              onClick={onTabPlaylists}
            />
            <LibraryMetricCard
              icon={Clock}
              label={t('library.history')}
              description={t('library.historyDescription')}
              onClick={onTabHistory}
            />
          </div>
        </div>
      </div>
    </section>
  );
});

const LikesTab = React.memo(function LikesTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const likesQuery = useLikedTracks();
  const { tracks: likedTracks, isLoading } = likesQuery;
  const sentinelRef = useInfiniteScroll(
    !!likesQuery.hasNextPage,
    !!likesQuery.isFetchingNextPage,
    likesQuery.fetchNextPage,
  );

  useEffect(() => {
    if (filter && likesQuery.hasNextPage && !likesQuery.isFetchingNextPage) {
      likesQuery.fetchNextPage();
    }
  }, [filter, likesQuery]);

  const filtered = useMemo(() => filterTracksByQuery(likedTracks, filter), [likedTracks, filter]);
  const expandQueue = useCallback(() => {
    fetchAllLikedTracks().then((all) => {
      usePlayerStore.getState().setQueue(all);
    });
  }, []);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/20" />
      </div>
    );
  }

  return (
    <div className="min-h-[420px] space-y-3" style={LIBRARY_SECTION_STYLE}>
      {filtered.length > 0 ? (
        filtered.map((track, index) => (
          <LibraryTrackRow
            key={track.urn}
            track={track}
            index={index}
            queue={filtered}
            onPlay={expandQueue}
          />
        ))
      ) : (
        <LibraryEmptyState
          icon={<Heart size={22} className="fill-white/10" />}
          title={filter ? t('library.noMatches') : t('library.noLikedTracks')}
          description={t('library.likedTracksDescription')}
        />
      )}

      {!filter ? (
        <div ref={sentinelRef} className="flex h-12 items-center justify-center">
          {likesQuery.isFetchingNextPage ? (
            <Loader2 size={18} className="animate-spin text-white/18" />
          ) : null}
        </div>
      ) : likesQuery.isFetchingNextPage ? (
        <div className="flex h-12 items-center justify-center">
          <Loader2 size={18} className="animate-spin text-white/18" />
        </div>
      ) : null}
    </div>
  );
});

const FollowingTab = React.memo(function FollowingTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const followingsQuery = useMyFollowings();
  const { users: followings, isLoading } = followingsQuery;
  const sentinelRef = useInfiniteScroll(
    !!followingsQuery.hasNextPage,
    !!followingsQuery.isFetchingNextPage,
    followingsQuery.fetchNextPage,
  );

  useEffect(() => {
    if (filter && followingsQuery.hasNextPage && !followingsQuery.isFetchingNextPage) {
      followingsQuery.fetchNextPage();
    }
  }, [filter, followingsQuery]);

  const filtered = useMemo(() => {
    if (!filter) return followings;
    const query = filter.toLowerCase();
    return followings.filter((user) =>
      [user.username, user.city, user.country]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query)),
    );
  }, [filter, followings]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/20" />
      </div>
    );
  }

  return (
    <div className="min-h-[420px] space-y-4" style={LIBRARY_SECTION_STYLE}>
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((user) => (
            <UserCard key={user.urn} user={user} />
          ))}
        </div>
      ) : (
        <LibraryEmptyState
          icon={<Users size={22} />}
          title={filter ? t('library.noMatches') : t('library.notFollowing')}
          description={t('library.followingDescription')}
        />
      )}

      {!filter ? (
        <div ref={sentinelRef} className="flex h-12 items-center justify-center">
          {followingsQuery.isFetchingNextPage ? (
            <Loader2 size={18} className="animate-spin text-white/18" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const PlaylistsTab = React.memo(function PlaylistsTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const myPlaylistsQuery = useMyPlaylists();
  const likedPlaylistsQuery = useMyLikedPlaylists();
  const createdPlaylists = myPlaylistsQuery.playlists;
  const likedPlaylists = likedPlaylistsQuery.playlists;

  const filterPlaylists = useCallback(
    (items: Playlist[]) => {
      if (!filter) return items;
      const query = filter.toLowerCase();
      return items.filter((playlist) =>
        [playlist.title, playlist.user?.username, playlist.genre]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query)),
      );
    },
    [filter],
  );

  const filteredCreated = useMemo(
    () => filterPlaylists(createdPlaylists),
    [createdPlaylists, filterPlaylists],
  );
  const filteredLiked = useMemo(
    () => filterPlaylists(likedPlaylists),
    [filterPlaylists, likedPlaylists],
  );

  const hasNextPage = likedPlaylistsQuery.hasNextPage || myPlaylistsQuery.hasNextPage;
  const isFetchingNextPage =
    likedPlaylistsQuery.isFetchingNextPage || myPlaylistsQuery.isFetchingNextPage;
  const fetchNextPage = likedPlaylistsQuery.hasNextPage
    ? likedPlaylistsQuery.fetchNextPage
    : myPlaylistsQuery.fetchNextPage;
  const sentinelRef = useInfiniteScroll(!!hasNextPage, !!isFetchingNextPage, fetchNextPage);

  useEffect(() => {
    if (filter && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, filter, hasNextPage, isFetchingNextPage]);

  const isLoading = myPlaylistsQuery.isLoading || likedPlaylistsQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/20" />
      </div>
    );
  }

  return (
    <div className="min-h-[420px] space-y-10" style={LIBRARY_SECTION_STYLE}>
      {filteredCreated.length > 0 ? (
        <section className="space-y-4">
          <LibrarySectionTitle
            title={t('library.yourPlaylists')}
            description={t('library.playlistsDescription')}
            action={
              <div className="rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-white/34">
                {filteredCreated.length}
              </div>
            }
          />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {filteredCreated.map((playlist) => (
              <LibraryPlaylistCard key={playlist.urn} playlist={playlist} />
            ))}
          </div>
        </section>
      ) : null}

      {filteredLiked.length > 0 ? (
        <section className="space-y-4">
          <LibrarySectionTitle
            title={t('library.likedPlaylists')}
            description={t('library.playlistsDescription')}
            action={
              <div className="rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-white/34">
                {filteredLiked.length}
              </div>
            }
          />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {filteredLiked.map((playlist) => (
              <LibraryPlaylistCard key={playlist.urn} playlist={playlist} />
            ))}
          </div>
        </section>
      ) : null}

      {filteredCreated.length === 0 && filteredLiked.length === 0 ? (
        <LibraryEmptyState
          icon={<ListMusic size={22} />}
          title={filter ? t('library.noMatches') : t('library.noPlaylists')}
          description={t('library.playlistsDescription')}
        />
      ) : null}

      {!filter ? (
        <div ref={sentinelRef} className="flex h-12 items-center justify-center">
          {isFetchingNextPage ? <Loader2 size={18} className="animate-spin text-white/18" /> : null}
        </div>
      ) : null}
    </div>
  );
});

const HistoryTab = React.memo(function HistoryTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const play = usePlayerStore((s) => s.play);
  const historyQuery = useHistory();
  const { entries, isLoading } = historyQuery;
  const [loadingTrackId, setLoadingTrackId] = useState<string | null>(null);
  const sentinelRef = useInfiniteScroll(
    !!historyQuery.hasNextPage,
    !!historyQuery.isFetchingNextPage,
    historyQuery.fetchNextPage,
  );

  const handlePlayFromHistory = useCallback(
    async (entry: HistoryEntry) => {
      if (loadingTrackId === entry.id) return;
      setLoadingTrackId(entry.id);
      try {
        const track = await api<Track>(`/tracks/${encodeURIComponent(entry.scTrackId)}`);
        play(track, [track]);
      } finally {
        setLoadingTrackId((current) => (current === entry.id ? null : current));
      }
    },
    [loadingTrackId, play],
  );

  useEffect(() => {
    if (filter && historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) {
      historyQuery.fetchNextPage();
    }
  }, [filter, historyQuery]);

  const filteredEntries = useMemo(() => {
    if (!filter) return entries;
    const query = filter.toLowerCase();
    return entries.filter((entry) =>
      [entry.title, entry.artistName].some((value) => value.toLowerCase().includes(query)),
    );
  }, [entries, filter]);

  const grouped = useMemo(() => {
    const groups: { label: string; items: HistoryEntry[] }[] = [];
    let currentLabel = '';

    for (const entry of filteredEntries) {
      const label = formatHistoryDate(entry.playedAt, t);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, items: [] });
      }
      groups[groups.length - 1].items.push(entry);
    }

    return groups;
  }, [filteredEntries, t]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/20" />
      </div>
    );
  }

  return (
    <div className="min-h-[420px] space-y-6" style={LIBRARY_SECTION_STYLE}>
      {filteredEntries.length > 0 ? (
        grouped.map((group) => (
          <section key={group.label} className="space-y-2.5">
            <div className="flex items-center gap-3">
              <div className="rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/34">
                {group.label}
              </div>
            </div>
            <div className="space-y-3">
              {group.items.map((entry) => (
                <HistoryEntryRow
                  key={entry.id}
                  entry={entry}
                  loadingTrackId={loadingTrackId}
                  onPlay={handlePlayFromHistory}
                />
              ))}
            </div>
          </section>
        ))
      ) : (
        <LibraryEmptyState
          icon={<Clock size={22} />}
          title={filter ? t('library.noMatches') : t('library.historyEmpty')}
          description={t('library.historyDescription')}
        />
      )}

      <div ref={sentinelRef} className="flex h-12 items-center justify-center">
        {historyQuery.isFetchingNextPage ? (
          <Loader2 size={18} className="animate-spin text-white/18" />
        ) : null}
      </div>
    </div>
  );
});

const DislikesTab = React.memo(function DislikesTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const dislikedTrackUrns = useDislikesStore((s) => s.dislikedTrackUrns);
  const toggleDislike = useDislikesStore((s) => s.toggleDislike);
  const pruneDislikes = useDislikesStore((s) => s.pruneDislikes);

  const invalidStoredUrns = useMemo(
    () => dislikedTrackUrns.filter((urn) => !isTrackUrn(urn)),
    [dislikedTrackUrns],
  );
  const trackUrns = useMemo(() => dislikedTrackUrns.filter(isTrackUrn), [dislikedTrackUrns]);

  const trackQueries = useQueries({
    queries: trackUrns.map((urn) => ({
      queryKey: ['track', urn],
      queryFn: () =>
        api<Track>(`/tracks/${encodeURIComponent(urn)}`, {
          quietHttpErrors: true,
        }),
      staleTime: 5 * 60 * 1000,
      retry: 0,
    })),
  });

  const missingTrackUrns = useMemo(
    () =>
      trackUrns.filter((_, index) => {
        const error = trackQueries[index]?.error;
        return error instanceof ApiError && error.status === 404;
      }),
    [trackQueries, trackUrns],
  );

  useEffect(() => {
    if (invalidStoredUrns.length > 0) {
      pruneDislikes(invalidStoredUrns);
    }
  }, [invalidStoredUrns, pruneDislikes]);

  useEffect(() => {
    if (missingTrackUrns.length > 0) {
      pruneDislikes(missingTrackUrns);
    }
  }, [missingTrackUrns, pruneDislikes]);

  const isLoading = trackUrns.length > 0 && trackQueries.some((query) => query.isLoading);

  const tracks = useMemo(() => {
    const loaded: Track[] = [];
    for (const query of trackQueries) {
      if (query.data) loaded.push(query.data);
    }
    return loaded;
  }, [trackQueries]);

  const filtered = useMemo(() => filterTracksByQuery(tracks, filter), [filter, tracks]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/20" />
      </div>
    );
  }

  if (trackUrns.length === 0) {
    return (
      <LibraryEmptyState
        icon={<Ban size={22} />}
        title={t('settings.dislikedTracksEmpty', 'No disliked tracks')}
        description={t('library.dislikesDescription')}
      />
    );
  }

  return (
    <div className="min-h-[420px] space-y-3" style={LIBRARY_SECTION_STYLE}>
      {filtered.length > 0 ? (
        filtered.map((track, index) => (
          <DislikedTrackRow
            key={track.urn}
            track={track}
            index={index}
            queue={filtered}
            onRemoveDislike={toggleDislike}
          />
        ))
      ) : (
        <LibraryEmptyState
          icon={<Ban size={22} />}
          title={
            filter
              ? t('library.noMatches')
              : t('settings.dislikedTracksEmpty', 'No disliked tracks')
          }
          description={t('library.dislikesDescription')}
        />
      )}
    </div>
  );
});

export const Library = React.memo(() => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const user = useAuthStore((s) => s.user);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const dislikedCount = useDislikesStore((s) => s.dislikedTrackUrns.length);
  const heavyContentReady = useMountFrameGate(isPlaying, 3);

  const rawTabParam = searchParams.get('tab');
  const urlTab: LibraryTab = isLibraryTab(rawTabParam) ? rawTabParam : 'likes';
  const [activeTab, setActiveTabState] = useState<LibraryTab>(urlTab);

  useEffect(() => {
    setActiveTabState((current) => (current === urlTab ? current : urlTab));
  }, [urlTab]);

  const setActiveTab = useCallback(
    (tab: LibraryTab) => {
      setActiveTabState(tab);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('tab', tab);
      setSearchParams(nextParams);
      setFilter('');
    },
    [searchParams, setSearchParams],
  );

  const tabs = useMemo(
    () =>
      [
        {
          id: 'playlists',
          label: t('search.playlists'),
          icon: ListMusic,
          count: null,
        },
        {
          id: 'likes',
          label: t('library.likedTracks'),
          icon: Heart,
          count: fc(user?.public_favorites_count ?? 0),
        },
        {
          id: 'following',
          label: t('nav.following'),
          icon: Users,
          count: fc(user?.followings_count ?? 0),
        },
        {
          id: 'history',
          label: t('library.history'),
          icon: Clock,
          count: null,
        },
        {
          id: 'dislikes',
          label: t('settings.dislikedTracksTitle', 'Disliked'),
          icon: Ban,
          count: dislikedCount > 0 ? fc(dislikedCount) : null,
        },
      ] as const,
    [dislikedCount, t, user?.followings_count, user?.public_favorites_count],
  );

  const activeTabData = tabs.find((tab) => tab.id === activeTab) ?? tabs[1];
  const contentSectionRef = React.useRef<HTMLElement | null>(null);
  const activeDescription: Record<LibraryTab, string> = {
    likes: t('library.likedTracksDescription'),
    following: t('library.followingDescription'),
    playlists: t('library.playlistsDescription'),
    history: t('library.historyDescription'),
    dislikes: t('library.dislikesDescription'),
  };

  const scrollToContent = useCallback(() => {
    window.requestAnimationFrame(() => {
      const contentSection = contentSectionRef.current;
      if (!contentSection) return;

      const scrollContainer = contentSection.closest('.app-shell-scroll');
      if (!(scrollContainer instanceof HTMLElement)) {
        contentSection.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        return;
      }

      const containerRect = scrollContainer.getBoundingClientRect();
      const contentRect = contentSection.getBoundingClientRect();
      const nextTop = scrollContainer.scrollTop + (contentRect.top - containerRect.top) - 12;

      scrollContainer.scrollTo({
        top: Math.max(0, nextTop),
        behavior: 'smooth',
      });
    });
  }, []);

  const selectTabAndScroll = useCallback(
    (tab: LibraryTab) => {
      setActiveTab(tab);
      scrollToContent();
    },
    [scrollToContent, setActiveTab],
  );

  if (!user) return null;

  return (
    <div className="space-y-6 p-4 pb-5 sm:p-6">
      <LibraryHero
        onTabLikes={() => selectTabAndScroll('likes')}
        onTabFollowing={() => selectTabAndScroll('following')}
        onTabPlaylists={() => selectTabAndScroll('playlists')}
        onTabHistory={() => selectTabAndScroll('history')}
      />

      <section className="glass rounded-[30px] border border-white/[0.08] px-5 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div
            className="overflow-x-auto border-b border-white/[0.06] lg:flex-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: 'none' }}
          >
            <div className="flex min-w-max items-center gap-4 pr-2">
              {tabs.map((tab) => (
                <LibraryTabButton
                  key={tab.id}
                  label={tab.label}
                  count={tab.count}
                  isActive={activeTab === tab.id}
                  icon={tab.icon}
                  onClick={() => setActiveTab(tab.id)}
                />
              ))}
            </div>
          </div>

          <div className="relative w-full lg:max-w-[220px] xl:max-w-[248px]">
            <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-white/24">
              <SearchIcon size={14} />
            </div>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('library.filter')}
              className="glass-flat h-10 w-full rounded-full border border-white/[0.08] bg-white/[0.02] pl-10 pr-10 text-[12px] text-white/84 outline-none transition-all duration-200 placeholder:text-white/24 focus:border-white/[0.12] focus:bg-white/[0.04]"
            />
            {filter ? (
              <button
                type="button"
                onClick={() => setFilter('')}
                className="absolute inset-y-0 right-3 flex items-center text-white/28 transition-colors duration-200 hover:text-white/62"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section
        ref={contentSectionRef}
        className="glass rounded-[32px] border border-white/[0.08] px-5 py-5 sm:px-6 sm:py-6"
      >
        <LibrarySectionTitle
          eyebrow={`${t('library.section')} • ${activeTabData.label}`}
          title={activeTabData.label}
          description={activeDescription[activeTab]}
          action={
            activeTab === 'history' ? (
              <HistoryHeaderAction />
            ) : (
              <div className="hidden items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/34 md:flex">
                <Disc3 size={12} />
                <span>{t('library.heroBadge')}</span>
              </div>
            )
          }
        />

        <div className="mt-6">
          {heavyContentReady ? (
            <>
              {activeTab === 'likes' ? <LikesTab filter={deferredFilter} /> : null}
              {activeTab === 'following' ? <FollowingTab filter={deferredFilter} /> : null}
              {activeTab === 'playlists' ? <PlaylistsTab filter={deferredFilter} /> : null}
              {activeTab === 'history' ? <HistoryTab filter={deferredFilter} /> : null}
              {activeTab === 'dislikes' ? <DislikesTab filter={deferredFilter} /> : null}
            </>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="glass-flat rounded-[24px] p-3.5">
                  <div className="flex items-center gap-3.5">
                    <div className="h-12 w-12 shrink-0 rounded-[16px] bg-white/[0.04]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/4 rounded-full bg-white/[0.06]" />
                      <div className="h-3 w-1/2 rounded-full bg-white/[0.04]" />
                    </div>
                    <div className="h-9 w-9 rounded-full bg-white/[0.04]" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
});
