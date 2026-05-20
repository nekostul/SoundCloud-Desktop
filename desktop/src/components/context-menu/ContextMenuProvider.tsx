import { useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
  Clipboard,
  Copy,
  Download,
  FolderPlus,
  Heart,
  Link2,
  ListMusic,
  ListPlus,
  LoaderCircle,
  Music2,
  Play,
  RefreshCw,
  Repeat2,
  Scissors,
  SkipForward,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import type React from 'react';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { invalidateAllLikesCache } from '../../lib/hooks';
import { isUrnLiked, optimisticToggleLike, setLikedUrn } from '../../lib/likes';
import { isTauriRuntime } from '../../lib/runtime';
import { useAuthStore } from '../../stores/auth';
import { type Track, usePlayerStore } from '../../stores/player';
import { AddToPlaylistDialog } from '../music/AddToPlaylistDialog';
import {
  type ContextMenuPlaylistEntity,
  type ContextMenuTrackTarget,
  type ContextMenuUserEntity,
  getContextMenuTargetById,
} from './context-menu-registry';

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type ImageContext = {
  src: string;
  alt: string;
};

type TextMenuContext = {
  type: 'text';
  selectionText: string;
  target: HTMLElement | null;
};

type InputMenuContext = {
  type: 'input';
  target: EditableTarget;
};

type BlankMenuContext = {
  type: 'blank';
  image: ImageContext | null;
};

type TrackMenuContext = {
  type: 'track';
  target: ContextMenuTrackTarget;
  image: ImageContext | null;
};

type PlaylistMenuContext = {
  type: 'playlist';
  playlist: ContextMenuPlaylistEntity;
  image: ImageContext | null;
};

type UserMenuContext = {
  type: 'user';
  user: ContextMenuUserEntity;
  image: ImageContext | null;
};

type MenuContextState =
  | TextMenuContext
  | InputMenuContext
  | BlankMenuContext
  | TrackMenuContext
  | PlaylistMenuContext
  | UserMenuContext;

type MenuActionItem = {
  id: string;
  label: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  onSelect?: () => void | Promise<void>;
  disabled?: boolean;
  separator?: false;
  danger?: boolean;
  trailing?: string;
};

type MenuSeparatorItem = {
  id: string;
  separator: true;
};

type MenuItem = MenuActionItem | MenuSeparatorItem;

type MenuState = {
  key: number;
  rawX: number;
  rawY: number;
  x: number;
  y: number;
  transformOrigin: string;
  context: MenuContextState;
};

type ContextMenuController = {
  closeMenu: () => void;
};

const ContextMenuControllerContext = createContext<ContextMenuController | null>(null);

const MENU_PADDING = 8;
const CONTEXT_IMAGE_SELECTOR = '[data-sc-context-image-url]';
const DISABLED_CONTEXT_IMAGE_SELECTOR = '[data-sc-disable-context-image="true"]';

function isEditableElement(target: EventTarget | null): target is EditableTarget {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isTextInputElement(
  target: EditableTarget,
): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function getSelectionText() {
  return window.getSelection()?.toString().trim() ?? '';
}

function isNonEmptySelectionInsideTarget(target: EventTarget | null) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const targetNode = target instanceof Node ? target : null;

  if (!anchorNode || !focusNode || !targetNode) {
    return selection.toString().trim().length > 0;
  }

  return (
    selection.toString().trim().length > 0 &&
    targetNode.contains(anchorNode) &&
    targetNode.contains(focusNode)
  );
}

function getSemanticContextTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;

  const contextHost = target.closest<HTMLElement>('[data-sc-context-id]');
  if (!contextHost) return null;

  return getContextMenuTargetById(contextHost.dataset.scContextId);
}

