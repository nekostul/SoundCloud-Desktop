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
  baseScore: number;
  track: ScTrack;
  source: string;
  hits: number;
};

type RankedCandidate = RecommendationCandidate & {
  descriptor: TrackDescriptor;
  score: number;
  safeScore: number;
  discoveryScore: number;
  continuityScore: number;
};

type TrackLike = ScTrack | { track?: ScTrack | null } | null | undefined;

type TrackLanguageProfile = {
  primary: string | null;
  confidence: number;
  mixed: boolean;
  matched: Set<string>;
};

type TrackDescriptor = {
  id: string;
  artistKey: string | null;
  genreKey: string | null;
  tokenSet: Set<string>;
  sceneSet: Set<string>;
  energy: number;
  bpm: number | null;
  socialScore: number;
  language: TrackLanguageProfile;
};

type ProfileSeed = {
  descriptor: TrackDescriptor;
  weight: number;
  source: string;
};

type RecommendationProfile = {
  seeds: ProfileSeed[];
  recentTrackIds: Set<string>;
  likedArtistKeys: Set<string>;
  followedArtistKeys: Set<string>;
  genreWeights: Map<string, number>;
  tagWeights: Map<string, number>;
  avgEnergy: number;
  dominantLanguage: string | null;
};

type HomeCandidatePool = {
  candidates: Map<string, RecommendationCandidate>;
  likedTracks: ScTrack[];
  followingTracks: ScTrack[];
  recentTrackIds: Set<string>;
};

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const DEFAULT_HOME_SEED_LIMIT = 5;
const MAX_PROFILE_SEEDS = 16;

