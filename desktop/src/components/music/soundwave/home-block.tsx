import { listen } from '@tauri-apps/api/event';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { art } from '../../../lib/formatters';
import type { FeedItem, Playlist } from '../../../lib/hooks';
import {
  AudioLines,
  Pause,
  Play,
  pauseBlack14,
  playBlack14,
  RefreshCw,
  SlidersHorizontal,
} from '../../../lib/icons';
import { useAuthStore } from '../../../stores/auth';
import type { Track } from '../../../stores/player';
import { usePlayerStore } from '../../../stores/player';
import { useSettingsStore } from '../../../stores/settings';
import { CHARACTER_PRESETS, useSoundWaveStore } from '../../../stores/soundwave';
import { HideLikedToggle } from './hide-liked-toggle';
import { LanguageFilter } from './language-filter';
import { ModeToggle } from './mode-toggle';

const FLOW_QUEUE_TARGET = 56;
const FLOW_STATION_SEED_LIMIT = 7;
const FLOW_PLAYLIST_LIMIT = 14;
const FLOW_FEED_LIMIT = 36;
const FLOW_BARS = Array.from({ length: 18 }, (_, index) => index);

function resolveTrackCover(track: Track | null): string | null {
  if (!track) return null;
  return art(track.artwork_url, 't500x500') ?? art(track.user.avatar_url, 't300x300');
}

