import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  toContextMenuUserEntity,
  useContextMenuTarget,
} from '../components/context-menu/context-menu-registry';
import { AddToPlaylistDialog } from '../components/music/AddToPlaylistDialog';
import { LikeButton } from '../components/music/LikeButton';
import { PlaylistCard } from '../components/music/PlaylistCard';
import { SoundWaveLaunchButton } from '../components/music/SoundWaveLaunchButton';
import { Avatar } from '../components/ui/Avatar';
import { CopyLinkButton } from '../components/ui/CopyLinkButton';
import { api } from '../lib/api';
import { preloadTrack } from '../lib/audio';
import { art, dur, fc } from '../lib/formatters';
import {
  type SCUser,
  type UserProfile,
  useUser,
  useUserArtistInsights,
  useUserFollowings,
  useUserPlaylists,
  useUserPopularTracks,
  useUserWebProfiles,
} from '../lib/hooks';
import {
  AlertCircle,
  ChevronRight,
  ChevronUp,
  Disc3,
  ExternalLink,
  Globe,
  headphones11,
  Headphones,
  heart11,
  Instagram,
  LinkIcon,
  ListPlus,
  Loader2,
  Music,
  Pause,
  Play,
  playBlack20ml1,
  Sparkles,
  Twitter,
  Users,
  X,
  Youtube,
} from '../lib/icons';
import { useTrackPlay } from '../lib/useTrackPlay';
import { useAuthStore } from '../stores/auth';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';

function getProfileDate(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(String(value).replace(/\//g, '-').replace(' +0000', 'Z'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getReleaseYear(track: Track | null | undefined): string {
  const ts = getProfileDate(track?.created_at);
  if (!ts) return '';
  return String(new Date(ts).getFullYear());
}

function getWebIcon(service: string) {
  switch (service.toLowerCase()) {
    case 'instagram':
      return <Instagram size={14} />;
    case 'twitter':
      return <Twitter size={14} />;
    case 'youtube':
      return <Youtube size={14} />;
    case 'personal':
      return <Globe size={14} />;
    default:
      return <LinkIcon size={14} />;
  }
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (!track?.urn || seen.has(track.urn)) return false;
    seen.add(track.urn);
    return true;
  });
}

function dedupeUsers(users: SCUser[]): SCUser[] {
  const seen = new Set<string>();
  return users.filter((user) => {
    if (!user?.urn || seen.has(user.urn)) return false;
    seen.add(user.urn);
    return true;
  });
}

