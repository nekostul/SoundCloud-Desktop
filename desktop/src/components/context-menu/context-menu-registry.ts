import { useEffect, useRef } from 'react';
import type { Track } from '../../stores/player';

export type ContextMenuUserEntity = {
  urn: string;
  username: string;
  avatar_url?: string | null;
  permalink_url?: string | null;
  followers_count?: number | null;
};

export type ContextMenuPlaylistEntity = {
  urn: string;
  title: string;
  artwork_url?: string | null;
  permalink_url?: string | null;
  user?: ContextMenuUserEntity | null;
  track_count?: number | null;
  likes_count?: number | null;
  user_favorite?: boolean;
  tracks?: Track[] | null;
  playlist_type?: string | null;
};

export type ContextMenuParentPlaylist = {
  urn: string;
  title: string;
  permalink_url?: string | null;
};

export type ContextMenuTrackTarget = {
  type: 'track';
  track: Track;
  queue?: Track[];
  queueIndex?: number;
  parentPlaylist?: ContextMenuParentPlaylist | null;
};

export type ContextMenuPlaylistTarget = {
  type: 'playlist';
  playlist: ContextMenuPlaylistEntity;
};

export type ContextMenuUserTarget = {
  type: 'user';
  user: ContextMenuUserEntity;
};

export type SemanticContextMenuTarget =
  | ContextMenuTrackTarget
  | ContextMenuPlaylistTarget
  | ContextMenuUserTarget;

type UserLike = {
  urn: string;
  username: string;
  avatar_url?: string | null;
  permalink_url?: string | null;
  followers_count?: number | null;
};

type PlaylistLike = {
  urn: string;
  title: string;
  artwork_url?: string | null;
  permalink_url?: string | null;
  user?: UserLike | null;
  track_count?: number | null;
  likes_count?: number | null;
  user_favorite?: boolean;
  tracks?: Track[] | null;
  playlist_type?: string | null;
};

const contextMenuRegistry = new Map<string, SemanticContextMenuTarget>();
let contextMenuRegistryCounter = 0;

function createContextMenuRegistryId() {
  contextMenuRegistryCounter += 1;
  return `sc-context-menu-${contextMenuRegistryCounter}`;
}

export function getContextMenuTargetById(id: string | null | undefined) {
  return id ? contextMenuRegistry.get(id) ?? null : null;
}

export function toContextMenuUserEntity(user: UserLike | null | undefined): ContextMenuUserEntity | null {
  if (!user?.urn || !user.username) return null;

  return {
    urn: user.urn,
    username: user.username,
    avatar_url: user.avatar_url ?? null,
    permalink_url: user.permalink_url ?? null,
    followers_count: user.followers_count ?? null,
  };
}

export function toContextMenuPlaylistEntity(
  playlist: PlaylistLike | null | undefined,
): ContextMenuPlaylistEntity | null {
  if (!playlist?.urn || !playlist.title) return null;

  return {
    urn: playlist.urn,
    title: playlist.title,
    artwork_url: playlist.artwork_url ?? null,
    permalink_url: playlist.permalink_url ?? null,
    user: toContextMenuUserEntity(playlist.user),
    track_count: playlist.track_count ?? null,
    likes_count: playlist.likes_count ?? null,
    user_favorite: Boolean(playlist.user_favorite),
    tracks: playlist.tracks ?? null,
    playlist_type: playlist.playlist_type ?? null,
  };
}

export function useContextMenuTarget(target: SemanticContextMenuTarget | null | undefined) {
  const idRef = useRef<string>(createContextMenuRegistryId());

  useEffect(() => {
    const id = idRef.current;

    if (!target) {
      contextMenuRegistry.delete(id);
      return;
    }

    contextMenuRegistry.set(id, target);

    return () => {
      contextMenuRegistry.delete(id);
    };
  }, [target]);

  return target
    ? ({
        'data-sc-context-id': idRef.current,
      } as const)
    : {};
}
