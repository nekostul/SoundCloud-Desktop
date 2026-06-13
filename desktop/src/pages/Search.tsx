import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  toContextMenuUserEntity,
  useContextMenuTarget,
} from '../components/context-menu/context-menu-registry';
import { AddToPlaylistDialog } from '../components/music/AddToPlaylistDialog';
import { LikeButton } from '../components/music/LikeButton';
import { PlaylistCard } from '../components/music/PlaylistCard';
import { TrackCard } from '../components/music/TrackCard';
import { HorizontalScroll } from '../components/ui/HorizontalScroll';
import { api } from '../lib/api';
import { preloadTrack } from '../lib/audio';
import { art, dur, fc } from '../lib/formatters';
import {
  type HistoryEntry,
  type SCUser,
  useDiscoverData,
  useFollowingTracks,
  useGenreTracks,
  useHistory,
  useInfiniteScroll,
  useLikedTracks,
  useMyFollowings,
  useRelatedPool,
  useSearchPlaylists,
  useSearchTracks,
  useSearchUsers,
} from '../lib/hooks';
import {
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  Compass,
  ExternalLink,
  headphones11,
  heart11,
  ListPlus,
  Loader2,
  Music,
  musicIcon20,
  Pause,
  Play,
  Repeat,
  Search as SearchIcon,
  Sparkles,
  Users,
  X,
} from '../lib/icons';
import { useSoundWave } from '../lib/soundwave';
import { useTrackPlay } from '../lib/useTrackPlay';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import { useSearchHistoryStore } from '../stores/searchHistory';

/* ── Components ───────────────────────────────────────────── */

