import { Injectable, Logger } from '@nestjs/common';
import { MeService } from '../me/me.service.js';
import { SoundcloudService } from '../soundcloud/soundcloud.service.js';
import type {
  ScActivity,
  ScPaginatedResponse,
  ScPlaylist,
  ScTrack,
} from '../soundcloud/soundcloud.types.js';
import { TracksService } from '../tracks/tracks.service.js';

type SoundWaveMode = 'similar' | 'diverse';

export interface RecommendResult {
  id: string;
  source?: string;
  payload?: Record<string, unknown>;
}

type TrackSource = {
  source: string;
  tracks: ScTrack[];
};

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly meService: MeService,
    private readonly tracksService: TracksService,
    private readonly sc: SoundcloudService,
  ) {}

  async getHomeRecommendations(
    token: string,
    _sessionId: string,
    opts: { limit?: number; mode?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit);
    const mode = this.normalizeMode(opts.mode);
    const sourceLimit = Math.max(limit * 2, 32);

    const [feed, likes, likedPlaylists, trending, top] = await Promise.all([
      this.safeFeed(token, sourceLimit),
      this.safeLikedTracks(token, Math.min(sourceLimit, 40)),
      this.safeLikedPlaylists(token, Math.min(sourceLimit, 40)),
      this.safeCharts(token, 'trending', Math.min(sourceLimit, 50)),
      this.safeCharts(token, 'top', Math.min(sourceLimit, 50)),
    ]);

    const likeRelated = await this.relatedFromSeeds(token, likes.slice(0, mode === 'diverse' ? 5 : 4), sourceLimit);
    const feedTracks = this.tracksFromActivities(feed);
    const playlistTracks = this.tracksFromPlaylists(likedPlaylists);

    const sources: TrackSource[] =
      mode === 'diverse'
        ? [
            { source: 'sc-feed', tracks: feedTracks },
            { source: 'sc-trending', tracks: trending },
            { source: 'sc-likes-related', tracks: likeRelated },
            { source: 'sc-playlist-continuation', tracks: playlistTracks },
            { source: 'sc-charts', tracks: top },
          ]
        : [
            { source: 'sc-feed', tracks: feedTracks },
            { source: 'sc-likes-related', tracks: likeRelated },
            { source: 'sc-playlist-continuation', tracks: playlistTracks },
            { source: 'sc-trending', tracks: trending },
            { source: 'sc-charts', tracks: top },
          ];

    return this.toRecommendResults(sources, limit);
  }

  async searchRecommendations(
    token: string,
    opts: { q?: string; limit?: number; languages?: string },
  ): Promise<RecommendResult[]> {
    const query = opts.q?.trim() ?? '';
    if (query.length < 2) return [];

    const limit = this.clampLimit(opts.limit);
    const page = await this.tracksService.search(token, {
      q: query,
      limit,
      access: 'playable,preview',
      linked_partitioning: true,
    });

    return this.toRecommendResults([{ source: 'sc-search', tracks: this.trackCollection(page) }], limit);
  }

  async getSimilarRecommendations(
    token: string,
    trackRef: string,
    opts: { limit?: number; diversity?: number; exclude?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const related = await this.safeRelated(token, anchorUrn, Math.max(limit * 2, 24));
    const exclude = this.parseExcludeIds(opts.exclude);
    exclude.add(this.extractTrackId(anchorUrn));

    return this.toRecommendResults([{ source: 'sc-related', tracks: related }], limit, exclude);
  }

  async getWaveRecommendations(
    token: string,
    _sessionId: string,
    trackRef: string,
    opts: { limit?: number; mode?: string; languages?: string; exclude?: string; recent?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit ?? 20);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const exclude = this.parseExcludeIds(opts.exclude);
    exclude.add(this.extractTrackId(anchorUrn));

    const recentUrns = this.parseTrackRefs(opts.recent)
      .map((ref) => this.normalizeTrackUrn(ref))
      .filter((urn) => urn && urn !== anchorUrn)
      .slice(0, 3);

    const anchorTrack = await this.safeTrack(token, anchorUrn);
    const station = anchorTrack ? await this.safeStationFromTrack(token, anchorTrack, limit * 2) : [];
    const related = await this.safeRelated(token, anchorUrn, Math.max(limit * 2, 24));

    const recentSources = await Promise.all(
      recentUrns.map(async (urn) => ({
        urn,
        related: await this.safeRelated(token, urn, Math.max(limit, 16)),
      })),
    );

    return this.toRecommendResults(
      [
        { source: 'sc-station', tracks: station },
        { source: 'sc-related', tracks: related },
        ...recentSources.map((source) => ({
          source: 'sc-related-refresh',
          tracks: source.related,
        })),
      ],
      limit,
      exclude,
    );
  }

  private async relatedFromSeeds(
    token: string,
    seeds: ScTrack[],
    limit: number,
  ): Promise<ScTrack[]> {
    const groups = await Promise.all(
      seeds.map((track) => this.safeRelated(token, this.normalizeTrackUrn(track.urn), limit)),
    );

    return groups.flat();
  }

  private async safeFeed(token: string, limit: number): Promise<ScActivity[]> {
    try {
      const page = await this.meService.getFeed(token, {
        limit,
        linked_partitioning: true,
        access: 'playable,preview',
      });
      return page.collection ?? [];
    } catch (error) {
      this.logger.warn(`SC feed source failed: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private async safeLikedTracks(token: string, limit: number): Promise<ScTrack[]> {
    try {
      const page = await this.meService.getLikedTracks(token, {
        limit,
        access: 'playable,preview',
        linked_partitioning: true,
      });
      return this.trackCollection(page);
    } catch (error) {
      this.logger.warn(`SC likes source failed: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private async safeLikedPlaylists(token: string, limit: number): Promise<ScPlaylist[]> {
    try {
      const page = await this.meService.getLikedPlaylists(token, {
        limit,
        linked_partitioning: true,
        access: 'playable,preview',
      });
      return page.collection ?? [];
    } catch (error) {
      this.logger.warn(`SC liked playlists source failed: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private async safeCharts(token: string, kind: 'top' | 'trending', limit: number): Promise<ScTrack[]> {
    try {
      const page = await this.sc.apiGet<unknown>('/charts', token, {
        kind,
        genre: 'soundcloud:genres:all-music',
        limit,
        linked_partitioning: true,
      });
      return this.trackCollection(page);
    } catch {
      return [];
    }
  }

  private async safeTrack(token: string, urn: string): Promise<ScTrack | null> {
    try {
      return await this.tracksService.getById(token, urn);
    } catch {
      return null;
    }
  }

  private async safeRelated(token: string, urn: string, limit: number): Promise<ScTrack[]> {
    try {
      const page = await this.tracksService.getRelated(token, urn, {
        limit,
        linked_partitioning: true,
        access: 'playable,preview',
      });
      return this.trackCollection(page);
    } catch (error) {
      this.logger.warn(`SC related source failed for ${urn}: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private async safeStationFromTrack(
    token: string,
    track: ScTrack,
    limit: number,
  ): Promise<ScTrack[]> {
    const stationUrn = track.station_urn?.trim();
    if (!stationUrn) return [];

    try {
      const page = await this.sc.apiGet<unknown>(`/stations/${stationUrn}/tracks`, token, {
        limit,
        linked_partitioning: true,
        access: 'playable,preview',
      });
      return this.trackCollection(page);
    } catch (error) {
      this.logger.warn(`SC station source failed for ${track.urn}: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private tracksFromActivities(activities: ScActivity[]): ScTrack[] {
    const tracks: ScTrack[] = [];

    for (const activity of activities) {
      const origin = activity.origin;
      if (this.isTrack(origin)) {
        tracks.push(origin);
      } else if (this.isPlaylist(origin)) {
        tracks.push(...(origin.tracks ?? []).filter((track) => this.isTrack(track)));
      }
    }

    return tracks;
  }

  private tracksFromPlaylists(playlists: ScPlaylist[]): ScTrack[] {
    return playlists.flatMap((playlist) => playlist.tracks ?? []).filter((track) => this.isTrack(track));
  }

  private trackCollection(value: unknown): ScTrack[] {
    const raw = this.unwrapCollection(value);
    const tracks: ScTrack[] = [];

    for (const entry of raw) {
      if (this.isTrack(entry)) {
        tracks.push(entry);
        continue;
      }

      const record = entry as { track?: unknown; origin?: unknown; playlist?: unknown };
      if (this.isTrack(record.track)) {
        tracks.push(record.track);
      } else if (this.isTrack(record.origin)) {
        tracks.push(record.origin);
      } else if (this.isPlaylist(record.playlist)) {
        tracks.push(...(record.playlist.tracks ?? []).filter((track) => this.isTrack(track)));
      }
    }

    return tracks;
  }

  private unwrapCollection(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const collection = (value as { collection?: unknown }).collection;
      return Array.isArray(collection) ? collection : [];
    }
    return [];
  }

  private toRecommendResults(
    sources: TrackSource[],
    limit: number,
    excludeIds = new Set<string>(),
  ): RecommendResult[] {
    const seen = new Set<string>();
    const results: RecommendResult[] = [];

    for (const source of sources) {
      for (const track of source.tracks) {
        if (!this.isTrack(track) || track.access === 'blocked') continue;

        const id = this.getTrackId(track);
        if (!id || seen.has(id) || excludeIds.has(id)) continue;

        seen.add(id);
        results.push({
          id,
          source: source.source,
          payload: track as unknown as Record<string, unknown>,
        });

        if (results.length >= limit) return results;
      }
    }

    return results;
  }

  private isTrack(value: unknown): value is ScTrack {
    const track = value as ScTrack;
    return Boolean(track?.urn && track.title && track.user?.username);
  }

  private isPlaylist(value: unknown): value is ScPlaylist {
    const playlist = value as ScPlaylist;
    return Boolean(playlist?.urn && Array.isArray(playlist.tracks));
  }

  private normalizeTrackUrn(value: string): string {
    if (!value) return '';
    if (value.startsWith('soundcloud:tracks:')) return value;
    const match = value.match(/(\d+)/);
    return match ? `soundcloud:tracks:${match[1]}` : value;
  }

  private getTrackId(track: ScTrack): string {
    return this.extractTrackId(track.urn || String(track.user_id || ''));
  }

  private extractTrackId(value: string): string {
    if (!value) return '';
    return value.split(':').pop()?.trim() || '';
  }

  private parseExcludeIds(value?: string): Set<string> {
    return new Set(
      (value ?? '')
        .split(',')
        .map((entry) => this.extractTrackId(this.normalizeTrackUrn(entry.trim())))
        .filter(Boolean),
    );
  }

  private parseTrackRefs(value?: string): string[] {
    return (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private clampLimit(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
  }

  private normalizeMode(mode?: string): SoundWaveMode {
    return mode === 'diverse' ? 'diverse' : 'similar';
  }

  private stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