function trimTrailingZeroes(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatMonthlyPlays(
  value: number | null | undefined,
  language: string | undefined,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (!value) return null;
  const isRussian = /^ru(?:-|$)/i.test(language || '');
  const label = t(
    'user.monthlyListeners',
    isRussian ? 'слушателей за месяц' : 'monthly listeners',
  );

  if (value >= 1_000_000) {
    const amount = trimTrailingZeroes((value / 1_000_000).toFixed(2));
    return isRussian ? `~${amount}млн ${label}` : `~${amount}M ${label}`;
  }

  if (value >= 1_000) {
    const amount = trimTrailingZeroes((value / 1_000).toFixed(1));
    return isRussian ? `~${amount}К ${label}` : `~${amount}K ${label}`;
  }

  return `~${fc(value)} ${label}`;
}

function buildProfileMeta(user: UserProfile) {
  return [user.full_name, [user.city, user.country].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' • ');
}

function HeroPlayButton({ tracks }: { tracks: Track[] }) {
  const { t } = useTranslation();
  const queue = useMemo(() => tracks.filter((track) => track.access !== 'blocked'), [tracks]);
  const trackUrns = useMemo(() => new Set(queue.map((track) => track.urn)), [queue]);
  const isPlaying = usePlayerStore(
    (s) => !!s.currentTrack && trackUrns.has(s.currentTrack.urn) && s.isPlaying,
  );
  const isPaused = usePlayerStore(
    (s) => !!s.currentTrack && trackUrns.has(s.currentTrack.urn) && !s.isPlaying,
  );

  const handlePlay = () => {
    const player = usePlayerStore.getState();
    if (isPlaying) {
      player.pause();
      return;
    }
    if (isPaused) {
      player.resume();
      return;
    }
    if (queue[0]) {
      player.play(queue[0], queue);
    }
  };

  return (
    <button
      type="button"
      onClick={handlePlay}
      disabled={queue.length === 0}
      className="inline-flex items-center gap-2.5 h-12 pl-3.5 pr-5 rounded-full bg-[#ffd047] text-black text-[14px] font-semibold shadow-[0_10px_34px_rgba(255,208,71,0.24)] transition-all duration-200 ease-[var(--ease-apple)] hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
    >
      <span className="relative w-7 h-7 rounded-full bg-black/95 text-white flex items-center justify-center">
        {isPlaying ? (
          <Pause size={16} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play
            size={14}
            fill="currentColor"
            strokeWidth={0}
            className="absolute left-1/2 top-1/2 -translate-y-1/2 -translate-x-[42%]"
          />
        )}
      </span>
      {isPlaying ? t('user.pause', 'Пауза') : isPaused ? t('user.continue', 'Продолжить') : t('user.listen', 'Слушать')}
    </button>
  );
}

function FollowBtn({ userUrn }: { userUrn: string }) {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const qc = useQueryClient();

  const { data: initialFollowing = false, isLoading: isQueryLoading } = useQuery({
    queryKey: ['following', currentUser?.urn, userUrn],
    queryFn: () =>
      api<boolean>(
        `/users/${encodeURIComponent(currentUser!.urn)}/followings/${encodeURIComponent(userUrn)}`,
      ),
    enabled: !!currentUser?.urn && !!userUrn,
  });

  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFollowing(initialFollowing);
  }, [initialFollowing]);

  const toggle = async () => {
    setLoading(true);
    const next = !following;
    setFollowing(next);
    try {
      await api(`/me/followings/${encodeURIComponent(userUrn)}`, {
        method: next ? 'PUT' : 'DELETE',
      });
      qc.invalidateQueries({ queryKey: ['following', currentUser?.urn, userUrn] });
      qc.invalidateQueries({ queryKey: ['user', userUrn] });
      qc.invalidateQueries({ queryKey: ['me', 'followings'] });
    } catch {
      setFollowing(!next);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={loading || isQueryLoading}
      className={`inline-flex items-center justify-center gap-2 h-12 px-5 rounded-full text-[13px] font-semibold transition-all duration-200 ease-[var(--ease-apple)] disabled:opacity-50 ${
        following
          ? 'bg-white/[0.06] text-white border border-white/[0.08] hover:bg-white/[0.1]'
          : 'bg-white text-black hover:bg-white/90 hover:scale-[1.03] active:scale-[0.97]'
      } cursor-pointer`}
    >
      {loading || isQueryLoading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : following ? (
        t('user.following')
      ) : (
        t('user.follow')
      )}
    </button>
  );
}

