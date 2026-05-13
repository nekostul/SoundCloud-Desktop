import Fuse from 'fuse.js';
import type { IFuseOptions } from 'fuse.js';
import type { Track } from '../stores/player';

type SearchableTrack = {
  combined: string;
  description: string;
  genre: string;
  index: number;
  normalizedArtist: string;
  normalizedCombined: string;
  normalizedTitle: string;
  tags: string;
  title: string;
  track: Track;
  username: string;
};

const TRACK_FUSE_OPTIONS: IFuseOptions<SearchableTrack> = {
  threshold: 0.36,
  ignoreLocation: true,
  includeScore: true,
  minMatchCharLength: 2,
  shouldSort: true,
  keys: [
    { name: 'title', weight: 0.5 },
    { name: 'username', weight: 0.3 },
    { name: 'combined', weight: 0.1 },
    { name: 'tags', weight: 0.06 },
    { name: 'genre', weight: 0.02 },
    { name: 'description', weight: 0.02 },
  ],
};

function normalizeTrackSearchText(value: string | undefined | null) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function createSearchableTracks(tracks: Track[]): SearchableTrack[] {
  return tracks.map((track, index) => {
    const title = track.title || '';
    const username = track.user?.username || '';
    const genre = track.genre || '';
    const tags = track.tag_list || '';
    const description = track.description || '';
    const combined = [title, username, genre, tags].filter(Boolean).join(' ');

    return {
      combined,
      description,
      genre,
      index,
      normalizedArtist: normalizeTrackSearchText(username),
      normalizedCombined: normalizeTrackSearchText(`${combined} ${description}`),
      normalizedTitle: normalizeTrackSearchText(title),
      tags,
      title,
      track,
      username,
    };
  });
}

function getLiteralBoost(track: SearchableTrack, normalizedQuery: string) {
  let boost = 0;

  if (track.normalizedTitle === normalizedQuery) boost -= 0.38;
  else if (track.normalizedTitle.startsWith(normalizedQuery)) boost -= 0.2;
  else if (track.normalizedTitle.includes(normalizedQuery)) boost -= 0.11;

  if (track.normalizedArtist === normalizedQuery) boost -= 0.16;
  else if (track.normalizedArtist.startsWith(normalizedQuery)) boost -= 0.08;
  else if (track.normalizedArtist.includes(normalizedQuery)) boost -= 0.04;

  if (track.normalizedCombined.includes(normalizedQuery)) boost -= 0.03;

  return boost;
}

function getTrackSearchScores(tracks: Track[], query: string) {
  const normalizedQuery = normalizeTrackSearchText(query);
  const searchable = createSearchableTracks(tracks);

  if (!normalizedQuery) {
    return {
      normalizedQuery,
      results: searchable.map((track) => ({ score: track.index, track })),
      searchable,
    };
  }

  const fuse = new Fuse(searchable, TRACK_FUSE_OPTIONS);
  const fuseResults = fuse.search(normalizedQuery);
  const scoreByUrn = new Map<string, number>();

  for (const result of fuseResults) {
    const urn = result.item.track.urn;
    const adjustedScore = (result.score ?? 1) + getLiteralBoost(result.item, normalizedQuery);
    const nextScore = Math.max(0, adjustedScore);
    const prevScore = scoreByUrn.get(urn);
    if (prevScore == null || nextScore < prevScore) {
      scoreByUrn.set(urn, nextScore);
    }
  }

  return {
    normalizedQuery,
    results: searchable.map((track) => ({
      score: scoreByUrn.get(track.track.urn) ?? 10 + track.index,
      track,
    })),
    searchable,
  };
}

export function rankTracksByQuery(tracks: Track[], query: string): Track[] {
  const { normalizedQuery, results } = getTrackSearchScores(tracks, query);
  if (!normalizedQuery) return tracks;

  return [...results]
    .sort((a, b) => a.score - b.score || a.track.index - b.track.index)
    .map(({ track }) => track.track);
}

export function filterTracksByQuery(tracks: Track[], query: string): Track[] {
  const { normalizedQuery, results } = getTrackSearchScores(tracks, query);
  if (!normalizedQuery) return tracks;

  return results
    .filter(({ score, track }) => score <= 0.46 || track.normalizedCombined.includes(normalizedQuery))
    .sort((a, b) => a.score - b.score || a.track.index - b.track.index)
    .map(({ track }) => track.track);
}
