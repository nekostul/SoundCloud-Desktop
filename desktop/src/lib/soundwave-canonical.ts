import type { Track } from '../stores/player';

type RawTrack = Track & {
  publisher_metadata?: Record<string, unknown> | null;
  label_name?: string | null;
  release_date?: string | null;
  monetization_model?: string | null;
  license?: string | null;
};

type ModifierKind =
  | 'none'
  | 'nightcore'
  | 'spedup'
  | 'slowed'
  | 'reverb'
  | 'bassboost'
  | 'tiktok'
  | 'eightd'
  | 'lofi'
  | 'pitched'
  | 'remix'
  | 'mashup'
  | 'cover'
  | 'acoustic'
  | 'instrumental'
  | 'live'
  | 'edit';

interface WorkIdentity {
  workKey: string;
  titleKey: string;
  artists: string[];
  modifierKind: ModifierKind;
  isDerivative: boolean;
}

interface WorkCompareResult {
  same: boolean;
  titleMatched: boolean;
  titleSimilarity: number;
  reason: string;
  artistOverlap: string[];
}

interface CollapseOptions {
  stage?: string;
  maxLoggedGroups?: number;
  protectedUrns?: Set<string>;
}

type TrackIdentity = {
  track: Track;
  identity: WorkIdentity;
  index: number;
};

const MODIFIER_PENALTY: Record<ModifierKind, number> = {
  none: 0,
  nightcore: 70,
  spedup: 62,
  tiktok: 58,
  slowed: 60,
  reverb: 60,
  bassboost: 55,
  eightd: 55,
  pitched: 55,
  lofi: 52,
  cover: 50,
  remix: 45,
  mashup: 45,
  acoustic: 40,
  instrumental: 40,
  edit: 35,
  live: 30,
};

const MODIFIER_PATTERNS: Array<[ModifierKind, RegExp]> = [
  ['nightcore', /\bnightcore\b/iu],
  ['slowed', /\bslow(?:ed)?(?:\s*(?:\+|and|n|&)?\s*reverb)?\b|\bslowed\s*down\b/iu],
  ['reverb', /\breverb(?:ed)?\b/iu],
  ['spedup', /\b(?:sped\s*up|speed\s*up|fast(?:er)?\s+version)\b/iu],
  ['tiktok', /\btik\s*tok(?:\s*(?:version|remix|edit))?\b/iu],
  ['eightd', /\b8d(?:\s*audio)?\b/iu],
  ['bassboost', /\bbass\s*boost(?:ed)?\b/iu],
  ['pitched', /\bpitched\s*(?:up|down)?\b/iu],
  ['lofi', /\blo[\s-]?fi\b/iu],
  ['mashup', /\bmash[\s-]?up\b/iu],
  [
    'remix',
    /\b(?:re)?mix(?:ed)?\b|\bremix\b|\bvip\s*mix\b|\bbootleg\b|\bflip\b|\brework\b|\brefix\b/iu,
  ],
  ['cover', /\bcover(?:ed)?\b/iu],
  ['acoustic', /\bacoustic\b/iu],
  ['instrumental', /\binstrumental\b/iu],
  ['live', /\blive(?:\s*(?:version|session|performance))?\b|\bunplugged\b/iu],
  ['edit', /\b(?:edit|extended|radio\s*edit|club\s*mix|rework)\b/iu],
];

const FEAT_PATTERN = /\b(?:feat\.?|ft\.?|featuring)\b/iu;
const FEAT_SEGMENT_PATTERN =
  /(?:^|[\s([{])(?:feat\.?|ft\.?|featuring)\s+([^\])}\-|\u2013\u2014]+)/iu;
const FEAT_REMOVE_PATTERN =
  /(?:\s*[([{]\s*)?(?:feat\.?|ft\.?|featuring)\s+[^\])}\-|\u2013\u2014]+[\])}]?/iu;
const DASH_SEPARATOR_PATTERN = /\s+[-|\u2013\u2014]\s+/u;
const ARTIST_SPLIT_PATTERN =
  /\s*(?:,|&|\+|\/|;)\s*|\s+(?:x|\u0445|and|\u0438|vs\.?|versus|with)\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/iu;