const SCRIPT_MATCHERS: Record<string, RegExp> = {
  ru: /[\u0400-\u04FF]/g,
  uk: /[іїєґІЇЄҐ]/g,
  kk: /[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/g,
  ar: /[\u0600-\u06FF]/g,
  hi: /[\u0900-\u097F]/g,
  ja: /[\u3040-\u30FF]/g,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
  zh: /[\u4E00-\u9FFF\u3400-\u4DBF]/g,
};

const LANGUAGE_HINTS: Record<string, string[]> = {
  en: [' english ', ' uk rap ', ' uk garage ', ' us rap ', ' american ', ' london ', ' remix '],
  ru: [' русский ', ' русская ', ' russian ', ' moscow ', ' russia ', ' moscow ', ' russkiy '],
  uk: [' україн', ' ukrainian ', ' kyiv ', ' kiev '],
  kk: [' qazaq ', ' kazakh ', ' қазақ ', ' almaty ', ' astana '],
  es: [' spanish ', ' espanol ', ' español ', ' latino ', ' latin trap '],
  de: [' german ', ' deutsch ', ' berlin ', ' deutsche '],
  fr: [' french ', ' francais ', ' français ', ' paris '],
  it: [' italian ', ' italiano '],
  pt: [' portuguese ', ' português ', ' brasil ', ' brazil ', ' brasileiro '],
  ja: [' japanese ', ' j-pop ', ' jpop ', ' anime '],
  ko: [' korean ', ' k-pop ', ' kpop '],
  tr: [' turkish ', ' türkçe ', ' turkce '],
  pl: [' polish ', ' polski '],
  ar: [' arabic ', ' arab ', ' الشرق ', ' الخليج '],
  hi: [' hindi ', ' bollywood ', ' desi '],
};

const HIGH_ENERGY_TOKENS = [
  'rage',
  'drift',
  'phonk',
  'trap',
  'drill',
  'club',
  'hardstyle',
  'jersey',
  'edm',
  'bass',
  'dance',
  'hyperpop',
  'hype',
  'ragebeat',
  'aggressive',
];

const LOW_ENERGY_TOKENS = [
  'ambient',
  'piano',
  'sleep',
  'calm',
  'acoustic',
  'lofi',
  'lo-fi',
  'mellow',
  'soft',
  'sadcore',
  'dream',
  'instrumental',
  'meditation',
  'relax',
];

const SCENE_CLUSTERS: Record<string, string[]> = {
  cloudrap: ['cloud', 'cloudrap', 'sadtrap', 'emo', 'gloomy'],
  phonk: ['phonk', 'drift', 'memphis', 'cowbell'],
  trap: ['trap', 'drill', 'rage', 'jersey', 'pluggnb'],
  electronic: ['edm', 'techno', 'house', 'trance', 'electro', 'dance'],
  ambient: ['ambient', 'drone', 'sleep', 'meditation', 'atmospheric'],
  indie: ['indie', 'alternative', 'shoegaze', 'dream'],
  pop: ['pop', 'radio', 'mainstream'],
  rap: ['rap', 'hiphop', 'hip-hop', 'boom bap', 'boom-bap'],
};

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);
  private readonly descriptorCache = new Map<string, TrackDescriptor>();

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
    const homePool = await this.buildHomeCandidatePool(token, sessionId, { limit, mode });
    const profile = this.buildRecommendationProfile({
      likedTracks: homePool.likedTracks,
      followingTracks: homePool.followingTracks,
      anchorTracks: [],
      recentTrackIds: homePool.recentTrackIds,
    });

    return this.finalizeCandidates(homePool.candidates, {
      limit,
      mode,
      languages,
      excludeIds: new Set(),
      profile,
      anchorTracks: profile.seeds.slice(0, 4).map((seed) => seed.descriptor),
      recentTracks: [],
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
    const searchLimit = Math.max(limit * 4, 28);
    const page = await this.safeSearch(token, {
      q: query,
      limit: searchLimit,
      access: 'playable,preview',
    });
    const candidates = new Map<string, RecommendationCandidate>();

    this.trackCollectionFromUnknown(page).forEach((track, index, collection) => {
      const rankBoost = 1.25 - index / Math.max(collection.length * 0.9, 1);
      this.mergeCandidate(candidates, track, {
        baseScore: Math.max(rankBoost, 0.12),
        source: 'search',
      });
    });

    return this.finalizeCandidates(candidates, {
      limit,
      mode: 'similar',
      languages,
      excludeIds: new Set(),
      profile: this.emptyRecommendationProfile(),
      anchorTracks: [],
      recentTracks: [],
    });
  }

  async getSimilarRecommendations(
    token: string,
    trackRef: string,
    opts: { limit?: number; diversity?: number; exclude?: string; languages?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit);
    const languages = this.parseLanguages(opts.languages);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const anchorId = this.extractTrackId(anchorUrn);
    const excludeIds = this.parseExcludeIds(opts.exclude);
    if (anchorId) excludeIds.add(anchorId);

    const [anchorTrack, related] = await Promise.all([
      this.safeTrack(token, anchorUrn),
      this.safeRelated(token, anchorUrn, Math.max(limit * 4, 28)),
    ]);

    const candidates = new Map<string, RecommendationCandidate>();
    related.forEach((track, index) => {
      this.mergeCandidate(candidates, track, {
        baseScore: 1.9 - index / Math.max(related.length * 0.82, 1),
        source: 'similar',
      });
    });

    const anchorTracks = anchorTrack ? [anchorTrack] : [];
    const profile = this.buildRecommendationProfile({
      likedTracks: [],
      followingTracks: [],
      anchorTracks,
      recentTrackIds: new Set(),
    });

    return this.finalizeCandidates(candidates, {
      limit,
      mode: opts.diversity && opts.diversity > 0.55 ? 'diverse' : 'similar',
      languages,
      excludeIds,
      profile,
      anchorTracks: anchorTracks.map((track) => this.describeTrack(track)),
      recentTracks: anchorTracks.map((track) => this.describeTrack(track)),
    });
  }

  async getWaveRecommendations(
    token: string,
    sessionId: string,
    trackRef: string,
    opts: { limit?: number; mode?: string; languages?: string; exclude?: string; recent?: string },
  ): Promise<RecommendResult[]> {
    const limit = this.clampLimit(opts.limit ?? 20);
    const mode = this.normalizeMode(opts.mode);
    const languages = this.parseLanguages(opts.languages);
    const anchorUrn = this.normalizeTrackUrn(trackRef);
    const anchorId = this.extractTrackId(anchorUrn);
    const excludeIds = this.parseExcludeIds(opts.exclude);
    if (anchorId) excludeIds.add(anchorId);

    const recentUrns = this.parseTrackRefs(opts.recent)
      .map((ref) => this.normalizeTrackUrn(ref))
      .filter((urn) => urn !== anchorUrn)
      .slice(0, 3);

    const [homePool, anchorTrack, recentTracks] = await Promise.all([
      this.buildHomeCandidatePool(token, sessionId, {
        limit: Math.max(limit * 2, 24),
        mode,
      }),
      this.safeTrack(token, anchorUrn),
      Promise.all(recentUrns.map((urn) => this.safeTrack(token, urn))),
    ]);

    const usableRecentTracks = recentTracks.filter((track): track is ScTrack => Boolean(track));
    const anchorRelatedInputs = [anchorUrn, ...usableRecentTracks.map((track) => track.urn)].slice(0, 4);
    const relatedGroups = await Promise.all(
      anchorRelatedInputs.map((urn, index) =>
        this.safeRelated(token, urn, Math.max(index === 0 ? limit * 4 : limit * 2, 18)),
      ),
    );

    const candidates = new Map<string, RecommendationCandidate>(homePool.candidates);
    relatedGroups.forEach((group, groupIndex) => {
      const groupBoost = groupIndex === 0 ? 2.05 : 1.55 - groupIndex * 0.12;
      group.forEach((track, index) => {
        this.mergeCandidate(candidates, track, {
          baseScore: Math.max(groupBoost - index / Math.max(group.length * 0.8, 1), 0.1),
          source: groupIndex === 0 ? 'wave-anchor' : 'wave-recent',
        });
      });
    });

    const profile = this.buildRecommendationProfile({
      likedTracks: homePool.likedTracks,
      followingTracks: homePool.followingTracks,
      anchorTracks: [anchorTrack, ...usableRecentTracks].filter((track): track is ScTrack =>
        Boolean(track),
      ),
      recentTrackIds: homePool.recentTrackIds,
    });

    const anchorDescriptors = [anchorTrack, ...usableRecentTracks]
      .filter((track): track is ScTrack => Boolean(track))
      .map((track) => this.describeTrack(track));

    return this.finalizeCandidates(candidates, {
      limit,
      mode,
      languages,
      excludeIds,
      profile,
      anchorTracks: anchorDescriptors,
      recentTracks: anchorDescriptors.slice(0, 3),
    });
  }

  private async buildHomeCandidatePool(
    token: string,
    sessionId: string,
    opts: { limit: number; mode: SoundWaveMode },
  ): Promise<HomeCandidatePool> {
    const historyLimit = opts.mode === 'diverse' ? 10 : 8;
    const likedLimit = opts.mode === 'diverse' ? 20 : 16;
    const followingLimit = Math.max(opts.limit * 2, 28);
    const candidateLimit = Math.max(opts.limit * 3, 36);
    const candidates = new Map<string, RecommendationCandidate>();

    const [historyResult, likedResult, followingsResult, popularResult] = await Promise.allSettled([
      this.historyService.findAll(sessionId, historyLimit, 0),
      this.meService.getLikedTracks(token, { limit: likedLimit }),
      this.meService.getFollowingsTracks(token, { limit: followingLimit }),
      this.tracksService.search(token, { limit: candidateLimit, access: 'playable,preview' }),
    ]);

    const recentTrackIds = new Set<string>();
    const seedTrackIds = new Set<string>();
    const relatedSeeds: Array<{ urn: string; baseScore: number; source: string }> = [];

    const likedTracks =
      likedResult.status === 'fulfilled' ? this.trackCollectionFromUnknown(likedResult.value) : [];
    const followingTracks =
      followingsResult.status === 'fulfilled'
        ? this.trackCollectionFromUnknown(followingsResult.value)
        : [];

    if (historyResult.status === 'fulfilled') {
      historyResult.value.collection.forEach((entry, index) => {
        const urn = this.normalizeTrackUrn(entry.scTrackId);
        const id = this.extractTrackId(urn);
        if (!urn || !id || seedTrackIds.has(id)) return;
        seedTrackIds.add(id);
        recentTrackIds.add(id);
        relatedSeeds.push({
          urn,
          baseScore: 1.52 * Math.exp(-index * 0.16),
          source: 'history',
        });
      });
    } else {
      this.logger.warn(`History recommendations seed failed: ${historyResult.reason}`);
    }

    likedTracks.slice(0, 10).forEach((track, index) => {
      const urn = this.normalizeTrackUrn(track.urn);
      const id = this.getTrackId(track);
      if (!urn || !id || seedTrackIds.has(id)) return;
      seedTrackIds.add(id);
      relatedSeeds.push({
        urn,
        baseScore: 1.24 - index * 0.06,
        source: 'likes',
      });
    });

    followingTracks.slice(0, 6).forEach((track, index) => {
      const urn = this.normalizeTrackUrn(track.urn);
      const id = this.getTrackId(track);
      if (!urn || !id || seedTrackIds.has(id)) return;
      seedTrackIds.add(id);
      relatedSeeds.push({
        urn,
        baseScore: 0.92 - index * 0.05,
        source: 'followings',
      });
    });

    const seedBudget = opts.mode === 'diverse' ? DEFAULT_HOME_SEED_LIMIT + 1 : DEFAULT_HOME_SEED_LIMIT;
    const relatedLists = await Promise.all(
      relatedSeeds.slice(0, seedBudget).map(async (seed) => ({
        seed,
        related: await this.safeRelated(token, seed.urn, candidateLimit),
      })),
    );

    relatedLists.forEach(({ seed, related }) => {
      related.forEach((track, index) => {
        const rankBoost = 1 - index / Math.max(related.length * 1.08, 1);
        this.mergeCandidate(candidates, track, {
          baseScore: seed.baseScore * Math.max(rankBoost, 0.08),
          source: `${seed.source}-related`,
        });
      });
    });

    followingTracks.forEach((track, index) => {
      this.mergeCandidate(candidates, track, {
        baseScore: Math.max(0.7 - index / Math.max(followingTracks.length * 2.8, 1), 0.04),
        source: 'followings-direct',
      });
    });

    if (popularResult.status === 'fulfilled') {
      const popularTracks = this.trackCollectionFromUnknown(popularResult.value);
      popularTracks.forEach((track, index) => {
        this.mergeCandidate(candidates, track, {
          baseScore: Math.max(0.48 - index / Math.max(popularTracks.length * 3.7, 1), 0.03),
          source: 'popular',
        });
      });
    }

    for (const excludedId of seedTrackIds) {
      candidates.delete(excludedId);
    }

    return {
      candidates,
      likedTracks,
      followingTracks,
      recentTrackIds,
    };
  }

  private buildRecommendationProfile(input: {
    likedTracks: ScTrack[];
    followingTracks: ScTrack[];
    anchorTracks: ScTrack[];
    recentTrackIds: Set<string>;
  }): RecommendationProfile {
    const likedArtistKeys = new Set<string>();
    const followedArtistKeys = new Set<string>();
    const genreWeights = new Map<string, number>();
    const tagWeights = new Map<string, number>();
    const languageWeights = new Map<string, number>();
    const seeds: ProfileSeed[] = [];

    const pushSeed = (track: ScTrack, weight: number, source: string) => {
      const descriptor = this.describeTrack(track);
      seeds.push({ descriptor, weight, source });

      const artistKey = descriptor.artistKey;
      if (artistKey) {
        if (source === 'likes' || source === 'anchor') {
          likedArtistKeys.add(artistKey);
        }
        if (source === 'followings') {
          followedArtistKeys.add(artistKey);
        }
      }

      if (descriptor.genreKey) {
        genreWeights.set(
          descriptor.genreKey,
          (genreWeights.get(descriptor.genreKey) ?? 0) + weight,
        );
      }

      descriptor.tokenSet.forEach((token) => {
        tagWeights.set(token, (tagWeights.get(token) ?? 0) + weight * 0.6);
      });

      if (descriptor.language.primary && descriptor.language.confidence >= 0.48) {
        languageWeights.set(
          descriptor.language.primary,
          (languageWeights.get(descriptor.language.primary) ?? 0) +
            weight * (descriptor.language.mixed ? 0.65 : 1),
        );
      }
    };

    input.anchorTracks.slice(0, 4).forEach((track, index) => {
      pushSeed(track, 1.8 - index * 0.18, 'anchor');
    });

    input.likedTracks.slice(0, 8).forEach((track, index) => {
      pushSeed(track, 1.28 - index * 0.08, 'likes');
    });

    input.followingTracks.slice(0, 6).forEach((track, index) => {
      pushSeed(track, 0.96 - index * 0.07, 'followings');
    });

    const boundedSeeds = seeds
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_PROFILE_SEEDS);

    const totalEnergyWeight =
      boundedSeeds.reduce((sum, seed) => sum + Math.max(seed.weight, 0.1), 0) || 1;
    const avgEnergy =
      boundedSeeds.reduce((sum, seed) => sum + seed.descriptor.energy * seed.weight, 0) /
      totalEnergyWeight;

    const dominantLanguage =
      [...languageWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      seeds: boundedSeeds,
      recentTrackIds: new Set(input.recentTrackIds),
      likedArtistKeys,
      followedArtistKeys,
      genreWeights,
      tagWeights,
      avgEnergy,
      dominantLanguage,
    };
  }

  private emptyRecommendationProfile(): RecommendationProfile {
    return {
      seeds: [],
      recentTrackIds: new Set(),
      likedArtistKeys: new Set(),
      followedArtistKeys: new Set(),
      genreWeights: new Map(),
      tagWeights: new Map(),
      avgEnergy: 0.5,
      dominantLanguage: null,
    };
  }

  private finalizeCandidates(
    source: Map<string, RecommendationCandidate>,
    opts: {
      limit: number;
      mode: SoundWaveMode;
      languages: string[];
      excludeIds: Set<string>;
      profile: RecommendationProfile;
      anchorTracks: TrackDescriptor[];
      recentTracks: TrackDescriptor[];
    },
  ): RecommendResult[] {
    const ranked: RankedCandidate[] = [];

    for (const candidate of source.values()) {
      if (opts.excludeIds.has(candidate.id)) continue;

      const descriptor = this.describeTrack(candidate.track);
      const languageFit = this.evaluateLanguageFit(
        descriptor.language,
        opts.languages,
        opts.profile.dominantLanguage,
      );
      if (!languageFit.allowed) continue;

      const anchorSimilarity = this.computeSeedSimilarity(descriptor, opts.anchorTracks, [1.35, 1.05, 0.88, 0.74]);
      const recentContinuity = this.computeSeedSimilarity(
        descriptor,
        opts.recentTracks.length > 0 ? opts.recentTracks : opts.anchorTracks,
        [1.6, 1.12, 0.86, 0.72],
      );
      const tasteSimilarity = this.computeProfileSimilarity(descriptor, opts.profile.seeds);
      const genreAffinity = this.computeGenreAffinity(descriptor, opts.profile.genreWeights);
      const tagAffinity = this.computeTagAffinity(descriptor, opts.profile.tagWeights);
      const artistAffinity = this.computeArtistAffinity(descriptor, opts.profile);
      const energyAffinity = 1 - Math.min(1, Math.abs(descriptor.energy - opts.profile.avgEnergy));
      const noveltyScore = this.computeNoveltyScore(
        descriptor,
        anchorSimilarity,
        tasteSimilarity,
        opts.profile,
      );
      const heardPenalty = opts.profile.recentTrackIds.has(candidate.id) ? 2.9 : 0;
      const mixedPenalty = descriptor.language.mixed ? 0.8 : 0;
      const unknownPenalty = descriptor.language.primary ? 0 : 0.7;

      const safeScore =
        anchorSimilarity * 0.42 +
        recentContinuity * 0.28 +
        tasteSimilarity * 0.2 +
        languageFit.score * 0.1;

      const discoveryScore = Math.max(
        0,
        noveltyScore +
          (opts.mode === 'diverse' ? 0.2 : 0) +
          Math.max(0, 0.55 - anchorSimilarity) * 0.45,
      );

      const score =
        candidate.baseScore * 3.05 +
        anchorSimilarity * 5.3 +
        recentContinuity * 4.2 +
        tasteSimilarity * 3.45 +
        genreAffinity * 1.55 +
        tagAffinity * 1.45 +
        artistAffinity * 1.1 +
        energyAffinity * 0.9 +
        descriptor.socialScore * 0.75 +
        languageFit.score * 2.6 +
        noveltyScore * (opts.mode === 'diverse' ? 1.35 : 0.6) -
        heardPenalty -
        mixedPenalty -
        unknownPenalty;

      ranked.push({
        ...candidate,
        descriptor,
        continuityScore: recentContinuity,
        safeScore,
        discoveryScore,
        score,
      });
    }

    ranked.sort((a, b) => b.score - a.score);

    const selected = this.selectCandidates(ranked, {
      limit: opts.limit,
      mode: opts.mode,
      anchors: opts.anchorTracks.length > 0 ? opts.anchorTracks : opts.recentTracks,
    });

    return selected.map((candidate) => ({
      id: candidate.id,
      score: Number(candidate.score.toFixed(4)),
      payload: {
        source: candidate.source,
        hits: candidate.hits,
      },
    }));
  }

  private selectCandidates(
    candidates: RankedCandidate[],
    opts: { limit: number; mode: SoundWaveMode; anchors: TrackDescriptor[] },
  ): RankedCandidate[] {
    const remaining = [...candidates];
    const selected: RankedCandidate[] = [];
    const recentAnchors = [...opts.anchors].slice(0, 3);
    const artistCounts = new Map<string, number>();
    const genreCounts = new Map<string, number>();

    while (remaining.length > 0 && selected.length < opts.limit) {
      const explorationTurn =
        opts.mode === 'diverse' ? selected.length > 0 && selected.length % 3 === 2 : selected.length > 0 && selected.length % 5 === 4;

      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      const scanLimit = Math.min(remaining.length, 28);

      for (let index = 0; index < scanLimit; index += 1) {
        const candidate = remaining[index];
        const continuity = this.computeSeedSimilarity(
          candidate.descriptor,
          recentAnchors,
          [1.65, 1.18, 0.82],
        );
        const artistKey = candidate.descriptor.artistKey;
        const genreKey = candidate.descriptor.genreKey;
        const lastDescriptor = recentAnchors[recentAnchors.length - 1];
        const sameArtistAsLast =
          Boolean(
            artistKey &&
              lastDescriptor?.artistKey &&
              artistKey === lastDescriptor.artistKey,
          );
        const artistPenalty = artistKey ? (artistCounts.get(artistKey) ?? 0) * 1.25 : 0;
        const genrePenalty = genreKey ? (genreCounts.get(genreKey) ?? 0) * 0.72 : 0;
        const energyJumpPenalty = lastDescriptor
          ? Math.max(0, Math.abs(candidate.descriptor.energy - lastDescriptor.energy) - 0.28) * 3.4
          : 0;
        const continuityPenalty = sameArtistAsLast ? (opts.mode === 'diverse' ? 3.4 : 2.2) : 0;
        const rankPenalty = index * 0.04;

        const adjustedSafeScore =
          candidate.score +
          continuity * 2.45 +
          candidate.safeScore * 1.35 -
          artistPenalty -
          genrePenalty -
          energyJumpPenalty -
          continuityPenalty -
          rankPenalty;

        const adjustedExploreScore =
          candidate.score * 0.76 +
          continuity * 1.35 +
          candidate.discoveryScore * 3.15 -
          artistPenalty * 0.85 -
          genrePenalty * 0.65 -
          energyJumpPenalty * 0.7 -
          continuityPenalty * 0.8 -
          rankPenalty;

        const effectiveScore =
          explorationTurn && candidate.safeScore >= 0.42
            ? adjustedExploreScore
            : adjustedSafeScore;

        if (effectiveScore > bestScore) {
          bestScore = effectiveScore;
          bestIndex = index;
        }
      }

      const [picked] = remaining.splice(bestIndex, 1);
      selected.push(picked);
      recentAnchors.push(picked.descriptor);
      if (recentAnchors.length > 3) recentAnchors.shift();

      if (picked.descriptor.artistKey) {
        artistCounts.set(
          picked.descriptor.artistKey,
          (artistCounts.get(picked.descriptor.artistKey) ?? 0) + 1,
        );
      }

      if (picked.descriptor.genreKey) {
        genreCounts.set(
          picked.descriptor.genreKey,
          (genreCounts.get(picked.descriptor.genreKey) ?? 0) + 1,
        );
      }
    }

    return selected;
  }

  private mergeCandidate(
    target: Map<string, RecommendationCandidate>,
    track: ScTrack,
    opts: { baseScore: number; source: string },
  ) {
    if (!this.isTrackPlayable(track)) return;

    const id = this.getTrackId(track);
    if (!id) return;

    const current = target.get(id);
    if (!current) {
      target.set(id, {
        id,
        baseScore: Math.max(opts.baseScore, 0.02),
        track,
        source: opts.source,
        hits: 1,
      });
      return;
    }

    const nextBaseScore = current.baseScore + Math.max(opts.baseScore, 0.02) * 0.88;
    target.set(id, {
      id,
      track: current.baseScore >= opts.baseScore ? current.track : track,
      source: current.baseScore >= opts.baseScore ? current.source : opts.source,
      baseScore: nextBaseScore,
      hits: current.hits + 1,
    });
  }

  private describeTrack(track: ScTrack): TrackDescriptor {
    const id = this.getTrackId(track) ?? track.urn;
    const cached = this.descriptorCache.get(id);
    if (cached) return cached;

    const text = this.extractTrackText(track);
    const tokens = this.tokenizeText(text);
    const tokenSet = new Set(tokens);
    const sceneSet = new Set<string>();

    for (const [scene, cues] of Object.entries(SCENE_CLUSTERS)) {
      if (cues.some((cue) => tokenSet.has(cue))) {
        sceneSet.add(scene);
      }
    }

    const bpm = this.extractTrackBpm(track);
    const descriptor: TrackDescriptor = {
      id,
      artistKey: this.getArtistKey(track),
      genreKey: this.getGenreKey(track),
      tokenSet,
      sceneSet,
      bpm,
      energy: this.estimateTrackEnergy(tokenSet, bpm),
      socialScore: this.computeSocialScore(track),
      language: this.detectTrackLanguage(text),
    };

    this.descriptorCache.set(id, descriptor);
    return descriptor;
  }

  private extractTrackText(track: ScTrack): string {
    const publisherMetadata = (track as ScTrack & {
      publisher_metadata?: Record<string, unknown>;
    }).publisher_metadata;

    const publisherText = Object.values(publisherMetadata ?? {})
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');

    return [
      track.title,
      track.genre,
      track.tag_list,
      track.description,
      track.user?.username,
      publisherText,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private tokenizeText(text: string): string[] {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .slice(0, 80);
  }

  private detectTrackLanguage(text: string): TrackLanguageProfile {
    const normalized = ` ${text.toLowerCase()} `;
    if (!normalized.trim()) {
      return { primary: null, confidence: 0, mixed: false, matched: new Set() };
    }

    const scores = new Map<string, number>();
    const addScore = (code: string, score: number) => {
      if (score <= 0) return;
      scores.set(code, (scores.get(code) ?? 0) + score);
    };

    for (const [code, regex] of Object.entries(SCRIPT_MATCHERS)) {
      const count = (text.match(regex) ?? []).length;
      if (count > 0) {
        addScore(code, Math.min(1.2, 0.18 + count / 18));
      }
    }

    for (const [code, hints] of Object.entries(LANGUAGE_HINTS)) {
      let hitCount = 0;
      for (const hint of hints) {
        if (normalized.includes(hint)) hitCount += 1;
      }
      if (hitCount > 0) {
        addScore(code, Math.min(1.15, hitCount * 0.32));
      }
    }

    const latinChars = text.match(/[A-Za-z\u00C0-\u024F]/g)?.length ?? 0;
    const cyrillicChars = text.match(/[\u0400-\u04FF]/g)?.length ?? 0;

    if (latinChars > 0 && cyrillicChars === 0) {
      const hasStrongLatinLanguage = ['es', 'de', 'fr', 'it', 'pt', 'tr', 'pl'].some(
        (code) => (scores.get(code) ?? 0) >= 0.58,
      );
      if (!hasStrongLatinLanguage) {
        addScore('en', Math.min(0.95, 0.38 + latinChars / 40));
      }
    }

    if (cyrillicChars > 0) {
      const ukrainianChars = text.match(/[іїєґІЇЄҐ]/g)?.length ?? 0;
      const kazakhChars = text.match(/[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/g)?.length ?? 0;
      const russianChars = text.match(/[ёыэъЁЫЭЪ]/g)?.length ?? 0;
      if (ukrainianChars > 0) addScore('uk', ukrainianChars * 0.32);
      if (kazakhChars > 0) addScore('kk', kazakhChars * 0.34);
      if (russianChars > 0) addScore('ru', russianChars * 0.22);
      if (ukrainianChars === 0 && kazakhChars === 0 && russianChars === 0) {
        addScore('ru', 0.58);
      }
    }

    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const primary = ordered[0]?.[0] ?? null;
    const primaryScore = ordered[0]?.[1] ?? 0;
    const secondScore = ordered[1]?.[1] ?? 0;
    const confidence = primary
      ? Math.max(0, Math.min(1, primaryScore - secondScore * 0.26))
      : 0;
    const mixed =
      Boolean(primary) &&
      secondScore >= 0.42 &&
      secondScore / Math.max(primaryScore, 0.01) >= 0.62;
    const matched = new Set(
      ordered.filter(([, score]) => score >= 0.52).map(([code]) => code),
    );

    return {
      primary,
      confidence,
      mixed,
      matched,
    };
  }

  private evaluateLanguageFit(
    profile: TrackLanguageProfile,
    selectedLanguages: string[],
    dominantProfileLanguage: string | null,
  ): { allowed: boolean; score: number } {
    if (selectedLanguages.length === 0) {
      if (dominantProfileLanguage && profile.primary === dominantProfileLanguage) {
        return { allowed: true, score: 1.08 + Math.min(profile.confidence, 1) * 0.12 };
      }
      return {
        allowed: true,
        score:
          profile.primary && profile.confidence >= 0.45
            ? 0.9 + profile.confidence * 0.08
            : 0.72,
      };
    }

    const allowedSet = new Set(selectedLanguages);
    if (selectedLanguages.length === 1) {
      const target = selectedLanguages[0];
      if (profile.primary !== target) return { allowed: false, score: 0 };
      if (profile.confidence < 0.46) return { allowed: false, score: 0 };
      if (profile.mixed && profile.confidence < 0.78) return { allowed: false, score: 0 };
      return { allowed: true, score: 1.18 + Math.min(profile.confidence, 1) * 0.18 };
    }

    if (profile.primary && allowedSet.has(profile.primary) && profile.confidence >= 0.4) {
      return { allowed: true, score: 1.04 + Math.min(profile.confidence, 1) * 0.14 };
    }

    for (const code of profile.matched) {
      if (allowedSet.has(code) && profile.confidence >= 0.42) {
        return { allowed: true, score: 0.96 };
      }
    }

    return { allowed: false, score: 0 };
  }

  private computeSeedSimilarity(
    descriptor: TrackDescriptor,
    seeds: TrackDescriptor[],
    weights: number[],
  ): number {
    if (seeds.length === 0) return 0;

    let best = 0;
    let weightedSum = 0;
    let totalWeight = 0;

    seeds.forEach((seed, index) => {
      const weight = weights[index] ?? Math.max(0.5, 1 - index * 0.12);
      const similarity = this.computeDescriptorSimilarity(descriptor, seed);
      best = Math.max(best, similarity * Math.min(weight, 1.4));
      weightedSum += similarity * weight;
      totalWeight += weight;
    });

    const average = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return Math.max(best * 0.92, average);
  }

  private computeProfileSimilarity(
    descriptor: TrackDescriptor,
    seeds: ProfileSeed[],
  ): number {
    if (seeds.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;
    let best = 0;

    for (const seed of seeds) {
      const weight = Math.max(seed.weight, 0.1);
      const similarity = this.computeDescriptorSimilarity(descriptor, seed.descriptor);
      weightedSum += similarity * weight;
      totalWeight += weight;
      best = Math.max(best, similarity * Math.min(weight, 1.45));
    }

    const average = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return Math.max(best * 0.84, average);
  }

  private computeDescriptorSimilarity(a: TrackDescriptor, b: TrackDescriptor): number {
    const genreMatch =
      a.genreKey && b.genreKey && a.genreKey === b.genreKey ? 0.24 : 0;
    const artistMatch =
      a.artistKey && b.artistKey && a.artistKey === b.artistKey ? 0.1 : 0;
    const tokenOverlap = this.computeSetOverlap(a.tokenSet, b.tokenSet) * 0.34;
    const sceneOverlap = this.computeSetOverlap(a.sceneSet, b.sceneSet) * 0.22;
    const energySimilarity = (1 - Math.min(1, Math.abs(a.energy - b.energy))) * 0.2;
    const bpmSimilarity =
      a.bpm && b.bpm
        ? (1 - Math.min(1, Math.abs(a.bpm - b.bpm) / 48)) * 0.1
        : 0;
    const languageSimilarity =
      a.language.primary && b.language.primary && a.language.primary === b.language.primary
        ? 0.08
        : 0;

    return Math.max(
      0,
      Math.min(
        1.25,
        genreMatch + artistMatch + tokenOverlap + sceneOverlap + energySimilarity + bpmSimilarity + languageSimilarity,
      ),
    );
  }

  private computeGenreAffinity(
    descriptor: TrackDescriptor,
    weights: Map<string, number>,
  ): number {
    if (!descriptor.genreKey) return 0;
    const raw = weights.get(descriptor.genreKey) ?? 0;
    return Math.min(1.3, raw * 0.18);
  }

  private computeTagAffinity(
    descriptor: TrackDescriptor,
    weights: Map<string, number>,
  ): number {
    let score = 0;
    for (const token of descriptor.tokenSet) {
      score += Math.min(0.18, (weights.get(token) ?? 0) * 0.08);
      if (score >= 1.35) break;
    }
    return Math.min(1.35, score);
  }

  private computeArtistAffinity(
    descriptor: TrackDescriptor,
    profile: RecommendationProfile,
  ): number {
    if (!descriptor.artistKey) return 0;
    let score = 0;
    if (profile.likedArtistKeys.has(descriptor.artistKey)) score += 0.72;
    if (profile.followedArtistKeys.has(descriptor.artistKey)) score += 0.54;
    return Math.min(1.2, score);
  }

  private computeNoveltyScore(
    descriptor: TrackDescriptor,
    anchorSimilarity: number,
    tasteSimilarity: number,
    profile: RecommendationProfile,
  ): number {
    const familiar = Math.max(anchorSimilarity, tasteSimilarity);
    const newArtist =
      descriptor.artistKey &&
      !profile.likedArtistKeys.has(descriptor.artistKey) &&
      !profile.followedArtistKeys.has(descriptor.artistKey)
        ? 0.18
        : 0;
    const freshness = profile.recentTrackIds.has(descriptor.id) ? -0.45 : 0.26;
    return Math.max(0, Math.min(1.05, (1 - Math.min(familiar, 1)) * 0.72 + newArtist + freshness));
  }

  private computeSetOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let overlap = 0;
    for (const token of a) {
      if (b.has(token)) overlap += 1;
    }

    return overlap / Math.max(Math.min(a.size, b.size), 1);
  }

  private estimateTrackEnergy(tokens: Set<string>, bpm: number | null): number {
    let energy = 0.48;

    if (bpm) {
      energy += Math.max(-0.12, Math.min(0.26, (bpm - 105) / 180));
    }

    let highHits = 0;
    let lowHits = 0;

    for (const token of tokens) {
      if (HIGH_ENERGY_TOKENS.includes(token)) highHits += 1;
      if (LOW_ENERGY_TOKENS.includes(token)) lowHits += 1;
    }

    energy += Math.min(0.28, highHits * 0.06);
    energy -= Math.min(0.28, lowHits * 0.06);

    return Math.max(0.06, Math.min(1, energy));
  }

  private extractTrackBpm(track: ScTrack): number | null {
    const directBpm = Number((track as ScTrack & { bpm?: unknown }).bpm);
    if (Number.isFinite(directBpm) && directBpm > 0) {
      return Math.max(40, Math.min(240, directBpm));
    }

    const publisherMetadata = (track as ScTrack & {
      publisher_metadata?: Record<string, unknown>;
    }).publisher_metadata;
    const rawPublisherBpm = Number(
      publisherMetadata?.bpm ?? publisherMetadata?.tempo ?? publisherMetadata?.bpm_value,
    );
    if (Number.isFinite(rawPublisherBpm) && rawPublisherBpm > 0) {
      return Math.max(40, Math.min(240, rawPublisherBpm));
    }

    return null;
  }

  private computeSocialScore(track: ScTrack): number {
    const plays = Math.max(track.playback_count ?? 0, 0);
    const likes = Math.max(track.likes_count ?? 0, 0);
    const reposts = Math.max(track.reposts_count ?? 0, 0);
    const comments = Math.max(track.comment_count ?? 0, 0);
    if (plays <= 0 && likes <= 0 && reposts <= 0 && comments <= 0) {
      return 0.08;
    }

    const likesPer1k = plays > 0 ? (likes / plays) * 1000 : likes / 12;
    const repostsPer1k = plays > 0 ? (reposts / plays) * 1000 : reposts / 12;
    const commentsPer1k = plays > 0 ? (comments / plays) * 1000 : comments / 12;

    return Math.max(
      0,
      Math.min(
        1.4,
        Math.log10(plays + 10) * 0.12 +
          Math.min(0.55, likesPer1k * 0.045) +
          Math.min(0.22, repostsPer1k * 0.06) +
          Math.min(0.2, commentsPer1k * 0.05),
      ),
    );
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

  private async safeTrack(token: string, trackUrn: string): Promise<ScTrack | null> {
    try {
      return await this.tracksService.getById(token, trackUrn);
    } catch (error) {
      this.logger.warn(`Track metadata fetch failed for ${trackUrn}: ${this.stringifyError(error)}`);
      return null;
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

  private clampLimit(value?: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.round(numeric)));
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

  private parseTrackRefs(value?: string): string[] {
    if (!value) return [];
    return [...new Set(value.split(',').map((item) => decodeURIComponent(item).trim()).filter(Boolean))];
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

  private stringifyError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