const TrackRow = React.memo(
  function TrackRow({ track, queue }: { track: Track; queue: Track[] }) {
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
        className={`group flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-300 ease-[var(--ease-apple)] ${
          isThis
            ? 'bg-accent/[0.06] ring-1 ring-accent/20 shadow-[inset_0_0_20px_rgba(255,85,0,0.05)]'
            : 'hover:bg-white/[0.04]'
        }`}
        onMouseEnter={() => preloadTrack(track.urn)}
      >
        <div
          className="w-10 h-10 flex items-center justify-center shrink-0 cursor-pointer"
          onClick={togglePlay}
        >
          {isThisPlaying ? (
            <div className="w-9 h-9 rounded-full bg-accent text-accent-contrast flex items-center justify-center shadow-[0_0_15px_var(--color-accent-glow)] scale-100 animate-fade-in-up">
              <Pause size={16} fill="currentColor" strokeWidth={0} />
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-white/[0.06] group-hover:bg-white/10 flex items-center justify-center transition-all">
              <Play
                size={16}
                fill="white"
                strokeWidth={0}
                className="ml-0.5 opacity-60 group-hover:opacity-100"
              />
            </div>
          )}
        </div>

        <div className="relative w-12 h-12 rounded-xl overflow-hidden shrink-0 ring-1 ring-white/[0.08] shadow-md">
          {cover ? (
            <img src={cover} alt="" className="w-full h-full object-cover" decoding="async" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-white/[0.05] to-transparent">
              {musicIcon20}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <p
            className={`text-[14px] font-medium truncate cursor-pointer transition-colors duration-200 ${
              isThis
                ? 'text-accent drop-shadow-[0_0_8px_rgba(255,85,0,0.4)]'
                : 'text-white/90 hover:text-white'
            }`}
            onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          >
            {track.title}
          </p>
          <p
            {...artistContextProps}
            className="text-[12px] text-white/40 truncate mt-0.5 cursor-pointer hover:text-white/70 transition-colors"
            onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
          >
            {track.user.username}
          </p>
        </div>

        <div className="hidden md:flex items-center gap-4 shrink-0 pr-4">
          {track.playback_count != null && (
            <span className="text-[11px] text-white/30 tabular-nums flex items-center gap-1.5 w-16">
              {headphones11}
              {fc(track.playback_count)}
            </span>
          )}
          <span className="text-[11px] text-white/30 tabular-nums flex items-center gap-1.5 w-14">
            {heart11}
            {fc(track.favoritings_count ?? track.likes_count)}
          </span>
        </div>

        {/* Like + Add to playlist */}
        <div className="flex items-center gap-0.5 shrink-0">
          <LikeButton track={track} />
          <AddToPlaylistDialog trackUrn={track.urn}>
            <button
              type="button"
              className="cursor-pointer w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 opacity-0 group-hover:opacity-100 transition-all duration-200"
              title={t('playlist.addToPlaylist')}
            >
              <ListPlus size={14} />
            </button>
          </AddToPlaylistDialog>
        </div>

        <span className="text-[12px] text-white/30 tabular-nums font-medium shrink-0 w-12 text-right">
          {dur(track.duration)}
        </span>
      </div>
    );
  },
  (prev, next) =>
    prev.track.urn === next.track.urn && prev.track.user_favorite === next.track.user_favorite,
);

const UserCard = React.memo(({ user }: { user: SCUser }) => {
  const navigate = useNavigate();
  const avatar = art(user.avatar_url, 't300x300');
  const userContextProps = useContextMenuTarget(
    useMemo(() => {
      const contextUser = toContextMenuUserEntity(user);
      return contextUser ? { type: 'user' as const, user: contextUser } : null;
    }, [user]),
  );

  return (
    <div
      {...userContextProps}
      className="group flex flex-col items-center gap-4 p-5 rounded-3xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04] hover:border-white/[0.08] transition-all duration-300 cursor-pointer"
      onClick={() => navigate(`/user/${encodeURIComponent(user.urn)}`)}
    >
      <div className="relative w-24 h-24 rounded-full shadow-xl overflow-hidden ring-2 ring-white/[0.05] group-hover:ring-white/[0.15] group-hover:scale-105 transition-all duration-500">
        {avatar ? (
          <img
            src={avatar}
            alt={user.username}
            className="w-full h-full object-cover"
            decoding="async"
          />
        ) : (
          <div className="w-full h-full bg-white/5 flex items-center justify-center">
            <Users size={32} className="text-white/20" />
          </div>
        )}
      </div>

      <div className="text-center w-full">
        <p className="text-[15px] font-bold text-white/90 truncate group-hover:text-white transition-colors">
          {user.username}
        </p>
        <div className="flex items-center justify-center gap-3 mt-2 text-[11px] text-white/30 font-medium">
          <span className="uppercase tracking-wider flex items-center gap-1">
            <Users size={10} />
            {fc(user.followers_count)}
          </span>
        </div>
      </div>
    </div>
  );
});

/* ── URL Detection ───────────────────────────────────────── */

const SC_URL_RE = /^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\/.+/i;

function isSoundCloudUrl(input: string): boolean {
  return SC_URL_RE.test(input.trim());
}

/* ── Resolve Card ────────────────────────────────────────── */

function ResolveCard({ url, onDone }: { url: string; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'error' | 'success'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    api<{ kind: string; urn: string }>(`/resolve?url=${encodeURIComponent(url.trim())}`)
      .then((res) => {
        if (cancelled) return;
        setState('success');
        const kind = res.kind;
        const urn = res.urn;
        if (kind === 'track') {
          navigate(`/track/${encodeURIComponent(urn)}`);
        } else if (kind === 'playlist' || kind === 'system-playlist') {
          navigate(`/playlist/${encodeURIComponent(urn)}`);
        } else if (kind === 'user') {
          navigate(`/user/${encodeURIComponent(urn)}`);
        } else {
          setErrorMsg(t('search.resolveUnknownResource', { kind }));
          setState('error');
        }
        onDone();
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(e?.body ? t('search.resolveNotFound') : t('search.resolveFailed'));
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [url, navigate, onDone]);

  return (
    <div className="max-w-lg mx-auto mt-12 animate-fade-in-up">
      <div className="glass rounded-3xl p-6 border border-white/[0.06]">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center shrink-0">
            <ExternalLink size={20} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-white/80">
              {state === 'loading'
                ? t('search.resolveLoading')
                : state === 'error'
                  ? t('search.resolveError')
                  : t('search.resolveRedirecting')}
            </p>
            <p className="text-[11px] text-white/30 truncate mt-0.5">{url.trim()}</p>
          </div>
          {state === 'loading' && (
            <Loader2 size={20} className="text-accent animate-spin shrink-0" />
          )}
        </div>
        {state === 'error' && <p className="text-[12px] text-red-400/70 mt-3 pl-16">{errorMsg}</p>}
      </div>
    </div>
  );
}

/* ── Isolated Search Results ──────────────────────────────── */

/* Each search tab is its own component — only fetches its own data type */

const SearchTracksTab = React.memo(function SearchTracksTab({ query }: { query: string }) {
  const { t } = useTranslation();
  const tracksQuery = useSearchTracks(query);
  const uniqueTracks = useMemo(
    () => Array.from(new Map(tracksQuery.tracks.map((t) => [t.urn, t])).values()),
    [tracksQuery.tracks],
  );
  const sentinelRef = useInfiniteScroll(
    !!tracksQuery.hasNextPage,
    !!tracksQuery.isFetchingNextPage,
    tracksQuery.fetchNextPage,
  );

  return (
    <div className="min-h-[400px]">
      {tracksQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={32} className="animate-spin text-white/20" />
        </div>
      ) : uniqueTracks.length === 0 ? (
        <div className="py-20 text-center text-white/30">{t('search.noResults')}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {uniqueTracks.map((track, i) => (
            <TrackRow key={`${track.urn}-${i}`} track={track} queue={uniqueTracks} />
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-20 flex items-center justify-center mt-6">
        {tracksQuery.isFetchingNextPage && (
          <Loader2 size={24} className="text-white/20 animate-spin" />
        )}
      </div>
    </div>
  );
});

const SearchPlaylistsTab = React.memo(function SearchPlaylistsTab({ query }: { query: string }) {
  const { t } = useTranslation();
  const playlistsQuery = useSearchPlaylists(query);
  const uniquePlaylists = useMemo(
    () => Array.from(new Map(playlistsQuery.playlists.map((p) => [p.urn, p])).values()),
    [playlistsQuery.playlists],
  );
  const sentinelRef = useInfiniteScroll(
    !!playlistsQuery.hasNextPage,
    !!playlistsQuery.isFetchingNextPage,
    playlistsQuery.fetchNextPage,
  );

  return (
    <div className="min-h-[400px]">
      {playlistsQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={32} className="animate-spin text-white/20" />
        </div>
      ) : uniquePlaylists.length === 0 ? (
        <div className="py-20 text-center text-white/30">{t('search.noResults')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
          {uniquePlaylists.map((p, i) => (
            <PlaylistCard key={`${p.urn}-${i}`} playlist={p} />
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-20 flex items-center justify-center mt-6">
        {playlistsQuery.isFetchingNextPage && (
          <Loader2 size={24} className="text-white/20 animate-spin" />
        )}
      </div>
    </div>
  );
});

const SearchUsersTab = React.memo(function SearchUsersTab({ query }: { query: string }) {
  const { t } = useTranslation();
  const usersQuery = useSearchUsers(query);
  const uniqueUsers = useMemo(
    () => Array.from(new Map(usersQuery.users.map((u) => [u.urn, u])).values()),
    [usersQuery.users],
  );
  const sentinelRef = useInfiniteScroll(
    !!usersQuery.hasNextPage,
    !!usersQuery.isFetchingNextPage,
    usersQuery.fetchNextPage,
  );

  return (
    <div className="min-h-[400px]">
      {usersQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={32} className="animate-spin text-white/20" />
        </div>
      ) : uniqueUsers.length === 0 ? (
        <div className="py-20 text-center text-white/30">{t('search.noResults')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {uniqueUsers.map((u, i) => (
            <UserCard key={`${u.urn}-${i}`} user={u} />
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-20 flex items-center justify-center mt-6">
        {usersQuery.isFetchingNextPage && (
          <Loader2 size={24} className="text-white/20 animate-spin" />
        )}
      </div>
    </div>
  );
});

/* ── Search Hub (idle state) ──────────────────────────────── */

function HubHeading({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h2 className="text-[14px] font-bold tracking-tight text-white/90">{title}</h2>
      <span className="text-[10px] text-white/30 font-medium">{hint}</span>
    </div>
  );
}

/* Favorite artists — real follows */
const HubFavoriteArtists = React.memo(function HubFavoriteArtists() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { users, isLoading } = useMyFollowings(20);
  const artists = useMemo(() => users.slice(0, 12), [users]);

  if (!isLoading && artists.length === 0) return null;

  return (
    <section className="space-y-4">
      <HubHeading
        icon={<Users size={15} className="text-accent" />}
        title={t('search.favoriteArtists')}
        hint={t('search.favoriteArtistsHint')}
      />
      <div className="flex items-center gap-5 overflow-x-auto pt-2 pb-3.5 px-2 -mx-2 scrollbar-hide">
        {artists.map((artist) => {
          const avatar = art(artist.avatar_url, 't120x120');
          return (
            <button
              key={artist.urn}
              type="button"
              onClick={() => navigate(`/user/${encodeURIComponent(artist.urn)}`)}
              className="flex flex-col items-center gap-2 group focus:outline-none min-w-[76px] cursor-pointer"
            >
              <div className="relative w-14 h-14 rounded-full overflow-hidden border border-white/[0.08] group-hover:border-accent group-hover:scale-105 shadow-[0_4px_12px_rgba(0,0,0,0.4)] transition-all duration-300 ease-[var(--ease-apple)] bg-white/[0.02]">
                {avatar ? (
                  <img
                    src={avatar}
                    alt={artist.username}
                    className="w-full h-full object-cover grayscale-[30%] group-hover:grayscale-0 transition-all duration-300"
                    decoding="async"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Users size={18} className="text-white/20" />
                  </div>
                )}
                <div className="absolute inset-0 bg-accent/0 group-hover:bg-accent/5 transition-all duration-300" />
              </div>
              <span className="text-[10px] font-medium text-white/60 truncate w-full text-center group-hover:text-white transition-colors">
                {artist.username}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
});

/* Fresh releases from follows — real "Что они выпустили" */
const HubFreshReleases = React.memo(function HubFreshReleases() {
  const { t } = useTranslation();
  const { data, isLoading } = useFollowingTracks(20);
  const tracks = useMemo(() => data?.collection ?? [], [data]);

  if (!isLoading && tracks.length === 0) return null;

  return (
    <section className="space-y-4">
      <HubHeading
        icon={<Sparkles size={15} className="text-amber-400" />}
        title={t('search.recentReleases')}
        hint={t('search.recentReleasesHint')}
      />
      <HorizontalScroll>
        {tracks.map((track) => (
          <div key={track.urn} className="w-[170px] shrink-0">
            <TrackCard
              track={track}
              queue={tracks}
              variant="shelf"
              disableTilt
              disableHoverPreload
            />
          </div>
        ))}
      </HorizontalScroll>
    </section>
  );
});

/* "Ещё раз?" — real listening history */
const HubListenAgainRow = React.memo(function HubListenAgainRow({
  entry,
  loading,
  onPlay,
}: {
  entry: HistoryEntry;
  loading: boolean;
  onPlay: (entry: HistoryEntry) => void;
}) {
  const cover = art(entry.artworkUrl, 't120x120');
  return (
    <button
      type="button"
      onClick={() => onPlay(entry)}
      className="flex items-center gap-3 p-2 rounded-xl bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] hover:border-white/[0.08] transition-all text-left group cursor-pointer"
    >
      <div className="relative w-11 h-11 rounded-lg overflow-hidden flex-none bg-white/[0.04]">
        {cover ? (
          <img src={cover} alt={entry.title} className="w-full h-full object-cover" decoding="async" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music size={14} className="text-white/20" />
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 size={14} className="text-white animate-spin" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-white/90 truncate group-hover:text-accent transition-colors">
          {entry.title}
        </div>
        <div className="text-[9px] text-white/45 truncate mt-0.5">{entry.artistName}</div>
      </div>
    </button>
  );
});

const HubListenAgain = React.memo(function HubListenAgain() {
  const { t } = useTranslation();
  const play = usePlayerStore((s) => s.play);
  const { entries, isLoading } = useHistory(50);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Tracks played 2+ times, ordered by play count (most-played first).
  // Single-play tracks are excluded — "Ещё раз" is about repeats.
  const tracks = useMemo(() => {
    const counts = new Map<string, { entry: HistoryEntry; count: number }>();
    for (const e of entries) {
      const existing = counts.get(e.scTrackId);
      if (existing) {
        existing.count += 1;
        // Keep the most recent entry as the representative row.
      } else {
        counts.set(e.scTrackId, { entry: e, count: 1 });
      }
    }
    return [...counts.values()]
      .filter((c) => c.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((c) => c.entry);
  }, [entries]);

  const handlePlay = useCallback(
    async (entry: HistoryEntry) => {
      if (loadingId === entry.id) return;
      setLoadingId(entry.id);
      try {
        const track = await api<Track>(`/tracks/${encodeURIComponent(entry.scTrackId)}`);
        play(track, [track]);
      } finally {
        setLoadingId((cur) => (cur === entry.id ? null : cur));
      }
    },
    [loadingId, play],
  );

  // Hide entirely while history is still loading and we have nothing yet.
  if (isLoading && tracks.length === 0) return null;

  return (
    <section className="space-y-4">
      <HubHeading
        icon={<Repeat size={15} className="text-purple-400" />}
        title={t('search.listenAgain')}
        hint={t('search.listenAgainHint')}
      />
      {tracks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 rounded-2xl bg-white/[0.02] border border-white/[0.04] text-center">
          <Repeat size={20} className="text-white/20" />
          <p className="text-[12px] text-white/40">{t('search.listenAgainEmpty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {tracks.map((entry) => (
            <HubListenAgainRow
              key={entry.id}
              entry={entry}
              loading={loadingId === entry.id}
              onPlay={handlePlay}
            />
          ))}
        </div>
      )}
    </section>
  );
});

/* "Послушайте новое" — real SoundCloud recommendations, excluding already-heard tracks */
const HubDiscoverNew = React.memo(function HubDiscoverNew({
  excludeTrackIds,
  historyReady,
}: {
  excludeTrackIds: string[];
  historyReady: boolean;
}) {
  const { t } = useTranslation();

  // SoundCloud-native recommender (feed, likes-related, liked-playlist
  // continuation, charts, stations). `excludeTrackIds` drops tracks the
  // user already played; `hideLiked` drops already-liked tracks.
  const { data, isLoading } = useSoundWave({
    enabled: historyReady,
    limit: 16,
    mode: 'diverse',
    hideLiked: true,
    excludeTrackIds,
  });
  const tracks = useMemo(() => data?.tracks ?? [], [data]);

  if (!isLoading && tracks.length === 0) return null;

  return (
    <section className="space-y-4">
      <HubHeading
        icon={<Compass size={15} className="text-cyan-400" />}
        title={t('search.discoverNew')}
        hint={t('search.discoverNewHint')}
      />
      <HorizontalScroll>
        {tracks.map((track) => (
          <div key={track.urn} className="w-[170px] shrink-0">
            <TrackCard
              track={track}
              queue={tracks}
              variant="shelf"
              disableTilt
              disableHoverPreload
            />
          </div>
        ))}
      </HorizontalScroll>
    </section>
  );
});

/* "Жанры и настроения" — real genres from SoundCloud data */
const GENRE_TILE_COLORS = [
  'from-purple-600/30 via-pink-600/25 to-pink-900/10 border-purple-500/20',
  'from-cyan-600/30 via-blue-600/25 to-blue-950/10 border-cyan-500/20',
  'from-indigo-600/30 via-violet-600/25 to-indigo-950/10 border-indigo-500/20',
  'from-amber-600/30 via-red-600/25 to-orange-950/10 border-amber-500/20',
  'from-teal-600/30 via-emerald-600/25 to-emerald-950/10 border-teal-500/20',
  'from-zinc-700/30 via-neutral-800/25 to-zinc-950/10 border-zinc-600/20',
];

const HubGenres = React.memo(function HubGenres({
  genres,
  onOpenGenre,
}: {
  genres: string[];
  onOpenGenre: (genre: string) => void;
}) {
  const { t } = useTranslation();

  if (genres.length === 0) return null;

  return (
    <section className="space-y-4">
      <HubHeading
        icon={<Music size={15} className="text-pink-400" />}
        title={t('search.genresMoods')}
        hint={t('search.genresMoodsHint')}
      />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {genres.map((genre, i) => (
          <button
            key={genre}
            type="button"
            onClick={() => onOpenGenre(genre)}
            className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-300 hover:scale-[1.03] hover:shadow-[0_8px_32px_rgba(0,0,0,0.4)] cursor-pointer group bg-gradient-to-br ${
              GENRE_TILE_COLORS[i % GENRE_TILE_COLORS.length]
            }`}
          >
            <div className="flex flex-col justify-between h-16 relative z-10">
              <span className="text-[12px] font-bold tracking-tight text-white/95 group-hover:text-white transition-colors capitalize">
                {genre}
              </span>
              <div className="flex items-center gap-1 text-[9px] text-white/40 group-hover:text-white/75 transition-colors">
                <span>{t('search.genreTap')}</span>
                <ArrowUpRight
                  size={10}
                  className="transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform"
                />
              </div>
            </div>
            <div className="absolute -right-4 -bottom-4 w-12 h-12 rounded-full bg-white/5 blur-xl group-hover:bg-white/10 transition-all duration-300" />
          </button>
        ))}
      </div>
    </section>
  );
});

/* Hub container — orchestrates real-data sections */
const SearchHub = React.memo(function SearchHub({
  onOpenGenre,
}: {
  onOpenGenre: (genre: string) => void;
}) {
  const { tracks: likedTracks } = useLikedTracks(100);
  const { data: pool } = useRelatedPool(likedTracks);
  const discoverData = useDiscoverData(pool, likedTracks);
  const genres = useMemo(() => discoverData.map((d) => d.genre).slice(0, 6), [discoverData]);

  // Listening history → exclusion list for "Послушайте новое" so the user
  // isn't shown tracks they've already heard. Real SC play history.
  const { entries: historyEntries, isLoading: historyLoading } = useHistory(50);
  const excludeTrackIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of historyEntries) {
      const id = (e.scTrackId || '').split(':').pop()?.trim();
      if (id) ids.add(id);
    }
    return [...ids];
  }, [historyEntries]);

  return (
    <div className="space-y-12 animate-fade-in">
      <HubFavoriteArtists />
      <HubFreshReleases />
      <HubListenAgain />
      <HubDiscoverNew excludeTrackIds={excludeTrackIds} historyReady={!historyLoading} />
      <HubGenres genres={genres} onOpenGenre={onOpenGenre} />
    </div>
  );
});

/* ── Genre Screen ─────────────────────────────────────────── */

/* Opened from a genre tile. Tracks come from the official SoundCloud
   `GET /tracks?genres=<genre>` filter — real SC data, no local curation. */
const GenreScreen = React.memo(function GenreScreen({
  genre,
  onBack,
}: {
  genre: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const play = usePlayerStore((s) => s.play);
  const genreQuery = useGenreTracks(genre);
  const { tracks, isLoading } = genreQuery;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useInfiniteScroll(
    !!genreQuery.hasNextPage,
    !!genreQuery.isFetchingNextPage,
    genreQuery.fetchNextPage,
  );

  // Toggle the sticky backdrop once the header leaves its inline position.
  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>('.app-shell-scroll');
    if (!scroller) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setScrolled(scroller.scrollTop > 12);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Fast, smooth scroll to top (custom easing — quicker than native smooth).
  const scrollToTop = useCallback(() => {
    const scroller = rootRef.current?.closest<HTMLElement>('.app-shell-scroll');
    if (!scroller) return;
    const start = scroller.scrollTop;
    if (start <= 0) return;
    const duration = 380;
    let startTime = 0;
    const step = (ts: number) => {
      if (!startTime) startTime = ts;
      const p = Math.min(1, (ts - startTime) / duration);
      const eased = 1 - (1 - p) ** 3; // easeOutCubic
      scroller.scrollTop = Math.round(start * (1 - eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  return (
    <div ref={rootRef} className="animate-genre-enter">
      {/* Genre header — sticky, gains a blurred dark backdrop on scroll */}
      <div
        className={`sticky top-0 z-30 -mx-6 px-6 transition-all duration-300 ease-[var(--ease-apple)] ${
          scrolled
            ? 'py-3 mb-5 bg-black/40 backdrop-blur-2xl'
            : 'py-0 mb-8'
        }`}
      >
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center justify-center w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.06] text-white/60 hover:text-white hover:bg-white/[0.08] transition-all cursor-pointer shrink-0"
            aria-label={t('common.back')}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-wider text-white/30">
              {t('search.genreLabel')}
            </div>
            <h1
              className={`font-bold tracking-tight text-white/95 capitalize truncate transition-all duration-300 ease-[var(--ease-apple)] ${
                scrolled ? 'text-[18px]' : 'text-[26px]'
              }`}
            >
              {genre}
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {scrolled && (
              <button
                type="button"
                onClick={scrollToTop}
                className="flex items-center justify-center w-10 h-10 rounded-full bg-white/[0.06] border border-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.1] transition-all cursor-pointer animate-fade-in"
                aria-label={t('search.scrollTop')}
                title={t('search.scrollTop')}
              >
                <ArrowUp size={18} />
              </button>
            )}
            {tracks.length > 0 && (
              <button
                type="button"
                onClick={() => play(tracks[0], tracks)}
                className="flex items-center gap-2 px-5 h-10 rounded-full bg-accent text-accent-contrast text-[13px] font-semibold shadow-[0_0_20px_var(--color-accent-glow)] hover:bg-accent-hover transition-all cursor-pointer shrink-0"
              >
                <Play size={15} fill="currentColor" strokeWidth={0} />
                {t('search.genrePlay')}
              </button>
            )}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Loader2 size={32} className="animate-spin text-white/20" />
        </div>
      ) : tracks.length === 0 ? (
        <div className="py-24 text-center text-white/30 text-[13px]">{t('search.noResults')}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {tracks.map((track, i) => (
            <TrackRow key={`${track.urn}-${i}`} track={track} queue={tracks} />
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="h-20 flex items-center justify-center mt-6">
        {genreQuery.isFetchingNextPage && (
          <Loader2 size={24} className="text-white/20 animate-spin" />
        )}
      </div>
    </div>
  );
});


export const Search = React.memo(() => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeGenre = searchParams.get('genre')?.trim() || '';
  const [inputValue, setInputValue] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'tracks' | 'playlists' | 'users'>('tracks');
  const [resolveUrl, setResolveUrl] = useState<string | null>(null);
  const addQuery = useSearchHistoryStore((state) => state.addQuery);

  // Open a genre as a sub-view of /search (history push) so the OS/app Back
  // button always returns to the search hub — never to Home.
  const openGenre = useCallback(
    (genre: string) => {
      navigate(`/search?genre=${encodeURIComponent(genre)}`);
    },
    [navigate],
  );
  const closeGenre = useCallback(() => navigate('/search'), [navigate]);

  const isUrl = isSoundCloudUrl(inputValue);

  // Debounce logic — skip debounce for URLs
  useEffect(() => {
    if (isUrl) {
      setDebouncedQuery('');
      return;
    }

    setResolveUrl(null);
    const trimmedInput = inputValue.trim();
    if (!trimmedInput) {
      setDebouncedQuery('');
      return;
    }

    const handler = setTimeout(() => {
      setDebouncedQuery(trimmedInput);
      addQuery(trimmedInput);
    }, 500);
    return () => clearTimeout(handler);
  }, [addQuery, inputValue, isUrl]);

  // Handle Enter for URL resolve
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isUrl) {
      setResolveUrl(inputValue.trim());
    }
  };

  // Handle paste — auto-resolve if it's a SC URL
  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text');
    if (isSoundCloudUrl(pasted)) {
      e.preventDefault();
      setInputValue(pasted);
      setResolveUrl(pasted.trim());
    }
  };

  const tabs = [
    { id: 'tracks', label: t('search.tracks') },
    { id: 'playlists', label: t('search.playlists') },
    { id: 'users', label: t('search.users') },
  ] as const;

  const showIdle = !inputValue && !resolveUrl;

  // Genre sub-view — replaces the hub, keeps Back → search hub.
  if (activeGenre) {
    return (
      <div className="p-6 pb-4">
        <GenreScreen genre={activeGenre} onBack={closeGenre} />
      </div>
    );
  }

  return (
    <div className="p-6 pb-4 space-y-8">
      {/* Search Input — centered pill */}
      <div className="flex items-center justify-center w-full relative">
        <div className="relative w-full max-w-[540px]">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('search.placeholder')}
            className={`w-full h-11 px-6 pr-12 rounded-full bg-white/[0.03] hover:bg-white/[0.05] focus:bg-white/[0.06] text-[13px] text-white/90 placeholder-white/35 outline-none border transition-all duration-300 shadow-[0_4px_24px_rgba(0,0,0,0.2)] ${
              isUrl
                ? 'border-accent/30 ring-1 ring-accent/20'
                : 'border-white/[0.06] focus:border-white/[0.15]'
            }`}
            autoFocus
          />
          {inputValue ? (
            <button
              onClick={() => {
                setInputValue('');
                setResolveUrl(null);
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 p-1 rounded-full hover:bg-white/[0.06] transition-all cursor-pointer"
            >
              <X size={14} />
            </button>
          ) : (
            <SearchIcon
              size={14}
              className="absolute right-5 top-1/2 -translate-y-1/2 text-white/20 select-none pointer-events-none"
            />
          )}
          {isUrl && !resolveUrl && (
            <div className="absolute -bottom-7 left-4 text-[11px] text-accent/60 flex items-center gap-1.5">
              <ExternalLink size={10} />
              {t('search.openLinkHint')}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      {debouncedQuery && (
        <div className="flex items-center justify-center gap-1.5 p-1.5 bg-white/[0.02] border border-white/[0.05] rounded-2xl w-fit backdrop-blur-2xl shadow-lg mx-auto">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-300 ease-[var(--ease-apple)] ${
                  isActive
                    ? 'bg-white/[0.12] text-white shadow-md border border-white/[0.05]'
                    : 'text-white/40 hover:text-white/80 hover:bg-white/[0.04] border border-transparent'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Resolve */}
      {resolveUrl && (
        <ResolveCard
          url={resolveUrl}
          onDone={() => {
            setInputValue('');
            setDebouncedQuery('');
            setResolveUrl(null);
          }}
        />
      )}

      {showIdle && <SearchHub onOpenGenre={openGenre} />}

      {!resolveUrl && debouncedQuery && activeTab === 'tracks' && (
        <SearchTracksTab query={debouncedQuery} />
      )}
      {!resolveUrl && debouncedQuery && activeTab === 'playlists' && (
        <SearchPlaylistsTab query={debouncedQuery} />
      )}
      {!resolveUrl && debouncedQuery && activeTab === 'users' && (
        <SearchUsersTab query={debouncedQuery} />
      )}
    </div>
  );
});