const NOISE_PATTERNS: RegExp[] = [
  /\bprod\.?(?:\s*by)?\b[\p{L}\p{N}_.\s&'-]*/iu,
  /\b(?:official\s+)?(?:audio|video|music\s*video|lyric\s*video|lyrics?|visuali[sz]er|mv)\b/iu,
  /\b(?:hd|hq|4k|320\s*kbps|free\s*(?:dl|download))\b/iu,
  /\b(?:full\s+)?(?:song|track)\b/iu,
  /\breupload\b|\bno\s*copyright\b/iu,
];

const ARTIST_NOISE_PATTERN = /\b(?:official|music|records?|label|archive|topic)\b/iu;
const AMBIGUOUS_BASE = new Set(['intro', 'outro', 'untitled', 'interlude', 'skit', 'freestyle']);
const FUZZY_TITLE_THRESHOLD = 0.83;
const FUZZY_TITLE_STRICT_THRESHOLD = 0.91;
const DEBUG_DEFAULT_GROUP_LIMIT = 5;
const debugGroupCounts = new Map<string, number>();
const debugSeparateCounts = new Map<string, number>();

function toGlobal(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeRawText(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .normalize('NFKD');
}

function normalizeSearchText(value: string): string {
  return normalizeRawText(value)
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArtistName(value: string): string {
  return normalizeRawText(value)
    .replace(toGlobal(ARTIST_NOISE_PATTERN), ' ')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function splitArtistNames(value: string): string[] {
  return normalizeRawText(value)
    .split(ARTIST_SPLIT_PATTERN)
    .map(normalizeArtistName)
    .filter((artist) => artist.length > 1);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function splitReleaseTitle(rawTitle: string): { artistText: string; mainTitle: string } {
  const title = normalizeRawText(rawTitle).replace(/\s+/g, ' ').trim();
  const parts = title
    .split(DASH_SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return { artistText: '', mainTitle: title };

  const artistText = parts[0];
  const mainTitle = parts.slice(1).join(' ');
  const artistWords = artistText.split(/\s+/).filter(Boolean).length;

  if (!mainTitle || artistWords > 8) return { artistText: '', mainTitle: title };
  return { artistText, mainTitle };
}

function extractFeaturedArtistTexts(rawTitle: string): string[] {
  const title = normalizeRawText(rawTitle);
  const pattern = toGlobal(FEAT_SEGMENT_PATTERN);
  const artists: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(title))) {
    const value = match[1]?.trim();
    if (value) artists.push(value);
  }

  return artists;
}

export function detectModifier(rawTitle: string): { kind: ModifierKind; isDerivative: boolean } {
  const title = rawTitle || '';
  for (const [kind, pattern] of MODIFIER_PATTERNS) {
    if (pattern.test(title)) return { kind, isDerivative: true };
  }
  return { kind: 'none', isDerivative: false };
}

function stripToBaseTitle(rawTitle: string): string {
  const { mainTitle } = splitReleaseTitle(rawTitle);
  let title = mainTitle;

  title = title.replace(/[([{][^)\]}]*[)\]}]/g, (chunk) => {
    const hasModifier = MODIFIER_PATTERNS.some(([, pattern]) => pattern.test(chunk));
    const hasNoise =
      FEAT_PATTERN.test(chunk) || NOISE_PATTERNS.some((pattern) => pattern.test(chunk));
    return hasModifier || hasNoise ? ' ' : chunk;
  });

  title = title.replace(toGlobal(FEAT_REMOVE_PATTERN), ' ');

  for (const [, pattern] of MODIFIER_PATTERNS) title = title.replace(toGlobal(pattern), ' ');
  for (const pattern of NOISE_PATTERNS) title = title.replace(toGlobal(pattern), ' ');

  return normalizeSearchText(title);
}

function artistKeysForTrack(track: Track): string[] {
  const raw = track as RawTrack;
  const pm = raw.publisher_metadata;
  const { artistText } = splitReleaseTitle(track.title);
  const artistTexts = [
    artistText,
    ...extractFeaturedArtistTexts(track.title),
    track.user?.username ?? '',
  ];

  if (pm && typeof pm === 'object') {
    artistTexts.push(asString(pm.artist), asString(pm.artist_title), asString(pm.writer_composer));
  }

  return uniqueSorted(artistTexts.flatMap(splitArtistNames));
}

function identityForTrack(track: Track): WorkIdentity {
  const titleKey = stripToBaseTitle(track.title);
  const artists = artistKeysForTrack(track);
  const { kind, isDerivative } = detectModifier(track.title);
  const artistKey = artists.length ? artists.join('+') : 'unknown';
  const fallback = track.urn ? `urn:${track.urn}` : 'unknown';
  const keyTitle = titleKey || fallback;

  return {
    workKey: `${keyTitle}::${artistKey}`,
    titleKey,
    artists,
    modifierKind: kind,
    isDerivative,
  };
}

export function workKeyForTrack(track: Track): string {
  return identityForTrack(track).workKey;
}

function titleTokens(title: string): string[] {
  return title.split(/\s+/).filter(Boolean);
}

function boundedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  const lengthRatio = Math.min(a.length, b.length) / maxLength;
  if (lengthRatio < 0.72) return 0;

  const distance = boundedEditDistance(a, b);
  return Math.max(0, 1 - distance / maxLength);
}