function getImageContext(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;

  const image = target.closest('img');
  if (image instanceof HTMLImageElement) {
    const src = image.currentSrc || image.src;
    if (src) {
      return {
        src,
        alt: image.alt?.trim() ?? '',
      } satisfies ImageContext;
    }
  }

  const imageHost = target.closest<HTMLElement>(CONTEXT_IMAGE_SELECTOR);
  const hostSrc = imageHost?.dataset.scContextImageUrl?.trim();
  const hostAlt = imageHost?.dataset.scContextImageAlt?.trim() ?? '';
  const hostedImage = imageHost?.querySelector('img');
  const hostedImageSrc =
    hostedImage instanceof HTMLImageElement ? hostedImage.currentSrc || hostedImage.src : '';
  if (hostedImageSrc) {
    return {
      src: hostedImageSrc,
      alt: hostedImage?.alt?.trim() || hostAlt,
    } satisfies ImageContext;
  }
  if (hostSrc) {
    return {
      src: hostSrc,
      alt: hostAlt,
    } satisfies ImageContext;
  }

  if (target.closest(DISABLED_CONTEXT_IMAGE_SELECTOR)) {
    return null;
  }

  return null;
}

function selectElementContents(element: HTMLElement | null) {
  if (!element) return;

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchInputEvent(target: EditableTarget) {
  target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
}

async function copyTextToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

async function copySelectionToClipboard(target: EditableTarget | HTMLElement | null) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    const selected = target.value.slice(start, end) || target.value;
    if (!selected) return;
    await copyTextToClipboard(selected);
    return;
  }

  const selectedText = getSelectionText();
  if (selectedText) {
    await copyTextToClipboard(selectedText);
    return;
  }

  if (target) {
    await copyTextToClipboard(target.textContent?.trim() ?? '');
  }
}

async function pasteIntoEditable(target: EditableTarget) {
  const text = await navigator.clipboard.readText();

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.focus();
    target.setRangeText(text, start, end, 'end');
    dispatchInputEvent(target);
    return;
  }

  target.focus();
  document.execCommand('insertText', false, text);
}

async function cutEditableSelection(target: EditableTarget) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    const selected = target.value.slice(start, end);
    if (!selected) return;
    await copyTextToClipboard(selected);
    target.setRangeText('', start, end, 'end');
    dispatchInputEvent(target);
    return;
  }

  const selectedText = getSelectionText();
  if (!selectedText) return;
  await copyTextToClipboard(selectedText);
  document.execCommand('delete');
}

function selectAllEditable(target: EditableTarget) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    target.select();
    return;
  }

  target.focus();
  selectElementContents(target);
}

function dedupeTracksByUrn(tracks: Track[]) {
  const seen = new Set<string>();
  const unique: Track[] = [];

  for (const track of tracks) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    unique.push(track);
  }

  return unique;
}

async function ensurePlaylistTracks(playlist: ContextMenuPlaylistEntity) {
  if (Array.isArray(playlist.tracks) && playlist.tracks.length > 0) {
    return dedupeTracksByUrn(playlist.tracks);
  }

  const result = await api<{ collection: Track[] }>(
    `/playlists/${encodeURIComponent(playlist.urn)}/tracks?limit=200`,
  );

  return dedupeTracksByUrn(result.collection ?? []);
}

function compactMenuItems(items: MenuItem[]) {
  const compact: MenuItem[] = [];

  for (const item of items) {
    if (item.separator) {
      if (compact.length === 0 || compact[compact.length - 1]?.separator) continue;
      compact.push(item);
      continue;
    }

    compact.push(item);
  }

  if (compact[compact.length - 1]?.separator) {
    compact.pop();
  }

  return compact;
}

function isActionMenuItem(item: MenuItem): item is MenuActionItem {
  return !item.separator;
}

function buildInternalRouteUrl(path: string) {
  return `${window.location.origin}${path}`;
}

function buildImageFileStem(context: MenuContextState, image: ImageContext): string {
  if (context.type === 'track') {
    return `${context.target.track.user.username} - ${context.target.track.title}`;
  }

  if (context.type === 'playlist') {
    return context.playlist.user?.username
      ? `${context.playlist.user.username} - ${context.playlist.title}`
      : context.playlist.title;
  }

  if (context.type === 'user') {
    return `${context.user.username} avatar`;
  }

  return image.alt || 'soundcloud-image';
}

