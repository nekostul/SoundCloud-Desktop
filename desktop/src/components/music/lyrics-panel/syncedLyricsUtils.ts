import { useEffect, useState } from 'react';
import { getCurrentTime, getSmoothCurrentTime } from '../../../lib/audio';
import type { AudioFeatures } from '../../../lib/audio-analyser';
import type { LyricLine, LyricsSource } from '../../../lib/lyrics';
import { getLyricMotionHintsForTrack, searchLyrics } from '../../../lib/lyrics';
import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  type Track,
  usePlayerStore,
} from '../../../stores/player';
import { getLyricsSearchOptions, getTrackDurationMs } from './lyricsData';

export function clamp01(value: number) {
  return Math.max(0, Math.min(value, 1));
}

export function getSmoothLyricTime(): number {
  try {
    return getSmoothCurrentTime();
  } catch {
    return getCurrentTime();
  }
}

const LYRIC_ACTIVE_TIME_BIAS_PER_RATE = 0.11;
const LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC = -0.03;
const LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC = 0.08;

export function getActiveLyricTime(rawTime: number): number {
  const smoothTime = getSmoothLyricTime();
  const playbackRate = Math.max(
    PLAYBACK_RATE_MIN,
    Math.min(PLAYBACK_RATE_MAX, usePlayerStore.getState().playbackRate),
  );
  const smoothLead = smoothTime - rawTime;
  const rateBias = (1 - playbackRate) * LYRIC_ACTIVE_TIME_BIAS_PER_RATE;
  const correctedLead = Math.max(
    LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC,
    Math.min(LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC, smoothLead + rateBias),
  );
  return Math.max(0, rawTime + correctedLead);
}

export function stabilizeCharProgress(value: number) {
  const clamped = clamp01(value);
  if (clamped >= 0.996) return 1;
  if (clamped <= 0.001) return 0;
  return clamped;
}

export function getLyricCharOnsetFactor(headPosition: number) {
  return clamp01(headPosition / 1.4);
}

export const LYRIC_TRAIL_CHAR_SPAN = 4.4;
export const LYRIC_CURSOR_CHAR_SPAN = 1.7;