function titleMatches(a: string, b: string): { matched: boolean; similarity: number } {
  if (!a || !b) return { matched: false, similarity: 0 };
  if (a === b) return { matched: true, similarity: 1 };

  const compactLength = Math.min(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length);
  if (compactLength < 5) return { matched: false, similarity: 0 };

  const similarity = titleSimilarity(a, b);
  if (similarity >= FUZZY_TITLE_STRICT_THRESHOLD) return { matched: true, similarity };

  const aTokens = titleTokens(a);
  const bTokens = titleTokens(b);
  const tokenOverlap = aTokens.filter((token) => bTokens.includes(token)).length;
  const tokenRatio = tokenOverlap / Math.max(aTokens.length, bTokens.length, 1);

  return {
    matched:
      similarity >= FUZZY_TITLE_THRESHOLD &&
      ((aTokens.length === 1 && bTokens.length === 1) || tokenRatio >= 0.5),
    similarity,
  };
}

function compareWorkIdentities(a: WorkIdentity, b: WorkIdentity): WorkCompareResult {
  const title = titleMatches(a.titleKey, b.titleKey);
  if (!title.matched) {
    return {
      same: false,
      titleMatched: false,
      titleSimilarity: title.similarity,
      reason: 'title mismatch',
      artistOverlap: [],
    };
  }

  const bArtists = new Set(b.artists);
  const artistOverlap = a.artists.filter((artist) => bArtists.has(artist));
  const hasArtistOverlap = artistOverlap.length > 0;

  if (hasArtistOverlap) {
    const relation =
      title.similarity >= 1 ? 'exact title' : `fuzzy title ${title.similarity.toFixed(2)}`;
    return {
      same: true,
      titleMatched: true,
      titleSimilarity: title.similarity,
      reason: `${relation} + shared artist: ${artistOverlap.slice(0, 3).join(', ')}`,
      artistOverlap,
    };
  }

  const missingArtistFallback =
    title.similarity >= 1 &&
    (a.artists.length === 0 || b.artists.length === 0) &&
    a.titleKey.replace(/\s/g, '').length > 3 &&
    !AMBIGUOUS_BASE.has(a.titleKey);

  return {
    same: missingArtistFallback,
    titleMatched: true,
    titleSimilarity: title.similarity,
    reason: missingArtistFallback
      ? 'exact title + missing artist metadata'
      : 'title matched but artists do not overlap',
    artistOverlap,
  };
}

function sameWork(a: Track, b: Track): WorkCompareResult {
  return compareWorkIdentities(identityForTrack(a), identityForTrack(b));
}

export function hasSameWork(tracks: Track[], candidate: Track): boolean {
  return tracks.some((track) => sameWork(track, candidate).same);
}

export function isSameWork(a: Track, b: Track): boolean {
  return sameWork(a, b).same;
}

