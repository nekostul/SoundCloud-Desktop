import { Injectable } from '@nestjs/common';
import { SoundcloudService } from '../soundcloud/soundcloud.service.js';
import { ScPlaylist } from '../soundcloud/soundcloud.types.js';

@Injectable()
export class LikesService {
  constructor(private readonly sc: SoundcloudService) {}

  private normalizeId(resourceRef: string, resourceKind: 'tracks' | 'playlists'): string {
    const value = decodeURIComponent(resourceRef).trim();
    if (/^\d+$/.test(value)) {
      return value;
    }

    const urnMatch = value.match(
      new RegExp(`^soundcloud:${resourceKind === 'tracks' ? 'tracks' : 'playlists'}:(\\d+)$`, 'i'),
    );
    if (urnMatch) {
      return urnMatch[1];
    }

    throw new Error(`Invalid SoundCloud ${resourceKind.slice(0, -1)} reference: ${resourceRef}`);
  }

  private matchesPlaylistRef(
    playlist: ScPlaylist,
    playlistRef: string,
    normalizedId: string,
  ): boolean {
    const playlistId = (playlist as ScPlaylist & { id?: number }).id;
    return playlist.urn === playlistRef || String(playlistId ?? '') === normalizedId;
  }

  likeTrack(token: string, trackUrn: string): Promise<unknown> {
    const trackId = this.normalizeId(trackUrn, 'tracks');
    return this.sc.apiPost(`/likes/tracks/${trackId}`, token);
  }

  unlikeTrack(token: string, trackUrn: string): Promise<unknown> {
    const trackId = this.normalizeId(trackUrn, 'tracks');
    return this.sc.apiDelete(`/likes/tracks/${trackId}`, token);
  }

  likePlaylist(token: string, playlistUrn: string): Promise<unknown> {
    const playlistId = this.normalizeId(playlistUrn, 'playlists');
    return this.sc.apiPost(`/likes/playlists/${playlistId}`, token);
  }

  unlikePlaylist(token: string, playlistUrn: string): Promise<unknown> {
    const playlistId = this.normalizeId(playlistUrn, 'playlists');
    return this.sc.apiDelete(`/likes/playlists/${playlistId}`, token);
  }

  async isPlaylistLiked(token: string, playlistUrn: string): Promise<{ liked: boolean }> {
    const normalizedId = this.normalizeId(playlistUrn, 'playlists');
    let cursor: string | undefined;

    for (;;) {
      const params: Record<string, unknown> = { limit: 200, linked_partitioning: true };
      if (cursor) {
        params.cursor = cursor;
      }

      const page = await this.sc.apiGet<{ collection: ScPlaylist[]; next_href?: string }>(
        '/me/likes/playlists',
        token,
        params,
      );

      if (
        (page.collection ?? []).some((playlist) =>
          this.matchesPlaylistRef(playlist, playlistUrn, normalizedId),
        )
      ) {
        return { liked: true };
      }

      if (!page.next_href) {
        break;
      }

      const next = new URL(page.next_href);
      cursor = next.searchParams.get('cursor') ?? undefined;
      if (!cursor) {
        break;
      }
    }

    return { liked: false };
  }
}