function formatSession(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    compact: `${hours}ч ${minutes}м`,
    full: `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
  };
}

function readAudioBands(bins: readonly number[]) {
  const bassEnd = Math.min(4, bins.length);
  const midEnd = Math.min(16, bins.length);
  let bass = 0;
  let mid = 0;
  let high = 0;

  for (let i = 0; i < bassEnd; i++) bass += bins[i] ?? 0;
  for (let i = bassEnd; i < midEnd; i++) mid += bins[i] ?? 0;
  for (let i = midEnd; i < bins.length; i++) high += bins[i] ?? 0;

  const bassDiv = Math.max(1, bassEnd);
  const midDiv = Math.max(1, midEnd - bassEnd);
  const highDiv = Math.max(1, bins.length - midEnd);
  const nextBass = bass / bassDiv / 255;
  const nextMid = mid / midDiv / 255;
  const nextHigh = high / highDiv / 255;

  return {
    bass: Math.min(1, nextBass),
    mid: Math.min(1, nextMid),
    high: Math.min(1, nextHigh),
    overall: Math.min(1, nextBass * 0.52 + nextMid * 0.34 + nextHigh * 0.14),
  };
}

type TrackListResponse = {
  collection?: Track[];
  next_href?: string | null;
};

type PlaylistListResponse = {
  collection?: Playlist[];
  next_href?: string | null;
};

type StationTrack = Track & {
  station_urn?: string | null;
};

function isPlayableFlowTrack(track: Track | null | undefined): track is Track {
  return Boolean(track?.urn && track.title && track.user?.username && track.access !== 'blocked');
}

function dedupeFlowTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const result: Track[] = [];

  for (const track of tracks) {
    if (!isPlayableFlowTrack(track) || seen.has(track.urn)) continue;
    seen.add(track.urn);
    result.push(track);
  }

  return result;
}

function rotateFlowItems<T>(items: T[], salt: number): T[] {
  if (items.length < 2) return items;
  const offset = Math.abs(salt) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function trackRouteParam(track: Track): string {
  const id = String(track.id || '').trim();
  if (id) return id;
  return track.urn.split(':').pop() ?? track.urn;
}

function extractTracks(input: TrackListResponse | Track[] | null | undefined): Track[] {
  const tracks = Array.isArray(input) ? input : (input?.collection ?? []);
  return tracks.filter(isPlayableFlowTrack);
}

function extractPlaylists(input: PlaylistListResponse | Playlist[] | null | undefined): Playlist[] {
  return Array.isArray(input) ? input : (input?.collection ?? []);
}

async function fetchFlowTracks(path: string): Promise<Track[]> {
  try {
    return extractTracks(await api<TrackListResponse | Track[]>(path, { quietHttpErrors: true }));
  } catch {
    return [];
  }
}

async function fetchFlowPlaylists(path: string): Promise<Playlist[]> {
  try {
    return extractPlaylists(
      await api<PlaylistListResponse | Playlist[]>(path, { quietHttpErrors: true }),
    );
  } catch {
    return [];
  }
}

function extractFlowCursor(nextHref: string | null | undefined): string | undefined {
  if (!nextHref) return undefined;

  try {
    const url = new URL(nextHref, 'https://api.soundcloud.com');
    return url.searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

async function fetchLikedFlowTracks(pageSize = 200): Promise<Track[]> {
  const tracks: Track[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) params.set('cursor', cursor);

    try {
      const response = await api<TrackListResponse>(`/me/likes/tracks?${params}`, {
        quietHttpErrors: true,
      });
      tracks.push(...extractTracks(response));
      cursor = extractFlowCursor(response.next_href);
      if (!cursor) break;
    } catch {
      break;
    }
  }

  return dedupeFlowTracks(tracks);
}

async function fetchPlaylistFlowTracks(playlists: Playlist[], salt: number): Promise<Track[]> {
  const rotated = rotateFlowItems(
    playlists.filter((playlist) => playlist.urn),
    salt,
  );
  const selected = rotated.slice(0, FLOW_PLAYLIST_LIMIT);
  const inlineTracks = selected.flatMap((playlist) => playlist.tracks ?? []);
  const loadedTracks = await Promise.all(
    selected
      .filter((playlist) => !playlist.tracks?.length)
      .slice(0, 6)
      .map((playlist) =>
        fetchFlowTracks(`/playlists/${encodeURIComponent(playlist.urn)}/tracks?limit=24`),
      ),
  );

  return dedupeFlowTracks([...inlineTracks, ...loadedTracks.flat()]);
}

async function fetchFeedFlowTracks(salt: number): Promise<Track[]> {
  const params = new URLSearchParams({
    limit: String(FLOW_FEED_LIMIT),
    linked_partitioning: 'true',
  });
  if (salt > 0) params.set('offset', String((salt % 4) * 10));

  try {
    const response = await api<{ collection?: FeedItem[] }>(`/me/feed?${params}`, {
      quietHttpErrors: true,
    });
    const tracks = (response.collection ?? []).flatMap((item) => [
      item.origin,
      ...(item.origin?.tracks ?? []),
    ]);
    return dedupeFlowTracks(tracks);
  } catch {
    return [];
  }
}

async function fetchStationTracksForSeeds(seeds: Track[], salt: number): Promise<Track[]> {
  const selectedSeeds = rotateFlowItems(seeds, salt).slice(0, FLOW_STATION_SEED_LIMIT);
  const groups = await Promise.all(
    selectedSeeds.map(async (seed) => {
      let stationUrn =
        typeof (seed as StationTrack).station_urn === 'string'
          ? (seed as StationTrack).station_urn?.trim()
          : '';

      if (!stationUrn) {
        try {
          const fullTrack = await api<StationTrack>(
            `/tracks/${encodeURIComponent(trackRouteParam(seed))}`,
            {
              quietHttpErrors: true,
            },
          );
          stationUrn =
            typeof fullTrack.station_urn === 'string' ? fullTrack.station_urn.trim() : '';
        } catch {
          stationUrn = '';
        }
      }

      if (stationUrn) {
        const params = new URLSearchParams({
          limit: '18',
          linked_partitioning: 'true',
          access: 'playable,preview,blocked',
        });
        const stationTracks = await fetchFlowTracks(`/stations/${stationUrn}/tracks?${params}`);
        if (stationTracks.length > 0) return stationTracks;
      }

      return fetchFlowTracks(
        `/tracks/${encodeURIComponent(trackRouteParam(seed))}/related?limit=18`,
      );
    }),
  );

  return dedupeFlowTracks(groups.flat());
}

async function buildSoundCloudFlowQueue(options: {
  anchorTrack?: Track | null;
  refreshSalt: number;
}): Promise<Track[]> {
  const likedTracks = await fetchLikedFlowTracks();
  const seedTracks = dedupeFlowTracks(
    [options.anchorTrack, ...likedTracks].filter(isPlayableFlowTrack),
  );
  const seedSlice = rotateFlowItems(seedTracks, options.refreshSalt).slice(
    0,
    FLOW_STATION_SEED_LIMIT,
  );

  const playlistParams = new URLSearchParams({
    limit: String(FLOW_PLAYLIST_LIMIT),
    linked_partitioning: 'true',
  });

  const [stationTracks, likedPlaylists, ownPlaylists, feedTracks] = await Promise.all([
    fetchStationTracksForSeeds(seedSlice, options.refreshSalt),
    fetchFlowPlaylists(`/me/likes/playlists?${playlistParams}`),
    fetchFlowPlaylists(`/me/playlists?${playlistParams}`),
    fetchFeedFlowTracks(options.refreshSalt),
  ]);

  const playlistTracks = await fetchPlaylistFlowTracks(
    [...likedPlaylists, ...ownPlaylists],
    options.refreshSalt,
  );

  return dedupeFlowTracks([...stationTracks, ...playlistTracks, ...feedTracks, ...seedSlice]).slice(
    0,
    FLOW_QUEUE_TARGET,
  );
}

function FlowLiquidVisualizer({ isPlaying }: { isPlaying: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const speedRef = useRef(0.12);
  const ampRef = useRef(0.65);
  const playWeightRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId = 0;
    let phase = 0;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resizeCanvas();
    const resizeObserver = new ResizeObserver(resizeCanvas);
    if (canvas.parentElement) {
      resizeObserver.observe(canvas.parentElement);
    }

    const particles: Array<{
      x: number;
      y: number;
      speedY: number;
      speedX: number;
      size: number;
      hueOffset: number;
      lightness: number;
      alpha: number;
      life: number;
      maxLife: number;
    }> = [];

    let unlistenAudio: (() => void) | null = null;
    const energy = { bass: 0, mid: 0, high: 0, overall: 0 };
    const targetEnergy = { bass: 0, mid: 0, high: 0, overall: 0 };

    const setupAudio = async () => {
      try {
        unlistenAudio = await listen<number[]>('audio:visualizer', (event) => {
          const bins = event.payload;
          if (!bins?.length || !isPlaying) return;

          const bands = readAudioBands(bins);
          targetEnergy.bass = bands.bass;
          targetEnergy.mid = bands.mid;
          targetEnergy.high = bands.high;
          targetEnergy.overall = bands.overall;
        });
      } catch {
        unlistenAudio = null;
      }
    };

    void setupAudio();

    const spawnParticle = (width: number, height: number, initInCore: boolean) => {
      const cx = width / 2;
      const cy = height / 2;
      let x = cx + (Math.random() * 160 - 80);
      let y = cy + (Math.random() * 160 - 80);

      if (!initInCore) {
        x = Math.random() * width;
        y = cy + (Math.random() * 180 - 45);
      }

      return {
        x,
        y,
        speedY: (Math.random() * 0.95 + 0.35) * -1,
        speedX: Math.random() * 0.8 - 0.4,
        size: Math.random() * 2.2 + 1.2,
        hueOffset: Math.random() * 50 - 25,
        lightness: Math.random() * 15 + 68,
        alpha: Math.random() * 0.85 + 0.15,
        life: 0,
        maxLife: Math.random() * 180 + 70,
      };
    };

    const getDynamicColor = (hueOffset: number, sat: number, lit: number, alpha = 1) => {
      const audioHue = energy.bass * 24 + energy.mid * 38 + energy.high * 54;
      const activeHue = (340 + phase * 18 + hueOffset + audioHue) % 360;
      const pausedHue = (22 + Math.sin(phase * 0.15) * 8 + hueOffset) % 360;
      let diff = activeHue - pausedHue;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;

      const baseHue = (pausedHue + diff * playWeightRef.current + 360) % 360;
      return `hsla(${baseHue}, ${sat}%, ${lit}%, ${alpha})`;
    };

    const drawOrganicBlob = (
      cx: number,
      cy: number,
      baseRadius: number,
      phaseOffset: number,
      amp: number,
      color1: string,
      color2: string,
      color3: string,
      numPoints: number,
      blurPx: number,
      opacity: number,
      layerIndex: number,
    ) => {
      ctx.save();
      ctx.filter = `blur(${blurPx}px)`;
      ctx.globalAlpha = opacity;

      const driftX = Math.sin(phase * 0.42 + layerIndex * 1.5) * baseRadius * 0.28;
      const driftY = Math.cos(phase * 0.33 + layerIndex * 2.2) * baseRadius * 0.24;
      const stretchX = 1.48 + Math.sin(phase * 0.22 + layerIndex * 1.3) * 0.38;
      const stretchY = 0.62 + Math.cos(phase * 0.18 + layerIndex * 0.9) * 0.24;
      const rotationAngle = phase * 0.28 * (layerIndex % 2 === 0 ? 1 : -1) + phaseOffset;

      ctx.translate(cx + driftX, cy + driftY);
      ctx.rotate(rotationAngle);
      ctx.scale(stretchX, stretchY);

      const grad = ctx.createRadialGradient(0, 0, baseRadius * 0.02, 0, 0, baseRadius * 1.35);
      grad.addColorStop(0, color1);
      grad.addColorStop(0.36, color2);
      grad.addColorStop(0.72, color3);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;

      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        let rFactor = 0.82;
        rFactor += 0.48 * Math.sin(angle - phase * 0.12 + phaseOffset);
        rFactor += 0.4 * Math.cos(angle * 2 + phase * 0.08 - phaseOffset * 1.2);
        rFactor += 0.28 * Math.sin(angle * 3 - phase * 0.11 + phaseOffset * 0.7);
        rFactor += 0.18 * Math.cos(angle * 5 + phase * 0.14 + phaseOffset * 1.5);

        const interference =
          Math.sin(angle * 2.5 + phase * 0.08) * Math.cos(angle - phase * 0.06) * 0.2;
        const spike1 = Math.abs(Math.sin(angle * 1.5 + phase * 0.09 + phaseOffset)) ** 1.8 * 0.55;
        const spike2 =
          Math.abs(Math.cos(angle * 3.5 - phase * 0.07 + phaseOffset * 1.4)) ** 1.8 * 0.45;
        const turbulence = Math.sin(angle * 6 + phase * 0.15) * 0.04 * (isPlaying ? 0.8 : 0.25);
        const totalR = baseRadius * (rFactor + (interference + spike1 + spike2 + turbulence) * amp);

        points.push({
          x: Math.cos(angle) * totalR,
          y: Math.sin(angle) * totalR,
        });
      }

      const lastPoint = points[points.length - 1];
      ctx.beginPath();
      ctx.moveTo((lastPoint.x + points[0].x) / 2, (lastPoint.y + points[0].y) / 2);

      for (let i = 0; i < numPoints; i++) {
        const next = (i + 1) % numPoints;
        ctx.quadraticCurveTo(
          points[i].x,
          points[i].y,
          (points[i].x + points[next].x) / 2,
          (points[i].y + points[next].y) / 2,
        );
      }

      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const render = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      const cx = width / 2;
      const cy = height / 2;

      while (particles.length < 34) {
        particles.push(spawnParticle(width, height, false));
      }

      if (!isPlaying) {
        targetEnergy.bass = 0;
        targetEnergy.mid = 0;
        targetEnergy.high = 0;
        targetEnergy.overall = 0;
      }

      const colorEase = isPlaying ? 0.0045 : 0.012;
      energy.bass += (targetEnergy.bass - energy.bass) * colorEase;
      energy.mid += (targetEnergy.mid - energy.mid) * colorEase;
      energy.high += (targetEnergy.high - energy.high) * colorEase;
      energy.overall += (targetEnergy.overall - energy.overall) * colorEase;

      const targetSpeed = isPlaying ? 0.22 : 0.08;
      const targetAmp = isPlaying ? 1.28 : 0.68;
      const targetPlayWeight = isPlaying ? 1 : 0;

      speedRef.current += (targetSpeed - speedRef.current) * 0.035;
      ampRef.current += (targetAmp - ampRef.current) * 0.035;
      playWeightRef.current += (targetPlayWeight - playWeightRef.current) * 0.035;
      phase += 0.0035 * speedRef.current;

      ctx.clearRect(0, 0, width, height);
      const baseRadius = Math.min(width, height) * 0.44;

      drawOrganicBlob(
        cx,
        cy,
        baseRadius * 1.38,
        0,
        1.22 * ampRef.current,
        getDynamicColor(240, 80, 42, 0.85),
        getDynamicColor(310, 75, 48, 0.3),
        'rgba(0, 0, 0, 0)',
        72,
        65,
        0.5,
        1,
      );

      const flowOffset2X = Math.sin(phase * 0.48) * baseRadius * 0.18;
      const flowOffset2Y = Math.cos(phase * 0.38) * baseRadius * 0.15;

      drawOrganicBlob(
        cx + flowOffset2X,
        cy + flowOffset2Y,
        baseRadius * 1.05,
        Math.PI * 0.38,
        1.15 * ampRef.current,
        getDynamicColor(340, 85, 45, 0.6),
        getDynamicColor(15, 85, 48, 0.55),
        'rgba(0, 0, 0, 0)',
        72,
        48,
        0.6,
        2,
      );

      drawOrganicBlob(
        cx - flowOffset2X,
        cy - flowOffset2Y,
        baseRadius * 0.96,
        Math.PI * 1.38,
        1.1 * ampRef.current,
        getDynamicColor(315, 85, 42, 0.55),
        getDynamicColor(350, 80, 48, 0.5),
        'rgba(0, 0, 0, 0)',
        72,
        42,
        0.55,
        3,
      );

      const flowOffset3X = Math.cos(phase * 0.58) * baseRadius * 0.22;
      const flowOffset3Y = Math.sin(phase * 0.44) * baseRadius * 0.18;

      drawOrganicBlob(
        cx + flowOffset3X,
        cy - flowOffset3Y,
        baseRadius * 0.84,
        Math.PI * 0.78,
        1.1 * ampRef.current,
        getDynamicColor(18, 90, 50, 0.75),
        getDynamicColor(50, 90, 48, 0.45),
        'rgba(0, 0, 0, 0)',
        72,
        32,
        0.65,
        4,
      );

      drawOrganicBlob(
        cx - flowOffset3X,
        cy + flowOffset3Y,
        baseRadius * 0.76,
        Math.PI * 1.88,
        1.05 * ampRef.current,
        getDynamicColor(355, 90, 48, 0.7),
        getDynamicColor(30, 90, 52, 0.45),
        'rgba(0, 0, 0, 0)',
        72,
        28,
        0.6,
        5,
      );

      const coreOffsetAX = Math.sin(phase * 0.75) * baseRadius * 0.16;
      const coreOffsetAY = Math.cos(phase * 0.64) * baseRadius * 0.14;

      drawOrganicBlob(
        cx + coreOffsetAX,
        cy + coreOffsetAY,
        baseRadius * 0.44,
        Math.PI * 1.28,
        0.9 * ampRef.current,
        getDynamicColor(45, 85, 70, 0.8),
        getDynamicColor(65, 80, 80, 0.75),
        'rgba(0, 0, 0, 0)',
        64,
        22,
        0.75,
        6,
      );

      drawOrganicBlob(
        cx,
        cy,
        baseRadius * 0.3,
        Math.PI * 2.15,
        0.8 * ampRef.current,
        getDynamicColor(340, 80, 75, 0.85),
        getDynamicColor(50, 85, 85, 0.75),
        'rgba(0, 0, 0, 0)',
        64,
        15,
        0.8,
        7,
      );

      particles.forEach((particle, index) => {
        particle.life += isPlaying ? 1.2 : 0.35;
        particle.y += particle.speedY * (isPlaying ? 2.6 : 0.85);
        particle.x += particle.speedX * (isPlaying ? 1.5 : 0.5);
        particle.x += Math.sin(particle.y * 0.02 + phase) * 0.45;

        const ageRatio = particle.life / particle.maxLife;
        const opacityRatio = Math.max(0, 1 - ageRatio);

        if (ageRatio >= 1 || particle.y < -20 || particle.x < -20 || particle.x > width + 20) {
          particles[index] = spawnParticle(width, height, index % 3 === 0);
          return;
        }

        ctx.save();
        ctx.globalAlpha = particle.alpha * opacityRatio * (isPlaying ? 1 : 0.35);
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (1 - ageRatio * 0.4), 0, Math.PI * 2);
        ctx.fillStyle = getDynamicColor(
          particle.hueOffset,
          100,
          particle.lightness,
          opacityRatio * particle.alpha,
        );
        ctx.shadowBlur = isPlaying ? 12 : 4;
        ctx.shadowColor = getDynamicColor(particle.hueOffset, 100, particle.lightness, 0.7);
        ctx.fill();
        ctx.restore();
      });

      animationFrameId = window.requestAnimationFrame(render);
    };

    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      unlistenAudio?.();
      resizeObserver.disconnect();
    };
  }, [isPlaying]);

  return (
    <div className="absolute inset-0 w-full h-full pointer-events-none select-none overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full opacity-[0.58] mix-blend-screen"
        style={{ filter: 'blur(4px) contrast(1.06)' }}
      />
    </div>
  );
}

const FlowSessionTime = React.memo(function FlowSessionTime({ isPlaying }: { isPlaying: boolean }) {
  const fullRef = useRef<HTMLSpanElement | null>(null);
  const compactRef = useRef<HTMLElement | null>(null);
  const playingRef = useRef(isPlaying);
  const sessionSecondsRef = useRef(0);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const paint = () => {
      const formatted = formatSession(sessionSecondsRef.current);
      if (fullRef.current) fullRef.current.textContent = formatted.full;
      if (compactRef.current) compactRef.current.textContent = formatted.compact;
    };

    paint();
    const interval = window.setInterval(() => {
      if (playingRef.current) {
        sessionSecondsRef.current += 1;
      }
      paint();
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <span
          ref={fullRef}
          className="text-2xl font-mono font-light text-white tracking-tight leading-none"
        >
          {formatSession(0).full}
        </span>
        <span className="text-[9px] text-white/25 font-bold uppercase tracking-wider">
          {isPlaying ? 'активна' : 'пауза'}
        </span>
      </div>
      <div className="text-[10px] text-[#a1a1aa] font-medium leading-none pt-1">
        Ты в музыке уже{' '}
        <strong ref={compactRef} className="text-white/60 font-mono text-[10px]">
          {formatSession(0).compact}
        </strong>
      </div>
    </div>
  );
});

const FlowBars = React.memo(function FlowBars({ isPlaying }: { isPlaying: boolean }) {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef<number[]>(FLOW_BARS.map(() => 0.22));
  const targetsRef = useRef<number[]>(FLOW_BARS.map(() => 0.22));
  const playingRef = useRef(isPlaying);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    let animationFrameId = 0;
    let unlistenAudio: (() => void) | null = null;
    let lastAudioAt = 0;

    const setupAudio = async () => {
      try {
        unlistenAudio = await listen<number[]>('audio:visualizer', (event) => {
          const bins = event.payload;
          if (!bins?.length || !playingRef.current) return;

          lastAudioAt = performance.now();
          const targetLevels = targetsRef.current;
          for (let index = 0; index < FLOW_BARS.length; index++) {
            const start = Math.floor((index / FLOW_BARS.length) * bins.length);
            const end = Math.max(
              start + 1,
              Math.floor(((index + 1) / FLOW_BARS.length) * bins.length),
            );
            let sum = 0;

            for (let binIndex = start; binIndex < end; binIndex++) {
              sum += bins[binIndex] ?? 0;
            }

            const average = sum / Math.max(1, end - start);
            const shaped = Math.min(1, (average / 255) ** 0.72 * 1.28);
            const bassLift = index < 4 ? 0.12 : 0;
            targetLevels[index] = Math.min(1, 0.16 + shaped * 0.84 + bassLift * shaped);
          }
        });
      } catch {
        unlistenAudio = null;
      }
    };

    void setupAudio();

    const render = () => {
      const levels = levelsRef.current;
      const targets = targetsRef.current;
      const now = performance.now();
      const hasFreshAudio = now - lastAudioAt < 700;

      for (let index = 0; index < FLOW_BARS.length; index++) {
        const fallbackPulse =
          playingRef.current && !hasFreshAudio
            ? 0.24 + Math.abs(Math.sin(now * 0.006 + index * 0.72)) * 0.34
            : 0.22;
        const target = playingRef.current ? (hasFreshAudio ? targets[index] : fallbackPulse) : 0.18;
        const ease = target > levels[index] ? 0.42 : 0.18;
        levels[index] += (target - levels[index]) * ease;

        const element = barRefs.current[index];
        if (!element) continue;

        const level = Math.max(0.14, Math.min(1, levels[index]));
        const hue = 14 + level * 22 + index * 0.35;
        element.style.transform = `scaleY(${level.toFixed(3)})`;
        element.style.opacity = String(Math.min(1, 0.5 + level * 0.62));
        element.style.background = `linear-gradient(to top, hsla(${hue}, 92%, 50%, 0.9), hsla(${hue + 24}, 88%, 58%, 0.78))`;
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      unlistenAudio?.();
    };
  }, []);

  return (
    <div className="flex items-end gap-[2px] h-5 mt-4 border-t border-white/[0.02] pt-3 w-full">
      {FLOW_BARS.map((index) => (
        <span
          key={index}
          ref={(element) => {
            barRefs.current[index] = element;
          }}
          className="flex-1 min-w-[2px] h-4 origin-bottom rounded-full bg-gradient-to-t from-orange-500/80 to-pink-500/60 will-change-transform"
          style={{
            transform: 'scaleY(0.22)',
          }}
        />
      ))}
    </div>
  );
});

export const SoundWaveBlock = React.memo(function SoundWaveBlock() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const selectedLanguages = useSettingsStore((s) => s.soundwaveLanguages);
  const setSelectedLanguages = useSettingsStore((s) => s.setSoundwaveLanguages);
  const mode = useSettingsStore((s) => s.soundwaveMode);
  const hideLiked = useSettingsStore((s) => s.soundwaveHideLiked);
  const setHideLiked = useSettingsStore((s) => s.setSoundwaveHideLiked);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queueSource = usePlayerStore((s) => s.queueSource);
  const isWaveActive = useSoundWaveStore((s) => s.isActive);
  const startFromQueue = useSoundWaveStore((s) => s.startFromQueue);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStartingWave, setIsStartingWave] = useState(false);
  const [showFlowTuner, setShowFlowTuner] = useState(false);

  const waveTrack = currentTrack ?? null;
  const waveSessionPreset =
    mode === 'diverse' ? CHARACTER_PRESETS.discover : CHARACTER_PRESETS.favorite;
  const isWaveQueue = isWaveActive && queueSource === 'soundwave' && !!currentTrack;

  const playSoundCloudFlow = useCallback(
    async (options?: { preserveCurrentTrack?: boolean }) => {
      const anchorTrack = isPlaying && currentTrack ? currentTrack : null;
      const queue = await buildSoundCloudFlowQueue({
        anchorTrack,
        refreshSalt: Date.now(),
      });
      if (queue.length === 0) return;

      const seedTracks = dedupeFlowTracks(
        [anchorTrack, ...queue].filter(isPlayableFlowTrack),
      ).slice(0, FLOW_STATION_SEED_LIMIT);

      await startFromQueue({
        queue,
        seedTracks,
        preserveCurrentTrack: Boolean(anchorTrack && options?.preserveCurrentTrack),
        preset: waveSessionPreset,
        continuationStrategy: null,
      });
    },
    [currentTrack, isPlaying, startFromQueue, waveSessionPreset],
  );

  const handleRefresh = async () => {
    if (isRefreshing || isStartingWave) return;

    setIsRefreshing(true);
    try {
      await playSoundCloudFlow({ preserveCurrentTrack: false });
    } finally {
      window.setTimeout(() => setIsRefreshing(false), 650);
    }
  };

  const handlePlayAll = async () => {
    if (isStartingWave) return;

    if (isWaveQueue) {
      if (isPlaying) {
        usePlayerStore.getState().pause();
      } else {
        usePlayerStore.getState().resume();
      }
      return;
    }

    setIsStartingWave(true);
    try {
      await playSoundCloudFlow({ preserveCurrentTrack: true });
    } finally {
      setIsStartingWave(false);
    }
  };

  const canStartWave = !isRefreshing || isWaveQueue;
  const spinning = isRefreshing;
  const trackCover = resolveTrackCover(waveTrack);
  const flowTitle = waveTrack?.title ?? 'Flow готов к запуску';
  const flowArtist = waveTrack?.user.username ?? 'Персональный эфир';
  const playLabel = isStartingWave ? 'Запускаем' : isWaveQueue && isPlaying ? 'Пауза' : 'Слушать';
  const playIcon = isStartingWave ? (
    <RefreshCw size={14} className="animate-spin" />
  ) : isWaveQueue && isPlaying ? (
    pauseBlack14
  ) : (
    playBlack14
  );

  if (!isAuthenticated) return null;

  return (
    <section
      className="relative flex min-h-[calc(100dvh-198px)] lg:min-h-[calc(100dvh-165px)] overflow-hidden border-b border-white/[0.06] bg-gradient-to-b from-[#090b11] via-[#050609] to-[#020204] p-8 lg:p-10 select-none group/flow"
      style={{
        contain: 'layout style paint',
        transform: 'translateZ(0)',
      }}
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff02_1.5px,transparent_1.5px)] [background-size:20px_20px] opacity-75 mix-blend-overlay" />
        <FlowLiquidVisualizer isPlaying={isPlaying} />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(2,3,6,0.92)_0%,rgba(2,3,6,0.18)_47%,rgba(2,3,6,0.9)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.02)_0%,rgba(255,255,255,0)_44%,rgba(0,0,0,0.42)_100%)]" />
      </div>
      <div
        className="absolute inset-x-0 bottom-0 z-[1] h-44 pointer-events-none bg-gradient-to-b from-transparent via-[#020204]/75 to-[var(--bg-primary)]"
        aria-hidden
      />

      <div className="relative z-10 grid min-h-[500px] w-full flex-1 grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        <div className="lg:col-span-4 flex flex-col justify-start h-full space-y-6 py-3 text-left">
          <div className="space-y-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono tracking-[0.25em] text-[#a1a1aa] uppercase font-bold">
                Персональный эфир
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shadow-[0_0_8px_rgba(255,85,0,0.8)]" />
            </div>

            <div className="flex items-center gap-4">
              <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white select-none">
                Мой Flow
              </h1>
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-r from-orange-500 to-pink-500 shadow-[0_4px_15px_rgba(255,85,0,0.35)]">
                <AudioLines className="w-4.5 h-4.5 text-white animate-spin [animation-duration:8s]" />
              </div>
            </div>

            <div className="space-y-1.5 pt-2">
              <p className="text-[11px] font-mono text-white/40 uppercase tracking-widest font-semibold">
                Продолжай слушать
              </p>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-white leading-tight truncate group-hover/flow:text-orange-400 transition-colors">
                  {flowTitle}
                </h2>
                <p className="text-xs text-[#a1a1aa] mt-0.5 font-medium truncate">{flowArtist}</p>
              </div>
            </div>

            <div className="flex flex-nowrap items-center gap-3 pt-5">
              <button
                type="button"
                onClick={() => void handlePlayAll()}
                disabled={!canStartWave || isStartingWave}
                className="h-12 min-w-[154px] rounded-full bg-white text-slate-950 hover:bg-orange-500 hover:text-white disabled:opacity-45 disabled:hover:bg-white disabled:hover:text-slate-950 transition-all duration-300 transform hover:scale-[1.05] active:scale-[0.95] flex items-center justify-center gap-2.5 px-6 shadow-lg hover:shadow-orange-500/25 cursor-pointer disabled:cursor-not-allowed shrink-0 font-bold text-[13px]"
                title={playLabel}
              >
                {playIcon}
                <span>{playLabel}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowFlowTuner((value) => !value)}
                className={`group/tune flex h-12 w-[136px] items-center justify-center gap-2.5 rounded-full border border-white/10 backdrop-blur-md text-white/90 hover:text-white select-none active:scale-[0.95] shrink-0 cursor-pointer transition-colors duration-200 ${
                  showFlowTuner
                    ? 'bg-orange-500/10 border-orange-500/25 text-orange-400'
                    : 'bg-white/[0.04] hover:bg-white/[0.08]'
                }`}
                title="Настроить Flow"
              >
                <SlidersHorizontal
                  className={`w-4 h-4 transition-transform duration-200 group-hover/tune:rotate-12 ${
                    showFlowTuner ? 'text-orange-400' : 'text-white/85 group-hover/tune:text-white'
                  }`}
                />
                <span className="text-xs font-bold tracking-wider whitespace-nowrap leading-none">
                  Настроить
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 min-h-[220px] lg:min-h-[300px] w-full pointer-events-none" />

        <div className="lg:col-span-4 flex flex-col justify-between h-full space-y-6 py-3 lg:pl-6 lg:border-l lg:border-white/[0.05]">
          <div className="bg-white/[0.02] border border-white/[0.04] p-3.5 rounded-3xl flex items-center justify-between gap-4 shadow-inner hover:bg-white/[0.035] transition-all duration-300">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="relative w-11 h-11 rounded-2xl overflow-hidden shrink-0 border border-white/[0.08] shadow-[0_4px_12px_rgba(0,0,0,0.3)] bg-slate-950">
                {trackCover ? (
                  <img
                    src={trackCover}
                    alt=""
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                    draggable={false}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-white/[0.04]">
                    <AudioLines className="w-4 h-4 text-white/25" />
                  </div>
                )}
                {isPlaying && waveTrack ? (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500" />
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="min-w-0">
                <h4 className="text-xs font-bold text-white truncate leading-tight">{flowTitle}</h4>
                <p className="text-[10px] text-white/40 truncate mt-0.5 leading-none">
                  {flowArtist}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handlePlayAll()}
              disabled={!canStartWave || isStartingWave}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 hover:scale-105 active:scale-90 flex items-center justify-center text-white transition-all cursor-pointer select-none shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
              title={playLabel}
            >
              {isWaveQueue && isPlaying ? (
                <Pause className="w-3.5 h-3.5 fill-current" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
              )}
            </button>
          </div>

          <div className="bg-white/[0.015] border border-white/[0.03] p-5 rounded-3xl relative overflow-hidden flex min-h-[150px] flex-col justify-center shadow-xl">
            <div className="absolute -right-8 -bottom-8 w-24 h-24 bg-orange-500/[0.04] rounded-full blur-2xl pointer-events-none" />

            <div className="space-y-1">
              <span className="text-[9px] font-mono tracking-widest text-[#ff5500]/80 uppercase block font-bold leading-none">
                Сессия длится
              </span>
              <FlowSessionTime isPlaying={isPlaying} />
            </div>

            <FlowBars isPlaying={isPlaying} />
          </div>
        </div>
      </div>

      {showFlowTuner ? (
        <div className="absolute inset-0 z-20 flex flex-col justify-between gap-6 overflow-y-auto bg-slate-950/95 backdrop-blur-2xl border border-white/10 p-6 md:p-8 animate-fade-in-up">
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-white/5 pb-4 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <SlidersHorizontal className="w-5 h-5 text-orange-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono truncate">
                    Настройка твоего Flow
                  </h3>
                  <p className="text-[11px] text-[#a1a1aa] truncate">
                    Подстрой эфир под язык, подбор и свежесть рекомендаций
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowFlowTuner(false)}
                className="text-[10px] font-mono uppercase tracking-widest text-white/40 hover:text-white border border-white/10 hover:bg-white/5 px-3 py-1.5 rounded-full transition-all cursor-pointer shrink-0"
              >
                Закрыть
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white/[0.015] p-4 rounded-2xl border border-white/[0.03] space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-white">Алгоритм подбора</h4>
                  <p className="text-[10px] text-white/40 mt-0.5">
                    Ближе к текущему вкусу или шире по настроению
                  </p>
                </div>
                <ModeToggle />
              </div>

              <div className="bg-white/[0.015] p-4 rounded-2xl border border-white/[0.03] space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-white">Языки эфира</h4>
                  <p className="text-[10px] text-white/40 mt-0.5">
                    Ограничь Flow выбранными языками
                  </p>
                </div>
                <LanguageFilter selected={selectedLanguages} onChange={setSelectedLanguages} />
              </div>

              <div className="bg-white/[0.015] p-4 rounded-2xl border border-white/[0.03] space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-white">Свежесть подборки</h4>
                  <p className="text-[10px] text-white/40 mt-0.5">
                    Можно убрать уже лайкнутые треки
                  </p>
                </div>
                <HideLikedToggle value={hideLiked} onChange={setHideLiked} />
              </div>

              <div className="bg-white/[0.015] p-4 rounded-2xl border border-white/[0.03] flex flex-col justify-between gap-4">
                <div>
                  <h4 className="text-xs font-bold text-white">Обновление эфира</h4>
                  <p className="text-[10px] text-white/40 mt-0.5">
                    Запросить свежую пачку треков для Flow
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={spinning}
                  className="h-10 px-4 rounded-full bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.1] hover:border-white/[0.14] transition-colors duration-200 text-white/80 hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 text-xs font-bold"
                  title="Обновить Flow"
                >
                  <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
                  Обновить Flow
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-white/5 pt-4 flex items-center justify-between gap-4">
            <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
              Neural Flow System
            </p>
            <button
              type="button"
              onClick={() => setShowFlowTuner(false)}
              className="h-10 px-6 rounded-full bg-[#ff5500] hover:bg-orange-600 font-extrabold text-xs text-white shadow-lg transition-all active:scale-95 cursor-pointer"
            >
              Применить параметры
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
});
