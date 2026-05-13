import { Injectable, Logger } from '@nestjs/common';
import { HistoryService } from '../history/history.service.js';
import { MeService } from '../me/me.service.js';
import type { ScPaginatedResponse, ScTrack } from '../soundcloud/soundcloud.types.js';
import { TracksService } from '../tracks/tracks.service.js';

type SoundWaveMode = 'similar' | 'diverse';

export interface RecommendResult {
  id: string;
  score?: number;
  payload?: Record<string, unknown>;
}

type RecommendationCandidate = {
  id: string;
  score: number;
  track: ScTrack;
  source: string;
};
type TrackLike = ScTrack | { track?: ScTrack | null } | null | undefined;

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const DEFAULT_HOME_SEED_LIMIT = 4;
const LANGUAGE_SCRIPT_REGEX: Record<string, RegExp> = {
  ru: /[\u0400-\u04FF]/,
  uk: /[іїєґІЇЄҐ]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
};
const LANGUAGE_HINTS: Record<string, string[]> = {
  en: ['english', 'uk garage', 'uk rap', 'us rap'],
  ru: ['russian', 'рус', 'russki', 'moscow', 'рос'],
  es: ['spanish', 'espanol', 'latino', 'latin trap'],
  de: ['german', 'deutsch', 'berlin'],
  fr: ['french', 'francais', 'paris'],
  it: ['italian', 'italiano'],
  pt: ['portuguese', 'brasil', 'brazil', 'brazilian'],
  ja: ['japanese', 'j-pop', 'jpop', 'anime'],
  ko: ['korean', 'k-pop', 'kpop'],
  tr: ['turkish', 'turkce'],
  pl: ['polish', 'polski'],
  uk: ['ukrainian', 'ukr', 'укра', 'kyiv', 'kiev'],
};
const LATIN_LANGUAGE_CODES = new Set(['en', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'pl']);

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly tracksService: TracksService,
    private readonly meService: MeService,
    private readonly historyService: HistoryService,
  ) {}

  async getHomeRecommendations(
    token: string,
    sessionId: string,
    opts: { limit?: number; mode?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit);
    const mode = this.normalizeMode(opts.mode);
    const languages = this.parseLanguages(opts.languages);
    const candidates = await this.buildHomeCandidates(token, sessionId, {
      limit,
      mode,
      languages,
    });
    return this.finalizeCandidates(candidates, {
      limit,
      excludeIds: new Set(),
      diversity: mode === 'diverse' ? 0.86 : 0.28,
    });
  }

  async searchRecommendations(
    token: string,
    opts: { q?: string; limit?: number; languages?: string },
  ): Promise<RecommendResult[]> {
    const query = opts.q?.trim() ?? '';
    if (query.length < 2) return [];

    const limit = this.clampLimit(opts.limit);
    const languages = this.parseLanguages(opts.languages);
    const searchLimit = Math.max(limit * 3, 24);
    const page = await this.safeSearch(token, {
      q: query,
      limit: searchLimit,
      access: 'playable,preview',
    });
    const candidates = new Map<string, RecommendationCandidate>();

    this.trackCollectionFromUnknown(page).forEach((track, index, collection) => {
      this.mergeCandidate(candidates, track, {
        score: 1.1 - index / Math.max(collection.length, 1),
        source: 'search',
        languages,
      });
    });

    return this.finalizeCandidates(candidates, {
      limit,
      excludeIds: new Set(),
      diversity: 0.16,
    });
  }

  async getSimilarRecommendations(
    token: string,
    trackRef: string,
    opts: { limit?: number; diversity?: number; exclude?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit);
    const diversity = this.clampDiversity(opts.diversity);
    const languages = this.parseLanguages(opts.languages);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const excludeIds = this.parseExcludeIds(opts.exclude);
    const anchorId = this.extractTrackId(anchorUrn);
    if (anchorId) excludeIds.add(anchorId);

    const related = await this.safeRelated(token, anchorUrn, Math.max(limit * 3, 24));
    const candidates = new Map<string, RecommendationCandidate>();

    related.forEach((track, index) => {
      this.mergeCandidate(candidates, track, {
        score: 1.35 - index / Math.max(related.length * 0.95, 1),
        source: 'similar',
        languages,
      });
    });

    return this.finalizeCandidates(candidates, {
      limit,
      excludeIds,
      diversity,
    });
  }

  async getWaveRecommendations(
    token: string,
    sessionId: string,
    trackRef: string,
    opts: { limit?: number; mode?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit ?? 20);
    const mode = this.normalizeMode(opts.mode);
    const languages = this.parseLanguages(opts.languages);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const anchorId = this.extractTrackId(anchorUrn);
    const excludeIds = new Set<string>();
    if (anchorId) excludeIds.add(anchorId);

    const [related, homeCandidates] = await Promise.all([
      this.safeRelated(token, anchorUrn, Math.max(limit * 3, 24)),
      this.buildHomeCandidates(token, sessionId, {
        limit: Math.max(limit * 2, 24),
        mode,
        languages,
      }),
    ]);

    const candidates = new Map<string, RecommendationCandidate>(homeCandidates);
    related.forEach((track, index) => {
      this.mergeCandidate(candidates, track, {
        score: 1.5 - index / Math.max(related.length * 0.9, 1),
        source: 'wave',
        languages,
      });
    });

    return this.finalizeCandidates(candidates, {
      limit,
      excludeIds,
      diversity: mode === 'diverse' ? 0.9 : 0.4,
    });
  }

  private async buildHomeCandidates(
    token: string,
    sessionId: string,
    opts: { limit: number; mode: SoundWaveMode; languages: string[] },
  ): Promise<Map<string, RecommendationCandidate>> {
    const historyLimit = opts.mode === 'diverse' ? 8 : 6;
    const likedLimit = opts.mode === 'diverse' ? 18 : 12;
    const candidateLimit = Math.max(opts.limit * 2, 24);
    const candidates = new Map<string, RecommendationCandidate>();

    const [historyResult, likedResult, followingsResult, popularResult] = await Promise.allSettled([
      this.historyService.findAll(sessionId, historyLimit, 0),
      this.meService.getLikedTracks(token, { limit: likedLimit }),
      this.meService.getFollowingsTracks(token, { limit: candidateLimit }),
      this.tracksService.search(token, { limit: candidateLimit, access: 'playable,preview' }),
    ]);

    const excludeIds = new Set<string>();
    const seeds: Array<{ urn: string; baseScore: number; source: string }> = [];

    if (historyResult.status === 'fulfilled') {
      historyResult.value.collection.forEach((entry, index) => {
        const urn = this.normalizeTrackUrn(entry.scTrackId);
        const id = this.extractTrackId(urn);
        if (!urn || !id || excludeIds.has(id)) return;
        excludeIds.add(id);
        seeds.push({
          urn,
          baseScore: 1.45 - index * 0.16,
          source: 'history',
        });
      });
    } else {
      this.logger.warn(`History recommendations seed failed: ${historyResult.reason}`);
    }

    if (likedResult.status === 'fulfilled') {
      this.trackCollectionFromUnknown(likedResult.value).forEach((track, index) => {
        const urn = this.normalizeTrackUrn(track.urn);
        const id = this.getTrackId(track);
        if (!urn || !id || excludeIds.has(id)) return;
        excludeIds.add(id);
        seeds.push({
          urn,
          baseScore: 1.08 - index * 0.08,
          source: 'likes',
        });
      });
    } else {
      this.logger.warn(`Likes recommendations seed failed: ${likedResult.reason}`);
    }

    const seedBudget = opts.mode === 'diverse' ? 5 : DEFAULT_HOME_SEED_LIMIT;
    const relatedLists = await Promise.all(
      seeds.slice(0, seedBudget).map(async (seed) => ({
        seed,
        related: await this.safeRelated(token, seed.urn, candidateLimit),
      })),
    );

    relatedLists.forEach(({ seed, related }) => {
      related.forEach((track, index) => {
        const rankBonus = 1 - index / Math.max(related.length * 1.15, 1);
        this.mergeCandidate(candidates, track, {
          score: seed.baseScore * Math.max(rankBonus, 0.12),
          source: seed.source,
          languages: opts.languages,
        });
      });
    });

    if (followingsResult.status === 'fulfilled') {
      const followings = this.trackCollectionFromUnknown(followingsResult.value);
      followings.forEach((track, index) => {
        this.mergeCandidate(candidates, track, {
          score: 0.48 - index / Math.max(followings.length * 3.6, 1),
          source: 'followings',
          languages: opts.languages,
        });
      });
    }

    if (popularResult.status === 'fulfilled') {
      const popular = this.trackCollectionFromUnknown(popularResult.value);
      popular.forEach((track, index) => {
        this.mergeCandidate(candidates, track, {
          score: 0.34 - index / Math.max(popular.length * 4.4, 1),
          source: 'popular',
          languages: opts.languages,
        });
      });
    }

    for (const excludedId of excludeIds) {
      candidates.delete(excludedId);
    }

    return candidates;
  }

  private async safeRelated(token: string, trackUrn: string, limit: number): Promise<ScTrack[]> {
    try {
      const page = await this.tracksService.getRelated(token, trackUrn, {
        limit,
        access: 'playable,preview',
      });
      return this.trackCollectionFromUnknown(page);
    } catch (error) {
      this.logger.warn(`Related recommendations failed for ${trackUrn}: ${this.stringifyError(error)}`);
      return [];
    }
  }

  private async safeSearch(
    token: string,
    params: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScTrack>> {
    try {
      return await this.tracksService.search(token, params);
    } catch (error) {
      this.logger.warn(`Track search recommendations failed: ${this.stringifyError(error)}`);
      return { collection: [] };
    }
  }

  private trackCollectionFromUnknown(input: unknown): ScTrack[] {
    const rawCollection = Array.isArray(input)
      ? input
      : ((input as { collection?: unknown[] } | null)?.collection ?? []);

    const normalized: ScTrack[] = [];
    for (const entry of rawCollection as TrackLike[]) {
      const track = this.unwrapTrack(entry);
      if (track) {
        normalized.push(track);
      }
    }

    return normalized;
  }

  private unwrapTrack(entry: TrackLike): ScTrack | null {
    if (!entry || typeof entry !== 'object') return null;

    if ('urn' in entry && typeof (entry as { urn?: unknown }).urn === 'string') {
      return entry as ScTrack;
    }

    const nestedTrack = (entry as { track?: unknown }).track;
    if (nestedTrack && typeof nestedTrack === 'object' && 'urn' in nestedTrack) {
      return nestedTrack as ScTrack;
    }

    return null;
  }

  private finalizeCandidates(
    source: Map<string, RecommendationCandidate>,
    opts: { limit: number; excludeIds: Set<string>; diversity: number },
  ): RecommendResult[] {
    const ordered = [...source.values()]
      .filter((candidate) => !opts.excludeIds.has(candidate.id))
      .sort((a, b) => b.score - a.score);

    const selected =
      opts.diversity > 0 ? this.diversifyCandidates(ordered, opts.limit, opts.diversity) : ordered;

    return selected.slice(0, opts.limit).map((candidate) => ({
      id: candidate.id,
      score: Number(candidate.score.toFixed(4)),
      payload: { source: candidate.source },
    }));
  }

  private diversifyCandidates(
    candidates: RecommendationCandidate[],
    limit: number,
    strength: number,
  ): RecommendationCandidate[] {
    const remaining = [...candidates];
    const selected: RecommendationCandidate[] = [];
    const seenArtists = new Map<string, number>();
    const seenGenres = new Map<string, number>();

    while (remaining.length > 0 && selected.length < limit) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      const scanLimit = Math.min(remaining.length, 28);

      for (let index = 0; index < scanLimit; index += 1) {
        const candidate = remaining[index];
        const artistKey = this.getArtistKey(candidate.track);
        const genreKey = this.getGenreKey(candidate.track);
        const artistPenalty = artistKey ? (seenArtists.get(artistKey) ?? 0) * 0.32 : 0;
        const genrePenalty = genreKey ? (seenGenres.get(genreKey) ?? 0) * 0.18 : 0;
        const rankPenalty = index * 0.015;
        const adjustedScore =
          candidate.score - strength * (artistPenalty + genrePenalty + rankPenalty);

        if (adjustedScore > bestScore) {
          bestScore = adjustedScore;
          bestIndex = index;
        }
      }

      const [picked] = remaining.splice(bestIndex, 1);
      selected.push(picked);

      const artistKey = this.getArtistKey(picked.track);
      if (artistKey) {
        seenArtists.set(artistKey, (seenArtists.get(artistKey) ?? 0) + 1);
      }

      const genreKey = this.getGenreKey(picked.track);
      if (genreKey) {
        seenGenres.set(genreKey, (seenGenres.get(genreKey) ?? 0) + 1);
      }
    }

    return selected;
  }

  private mergeCandidate(
    target: Map<string, RecommendationCandidate>,
    track: ScTrack,
    opts: { score: number; source: string; languages: string[] },
  ) {
    if (!this.isTrackPlayable(track)) return;

    const id = this.getTrackId(track);
    if (!id) return;

    const languageAffinity = this.getLanguageAffinity(track, opts.languages);
    const popularityBoost = Math.min(track.likes_count ?? 0, 400_000) / 400_000 * 0.1;
    const score = Math.max(opts.score, 0.02) * (0.58 + 0.42 * languageAffinity) + popularityBoost;
    const current = target.get(id);

    if (!current) {
      target.set(id, {
        id,
        score,
        track,
        source: opts.source,
      });
      return;
    }

    target.set(id, {
      ...current,
      track: current.score >= score ? current.track : track,
      source: current.score >= score ? current.source : opts.source,
      score: current.score + score * 0.85,
    });
  }

  private clampLimit(value?: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.round(numeric)));
  }

  private clampDiversity(value?: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.35;
    return Math.max(0, Math.min(1, numeric));
  }

  private normalizeMode(mode?: string): SoundWaveMode {
    return mode === 'diverse' ? 'diverse' : 'similar';
  }

  private parseLanguages(languages?: string): string[] {
    if (!languages) return [];
    return [...new Set(languages.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  }

  private parseExcludeIds(exclude?: string): Set<string> {
    const result = new Set<string>();
    if (!exclude) return result;

    exclude
      .split(',')
      .map((value) => this.extractTrackId(value))
      .filter((value): value is string => Boolean(value))
      .forEach((value) => result.add(value));

    return result;
  }

  private normalizeTrackUrn(trackRef: string): string {
    const value = decodeURIComponent(trackRef).trim();
    if (!value) return value;
    if (/^\d+$/.test(value)) return `soundcloud:tracks:${value}`;
    const urnMatch = value.match(/^soundcloud:tracks:(\d+)$/i);
    if (urnMatch) return `soundcloud:tracks:${urnMatch[1]}`;
    return value;
  }

  private extractTrackId(trackRef: string | null | undefined): string | null {
    if (!trackRef) return null;
    const value = decodeURIComponent(trackRef).trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) return value;
    const urnMatch = value.match(/^soundcloud:tracks:(\d+)$/i);
    return urnMatch?.[1] ?? null;
  }

  private getTrackId(track: ScTrack): string | null {
    const maybeId = (track as ScTrack & { id?: number | string }).id;
    if (typeof maybeId === 'number' && Number.isFinite(maybeId)) {
      return String(maybeId);
    }
    if (typeof maybeId === 'string' && maybeId.trim()) {
      return maybeId.trim();
    }
    return this.extractTrackId(track.urn);
  }

  private getArtistKey(track: ScTrack): string | null {
    return track.user?.urn?.trim() || track.user?.username?.trim().toLowerCase() || null;
  }

  private getGenreKey(track: ScTrack): string | null {
    return track.genre?.trim().toLowerCase() || null;
  }

  private isTrackPlayable(track: ScTrack): boolean {
    return track.access !== 'blocked' && Boolean(track.urn);
  }

  private getLanguageAffinity(track: ScTrack, languages: string[]): number {
    if (languages.length === 0) return 1;

    const publisherMetadata = (track as ScTrack & { publisher_metadata?: Record<string, unknown> })
      .publisher_metadata;
    const rawText = [
      track.title,
      track.genre,
      track.tag_list,
      track.description,
      track.user?.username,
      typeof publisherMetadata?.artist === 'string' ? publisherMetadata.artist : '',
    ]
      .filter(Boolean)
      .join(' ');
    const normalized = rawText.toLowerCase();
    const hasLatinLetters = /[a-z]/i.test(rawText);

    let best = 0.25;
    for (const code of languages) {
      const scriptRegex = LANGUAGE_SCRIPT_REGEX[code];
      if (scriptRegex && scriptRegex.test(rawText)) {
        best = Math.max(best, 1);
        continue;
      }

      const hints = LANGUAGE_HINTS[code];
      if (hints?.some((hint) => normalized.includes(hint))) {
        best = Math.max(best, 0.96);
        continue;
      }

      if (LATIN_LANGUAGE_CODES.has(code) && hasLatinLetters) {
        best = Math.max(best, 0.72);
      }
    }

    return Math.max(0.25, Math.min(1, best));
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