function resolveLinkForContext(context: MenuContextState) {
  switch (context.type) {
    case 'track':
      return (
        context.target.track.permalink_url ||
        buildInternalRouteUrl(`/track/${encodeURIComponent(context.target.track.urn)}`)
      );
    case 'playlist':
      return (
        context.playlist.permalink_url ||
        buildInternalRouteUrl(`/playlist/${encodeURIComponent(context.playlist.urn)}`)
      );
    case 'user':
      return (
        context.user.permalink_url ||
        buildInternalRouteUrl(`/user/${encodeURIComponent(context.user.urn)}`)
      );
    default:
      return window.location.href;
  }
}

export function useContextMenuController() {
  return useContext(ContextMenuControllerContext);
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);
  const playerQueue = usePlayerStore((state) => state.queue);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [followState, setFollowState] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [addToPlaylistTrackUrns, setAddToPlaylistTrackUrns] = useState<string[] | null>(null);

  const closeMenu = useCallback(() => {
    setMenuState(null);
    setFollowLoading(false);
    setFollowState(null);
  }, []);

  useEffect(() => {
    void location.key;
    closeMenu();
  }, [closeMenu, location.key]);

  useEffect(() => {
    if (!menuState || menuState.context.type !== 'user' || !currentUser?.urn) {
      setFollowLoading(false);
      setFollowState(null);
      return;
    }

    const { user } = menuState.context;
    if (user.urn === currentUser.urn) {
      setFollowLoading(false);
      setFollowState(null);
      return;
    }

    let cancelled = false;

    setFollowLoading(true);
    setFollowState(null);

    api<boolean>(
      `/users/${encodeURIComponent(currentUser.urn)}/followings/${encodeURIComponent(user.urn)}`,
    )
      .then((value) => {
        if (!cancelled) {
          setFollowState(Boolean(value));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFollowState(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFollowLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser?.urn, menuState]);

  useEffect(() => {
    if (!menuState) {
      delete document.body.dataset.scContextMenuOpen;
      return;
    }

    document.body.dataset.scContextMenuOpen = '1';

    return () => {
      delete document.body.dataset.scContextMenuOpen;
    };
  }, [menuState]);

  const showClipboardError = useCallback(() => {
    toast.error(t('common.error'));
  }, [t]);

  const copyLinkWithToast = useCallback(
    async (url: string) => {
      try {
        await copyTextToClipboard(url);
        toast.success(t('contextMenu.linkCopied'));
      } catch {
        showClipboardError();
      }
    },
    [showClipboardError, t],
  );

  const toggleTrackLike = useCallback(
    async (track: Track) => {
      const nextLiked = !(isUrnLiked(track.urn) || Boolean(track.user_favorite));
      const cachedTrack = queryClient.getQueryData<Track>(['track', track.urn]);

      if (cachedTrack) {
        optimisticToggleLike(queryClient, cachedTrack, nextLiked);
      } else {
        setLikedUrn(track.urn, nextLiked);
      }

      invalidateAllLikesCache();

      try {
        await api(`/likes/tracks/${encodeURIComponent(track.urn)}`, {
          method: nextLiked ? 'POST' : 'DELETE',
        });
        queryClient.invalidateQueries({ queryKey: ['track', track.urn, 'favoriters'] });
      } catch {
        if (cachedTrack) {
          optimisticToggleLike(queryClient, cachedTrack, !nextLiked);
        } else {
          setLikedUrn(track.urn, !nextLiked);
        }
        throw new Error('toggle-track-like-failed');
      }
    },
    [queryClient],
  );

  const togglePlaylistLike = useCallback(
    async (playlist: ContextMenuPlaylistEntity) => {
      const nextLiked = !playlist.user_favorite;
      const previousPlaylist = queryClient.getQueryData(['playlist', playlist.urn]);

      queryClient.setQueryData(['playlist', playlist.urn], (previous: unknown) =>
        previous && typeof previous === 'object'
          ? { ...(previous as Record<string, unknown>), user_favorite: nextLiked }
          : previous,
      );

      try {
        await api(`/likes/playlists/${encodeURIComponent(playlist.urn)}`, {
          method: nextLiked ? 'POST' : 'DELETE',
        });
        queryClient.invalidateQueries({ queryKey: ['playlist', playlist.urn] });
        queryClient.invalidateQueries({ queryKey: ['likes', 'playlist', playlist.urn] });
        queryClient.invalidateQueries({ queryKey: ['me', 'likes', 'playlists'] });
      } catch {
        queryClient.setQueryData(['playlist', playlist.urn], previousPlaylist);
        throw new Error('toggle-playlist-like-failed');
      }
    },
    [queryClient],
  );

  const toggleFollowUser = useCallback(
    async (user: ContextMenuUserEntity) => {
      if (!currentUser?.urn || currentUser.urn === user.urn) return;

      const nextFollow = !followState;
      setFollowState(nextFollow);

      try {
        await api(`/me/followings/${encodeURIComponent(user.urn)}`, {
          method: nextFollow ? 'PUT' : 'DELETE',
        });
        queryClient.invalidateQueries({ queryKey: ['following', currentUser.urn, user.urn] });
        queryClient.invalidateQueries({ queryKey: ['user', user.urn] });
        queryClient.invalidateQueries({ queryKey: ['me', 'followings'] });
      } catch {
        setFollowState(!nextFollow);
        throw new Error('toggle-follow-failed');
      }
    },
    [currentUser?.urn, followState, queryClient],
  );

  const saveImage = useCallback(
    async (context: MenuContextState, image: ImageContext) => {
      try {
        const suggestedName = buildImageFileStem(context, image);

        if (isTauriRuntime()) {
          await invoke('save_image_to_downloads', {
            url: image.src,
            suggestedName,
          });
        } else {
          const response = await fetch(image.src);
          const blob = await response.blob();
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = suggestedName;
          anchor.click();
          URL.revokeObjectURL(href);
        }

        toast.success(t('contextMenu.imageSaved'));
      } catch (error) {
        console.error('[context-menu] save image failed:', error);
        toast.error(t('contextMenu.imageSaveFailed'));
      }
    },
    [t],
  );

  const openMenuAt = useCallback((rawX: number, rawY: number, context: MenuContextState) => {
    setMenuState({
      key: Date.now(),
      rawX,
      rawY,
      x: rawX,
      y: rawY,
      transformOrigin: 'left top',
      context,
    });
  }, []);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;

      if (target instanceof Element && target.closest('[data-sc-context-menu-root="true"]')) {
        event.preventDefault();
        return;
      }

      event.preventDefault();

      if (isEditableElement(target)) {
        openMenuAt(event.clientX, event.clientY, {
          type: 'input',
          target,
        });
        return;
      }

      if (isNonEmptySelectionInsideTarget(target)) {
        openMenuAt(event.clientX, event.clientY, {
          type: 'text',
          selectionText: getSelectionText(),
          target: target instanceof HTMLElement ? target : null,
        });
        return;
      }

      const semanticTarget = getSemanticContextTarget(target);
      const image = getImageContext(target);

      if (semanticTarget?.type === 'track') {
        openMenuAt(event.clientX, event.clientY, {
          type: 'track',
          target: semanticTarget,
          image,
        });
        return;
      }

      if (semanticTarget?.type === 'playlist') {
        openMenuAt(event.clientX, event.clientY, {
          type: 'playlist',
          playlist: semanticTarget.playlist,
          image,
        });
        return;
      }

      if (semanticTarget?.type === 'user') {
        openMenuAt(event.clientX, event.clientY, {
          type: 'user',
          user: semanticTarget.user,
          image,
        });
        return;
      }

      if (image) {
        openMenuAt(event.clientX, event.clientY, {
          type: 'blank',
          image,
        });
        return;
      }

      closeMenu();
    };

    const onBlockedShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const blockedDevtools =
        event.key === 'F12' ||
        ((event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          (key === 'i' || key === 'j' || key === 'c')) ||
        ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'u');

      if (!blockedDevtools) return;

      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('keydown', onBlockedShortcut, true);

    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('keydown', onBlockedShortcut, true);
    };
  }, [closeMenu, openMenuAt]);

  useEffect(() => {
    if (!menuState) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };

    const closeOnResize = () => closeMenu();

    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('resize', closeOnResize);
    window.addEventListener('blur', closeOnResize);
    window.addEventListener('scroll', closeOnResize, true);

    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('resize', closeOnResize);
      window.removeEventListener('blur', closeOnResize);
      window.removeEventListener('scroll', closeOnResize, true);
    };
  }, [closeMenu, menuState]);

  const addImageAction = useCallback(
    (items: MenuItem[], context: MenuContextState, image: ImageContext | null) => {
      if (!image) return items;

      if (items.length > 0) {
        items.push({ separator: true, id: 'separator-image' });
      }
      items.push({
        id: 'save-image',
        label: t('contextMenu.saveImage'),
        icon: Download,
        onSelect: async () => {
          await saveImage(context, image);
        },
      });

      return items;
    },
    [saveImage, t],
  );

  const menuItems = useMemo(() => {
    if (!menuState) return [] as MenuItem[];

    const context = menuState.context;

    if (context.type === 'blank') {
      return compactMenuItems(addImageAction([], context, context.image));
    }

    if (context.type === 'text') {
      return compactMenuItems([
        {
          id: 'copy-text',
          label: t('contextMenu.copy'),
          icon: Copy,
          disabled: !context.selectionText,
          onSelect: async () => {
            await copySelectionToClipboard(context.target);
          },
        },
        {
          id: 'select-all-text',
          label: t('contextMenu.selectAll'),
          icon: Clipboard,
          onSelect: () => {
            selectElementContents(context.target);
          },
        },
      ]);
    }

    if (context.type === 'input') {
      const textInputTarget = isTextInputElement(context.target) ? context.target : null;
      const selectedLength = textInputTarget
        ? Math.abs((textInputTarget.selectionEnd ?? 0) - (textInputTarget.selectionStart ?? 0))
        : getSelectionText().length;
      const hasValue = textInputTarget
        ? textInputTarget.value.length > 0
        : Boolean(context.target.textContent?.trim());

      return compactMenuItems([
        {
          id: 'copy-input',
          label: t('contextMenu.copy'),
          icon: Copy,
          disabled: !hasValue,
          onSelect: async () => {
            await copySelectionToClipboard(context.target);
          },
        },
        {
          id: 'paste-input',
          label: t('contextMenu.paste'),
          icon: Clipboard,
          onSelect: async () => {
            await pasteIntoEditable(context.target);
          },
        },
        {
          id: 'cut-input',
          label: t('contextMenu.cut'),
          icon: Scissors,
          disabled: selectedLength === 0,
          onSelect: async () => {
            await cutEditableSelection(context.target);
          },
        },
        {
          id: 'select-all-input',
          label: t('contextMenu.selectAll'),
          icon: Copy,
          onSelect: () => {
            selectAllEditable(context.target);
          },
        },
      ]);
    }

    if (context.type === 'track') {
      const { target, image } = context;
      const currentLiked = isUrnLiked(target.track.urn) || Boolean(target.track.user_favorite);
      const queuedTrackIndex = playerQueue.findIndex((track) => track.urn === target.track.urn);
      const removableQueueIndex =
        queuedTrackIndex >= 0
          ? queuedTrackIndex
          : typeof target.queueIndex === 'number'
            ? target.queueIndex
            : -1;
      const isTrackInQueue = removableQueueIndex >= 0;
      const items: MenuItem[] = [
        {
          id: 'play-track',
          label: t('contextMenu.play'),
          icon: Play,
          onSelect: () => {
            usePlayerStore.getState().play(target.track, target.queue);
          },
        },
        {
          id: 'play-next-track',
          label: t('contextMenu.playNext'),
          icon: SkipForward,
          onSelect: () => {
            usePlayerStore.getState().addToQueueNext([target.track]);
          },
        },
        {
          id: isTrackInQueue ? 'remove-track-from-queue' : 'add-track-to-queue',
          label: isTrackInQueue ? t('contextMenu.removeFromQueue') : t('player.addToQueue'),
          icon: isTrackInQueue ? Trash2 : ListPlus,
          onSelect: () => {
            if (isTrackInQueue) {
              usePlayerStore.getState().removeFromQueue(removableQueueIndex);
              return;
            }

            usePlayerStore.getState().addToQueue([target.track]);
          },
          danger: isTrackInQueue,
        },
        { id: 'separator-track-primary', separator: true },
        {
          id: 'toggle-track-like',
          label: currentLiked ? t('contextMenu.unlike') : t('contextMenu.like'),
          icon: Heart,
          onSelect: async () => {
            await toggleTrackLike(target.track);
          },
        },
        {
          id: 'repost-track',
          label: t('contextMenu.repost'),
          icon: Repeat2,
          onSelect: async () => {
            await api(`/reposts/tracks/${encodeURIComponent(target.track.urn)}`, {
              method: 'POST',
            });
          },
        },
        {
          id: 'add-track-to-playlist',
          label: t('playlist.addToPlaylist'),
          icon: FolderPlus,
          onSelect: () => {
            setAddToPlaylistTrackUrns([target.track.urn]);
          },
        },
        { id: 'separator-track-links', separator: true },
        {
          id: 'copy-track-link',
          label: t('contextMenu.copyLink'),
          icon: Link2,
          onSelect: async () => {
            await copyLinkWithToast(
              target.track.permalink_url ||
                buildInternalRouteUrl(`/track/${encodeURIComponent(target.track.urn)}`),
            );
          },
        },
        { id: 'separator-track-open', separator: true },
        {
          id: 'open-track',
          label: t('contextMenu.openTrack'),
          icon: Music2,
          onSelect: () => {
            navigate(`/track/${encodeURIComponent(target.track.urn)}`);
          },
        },
        {
          id: 'open-track-artist',
          label: t('contextMenu.openArtist'),
          icon: UserRound,
          onSelect: () => {
            navigate(`/user/${encodeURIComponent(target.track.user.urn)}`);
          },
        },
      ];

      if (target.parentPlaylist) {
        items.push({
          id: 'open-parent-playlist',
          label: t('contextMenu.goToPlaylist'),
          icon: ListMusic,
          onSelect: () => {
            navigate(`/playlist/${encodeURIComponent(target.parentPlaylist!.urn)}`);
          },
        });
      }

      return compactMenuItems(addImageAction(items, context, image));
    }

    if (context.type === 'playlist') {
      const items: MenuItem[] = [
        {
          id: 'play-playlist',
          label: t('contextMenu.playPlaylist'),
          icon: Play,
          onSelect: async () => {
            const tracks = await ensurePlaylistTracks(context.playlist);
            if (tracks[0]) {
              usePlayerStore.getState().play(tracks[0], tracks);
            } else {
              navigate(`/playlist/${encodeURIComponent(context.playlist.urn)}`);
            }
          },
        },
        {
          id: 'shuffle-playlist',
          label: t('contextMenu.shufflePlay'),
          icon: RefreshCw,
          onSelect: async () => {
            const tracks = await ensurePlaylistTracks(context.playlist);
            if (tracks.length === 0) {
              navigate(`/playlist/${encodeURIComponent(context.playlist.urn)}`);
              return;
            }

            const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
            usePlayerStore.getState().play(randomTrack, tracks);
            usePlayerStore.setState({ shuffle: true });
          },
        },
        { id: 'separator-playlist-actions', separator: true },
        {
          id: 'toggle-playlist-like',
          label: context.playlist.user_favorite
            ? t('contextMenu.unlikePlaylist')
            : t('contextMenu.likePlaylist'),
          icon: Heart,
          onSelect: async () => {
            await togglePlaylistLike(context.playlist);
          },
        },
        { id: 'separator-playlist-links', separator: true },
        {
          id: 'copy-playlist-link',
          label: t('contextMenu.copyLink'),
          icon: Link2,
          onSelect: async () => {
            await copyLinkWithToast(resolveLinkForContext(context));
          },
        },
      ];

      if (context.playlist.user?.urn) {
        items.push({
          id: 'open-playlist-creator',
          label: t('contextMenu.openCreator'),
          icon: Users,
          onSelect: () => {
            navigate(`/user/${encodeURIComponent(context.playlist.user!.urn)}`);
          },
        });
      }

      return compactMenuItems(addImageAction(items, context, context.image));
    }

    if (context.type === 'user') {
      const items: MenuItem[] = [
        {
          id: 'open-user-profile',
          label: t('contextMenu.openProfile'),
          icon: UserRound,
          onSelect: () => {
            navigate(`/user/${encodeURIComponent(context.user.urn)}`);
          },
        },
      ];

      if (currentUser?.urn && currentUser.urn !== context.user.urn) {
        items.push({
          id: 'toggle-user-follow',
          label: followLoading
            ? t('contextMenu.loading')
            : followState
              ? t('user.unfollow')
              : t('user.follow'),
          icon: followLoading ? LoaderCircle : Users,
          disabled: followLoading,
          onSelect: async () => {
            await toggleFollowUser(context.user);
          },
        });
      }

      items.push({ id: 'separator-user-links', separator: true });
      items.push({
        id: 'copy-user-link',
        label: t('contextMenu.copyProfileLink'),
        icon: Link2,
        onSelect: async () => {
          await copyLinkWithToast(resolveLinkForContext(context));
        },
      });

      return compactMenuItems(addImageAction(items, context, context.image));
    }

    return [] as MenuItem[];
  }, [
    addImageAction,
    copyLinkWithToast,
    currentUser?.urn,
    followLoading,
    followState,
    menuState,
    navigate,
    playerQueue,
    t,
    toggleFollowUser,
    togglePlaylistLike,
    toggleTrackLike,
  ]);

  const actionableIndexes = useMemo(
    () =>
      menuItems.reduce<number[]>((indexes, item, index) => {
        if (!item.separator && !item.disabled) {
          indexes.push(index);
        }
        return indexes;
      }, []),
    [menuItems],
  );

  useEffect(() => {
    void menuState?.key;
    setFocusIndex(actionableIndexes[0] ?? 0);
  }, [actionableIndexes, menuState?.key]);

  useLayoutEffect(() => {
    void menuItems.length;
    if (!menuState || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const nextX = Math.max(
      MENU_PADDING,
      Math.min(menuState.rawX, window.innerWidth - rect.width - MENU_PADDING),
    );
    const nextY = Math.max(
      MENU_PADDING,
      Math.min(menuState.rawY, window.innerHeight - rect.height - MENU_PADDING),
    );
    const transformOrigin = `${nextX < menuState.rawX ? 'right' : 'left'} ${
      nextY < menuState.rawY ? 'bottom' : 'top'
    }`;

    menuRef.current.focus();

    if (
      nextX !== menuState.x ||
      nextY !== menuState.y ||
      transformOrigin !== menuState.transformOrigin
    ) {
      setMenuState((current) =>
        current
          ? {
              ...current,
              x: nextX,
              y: nextY,
              transformOrigin,
            }
          : current,
      );
    }
  }, [menuItems.length, menuState]);

  const handleItemSelect = useCallback(
    async (item: MenuActionItem) => {
      if (item.disabled || !item.onSelect) return;

      closeMenu();

      try {
        await item.onSelect();
      } catch (error) {
        console.error('[context-menu] action failed:', error);
        toast.error(t('common.error'));
      }
    },
    [closeMenu, t],
  );

  const focusNextItem = useCallback(
    (direction: 1 | -1) => {
      if (actionableIndexes.length === 0) return;
      const currentPosition = actionableIndexes.indexOf(focusIndex);
      const nextPosition =
        currentPosition === -1
          ? 0
          : (currentPosition + direction + actionableIndexes.length) % actionableIndexes.length;
      setFocusIndex(actionableIndexes[nextPosition] ?? actionableIndexes[0] ?? 0);
    },
    [actionableIndexes, focusIndex],
  );

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();

      if (!menuState) return;

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          event.preventDefault();
          focusNextItem(1);
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          event.preventDefault();
          focusNextItem(-1);
          break;
        case 'Home':
          event.preventDefault();
          setFocusIndex(actionableIndexes[0] ?? 0);
          break;
        case 'End':
          event.preventDefault();
          setFocusIndex(actionableIndexes[actionableIndexes.length - 1] ?? 0);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (menuItems[focusIndex] && isActionMenuItem(menuItems[focusIndex])) {
            void handleItemSelect(menuItems[focusIndex]);
          }
          break;
        case 'Escape':
          event.preventDefault();
          closeMenu();
          break;
      }
    },
    [
      actionableIndexes,
      closeMenu,
      focusIndex,
      focusNextItem,
      handleItemSelect,
      menuItems,
      menuState,
    ],
  );

  return (
    <ContextMenuControllerContext.Provider value={{ closeMenu }}>
      {children}
      <AddToPlaylistDialog
        open={Boolean(addToPlaylistTrackUrns)}
        onOpenChange={(open) => {
          if (!open) {
            setAddToPlaylistTrackUrns(null);
          }
        }}
        trackUrns={addToPlaylistTrackUrns ?? undefined}
      />
      {menuState && typeof document !== 'undefined'
        ? createPortal(
            <div className="pointer-events-none fixed inset-0 z-[1000]">
              <div
                ref={menuRef}
                data-sc-context-menu-root="true"
                role="menu"
                tabIndex={-1}
                onKeyDown={handleMenuKeyDown}
                className="pointer-events-auto absolute min-w-[220px] max-w-[320px] overflow-hidden rounded-[18px] border border-white/10 bg-[rgba(18,18,22,0.82)] p-1.5 text-white shadow-[0_22px_72px_rgba(0,0,0,0.55)] backdrop-blur-[24px] saturate-150 outline-none"
                style={{
                  left: menuState.x,
                  top: menuState.y,
                  transformOrigin: menuState.transformOrigin,
                  animation: 'sc-context-menu-in 160ms cubic-bezier(0.18, 0.89, 0.32, 1.15)',
                }}
              >
                {menuItems.map((item, index) =>
                  item.separator ? (
                    <div key={item.id} className="mx-2 my-1 h-px bg-white/8" />
                  ) : (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => void handleItemSelect(item)}
                      onMouseEnter={() => setFocusIndex(index)}
                      className={`flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[13px] transition-all duration-150 ${
                        index === focusIndex
                          ? 'bg-white/[0.11] text-white'
                          : item.danger
                            ? 'text-red-200/90 hover:bg-red-500/[0.09]'
                            : 'text-white/78 hover:bg-white/[0.07] hover:text-white'
                      } ${item.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}
                    >
                      {item.icon
                        ? createElement(item.icon, { size: 15, className: 'shrink-0' })
                        : null}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.trailing ? (
                        <span className="text-[11px] text-white/30">{item.trailing}</span>
                      ) : null}
                    </button>
                  ),
                )}
              </div>
              <style>
                {`@keyframes sc-context-menu-in {
                  from {
                    opacity: 0;
                    transform: translateY(6px) scale(0.97);
                  }
                  to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                  }
                }`}
              </style>
            </div>,
            document.body,
          )
        : null}
    </ContextMenuControllerContext.Provider>
  );
}