function parentFind(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

function parentUnion(parent: number[], a: number, b: number) {
  const rootA = parentFind(parent, a);
  const rootB = parentFind(parent, b);
  if (rootA !== rootB) parent[rootB] = rootA;
}

function debugTrack(track: Track, identity: WorkIdentity) {
  return {
    title: track.title,
    artist: track.user?.username,
    urn: track.urn,
    workKey: identity.workKey,
    canonicalScore: Number(canonicalScore(track).toFixed(2)),
  };
}

function logKeepSeparate(
  stage: string,
  a: TrackIdentity,
  b: TrackIdentity,
  compare: WorkCompareResult,
  maxLoggedGroups: number,
) {
  const count = debugSeparateCounts.get(stage) ?? 0;
  if (count >= maxLoggedGroups) return;

  debugSeparateCounts.set(stage, count + 1);
  console.debug('[SoundWave] Canonical keep-separate', {
    stage,
    reason: compare.reason,
    titleSimilarity: Number(compare.titleSimilarity.toFixed(2)),
    tracks: [debugTrack(a.track, a.identity), debugTrack(b.track, b.identity)],
  });
}

function logCollapseGroup(
  stage: string,
  group: TrackIdentity[],
  best: Track,
  reason: string,
  maxLoggedGroups: number,
) {
  const count = debugGroupCounts.get(stage) ?? 0;
  if (count >= maxLoggedGroups) return;

  const bestIdentity = identityForTrack(best);
  debugGroupCounts.set(stage, count + 1);
  console.debug('[SoundWave] Canonical collapse', {
    stage,
    workKey: bestIdentity.workKey,
    canonicalScore: Number(canonicalScore(best).toFixed(2)),
    reason,
    kept: debugTrack(best, bestIdentity),
    candidates: group.map((item) => debugTrack(item.track, item.identity)),
  });
}

function groupCollapseReason(group: TrackIdentity[]): string {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const compare = compareWorkIdentities(group[i].identity, group[j].identity);
      if (compare.same) return compare.reason;
    }
  }
  return 'same work key';
}

function groupByWork(tracks: Track[], opts: CollapseOptions = {}): TrackIdentity[][] {
  const stage = opts.stage ?? 'collapse';
  const maxLoggedGroups = opts.maxLoggedGroups ?? DEBUG_DEFAULT_GROUP_LIMIT;
  const items = tracks
    .filter((track) => !!track?.urn)
    .map((track, index) => ({ track, identity: identityForTrack(track), index }));
  const parent = items.map((_, index) => index);

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const compare = compareWorkIdentities(items[i].identity, items[j].identity);
      if (compare.same) {
        parentUnion(parent, i, j);
      } else if (compare.titleMatched) {
        logKeepSeparate(stage, items[i], items[j], compare, maxLoggedGroups);
      }
    }
  }

  const groupsByRoot = new Map<number, TrackIdentity[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = parentFind(parent, index);
    const group = groupsByRoot.get(root);
    if (group) {
      group.push(items[index]);
    } else {
      groupsByRoot.set(root, [items[index]]);
    }
  }

  return [...groupsByRoot.values()].sort((a, b) => a[0].index - b[0].index);
}

function originalReleaseBonus(track: RawTrack): number {
  let bonus = 0;
  const pm = track.publisher_metadata;
  if (pm && typeof pm === 'object') {
    if (asString(pm.isrc).trim()) bonus += 12;
    const metaArtist = asString(pm.artist).trim().toLowerCase();
    if (metaArtist && metaArtist === (track.user?.username || '').toLowerCase()) bonus += 5;
    if (asString(pm.album_title).trim()) bonus += 2;
  }
  if (asString(track.label_name).trim()) bonus += 6;
  if (asString(track.release_date).trim()) bonus += 4;
  const monet = asString(track.monetization_model).toUpperCase();
  if (monet.includes('SUB') || monet.includes('AD')) bonus += 3;
  return bonus;
}

function authorityBonus(track: RawTrack): number {
  const followers = track.user?.followers_count ?? 0;
  let bonus = 0;
  if (followers >= 500_000) bonus += 8;
  else if (followers >= 100_000) bonus += 6;
  else if (followers >= 20_000) bonus += 3;
  if (asString(track.label_name).trim() && followers >= 10_000) bonus += 2;
  return bonus;
}