const PopularTrackRow = React.memo(function PopularTrackRow({
  track,
  index,
  queue,
}: {
  track: Track;
  index: number;
  queue: Track[];
}) {
  const navigate = useNavigate();
  const cover = art(track.artwork_url, 't200x200');
  const { isThis, isThisPlaying, togglePlay } = useTrackPlay(track, queue);
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
      className={`group grid grid-cols-[34px_54px_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-[22px] px-3 py-2.5 transition-all duration-200 ease-[var(--ease-apple)] ${
        isThis ? 'bg-white/[0.07] ring-1 ring-white/[0.08]' : 'hover:bg-white/[0.045]'
      }`}
      onMouseEnter={() => preloadTrack(track.urn)}
    >
      <button
        type="button"
        onClick={togglePlay}
        className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold transition-all duration-200 cursor-pointer ${
          isThisPlaying
            ? 'bg-white text-black shadow-[0_8px_22px_rgba(255,255,255,0.22)]'
            : 'bg-white/[0.06] text-white/55 hover:bg-white/[0.12] hover:text-white'
        }`}
      >
        {isThisPlaying ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : index + 1}
      </button>

      <button
        type="button"
        onClick={togglePlay}
        className="relative w-[54px] h-[54px] rounded-2xl overflow-hidden ring-1 ring-white/[0.08] bg-white/[0.03] shrink-0 cursor-pointer"
      >
        {cover ? (
          <img src={cover} alt="" className="w-full h-full object-cover" decoding="async" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music size={16} className="text-white/20" />
          </div>
        )}
      </button>

      <div className="min-w-0">
        <button
          type="button"
          onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          className={`block truncate text-left text-[14px] font-semibold transition-colors cursor-pointer ${
            isThis ? 'text-white' : 'text-white/92 hover:text-white'
          }`}
        >
          {track.title}
        </button>
        <button
          type="button"
          {...artistContextProps}
          onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
          className="block truncate text-left text-[12px] text-white/42 hover:text-white/72 transition-colors cursor-pointer mt-0.5"
        >
          {track.user.username}
        </button>
      </div>

      <div className="hidden md:flex items-center gap-3 text-[11px] text-white/32 tabular-nums">
        {track.playback_count != null && (
          <span className="flex items-center gap-1.5 min-w-[70px] justify-end">
            {headphones11}
            {fc(track.playback_count)}
          </span>
        )}
        {(track.favoritings_count ?? track.likes_count) != null && (
          <span className="flex items-center gap-1.5 min-w-[58px] justify-end">
            {heart11}
            {fc(track.favoritings_count ?? track.likes_count)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <LikeButton track={track} />
        <AddToPlaylistDialog trackUrn={track.urn}>
          <button
            type="button"
            className="w-8 h-8 rounded-xl flex items-center justify-center text-white/24 hover:text-white/60 hover:bg-white/[0.06] transition-all duration-200 cursor-pointer"
          >
            <ListPlus size={14} />
          </button>
        </AddToPlaylistDialog>
        <span className="text-[12px] text-white/34 tabular-nums font-medium w-12 text-right ml-1">
          {dur(track.duration)}
        </span>
      </div>
    </div>
  );
});

const ReleaseCard = React.memo(function ReleaseCard({
  track,
  compact = false,
}: {
  track: Track;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const cover = art(track.artwork_url, compact ? 't300x300' : 't500x500');
  const queue = useMemo(() => [track], [track]);
  const { isThisPlaying, togglePlay } = useTrackPlay(track, queue);
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
      className={`group rounded-[28px] border border-white/[0.06] bg-white/[0.03] overflow-hidden transition-all duration-300 ease-[var(--ease-apple)] hover:bg-white/[0.05] hover:border-white/[0.1] ${
        compact ? '' : 'shadow-[0_24px_80px_rgba(0,0,0,0.28)]'
      }`}
    >
                  <div
                    className={`relative ${compact ? 'aspect-square' : 'aspect-[0.95]'} rounded-[inherit] cursor-pointer overflow-hidden`}
                  >
        {cover ? (
          <img
            src={cover}
            alt={track.title}
            className="w-full h-full object-cover rounded-[inherit] will-change-transform transition-transform duration-700 ease-[var(--ease-apple)] group-hover:scale-[1.04]"
            decoding="async"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-white/[0.08] to-transparent flex items-center justify-center">
            <Disc3 size={compact ? 26 : 34} className="text-white/18" />
          </div>
        )}

        <div className="absolute inset-0 rounded-[inherit] bg-gradient-to-t from-black/70 via-black/5 to-transparent" />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            togglePlay();
          }}
          className="absolute left-4 bottom-4 w-12 h-12 rounded-full bg-white text-black flex items-center justify-center shadow-[0_12px_34px_rgba(255,255,255,0.22)] hover:scale-105 active:scale-[0.96] transition-transform duration-200 cursor-pointer"
        >
          {isThisPlaying ? <Pause size={18} fill="currentColor" strokeWidth={0} /> : playBlack20ml1}
        </button>
      </div>

      <div className="p-4">
        <button
          type="button"
          onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          className="block text-left w-full text-[15px] font-semibold text-white/92 hover:text-white transition-colors truncate cursor-pointer"
        >
          {track.title}
        </button>
        <button
          type="button"
          {...artistContextProps}
          onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
          className="block text-left w-full text-[12px] text-white/46 hover:text-white/72 transition-colors truncate mt-1 cursor-pointer"
        >
          {track.user.username}
        </button>
        <div className="flex items-center gap-2 mt-2 text-[11px] text-white/34">
          <span>{getReleaseYear(track) || '—'}</span>
          <span>•</span>
          <span>{'Сингл'}</span>
        </div>
      </div>
    </div>
  );
});

const SimilarArtistCard = React.memo(function SimilarArtistCard({ user }: { user: SCUser }) {
  const navigate = useNavigate();
  const userContextProps = useContextMenuTarget(
    useMemo(() => {
      const contextUser = toContextMenuUserEntity(user);
      return contextUser ? { type: 'user' as const, user: contextUser } : null;
    }, [user]),
  );

  return (
    <button
      type="button"
      {...userContextProps}
      onClick={() => navigate(`/user/${encodeURIComponent(user.urn)}`)}
      className="group flex flex-col items-center text-center gap-3 cursor-pointer"
    >
      <div className="w-[132px] h-[132px] rounded-full overflow-hidden ring-1 ring-white/[0.08] bg-white/[0.03] shadow-[0_18px_42px_rgba(0,0,0,0.22)] transition-all duration-300 ease-[var(--ease-apple)] group-hover:scale-[1.03] group-hover:ring-white/[0.14]">
        <Avatar src={user.avatar_url} alt={user.username} size={132} />
      </div>
      <div className="min-w-0 w-full px-1">
        <p className="text-[14px] font-semibold text-white/88 truncate group-hover:text-white transition-colors">
          {user.username}
        </p>
      </div>
    </button>
  );
});

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-[22px] md:text-[26px] font-extrabold tracking-tight text-white">
        {title}
      </h2>
      <ChevronRight size={22} className="text-white/42" />
    </div>
  );
}

function EmptyPanel({ title }: { title: string }) {
  return (
    <div className="rounded-[28px] border border-white/[0.06] bg-white/[0.03] px-5 py-8 text-[13px] text-white/42">
      {title}
    </div>
  );
}

export function UserPage() {
  const { urn } = useParams<{ urn: string }>();
  const { t, i18n } = useTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const [showFullAvatar, setShowFullAvatar] = useState(false);
  const [showCompactHeader, setShowCompactHeader] = useState(false);
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const heroSectionRef = useRef<HTMLElement | null>(null);

  const { data: user, isLoading: userLoading } = useUser(urn);
  const { data: webProfiles = [] } = useUserWebProfiles(urn);
  const { data: insights, isLoading: insightsLoading } = useUserArtistInsights(urn);
  const { data: popularTracksData = [], isLoading: tracksLoading } = useUserPopularTracks(urn);
  const playlistsQuery = useUserPlaylists(urn);
  const followingsQuery = useUserFollowings(urn);

  const tracks = useMemo(() => dedupeTracks(popularTracksData), [popularTracksData]);
  const popularTracks = useMemo(() => tracks.slice(0, 5), [tracks]);
  const newestTrack = useMemo(
    () => [...tracks].sort((a, b) => getProfileDate(b.created_at) - getProfileDate(a.created_at))[0] ?? null,
    [tracks],
  );
  const releaseTracks = useMemo(
    () =>
      [...tracks]
        .sort(
          (a, b) =>
            (b.playback_count ?? 0) - (a.playback_count ?? 0) ||
            getProfileDate(b.created_at) - getProfileDate(a.created_at),
        )
        .slice(0, 6),
    [tracks],
  );
  const playlists = useMemo(
    () =>
      Array.from(new Map(playlistsQuery.playlists.map((playlist) => [playlist.urn, playlist])).values()).slice(0, 6),
    [playlistsQuery.playlists],
  );
  const similarArtists = useMemo(() => {
    const base =
      insights?.similarArtists && insights.similarArtists.length > 0
        ? insights.similarArtists
        : followingsQuery.users;
    return dedupeUsers(base).filter((candidate) => candidate.urn !== user?.urn).slice(0, 7);
  }, [followingsQuery.users, insights?.similarArtists, user?.urn]);

  const avatar = art(user?.avatar_url, 't500x500');
  const isOwnProfile = currentUser?.urn === user?.urn;
  const userContextProps = useContextMenuTarget(
    useMemo(() => {
      const contextUser = toContextMenuUserEntity(user);
      return contextUser ? { type: 'user' as const, user: contextUser } : null;
    }, [user]),
  );
  const monthlyPlays = formatMonthlyPlays(
    insights?.estimatedMonthlyPlays,
    i18n.resolvedLanguage || i18n.language,
    t,
  );
  const platforms = insights?.platforms ?? [];
  const visiblePlatforms = platforms.filter((platform) => platform.source !== 'yandex_music');

  useEffect(() => {
    console.log('[artist-insights][user-page]', {
      urn,
      username: user?.username ?? null,
      insightsLoading,
      estimatedMonthlyPlays: insights?.estimatedMonthlyPlays ?? null,
      monthlyPlays,
      platforms,
      insights: insights ?? null,
    });
  }, [insights, insightsLoading, monthlyPlays, platforms, urn, user?.username]);

  useEffect(() => {
    setShowFullAvatar(false);
    setShowCompactHeader(false);
    const scrollContainer = pageRootRef.current?.parentElement;
    scrollContainer?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [urn]);

  const scrollToTop = () => {
    const scrollContainer = pageRootRef.current?.parentElement;
    scrollContainer?.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const scrollContainer = pageRootRef.current?.parentElement;
    const heroSection = heroSectionRef.current;
    if (!scrollContainer || !heroSection) return;

    let rafId = 0;

    const updateCompactHeader = () => {
      rafId = 0;
      const containerTop = scrollContainer.getBoundingClientRect().top;
      const heroBottom = heroSection.getBoundingClientRect().bottom;
      const revealThreshold = containerTop + 18;
      const nextVisible = heroBottom <= revealThreshold;

      setShowCompactHeader((prev) => (prev === nextVisible ? prev : nextVisible));
    };

    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(updateCompactHeader);
    };

    scheduleUpdate();
    scrollContainer.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      scrollContainer.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [urn, insightsLoading, monthlyPlays, user?.followers_count, user?.plan, webProfiles.length, visiblePlatforms.length]);

  const avatarModal =
    showFullAvatar && avatar && typeof document !== 'undefined'
      ? createPortal(
          <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/90 p-8 backdrop-blur-md sm:p-12">
            <div className="absolute inset-0 cursor-pointer" onClick={() => setShowFullAvatar(false)} />
            <button
              type="button"
              onClick={() => setShowFullAvatar(false)}
              className="absolute right-6 top-6 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white transition-all hover:bg-white/20 cursor-pointer"
            >
              <X size={20} />
            </button>
            <div
              className="relative z-10 flex h-[min(calc(100vw-4rem),calc(100vh-4rem))] w-[min(calc(100vw-4rem),calc(100vh-4rem))] items-center justify-center sm:h-[min(calc(100vw-6rem),calc(100vh-6rem))] sm:w-[min(calc(100vw-6rem),calc(100vh-6rem))]"
              data-sc-context-image-url={avatar}
              data-sc-context-image-alt={`${user?.username || ''} avatar`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="h-full w-full overflow-hidden rounded-[28px] border border-white/10 bg-black/24 shadow-[0_32px_128px_rgba(0,0,0,0.8)]">
                <img
                  src={avatar}
                  alt={user?.username || ''}
                  data-sc-context-image-url={avatar}
                  data-sc-context-image-alt={`${user?.username || ''} avatar`}
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                  className="h-full w-full animate-zoom-in object-cover"
                />
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  if (userLoading || !user) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={28} className="text-accent animate-spin" />
      </div>
    );
  }

  return (
    <>
      {avatarModal}
      <div
        ref={pageRootRef}
        className="px-6 pb-10 select-none"
        onContextMenuCapture={(event) => event.preventDefault()}
        onDragStartCapture={(event) => event.preventDefault()}
      >
        <div className="sticky top-0 z-20 h-0 pointer-events-none">
          <div
            className={`absolute inset-x-0 top-3 ${
              showCompactHeader
                ? 'pointer-events-auto visible opacity-100'
                : 'pointer-events-none invisible opacity-0'
            }`}
          >
            <div className="relative overflow-hidden rounded-[24px] bg-black/20 shadow-[0_10px_30px_rgba(0,0,0,0.18)] ring-1 ring-inset ring-white/[0.06]">
              <div className="absolute inset-0 rounded-[24px] bg-black/20 backdrop-blur-2xl" />
              <div
                className={`relative flex items-center gap-3 px-4 py-3 transition-[opacity,transform] duration-500 ${
                  showCompactHeader
                    ? 'opacity-100 translate-y-0 ease-[cubic-bezier(0.22,1,0.36,1)]'
                    : 'opacity-0 -translate-y-2 ease-[cubic-bezier(0.4,0,1,1)]'
                }`}
              >
                <button
                  type="button"
                  {...userContextProps}
                  onClick={() => avatar && setShowFullAvatar(true)}
                  data-sc-disable-context-image="true"
                  className="relative w-10 h-10 rounded-full overflow-hidden ring-1 ring-white/[0.08] shrink-0 cursor-pointer"
                >
                  <Avatar key={user.urn || urn} src={user.avatar_url} alt={user.username} size={40} />
                </button>
                <div className="relative min-w-0 flex-1">
                  <h1 className="text-[28px] leading-none font-extrabold tracking-tight text-white truncate">
                    {user.username}
                  </h1>
                </div>
                <button
                  type="button"
                  onClick={scrollToTop}
                  className="relative ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-[0_10px_24px_rgba(255,255,255,0.18)] transition-transform duration-200 hover:scale-[1.04] active:scale-[0.97] cursor-pointer"
                  aria-label={t('user.scrollTop', 'Наверх')}
                  title={t('user.scrollTop', 'Наверх')}
                >
                  <ChevronUp size={20} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </div>
        </div>

      <div className="space-y-8">
        {isOwnProfile && (
          <div className="rounded-[24px] border border-amber-500/16 bg-amber-500/[0.08] px-5 py-3.5 text-[13px] text-amber-200/90 flex items-center gap-3">
            <AlertCircle size={18} />
            {t('user.publicProfile')}
          </div>
        )}

        <section {...userContextProps} ref={heroSectionRef} className="relative">
          <div className="relative px-0 py-2 md:py-4 lg:py-6">
            <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-8 items-center">
              <button
                type="button"
                onClick={() => avatar && setShowFullAvatar(true)}
                data-sc-disable-context-image="true"
                className="relative w-[180px] h-[180px] md:w-[220px] md:h-[220px] rounded-full overflow-hidden ring-1 ring-white/[0.08] bg-white/[0.03] shadow-[0_28px_70px_rgba(0,0,0,0.34)] cursor-pointer transition-transform duration-300 ease-[var(--ease-apple)] hover:scale-[1.02]"
              >
                {avatar ? (
                  <img
                    key={user.urn || avatar}
                    src={avatar}
                    alt={user.username}
                    className="block w-full h-full object-cover"
                    decoding="async"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Users size={56} className="text-white/20" />
                  </div>
                )}
              </button>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  {user.plan && user.plan !== 'Free' && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#ffd047]/14 border border-[#ffd047]/25 px-3 py-1.5 text-[12px] font-semibold text-[#ffe08a]">
                      <Sparkles size={12} />
                      {user.plan}
                    </span>
                  )}
                </div>

                <h2 className="text-[42px] md:text-[64px] leading-[0.96] font-black tracking-[-0.04em] text-white">
                  {user.username}
                </h2>

                {buildProfileMeta(user) && (
                  <p className="mt-3 text-[14px] text-white/58 max-w-[780px]">{buildProfileMeta(user)}</p>
                )}

                <div className="flex flex-wrap items-center gap-3 mt-5">
                  {monthlyPlays && (
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.06] px-4 py-2 text-[13px] font-medium text-white/82">
                      <Headphones size={15} className="text-white/54" />
                      {monthlyPlays}
                    </div>
                  )}
                  {!monthlyPlays && insightsLoading && (
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.06] px-4 py-2 text-[13px] font-medium text-white/70">
                      <Loader2 size={14} className="animate-spin text-white/48" />
                      {t('user.loadingListeners', 'Слушатели...')}
                    </div>
                  )}
                  {user.followers_count != null && (
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.04] px-4 py-2 text-[13px] font-medium text-white/70">
                      <Users size={14} className="text-white/45" />
                      {fc(user.followers_count)} {t('user.followers').toLowerCase()}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 mt-7">
                  <HeroPlayButton tracks={tracks} />
                  <SoundWaveLaunchButton
                    seedTracks={tracks}
                    context={{
                      kind: 'artist',
                      key: user.urn,
                      title: user.username,
                      subtitle: user.full_name || undefined,
                    }}
                    variant="hero"
                  />
                  {!isOwnProfile && <FollowBtn userUrn={user.urn} />}
                  <CopyLinkButton url={user.permalink_url} />
                </div>

                {visiblePlatforms.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2.5 mt-7">
                    {visiblePlatforms.map((platform) => (
                      <a
                        key={`${platform.source}-${platform.matchedName}`}
                        href={platform.url || undefined}
                        target={platform.url ? '_blank' : undefined}
                        rel={platform.url ? 'noopener noreferrer' : undefined}
                        className={`inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[12px] text-white/66 ${
                          platform.url ? 'hover:bg-white/[0.08] hover:text-white transition-colors' : ''
                        }`}
                      >
                        <Globe size={13} className="text-white/42" />
                        {platform.label}
                        {platform.url && <ExternalLink size={12} className="text-white/34" />}
                      </a>
                    ))}
                  </div>
                )}

                {webProfiles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2.5 mt-4">
                    {webProfiles.slice(0, 5).map((link) => (
                      <a
                        key={link.id}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-black/18 px-3 py-2 text-[12px] text-white/62 hover:bg-white/[0.08] hover:text-white transition-colors"
                      >
                        {getWebIcon(link.service)}
                        <span className="truncate max-w-[180px]">{link.title}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_360px] gap-8">
          <section className="min-w-0 space-y-4">
            <SectionHeading title={t('user.popular', 'Популярные треки')} />

            <div className="rounded-[32px] border border-white/[0.06] bg-white/[0.03] p-3 md:p-4 shadow-[0_24px_70px_rgba(0,0,0,0.22)]">
              {tracksLoading ? (
                <div className="py-10 flex justify-center">
                  <Loader2 size={24} className="animate-spin text-white/24" />
                </div>
              ) : popularTracks.length === 0 ? (
                <EmptyPanel title={t('user.noPopularTracksFound')} />
              ) : (
                <div className="space-y-1.5">
                  {popularTracks.map((track, index) => (
                    <PopularTrackRow key={track.urn} track={track} index={index} queue={tracks} />
                  ))}
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-4">
            <SectionHeading title={t('user.newRelease', 'Новый релиз')} />
            {newestTrack ? (
              <ReleaseCard track={newestTrack} />
            ) : (
              <EmptyPanel title={t('user.noTracksFound')} />
            )}

            {user.description && (
              <section className="rounded-[32px] border border-white/[0.06] bg-white/[0.03] p-5">
                <h3 className="text-[13px] font-bold uppercase tracking-[0.18em] text-white/36 mb-3">
                  {t('user.about')}
                </h3>
                <p className="text-[13px] leading-6 text-white/62 whitespace-pre-wrap break-words">
                  {user.description}
                </p>
              </section>
            )}

            {insightsLoading && !insights && (
              <section className="rounded-[32px] border border-white/[0.06] bg-white/[0.03] px-5 py-6 flex items-center gap-3 text-white/42 text-[13px]">
                <Loader2 size={18} className="animate-spin" />
                {t('user.loadingInsights', 'Собираем данные об артисте')}
              </section>
            )}
          </aside>
        </div>

        {releaseTracks.length > 0 && (
          <section className="space-y-4">
            <SectionHeading title={t('user.popularReleases', 'Популярные релизы')} />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-5">
              {releaseTracks.map((track) => (
                <ReleaseCard key={track.urn} track={track} compact />
              ))}
            </div>
          </section>
        )}

        {playlists.length > 0 && (
          <section className="space-y-4">
            <SectionHeading title={t('user.playlists')} />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-5">
              {playlists.map((playlist) => (
                <PlaylistCard key={playlist.urn} playlist={playlist} showPlayback />
              ))}
            </div>
          </section>
        )}

        {similarArtists.length > 0 && (
          <section className="space-y-4">
            <SectionHeading title={t('user.similarArtists', 'Похожие исполнители')} />
            <div className="rounded-[32px] border border-white/[0.06] bg-white/[0.03] p-5 md:p-6 overflow-x-auto">
              <div className="flex items-start gap-6 min-w-max">
                {similarArtists.map((artist) => (
                  <SimilarArtistCard key={artist.urn} user={artist} />
                ))}
              </div>
            </div>
          </section>
        )}

        {webProfiles.length > 5 && (
          <section className="space-y-4">
            <SectionHeading title={t('user.links')} />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {webProfiles.slice(5).map((link) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group rounded-[24px] border border-white/[0.06] bg-white/[0.03] px-4 py-4 flex items-center gap-3 hover:bg-white/[0.05] hover:border-white/[0.1] transition-all duration-200"
                >
                  <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center text-white/46 group-hover:text-white transition-colors">
                    {getWebIcon(link.service)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-white/84 truncate">{link.title}</p>
                    {link.username && <p className="text-[11px] text-white/36 truncate mt-0.5">@{link.username}</p>}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {!tracksLoading && tracks.length === 0 && playlists.length === 0 && (
          <EmptyPanel title={t('user.noTracksFound')} />
        )}
      </div>
      </div>
    </>
  );
}