export function getLyricAnimatedCharCount(lineEl: HTMLElement) {
  const raw = Number(lineEl.dataset.charCount ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function getLyricTransitionWindow(progress: number, charCount: number) {
  const safeProgress = clamp01(progress);
  const safeCharCount = Math.max(1, charCount);
  const tailSpan = Math.max(3.2, Math.min(LYRIC_TRAIL_CHAR_SPAN, safeCharCount * 0.2));
  const cursorSpan = Math.max(1.05, Math.min(LYRIC_CURSOR_CHAR_SPAN, tailSpan * 0.46));
  const charUnit = 1 / safeCharCount;

  return {
    tailStart: safeProgress,
    tailEnd: clamp01(safeProgress + tailSpan * charUnit),
    cursorStart: clamp01(safeProgress - cursorSpan * charUnit * 0.34),
    cursorEnd: clamp01(safeProgress + cursorSpan * charUnit * 0.92),
  };
}

export function applyLyricProgressStyle(lineEl: HTMLElement, progress: number) {
  const safeProgress = clamp01(progress);
  const { tailStart, tailEnd, cursorStart, cursorEnd } = getLyricTransitionWindow(
    safeProgress,
    getLyricAnimatedCharCount(lineEl),
  );

  lineEl.style.setProperty('--lyric-progress', `${safeProgress * 100}%`);
  lineEl.style.setProperty('--lyric-progress-value', `${safeProgress}`);
  lineEl.style.setProperty('--lyric-tail-start', `${tailStart}`);
  lineEl.style.setProperty('--lyric-tail-end', `${tailEnd}`);
  lineEl.style.setProperty('--lyric-cursor-start', `${cursorStart}`);
  lineEl.style.setProperty('--lyric-cursor-end', `${cursorEnd}`);
  lineEl.style.setProperty(
    '--lyric-cursor-opacity',
    safeProgress > 0.001 && safeProgress < 0.999 ? '1' : '0',
  );
}

export function syncLyricCharProgress(charEl: HTMLElement, progress: number) {
  const clamped = stabilizeCharProgress(progress);
  const easedProgress = clamped * clamped * (3 - 2 * clamped);
  const charState = easedProgress >= 0.996 ? 'active' : easedProgress > 0 ? 'fading' : '';
  const blurPx = (1 - easedProgress) * 7;
  const offsetEm = (1 - easedProgress) * 0.18;
  const scale = 0.92 + easedProgress * 0.08;

  charEl.style.setProperty('--char-progress', `${easedProgress}`);
  charEl.style.opacity = `${0.18 + easedProgress * 0.82}`;
  charEl.style.transform = `translate3d(0, ${offsetEm.toFixed(3)}em, 0) scale(${scale.toFixed(3)})`;
  charEl.style.filter = `blur(${blurPx.toFixed(3)}px)`;
  charEl.dataset.charState = charState;
}

export function getLyricMotionWeight(text: string | undefined) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0.6;
  return Math.max(0.72, Math.min(normalized.length / 16, 1.65));
}

export function countLyricVowels(value: string) {
  return (value.match(/[aeiouyаеёиоуыэюя]/giu) || []).length;
}

export function getRapLineBoost(text: string | undefined) {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0;

  const tokens = normalized.split(' ').filter(Boolean);
  const vowels = countLyricVowels(normalized);
  const cyr = (normalized.match(/[а-яё]/giu) || []).length;
  const lat = (normalized.match(/[a-z]/giu) || []).length;
  const denseLanguage = cyr > 0 || lat > 0;
  const languageBoost = cyr > 0 && lat > 0 ? 0.2 : denseLanguage ? 0.12 : 0;
  const rapidMarkers =
    /\b(yeah|hey|go|get|run|drop|drip|flow|fast|дай|бей|эй|го|лети|пау|пау|рау|скрт)\b/iu.test(
      normalized,
    )
      ? 0.12
      : 0;
  const repeatedEdges =
    (normalized.match(/[бвгджзйклмнпрстфхцчшщbcdfghjklmnpqrstvwxyz]/giu) || []).length /
    Math.max(normalized.length, 1);
  const density =
    tokens.length * 0.11 + vowels * 0.03 + repeatedEdges * 0.9 + languageBoost + rapidMarkers;

  return clamp01((density - 0.72) / 0.9);
}

export function getReactiveLyricDrive(features: AudioFeatures | null, rapBoost = 0) {
  if (!features) {
    return {
      speedMultiplier: 1 + rapBoost * 0.12,
      onsetPull: rapBoost * 0.12,
    };
  }

  const flux = clamp01((features.flux - 0.02) / 0.11);
  const mids = clamp01(features.midPresence ?? 0);
  const bass = clamp01(features.subBass ?? 0);
  const dynamics = clamp01(features.dynamicRange ?? 0);
  const stability = clamp01(features.rhythmicStability ?? 0.5);
  const arousal = clamp01(features.arousal);
  const bpmDrive = clamp01(((features.bpm || 0) - 84) / 72);
  const rapPresence = clamp01(
    mids * 0.34 + flux * 0.28 + bpmDrive * 0.18 + dynamics * 0.12 + rapBoost * 0.48,
  );

  const dropDrive = clamp01(
    bass * 0.24 +
      dynamics * 0.22 +
      arousal * 0.17 +
      flux * 0.14 +
      bpmDrive * 0.08 +
      stability * 0.07 +
      rapBoost * 0.22,
  );
  const onsetPull = clamp01(
    flux * 0.46 +
      mids * 0.18 +
      dynamics * 0.12 +
      stability * 0.08 +
      rapPresence * 0.26 +
      rapBoost * 0.14,
  );

  return {
    speedMultiplier: 1 + dropDrive * 0.34 + onsetPull * 0.18 + rapPresence * 0.32 + rapBoost * 0.22,
    onsetPull,
  };
}

export function getAnimatedLineProgress(
  lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[],
  idx: number,
  time: number,
  reactiveMode: boolean,
  features: AudioFeatures | null,
  hintBoost = 0,
) {
  const currentLine = lines[idx];
  if (!currentLine) return 0;

  const nextLine = lines[idx + 1];
  const prevLine = lines[idx - 1];
  const rawDuration = Math.max((nextLine?.time ?? currentLine.time + 2.4) - currentLine.time, 0.35);
  const rawProgress = clamp01((time - currentLine.time) / rawDuration);
  if (!reactiveMode) return rawProgress;

  const prevDuration = prevLine ? Math.max(currentLine.time - prevLine.time, 0.35) : rawDuration;
  const prevWeight = getLyricMotionWeight(prevLine?.text);
  const currentWeight = getLyricMotionWeight(currentLine.text);
  const rapBoost = getRapLineBoost(currentLine.text);
  const continuityDuration = Math.max(
    0.32,
    Math.min(
      rawDuration,
      prevDuration *
        clamp01(currentWeight / Math.max(prevWeight, 0.001)) *
        (1.25 - rapBoost * 0.18),
    ),
  );
  const { speedMultiplier, onsetPull } = getReactiveLyricDrive(features, rapBoost);
  const boostedDuration = Math.max(
    0.2,
    continuityDuration / (speedMultiplier + hintBoost * 0.22 + rapBoost * 0.3),
  );
  const boostedProgress = clamp01((time - currentLine.time) / boostedDuration);
  const blendedProgress = Math.max(rawProgress, boostedProgress);

  return clamp01(
    blendedProgress +
      (1 - blendedProgress) * onsetPull * (0.18 + hintBoost * 0.06 + rapBoost * 0.08),
  );
}

export function getMotionHintBoost(
  motionHints: Array<{ index: number; importance: number; density: number; onsetBias: number }>,
  idx: number,
) {
  let best = 0;
  for (const hint of motionHints) {
    const distance = Math.abs(hint.index - idx);
    if (distance > 2) continue;
    const proximity = distance === 0 ? 1 : distance === 1 ? 0.58 : 0.24;
    const score = (hint.importance * 0.5 + hint.density * 0.28 + hint.onsetBias * 0.22) * proximity;
    if (score > best) best = score;
  }
  return clamp01(best / 1.45);
}

export function getMotionHintFloor(
  motionHints: Array<{ importance: number; onsetBias: number; density?: number }>,
) {
  if (!motionHints.length) return 1;
  const peak = Math.max(
    ...motionHints.map(
      (hint) => hint.importance * 0.56 + hint.onsetBias * 0.24 + (hint.density ?? 0) * 0.2,
    ),
  );
  return 1 + clamp01(peak / 1.95) * 0.13;
}

export function getAudioTextHintLabel(motionHints: Array<{ language: string }>) {
  const hasRu = motionHints.some((hint) => hint.language === 'ru' || hint.language === 'mixed');
  const hasEn = motionHints.some((hint) => hint.language === 'en' || hint.language === 'mixed');
  if (hasRu && hasEn) return 'RU/EN';
  if (hasRu) return 'RU';
  if (hasEn) return 'EN';
  return null;
}


export function useWarmLyricMotionHints(
  trackUrn: string | undefined,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
  enabled: boolean,
) {
  const [motionHints, setMotionHints] = useState<ReturnType<typeof getLyricMotionHintsForTrack>>(
    [],
  );

  useEffect(() => {
    if (!enabled || !trackUrn || !lyrics?.synced?.length) {
      setMotionHints([]);
      return;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const next = getLyricMotionHintsForTrack(
        trackUrn,
        lyrics as { synced: LyricLine[] | null; plain: string | null; source: LyricsSource },
      );
      if (!cancelled) setMotionHints(next);
    };

    const idleApi = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (idleApi.requestIdleCallback) {
      const id = idleApi.requestIdleCallback(run, { timeout: 700 });
      return () => {
        cancelled = true;
        idleApi.cancelIdleCallback?.(id);
      };
    }

    const timeoutId = window.setTimeout(run, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [enabled, trackUrn, lyrics]);

  return motionHints;
}

export function usePrimeLyricsSearch(
  track: Track | null | undefined,
  visible: boolean,
  reqArtist: string,
  reqTitle: string,
) {
  useEffect(() => {
    if (!visible || !track?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        track.urn,
        reqArtist,
        reqTitle,
        getLyricsSearchOptions(track, reqArtist, reqTitle, getTrackDurationMs(track)),
      ).catch(() => null);
    }, 20);
    return () => window.clearTimeout(timeoutId);
  }, [visible, track, reqArtist, reqTitle]);
}

export function usePrefetchNextTrackLyrics(visible: boolean) {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);

  useEffect(() => {
    if (!visible) return;
    const nextTrack = queue[queueIndex + 1];
    if (!nextTrack?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        nextTrack.urn,
        nextTrack.user?.username ?? '',
        nextTrack.title ?? '',
        getLyricsSearchOptions(
          nextTrack,
          nextTrack.user?.username ?? '',
          nextTrack.title ?? '',
          getTrackDurationMs(nextTrack),
        ),
      ).catch(() => null);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [visible, queue, queueIndex]);
}

export function useAudioTextWarmup(
  enabled: boolean,
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
) {
  usePrimeLyricsSearch(track, enabled, reqArtist, reqTitle);
  usePrefetchNextTrackLyrics(enabled);
  const motionHints = useWarmLyricMotionHints(
    track?.urn,
    lyrics,
    enabled && Boolean(lyrics?.synced?.length),
  );
  return {
    motionHints,
    hintLabel: enabled ? getAudioTextHintLabel(motionHints) : null,
  };
}

export type DisplayLyricLine = LyricLine | { time: number; text: string; isPlaceholder: true };

export const PAUSE_MARKER = '\u266A\u266A\u266A';
const NOTE_GRADIENT_DURATION_SEC = 3.2;

export function isPauseMarkerText(text: string): boolean {
  const trimmed = String(text || '').trim();
  return trimmed.length === 0 || trimmed === '...' || trimmed === PAUSE_MARKER;
}

export function buildDisplayLinesWithPausePlaceholders(lines: LyricLine[]): DisplayLyricLine[] {
  if (!lines || lines.length === 0) return [];

  const result: DisplayLyricLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (!isPauseMarkerText(current.text)) {
      result.push(current);
      continue;
    }

    let runEnd = i;
    while (runEnd + 1 < lines.length && isPauseMarkerText(lines[runEnd + 1].text)) {
      runEnd += 1;
    }

    result.push({
      ...current,
      text: PAUSE_MARKER,
    });

    i = runEnd;
  }

  return result;
}

export function getPauseNoteAnimationDelay(time: number): string {
  const safeTime = Number.isFinite(time) ? Math.max(time, 0) : 0;
  const phase =
    ((safeTime % NOTE_GRADIENT_DURATION_SEC) + NOTE_GRADIENT_DURATION_SEC) %
    NOTE_GRADIENT_DURATION_SEC;
  return `-${phase.toFixed(3)}s`;
}

export function getPauseNoteAnimationDurationSec(playbackRate: number): number {
  return NOTE_GRADIENT_DURATION_SEC / Math.max(playbackRate, 0.35);
}

export type ReleaseSyncedLyricsLayout = 'default' | 'communityPreview';