function popularitySignal(track: Track): number {
  const plays = Math.max(0, track.playback_count ?? 0);
  const likes = Math.max(0, track.likes_count ?? track.favoritings_count ?? 0);
  const reposts = Math.max(0, track.reposts_count ?? 0);
  const playScore = Math.min(10, Math.log10(plays + 1) * 1.4);
  const likeScore = Math.min(6, Math.log10(likes + 1) * 1.2);
  const repostScore = Math.min(2, Math.log10(reposts + 1) * 0.6);
  return playScore + likeScore + repostScore;
}

export function canonicalScore(track: Track): number {
  const raw = track as RawTrack;
  const { kind } = detectModifier(track.title);
  let score = 100 - MODIFIER_PENALTY[kind];
  score += originalReleaseBonus(raw);
  score += authorityBonus(raw);
  score += popularitySignal(track);
  return score;
}

export function originalityScore(track: Track): number {
  return canonicalScore(track);
}

function pickCanonical(group: Track[], protectedUrns?: Set<string>): Track {
  const protectedTrack = protectedUrns
    ? group.find((track) => track.urn && protectedUrns.has(track.urn))
    : undefined;
  if (protectedTrack) return protectedTrack;

  let best = group[0];
  let bestScore = canonicalScore(best);
  for (let i = 1; i < group.length; i += 1) {
    const candidate = group[i];
    const score = canonicalScore(candidate);
    if (score > bestScore + 0.01) {
      best = candidate;
      bestScore = score;
      continue;
    }
    if (Math.abs(score - bestScore) <= 0.01) {
      const byPlays = (candidate.playback_count ?? 0) - (best.playback_count ?? 0);
      const byLikes = (candidate.likes_count ?? 0) - (best.likes_count ?? 0);
      const candidateDate = Date.parse(candidate.created_at ?? '') || Infinity;
      const bestDate = Date.parse(best.created_at ?? '') || Infinity;
      if (
        byPlays > 0 ||
        (byPlays === 0 && byLikes > 0) ||
        (byPlays === 0 && byLikes === 0 && candidateDate < bestDate)
      ) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return best;
}

export function collapseVariations(tracks: Track[], opts: CollapseOptions = {}): Track[] {
  const groups = groupByWork(tracks, opts);
  const stage = opts.stage ?? 'collapse';
  const maxLoggedGroups = opts.maxLoggedGroups ?? DEBUG_DEFAULT_GROUP_LIMIT;

  return groups.map((group) => {
    if (group.length === 1) return group[0].track;

    const best = pickCanonical(
      group.map((item) => item.track),
      opts.protectedUrns,
    );
    const reasonPrefix = opts.protectedUrns?.has(best.urn) ? 'protected queue track kept; ' : '';
    const reason = `${reasonPrefix}${groupCollapseReason(group)}`;
    logCollapseGroup(stage, group, best, reason, maxLoggedGroups);
    return best;
  });
}

export function dedupeWaveQueue(tracks: Track[], opts: CollapseOptions = {}): Track[] {
  return collapseVariations(tracks, { ...opts, stage: opts.stage ?? 'final-queue' });
}

const SUPPRESS_FOR_NEXT = 15;
let playCounter = 0;
const suppressedWorks: Array<{ identity: WorkIdentity; until: number }> = [];

export function registerPlayedForSuppression(track: Track | null | undefined) {
  if (!track?.urn) return;
  playCounter += 1;
  suppressedWorks.push({
    identity: identityForTrack(track),
    until: playCounter + SUPPRESS_FOR_NEXT,
  });
  while (suppressedWorks.length > SUPPRESS_FOR_NEXT * 2) suppressedWorks.shift();
}

export function isVariationSuppressed(track: Track | null | undefined): boolean {
  if (!track?.urn) return false;
  const identity = identityForTrack(track);
  return suppressedWorks.some(
    (entry) => entry.until > playCounter && compareWorkIdentities(entry.identity, identity).same,
  );
}

export function resetVariationSuppression() {
  playCounter = 0;
  suppressedWorks.length = 0;
}
