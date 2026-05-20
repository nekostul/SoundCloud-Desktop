import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getEffectivePitchSemitones, type Track, usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { CHARACTER_PRESETS, useSoundWaveStore } from '../stores/soundwave';
import {
  api,
  getBackendProgressiveTrackStreamSource,
  getSessionId,
  resolveTrackFromStreaming,
  getTrackStreamSource,
} from './api';
import { audioAnalyser } from './audio-analyser';
import {
  fetchAndCacheTrack,
  getCacheEntryInfo,
  getCacheFilePath,
  getCacheTargetPath,
  isCached,
  removeCachedTrack,
} from './cache';
import { art } from './formatters';
import { isTauriRuntime } from './runtime';
import { buildWaveQueueFromPlayerContext, dedupeTracksByUrn } from './soundwave-queue';
import { getTrackWaveform } from './waveform';

/* ── Audio engine state ──────────────────────────────────────── */

let currentUrn: string | null = null;
let hasTrack = false;
let fallbackDuration = 0;
let cachedTime = 0;
let cachedDuration = 0;
let loadGen = 0;
const API_PREVIEW_DURATION_MS = 30_000;
let lastTickAt = 0;
let isCrossfadingOut = false;
let crossfadeInProgress = false;
let pendingCrossfadeTrackUrn: string | null = null;
let pendingCrossfadeDurationSecs: number | null = null;
let lastSmoothTime = 0;
let stallProbeInFlight = false;
let stallRecoveryInFlight = false;
let stallSuppressedUntil = 0;
let endedGuardUntil = 0;
let deviceChangeCooldownUntil = 0;
let seekTargetTime = -1;
let seekPendingUntil = 0;
let queuedSeekTarget = -1;
let queuedSeekTrackUrn: string | null = null;
let queuedSeekAllowRecovery = true;
let queuedSeekRetries = 0;
let queuedSeekRequestId = 0;
let queuedSeekTimer: ReturnType<typeof setTimeout> | null = null;
let nativeSeekInFlight = false;
let waitingForStartupProgress = false;
let startupProgressDeadline = 0;
let latestSeekRequestId = 0;
let nativeSeekPausedForBuffering = false;
let nativeSeekResumeAfterBufferedSeek = false;
let nativeStartupPausedForBuffering = false;
let nativeStartupResumeAfterBuffering = false;
let startupBufferedSecs = 0;
let waitForReadyBuffer = true;
let readyBufferPromise: Promise<void> | null = null;
let readyBufferResolver: (() => void) | null = null;
let startupPlaybackTickReceived = false;
let startupRecoveryTrackUrn: string | null = null;
let startupRecoveryAttempts = 0;
let startupRecoveryWindowStartedAt = 0;
let startupRecoveryInFlight = false;
const listeners = new Set<() => void>();
const bufferListeners = new Set<() => void>();
let bufferNotifyRafId: number | null = null;
let bufferNotifyTimeout: ReturnType<typeof setTimeout> | null = null;

// Throttle playback state notifications to prevent UI thread starvation during active playback
let notifyRafId: number | null = null;
let notifyTimeout: ReturnType<typeof setTimeout> | null = null;
let notifyPending = false;
const MAX_PLAYBACK_NOTIFY_HZ = 30; // Limit notification frequency to 30/sec max during playback

const SEEK_DEBOUNCE_MS = 120;
const CONTEXTUAL_AUTOPLAY_TAIL_TARGET = 18;
const SOUNDWAVE_REFRESH_DEBOUNCE_MS = 180;
let backgroundContinuationInFlight = false;
let backgroundContinuationPreparedUrn: string | null = null;
let queuedSoundWaveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const SEEK_BUSY_RETRY_MS = 80;
const SEEK_NO_SOURCE_RETRY_MS = 220;
const SEEK_UNBUFFERED_RETRY_MS = 260;
const SEEK_RECOVERY_RETRY_MS = 140;
const SEEK_RECOVERY_COALESCE_MS = 180;
const SEEK_MAX_NO_SOURCE_RETRIES = 8;
const SEEK_MAX_RECOVERY_RETRIES = 2;
const SEEK_IGNORE_DELTA_SEC = 0.12;
const SEEK_TICK_SETTLE_EPSILON_SEC = 0.75;
const DIRECT_SEEK_RELOAD_FORWARD_TOLERANCE_SEC = 0.35;
const DIRECT_SEEK_RELOAD_BACKWARD_TOLERANCE_SEC = 0.9;
const STARTUP_RECOVERY_MAX_RETRIES = 2;
const STARTUP_RECOVERY_ACTIVITY_TIMEOUT_MS = 4_500;
const STARTUP_RECOVERY_NO_TICK_TIMEOUT_MS = 9_000;
const STARTUP_RECOVERY_WINDOW_MS = 20_000;

type PlaybackBufferPhase = 'idle' | 'loading' | 'buffering' | 'ready';
type AudioTickPayload = number | { gen?: number; position?: number | null };
type PlaybackSourceKind = 'none' | 'network' | 'cache-file';

type PlaybackBufferSnapshot = {
  phase: PlaybackBufferPhase;
  progress: number | null;
  bufferedSecs: number;
  downloadedBytes: number;
  totalBytes: number | null;
  seekUnlocked: boolean;
  fullyCached: boolean;
};

type BufferStrategy = {
  mode: 'short' | 'medium' | 'long' | 'epic';
  startupBufferSecs: number;
  startupProgress: number | null;
  seekUnlockBufferSecs: number;
  seekUnlockProgress: number | null;
  startupTimeoutMs: number;
  unknownTotalStartupGraceMs: number;
  preferHttpStream: boolean;
};

type TrackTransitionProfile = {
  introAudibleSecs: number;
  introStrongSecs: number;
  outroAudibleTailSecs: number;
  outroStrongTailSecs: number;
  trailingSilenceSecs: number;
  introEnergy: number;
  outroEnergy: number;
};

let playbackBufferSnapshot: PlaybackBufferSnapshot = {
  phase: 'idle',
  progress: null,
  bufferedSecs: 0,
  downloadedBytes: 0,
  totalBytes: null,
  seekUnlocked: true,
  fullyCached: false,
};
let currentBufferStrategy: BufferStrategy = createBufferStrategy(0);
let bufferProgressKnown = false;
let bufferLoadStartedAt = 0;
let lastDownloadProgressAt = 0;
let activeRangedSeekLoad = false;
let estimatedStreamTotalBytes: number | null = null;
let currentPlaybackSource: PlaybackSourceKind = 'none';
const transitionProfileCache = new Map<string, TrackTransitionProfile | null>();
const transitionProfilePromiseCache = new Map<string, Promise<TrackTransitionProfile | null>>();
const MAX_SMOOTH_TIME_EXTRAPOLATION_SECS = 5;

let lastNotifyTime = 0;
const throttleMs = 1000 / MAX_PLAYBACK_NOTIFY_HZ;

function flushNotify() {
  notifyPending = false;
  lastNotifyTime = performance.now();
  for (const l of listeners) l();
}

function notify() {
  if (notifyPending) return;

  const now = performance.now();
  const timeSinceLastNotify = now - lastNotifyTime;

  if (timeSinceLastNotify >= throttleMs) {
    // Enough time has passed, flush immediately
    notifyPending = true;
    flushNotify();
  } else {
    // Schedule for later
    notifyPending = true;
    if (notifyTimeout != null) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(flushNotify, throttleMs - timeSinceLastNotify);
  }
}

function flushNotifyImmediate() {
  if (notifyTimeout != null) clearTimeout(notifyTimeout);
  notifyPending = false;
  lastNotifyTime = performance.now();
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyBufferState() {
  if (bufferNotifyRafId != null || bufferNotifyTimeout != null) return;

  const flush = () => {
    bufferNotifyRafId = null;
    bufferNotifyTimeout = null;
    for (const listener of bufferListeners) listener();
  };

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    bufferNotifyRafId = window.requestAnimationFrame(() => flush());
    return;
  }

  bufferNotifyTimeout = setTimeout(flush, 16);
}

export function subscribePlaybackBuffer(listener: () => void): () => void {
  bufferListeners.add(listener);
  return () => bufferListeners.delete(listener);
}

export function getPlaybackBufferSnapshot(): PlaybackBufferSnapshot {
  return playbackBufferSnapshot;
}

export function isPlaybackInteractionLocked(): boolean {
  return false;
}

export function getSeekableTimeLimit(): number {
  if (!currentUrn) return Number.POSITIVE_INFINITY;
  const durationLimit = cachedDuration > 0 ? cachedDuration : Number.POSITIVE_INFINITY;
  if (playbackBufferSnapshot.fullyCached) return durationLimit;
  if (
    isTauriRuntime() &&
    playbackBufferSnapshot.seekUnlocked &&
    Number.isFinite(durationLimit) &&
    durationLimit > 0
  ) {
    return durationLimit;
  }

  return getBufferedSeekWindowEnd();
}

function getBufferedSeekWindowEnd(): number {
  const durationLimit = cachedDuration > 0 ? cachedDuration : Number.POSITIVE_INFINITY;
  const bufferedLimit = Math.max(
    0,
    playbackBufferSnapshot.bufferedSecs,
    cachedTime,
    getSmoothCurrentTime(),
  );
  return Math.min(bufferedLimit, durationLimit);
}

export function canSeekCurrentTrack(targetSecs?: number): boolean {
  if (!currentUrn) return true;
  if (isPlaybackInteractionLocked()) return false;
  if (isTauriRuntime() && playbackBufferSnapshot.seekUnlocked) {
    if (targetSecs == null) return true;
    const durationLimit = cachedDuration > 0 ? cachedDuration : Number.POSITIVE_INFINITY;
    return targetSecs >= 0 && targetSecs <= durationLimit + 0.35;
  }

  const limit = getSeekableTimeLimit();
  if (playbackBufferSnapshot.fullyCached || !Number.isFinite(limit)) {
    return true;
  }
  if (targetSecs == null) {
    return limit >= 0.35;
  }

  return targetSecs >= 0 && targetSecs <= limit + 0.35;
}

export function getCurrentTime(): number {
  return cachedTime;
}

export function getSmoothCurrentTime(): number {
  if (!usePlayerStore.getState().isPlaying || !hasTrack) {
    lastSmoothTime = cachedTime;
    return cachedTime;
  }
  const now = Date.now();
  const hasQueuedSeek =
    queuedSeekTarget >= 0 && queuedSeekTrackUrn === usePlayerStore.getState().currentTrack?.urn;
  if (
    nativeSeekPausedForBuffering ||
    nativeSeekInFlight ||
    waitingForStartupProgress ||
    waitForReadyBuffer ||
    (seekTargetTime >= 0 && seekPendingUntil > now) ||
    hasQueuedSeek
  ) {
    lastSmoothTime = cachedTime;
    return cachedTime;
  }
  if (lastTickAt === 0 || now < lastTickAt) return cachedTime;
  const elapsed = (now - lastTickAt) / 1000;
  const raw = Math.min(cachedTime + elapsed, cachedTime + MAX_SMOOTH_TIME_EXTRAPOLATION_SECS);

  if (raw + 0.08 < lastSmoothTime && lastSmoothTime - raw < 1.25) {
    return lastSmoothTime;
  }

  lastSmoothTime = raw;
  return raw;
}

export function getDuration(): number {
  return cachedDuration;
}

function isCurrentPlaybackSourceSeekSafe(): boolean {
  return currentPlaybackSource === 'cache-file';
}

function hasActiveSeekTransition(trackUrn?: string | null) {
  const activeTrackUrn = trackUrn ?? usePlayerStore.getState().currentTrack?.urn ?? null;
  const hasQueuedSeek = queuedSeekTarget >= 0 && queuedSeekTrackUrn === activeTrackUrn;
  return (
    nativeSeekPausedForBuffering ||
    nativeSeekInFlight ||
    activeRangedSeekLoad ||
    hasQueuedSeek ||
    (seekTargetTime >= 0 && seekPendingUntil > Date.now())
  );
}

function hasPendingCrossfadeLoad(trackUrn?: string | null) {
  const activeTrackUrn = trackUrn ?? usePlayerStore.getState().currentTrack?.urn ?? null;
  return pendingCrossfadeTrackUrn != null && pendingCrossfadeTrackUrn === activeTrackUrn;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function findFirstSustainedIndex(values: number[], threshold: number, minRun = 3) {
  let run = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] >= threshold) {
      run += 1;
      if (run >= minRun) {
        return i - minRun + 1;
      }
    } else {
      run = 0;
    }
  }
  return -1;
}

function findLastSustainedIndex(values: number[], threshold: number, minRun = 3) {
  let run = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] >= threshold) {
      run += 1;
      if (run >= minRun) {
        return i + minRun - 1;
      }
    } else {
      run = 0;
    }
  }
  return -1;
}

function buildTrackTransitionProfile(
  track: Track,
  values: number[],
): TrackTransitionProfile | null {
  const durationSecs = track.duration > 0 ? track.duration / 1000 : 0;
  if (!Number.isFinite(durationSecs) || durationSecs <= 1 || values.length < 8) {
    return null;
  }

  const maxValue = Math.max(...values);
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return null;
  }

  const normalized = values.map((value) => clampNumber(value / maxValue, 0, 1));
  const smoothed = normalized.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const sample = normalized[index + offset];
      if (sample != null) {
        sum += sample;
        count += 1;
      }
    }
    return count > 0 ? sum / count : normalized[index];
  });

  const sampleToSecs = (index: number) =>
    clampNumber((index / Math.max(1, smoothed.length - 1)) * durationSecs, 0, durationSecs);

  const introAudibleIndex = findFirstSustainedIndex(smoothed, 0.06, 3);
  const introStrongIndex = findFirstSustainedIndex(smoothed, 0.22, 3);
  const outroAudibleIndex = findLastSustainedIndex(smoothed, 0.06, 3);
  const outroStrongIndex = findLastSustainedIndex(smoothed, 0.22, 3);

  const introWindow = smoothed.slice(0, Math.max(4, Math.floor(smoothed.length * 0.12)));
  const outroWindow = smoothed.slice(
    Math.max(0, smoothed.length - Math.max(4, Math.floor(smoothed.length * 0.12))),
  );
  const introEnergy =
    introWindow.reduce((sum, value) => sum + value, 0) / Math.max(1, introWindow.length);
  const outroEnergy =
    outroWindow.reduce((sum, value) => sum + value, 0) / Math.max(1, outroWindow.length);

  const introAudibleSecs = introAudibleIndex >= 0 ? sampleToSecs(introAudibleIndex) : 0;
  const introStrongSecs = introStrongIndex >= 0 ? sampleToSecs(introStrongIndex) : introAudibleSecs;
  const outroAudibleTailSecs =
    outroAudibleIndex >= 0 ? Math.max(0, durationSecs - sampleToSecs(outroAudibleIndex)) : 0;
  const outroStrongTailSecs =
    outroStrongIndex >= 0 ? Math.max(0, durationSecs - sampleToSecs(outroStrongIndex)) : 0;
  const trailingSilenceSecs =
    outroAudibleIndex >= 0 ? Math.max(0, durationSecs - sampleToSecs(outroAudibleIndex)) : 0;

  return {
    introAudibleSecs,
    introStrongSecs,
    outroAudibleTailSecs,
    outroStrongTailSecs,
    trailingSilenceSecs,
    introEnergy,
    outroEnergy,
  };
}

async function getTrackTransitionProfile(
  track: Track | null,
): Promise<TrackTransitionProfile | null> {
  const urn = track?.urn;
  if (!urn) return null;

  if (transitionProfileCache.has(urn)) {
    return transitionProfileCache.get(urn) ?? null;
  }

  const existing = transitionProfilePromiseCache.get(urn);
  if (existing) {
    return existing;
  }

  const request = getTrackWaveform(track)
    .then((waveform) => {
      const profile =
        waveform && Array.isArray(waveform.values)
          ? buildTrackTransitionProfile(track, waveform.values)
          : null;
      transitionProfileCache.set(urn, profile);
      return profile;
    })
    .catch(() => {
      transitionProfileCache.set(urn, null);
      return null;
    })
    .finally(() => {
      transitionProfilePromiseCache.delete(urn);
    });

  transitionProfilePromiseCache.set(urn, request);
  return request;
}

function warmTrackTransitionProfile(track: Track | null | undefined) {
  if (!track?.urn) return;
  void getTrackTransitionProfile(track);
}

function getNextTrackForCrossfade(state = usePlayerStore.getState()) {
  const { queue, queueIndex, repeat } = state;
  if (queue.length === 0 || queueIndex < 0) return null;

  let nextIndex = queueIndex + 1;
  if (nextIndex >= queue.length) {
    if (repeat !== 'all') return null;
    nextIndex = 0;
  }

  return queue[nextIndex] ?? null;
}

function getSmartCrossfadeDurationForTracks(currentTrack: Track | null, positionSecs: number) {
  const durationSecs =
    currentTrack?.duration && currentTrack.duration > 0
      ? currentTrack.duration / 1000
      : cachedDuration;
  const fallback = getSmartCrossfadeDuration(durationSecs, positionSecs);
  if (!currentTrack?.urn) return fallback;

  const currentProfile = transitionProfileCache.get(currentTrack.urn) ?? null;
  const nextTrack = getNextTrackForCrossfade();
  const nextProfile = nextTrack ? (transitionProfileCache.get(nextTrack.urn) ?? null) : null;
  if (!currentProfile && !nextProfile) return fallback;

  const desiredFromNext = nextProfile
    ? clampNumber(
        Math.max(
          nextProfile.introStrongSecs,
          nextProfile.introAudibleSecs + (nextProfile.introEnergy < 0.18 ? 1.6 : 0.9),
        ),
        2,
        12,
      )
    : fallback;

  const currentCeiling = currentProfile
    ? clampNumber(
        Math.max(
          2,
          currentProfile.outroStrongTailSecs +
            currentProfile.trailingSilenceSecs * 0.85 +
            (currentProfile.outroEnergy < 0.22 ? 1.2 : 0.4),
        ),
        2,
        12,
      )
    : 12;

  const currentFloor = currentProfile
    ? clampNumber(
        Math.max(
          2,
          currentProfile.outroAudibleTailSecs + Math.min(1.5, currentProfile.trailingSilenceSecs),
        ),
        2,
        8,
      )
    : 2;

  const recommended = clampNumber(
    Math.max(currentFloor, Math.max(fallback, desiredFromNext)),
    2,
    currentCeiling,
  );

  return clampNumber(Math.round(recommended), 2, 12);
}

function warmUpcomingTransitionProfiles() {
  const state = usePlayerStore.getState();
  warmTrackTransitionProfile(state.currentTrack);
  warmTrackTransitionProfile(getNextTrackForCrossfade(state));
}

function isCrossfadeOffMode(mode: 'off' | 'smart' | 'manual') {
  return mode === 'off';
}

function getManualCrossfadeDuration(settings: ReturnType<typeof useSettingsStore.getState>) {
  return Math.max(1, Math.min(15, Math.round(settings.crossfadeDuration || 0)));
}

function getSmartCrossfadeDuration(durationSecs: number, positionSecs: number) {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return 4;
  const remaining = Math.max(0, durationSecs - Math.max(0, positionSecs));
  const introAware = durationSecs < 90 ? 2 : durationSecs < 180 ? 4 : durationSecs < 360 ? 6 : 8;
  const outroAware = remaining < 8 ? 2 : remaining < 14 ? 4 : remaining < 22 ? 6 : introAware;
  return Math.max(2, Math.min(10, Math.round(Math.min(introAware, outroAware))));
}

function resolveCrossfadeDurationForLoad(
  settings: ReturnType<typeof useSettingsStore.getState>,
  durationSecs: number,
  positionSecs = 0,
) {
  if (isCrossfadeOffMode(settings.crossfadeMode)) return null;
  if (settings.crossfadeMode === 'manual') return getManualCrossfadeDuration(settings);
  return getSmartCrossfadeDuration(durationSecs, positionSecs);
}

function clampStrategyThreshold(durationSecs: number, thresholdSecs: number, multiplier = 0.94) {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
    return thresholdSecs;
  }
  return Math.min(thresholdSecs, Math.max(12, durationSecs * multiplier));
}

function createBufferStrategy(durationSecs: number): BufferStrategy {
  if (durationSecs > 0 && durationSecs <= 12 * 60) {
    return {
      mode: 'short',
      startupBufferSecs: clampStrategyThreshold(durationSecs, 12, 0.16),
      startupProgress: 0.22,
      seekUnlockBufferSecs: clampStrategyThreshold(durationSecs, 28, 0.38),
      seekUnlockProgress: 0.52,
      startupTimeoutMs: 6_000,
      unknownTotalStartupGraceMs: 1_100,
      preferHttpStream: false,
    };
  }

  if (durationSecs > 0 && durationSecs <= 35 * 60) {
    return {
      mode: 'medium',
      startupBufferSecs: clampStrategyThreshold(durationSecs, 20, 0.12),
      startupProgress: 0.16,
      seekUnlockBufferSecs: clampStrategyThreshold(durationSecs, 60, 0.24),
      seekUnlockProgress: 0.35,
      startupTimeoutMs: 7_000,
      unknownTotalStartupGraceMs: 1_300,
      preferHttpStream: false,
    };
  }

  if (durationSecs > 0 && durationSecs <= 90 * 60) {
    return {
      mode: 'long',
      startupBufferSecs: clampStrategyThreshold(durationSecs, 45, 0.06),
      startupProgress: 0.08,
      seekUnlockBufferSecs: clampStrategyThreshold(durationSecs, 120, 0.16),
      seekUnlockProgress: 0.2,
      startupTimeoutMs: 8_000,
      unknownTotalStartupGraceMs: 1_700,
      preferHttpStream: false,
    };
  }

  return {
    mode: 'epic',
    startupBufferSecs: clampStrategyThreshold(durationSecs, 70, 0.04),
    startupProgress: durationSecs > 0 ? 0.05 : null,
    seekUnlockBufferSecs: clampStrategyThreshold(durationSecs, 180, 0.1),
    seekUnlockProgress: durationSecs > 0 ? 0.12 : null,
    startupTimeoutMs: 9_000,
    unknownTotalStartupGraceMs: 2_000,
    preferHttpStream: false,
  };
}

function inferNominalBitrateKbps(format: string | null | undefined) {
  if (!format) return null;
  if (format.includes('hls_aac_160')) return 160;
  if (format.includes('http_mp3_128') || format.includes('hls_mp3_128')) return 128;
  if (format.includes('hls_opus_64')) return 64;
  return null;
}

function updateEstimatedStreamTotalBytes(durationSecs: number, format: string | null | undefined) {
  const bitrateKbps = inferNominalBitrateKbps(format);
  if (!Number.isFinite(durationSecs) || durationSecs <= 0 || !bitrateKbps) {
    estimatedStreamTotalBytes = null;
    return;
  }

  const estimatedBytes = Math.round(durationSecs * ((bitrateKbps * 1000) / 8) * 1.02);
  estimatedStreamTotalBytes = estimatedBytes > 0 ? estimatedBytes : null;
}

function estimateBufferProgress(downloadedBytes: number, totalBytes: number | null, done: boolean) {
  const effectiveTotalBytes = totalBytes && totalBytes > 0 ? totalBytes : estimatedStreamTotalBytes;
  if (!effectiveTotalBytes || downloadedBytes <= 0) {
    return null;
  }

  const rawRatio = downloadedBytes / effectiveTotalBytes;
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) {
    return null;
  }

  return Math.max(0, Math.min(rawRatio, done ? 1 : 0.995));
}

function updatePlaybackBufferSnapshot(next: Partial<PlaybackBufferSnapshot>, force = false) {
  const updated: PlaybackBufferSnapshot = {
    ...playbackBufferSnapshot,
    ...next,
  };
  const changed =
    force ||
    updated.phase !== playbackBufferSnapshot.phase ||
    updated.progress !== playbackBufferSnapshot.progress ||
    updated.bufferedSecs !== playbackBufferSnapshot.bufferedSecs ||
    updated.downloadedBytes !== playbackBufferSnapshot.downloadedBytes ||
    updated.totalBytes !== playbackBufferSnapshot.totalBytes ||
    updated.seekUnlocked !== playbackBufferSnapshot.seekUnlocked ||
    updated.fullyCached !== playbackBufferSnapshot.fullyCached;

  if (!changed) return;

  playbackBufferSnapshot = updated;
  notifyBufferState();
}

function syncPlaybackBufferPhase(force = false) {
  const nextPhase: PlaybackBufferPhase = !currentUrn
    ? 'idle'
    : waitForReadyBuffer
      ? 'loading'
      : startupPlaybackTickReceived || playbackBufferSnapshot.fullyCached
        ? 'ready'
        : 'buffering';
  updatePlaybackBufferSnapshot({ phase: nextPhase }, force);
}

function resetPlaybackBufferState() {
  currentBufferStrategy = createBufferStrategy(0);
  bufferProgressKnown = false;
  bufferLoadStartedAt = 0;
  lastDownloadProgressAt = 0;
  activeRangedSeekLoad = false;
  estimatedStreamTotalBytes = null;
  startupPlaybackTickReceived = false;
  updatePlaybackBufferSnapshot(
    {
      phase: 'idle',
      progress: null,
      bufferedSecs: 0,
      downloadedBytes: 0,
      totalBytes: null,
      seekUnlocked: true,
      fullyCached: false,
    },
    true,
  );
}

function beginPlaybackBufferTracking(durationSecs: number, rangedSeekLoad = false) {
  currentBufferStrategy = createBufferStrategy(durationSecs);
  bufferProgressKnown = false;
  bufferLoadStartedAt = Date.now();
  lastDownloadProgressAt = 0;
  activeRangedSeekLoad = rangedSeekLoad;
  startupPlaybackTickReceived = false;
  if (rangedSeekLoad) {
    estimatedStreamTotalBytes = null;
  }
  updatePlaybackBufferSnapshot(
    {
      phase: 'loading',
      progress: null,
      bufferedSecs: 0,
      downloadedBytes: 0,
      totalBytes: null,
      seekUnlocked: false,
      fullyCached: false,
    },
    true,
  );
}

function finalizePlaybackBufferAsCached() {
  startupRecoveryAttempts = 0;
  updatePlaybackBufferSnapshot(
    {
      phase: 'ready',
      progress: 1,
      bufferedSecs: cachedDuration > 0 ? cachedDuration : playbackBufferSnapshot.bufferedSecs,
      seekUnlocked: true,
      fullyCached: true,
    },
    true,
  );
}

function shouldResolveStartupBuffer(progress: number | null, fullyCached: boolean) {
  if (fullyCached) return true;
  if (
    currentBufferStrategy.startupProgress != null &&
    bufferProgressKnown &&
    progress != null &&
    progress >= currentBufferStrategy.startupProgress
  ) {
    return true;
  }

  if (!startupPlaybackTickReceived && !nativeStartupPausedForBuffering) {
    return false;
  }

  return startupBufferedSecs >= currentBufferStrategy.startupBufferSecs;
}

function shouldUnlockSeek(progress: number | null, fullyCached: boolean) {
  if (fullyCached) return true;
  if (
    currentBufferStrategy.seekUnlockProgress != null &&
    bufferProgressKnown &&
    progress != null &&
    progress >= currentBufferStrategy.seekUnlockProgress
  ) {
    return true;
  }

  return startupBufferedSecs >= currentBufferStrategy.seekUnlockBufferSecs;
}

function resolveReadyBuffer(reason: string) {
  if (!waitForReadyBuffer) return;

  startupRecoveryAttempts = 0;
  waitForReadyBuffer = false;
  const resolve = readyBufferResolver;
  readyBufferResolver = null;
  readyBufferPromise = null;
  if (resolve) {
    resolve();
  }
  resumeNativeAfterStartupBuffer();
  syncPlaybackBufferPhase(true);
  console.log(`[Audio] Startup buffer ready (${reason})`);
}

function updatePlaybackBufferProgress(
  progress: number | null,
  downloadedBytes: number,
  totalBytes: number | null,
  done: boolean,
  cacheComplete = false,
) {
  const rawProgress =
    progress != null && Number.isFinite(progress) ? Math.max(0, Math.min(progress, 1)) : null;
  const normalizedProgress =
    rawProgress == null ? null : done ? rawProgress : Math.min(rawProgress, 0.995);
  lastDownloadProgressAt = Date.now();
  const normalizedTotalBytes = totalBytes && totalBytes > 0 ? totalBytes : null;
  const effectiveProgress = activeRangedSeekLoad
    ? normalizedProgress
    : (normalizedProgress ?? estimateBufferProgress(downloadedBytes, normalizedTotalBytes, done));
  bufferProgressKnown = effectiveProgress != null && Number.isFinite(effectiveProgress);
  const fullyCached =
    !activeRangedSeekLoad && (cacheComplete || (done && normalizedProgress === 1));
  const nextBufferedSecs =
    effectiveProgress != null && cachedDuration > 0 ? effectiveProgress * cachedDuration : 0;
  startupBufferedSecs = Math.max(startupBufferedSecs, nextBufferedSecs);
  const seekUnlocked = shouldUnlockSeek(effectiveProgress, fullyCached);

  updatePlaybackBufferSnapshot({
    progress: normalizedProgress,
    bufferedSecs: startupBufferedSecs,
    downloadedBytes,
    totalBytes: normalizedTotalBytes,
    seekUnlocked,
    fullyCached,
  });

  usePlayerStore.setState({
    downloadProgress:
      normalizedProgress != null && Number.isFinite(normalizedProgress)
        ? Math.max(0, Math.min(normalizedProgress, 1))
        : cacheComplete
          ? 1
          : null,
  });

  if (shouldResolveStartupBuffer(effectiveProgress, fullyCached)) {
    resolveReadyBuffer(fullyCached ? 'cache-complete' : 'threshold');
  } else {
    syncPlaybackBufferPhase();
  }
}

function maybeResolveUnknownTotalStartup(tickPos: number) {
  if (!waitForReadyBuffer || bufferProgressKnown || activeRangedSeekLoad) return;
  if (tickPos < 0.35) return;
  if (Date.now() - bufferLoadStartedAt < currentBufferStrategy.unknownTotalStartupGraceMs) return;

  startupBufferedSecs = Math.max(startupBufferedSecs, tickPos);
  updatePlaybackBufferSnapshot({
    bufferedSecs: startupBufferedSecs,
    seekUnlocked: shouldUnlockSeek(playbackBufferSnapshot.progress, false),
  });
  resolveReadyBuffer('playback-progress');
}

function updateTickDrivenBufferState(tickPos: number) {
  if (!Number.isFinite(tickPos) || tickPos <= 0) return;

  startupBufferedSecs = Math.max(startupBufferedSecs, tickPos);
  const seekUnlocked = shouldUnlockSeek(
    playbackBufferSnapshot.progress,
    playbackBufferSnapshot.fullyCached,
  );

  updatePlaybackBufferSnapshot({
    bufferedSecs: startupBufferedSecs,
    seekUnlocked,
  });

  if (waitForReadyBuffer) {
    if (
      shouldResolveStartupBuffer(
        playbackBufferSnapshot.progress,
        playbackBufferSnapshot.fullyCached,
      )
    ) {
      resolveReadyBuffer('playback-tick');
      return;
    }
    maybeResolveUnknownTotalStartup(tickPos);
    return;
  }

  if (seekUnlocked && playbackBufferSnapshot.phase !== 'ready') {
    syncPlaybackBufferPhase(true);
  }
}

function suppressStallDetection(ms: number) {
  stallSuppressedUntil = Math.max(stallSuppressedUntil, Date.now() + ms);
}

function primeStartupRecoveryWindow(trackUrn: string) {
  const now = Date.now();
  if (
    startupRecoveryTrackUrn !== trackUrn ||
    now - startupRecoveryWindowStartedAt > STARTUP_RECOVERY_WINDOW_MS
  ) {
    startupRecoveryTrackUrn = trackUrn;
    startupRecoveryAttempts = 0;
    startupRecoveryWindowStartedAt = now;
  }
}

async function recoverFromStartupHang(reason: string) {
  if (startupRecoveryInFlight) return;
  if (hasPendingCrossfadeLoad()) return;
  if (nativeStartupPausedForBuffering) return;

  const state = usePlayerStore.getState();
  const track = state.currentTrack;
  if (!track || track.urn !== currentUrn || !state.isPlaying) return;
  if (playbackBufferSnapshot.phase === 'ready' || playbackBufferSnapshot.fullyCached) return;

  primeStartupRecoveryWindow(track.urn);
  if (startupRecoveryAttempts >= STARTUP_RECOVERY_MAX_RETRIES) {
    return;
  }

  startupRecoveryInFlight = true;
  startupRecoveryAttempts += 1;
  suppressStallDetection(5000);
  console.warn(
    `[Audio] Startup hang detected (${reason}), retrying load ${startupRecoveryAttempts}/${STARTUP_RECOVERY_MAX_RETRIES} for ${track.urn}`,
  );

  try {
    await loadTrack(track);
  } finally {
    startupRecoveryInFlight = false;
  }
}

function inferCodecFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase();
  if (normalized.includes('opus')) return 'OPUS';
  if (normalized.includes('ogg')) return 'OGG';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'MP3';
  if (
    normalized.includes('aac') ||
    normalized.includes('mp4a') ||
    normalized.includes('audio/mp4')
  ) {
    return 'AAC';
  }
  if (normalized.includes('flac')) return 'FLAC';
  return undefined;
}

function inferCodecFromFormat(format: string): string | undefined {
  if (format.includes('opus')) return 'OPUS';
  if (format.includes('aac')) return 'AAC';
  if (format.includes('mp3')) return 'MP3';
  return undefined;
}

function isNotFoundLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || message.includes('Not Found');
}

function hasNoSeekFallbackSource(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No source to reload for seek/i.test(message);
}

function isUnbufferedSeekError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not buffered yet/i.test(message);
}

function isBusySeekError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Seek busy/i.test(message);
}

function clearQueuedSeekTimer() {
  if (queuedSeekTimer) {
    clearTimeout(queuedSeekTimer);
    queuedSeekTimer = null;
  }
}

function resetQueuedSeekQueue() {
  clearQueuedSeekTimer();
  queuedSeekTarget = -1;
  queuedSeekTrackUrn = null;
  queuedSeekAllowRecovery = true;
  queuedSeekRetries = 0;
  queuedSeekRequestId = 0;
}

function isActiveSeekRequest(trackUrn: string, requestId: number) {
  return (
    latestSeekRequestId === requestId && usePlayerStore.getState().currentTrack?.urn === trackUrn
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function clearBufferedSeekPauseState() {
  nativeSeekPausedForBuffering = false;
  nativeSeekResumeAfterBufferedSeek = false;
}

function clearStartupBufferPauseState() {
  nativeStartupPausedForBuffering = false;
  nativeStartupResumeAfterBuffering = false;
}

function pauseNativeForBufferedSeek() {
  if (!isTauriRuntime() || nativeSeekPausedForBuffering) return;

  nativeSeekPausedForBuffering = true;
  nativeSeekResumeAfterBufferedSeek = usePlayerStore.getState().isPlaying;
  suppressStallDetection(3200);
  invoke('audio_pause').catch((error) => {
    console.warn('[Audio] Failed to pause native playback during buffered seek', error);
  });
}

function resumeNativeAfterBufferedSeek() {
  if (!isTauriRuntime()) {
    clearBufferedSeekPauseState();
    return;
  }

  const shouldResume = nativeSeekPausedForBuffering && nativeSeekResumeAfterBufferedSeek;
  clearBufferedSeekPauseState();

  if (!shouldResume || !usePlayerStore.getState().isPlaying) {
    return;
  }

  invoke('audio_play').catch((error) => {
    console.warn('[Audio] Failed to resume native playback after buffered seek', error);
  });
}

function pauseNativeForStartupBuffer() {
  if (!isTauriRuntime() || nativeStartupPausedForBuffering) return;

  nativeStartupPausedForBuffering = true;
  nativeStartupResumeAfterBuffering = usePlayerStore.getState().isPlaying;
  suppressStallDetection(5000);
  invoke('audio_pause').catch((error) => {
    console.warn('[Audio] Failed to pause native playback during startup buffering', error);
  });
}

function resumeNativeAfterStartupBuffer() {
  if (!isTauriRuntime()) {
    clearStartupBufferPauseState();
    return;
  }

  const shouldResume = nativeStartupPausedForBuffering && nativeStartupResumeAfterBuffering;
  clearStartupBufferPauseState();

  if (!shouldResume || !usePlayerStore.getState().isPlaying) {
    return;
  }

  invoke('audio_play').catch((error) => {
    console.warn('[Audio] Failed to resume native playback after startup buffering', error);
  });
}

function keepSeekGuardAlive(target: number, ms: number) {
  seekTargetTime = target;
  seekPendingUntil = Math.max(seekPendingUntil, Date.now() + ms);
  lastTickAt = Date.now();
  suppressStallDetection(Math.max(ms + 800, 1800));
}

async function syncPlaybackBufferFromCompleteCache(
  trackUrn: string,
  expectedGen?: number,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (currentUrn !== trackUrn || usePlayerStore.getState().currentTrack?.urn !== trackUrn) {
    return false;
  }
  if (expectedGen != null && expectedGen !== loadGen) {
    return false;
  }
  if (hasActiveSeekTransition(trackUrn)) {
    return false;
  }

  try {
    const entry = await getCacheEntryInfo(trackUrn);
    if (!entry?.complete) {
      return false;
    }
    if (currentUrn !== trackUrn || usePlayerStore.getState().currentTrack?.urn !== trackUrn) {
      return false;
    }
    if (expectedGen != null && expectedGen !== loadGen) {
      return false;
    }

    if (currentPlaybackSource !== 'cache-file') {
      const track = usePlayerStore.getState().currentTrack;
      if (!track || track.urn !== trackUrn) {
        return false;
      }

      const position = Math.max(cachedTime, getSmoothCurrentTime());
      const requestId = latestSeekRequestId;
      const promoted = await loadTrackFromFullCacheAtSeekTarget(track, position, requestId);
      if (!promoted) {
        return false;
      }
    }

    waitForReadyBuffer = false;
    waitingForStartupProgress = false;
    startupProgressDeadline = 0;
    readyBufferPromise = null;
    readyBufferResolver = null;
    usePlayerStore.setState({ downloadProgress: 1 });
    finalizePlaybackBufferAsCached();
    return true;
  } catch {
    return false;
  }
}

function shouldUseDirectSeekReload(target: number, allowWhileSeekLocked = false): boolean {
  if (
    !isTauriRuntime() ||
    playbackBufferSnapshot.fullyCached ||
    (!playbackBufferSnapshot.seekUnlocked && !allowWhileSeekLocked)
  ) {
    return false;
  }

  const localBufferedEnd = getBufferedSeekWindowEnd();
  if (target > localBufferedEnd + DIRECT_SEEK_RELOAD_FORWARD_TOLERANCE_SEC) {
    return true;
  }

  if (!activeRangedSeekLoad) {
    return false;
  }

  const localBufferedStart = Math.max(0, Math.min(cachedTime, getSmoothCurrentTime()) - 0.45);
  return target + DIRECT_SEEK_RELOAD_BACKWARD_TOLERANCE_SEC < localBufferedStart;
}

async function resyncFromNativePosition() {
  if (!isTauriRuntime()) return;

  try {
    const nativePos = await invoke<number>('audio_get_position');
    if (!Number.isFinite(nativePos) || nativePos < 0) return;

    cachedTime = nativePos;
    lastSmoothTime = nativePos;
    lastTickAt = Date.now();
    seekPendingUntil = 0;
    seekTargetTime = -1;
    resumeNativeAfterBufferedSeek();
    flushNotifyImmediate();
    setTimeout(() => updateMediaPosition(), 120);
  } catch (error) {
    console.warn('[Audio] Failed to resync native position after seek error', error);
  }
}

function scheduleQueuedSeek(
  target: number,
  trackUrn: string,
  allowRecovery: boolean,
  delayMs = SEEK_DEBOUNCE_MS,
  retries = 0,
  requestId = latestSeekRequestId,
) {
  keepSeekGuardAlive(target, delayMs + 2600);
  queuedSeekTarget = target;
  queuedSeekTrackUrn = trackUrn;
  queuedSeekAllowRecovery = allowRecovery;
  queuedSeekRetries = retries;
  queuedSeekRequestId = requestId;
  clearQueuedSeekTimer();
  queuedSeekTimer = setTimeout(() => {
    queuedSeekTimer = null;
    void flushQueuedSeek();
  }, delayMs);
}

async function flushQueuedSeek() {
  if (!isTauriRuntime() || nativeSeekInFlight || queuedSeekTarget < 0 || !queuedSeekTrackUrn) {
    return;
  }

  const target = queuedSeekTarget;
  const trackUrn = queuedSeekTrackUrn;
  const allowRecovery = queuedSeekAllowRecovery;
  const retries = queuedSeekRetries;
  const requestId = queuedSeekRequestId;
  const track = usePlayerStore.getState().currentTrack;

  resetQueuedSeekQueue();

  if (!track || track.urn !== trackUrn || !isActiveSeekRequest(trackUrn, requestId)) {
    return;
  }

  nativeSeekInFlight = true;
  try {
    await invoke('audio_seek', { position: target });
    keepSeekGuardAlive(target, 900);
    hasTrack = true;
    resumeNativeAfterBufferedSeek();
  } catch (error) {
    if (usePlayerStore.getState().currentTrack?.urn !== trackUrn) {
      return;
    }

    if (isBusySeekError(error)) {
      if (isActiveSeekRequest(trackUrn, requestId)) {
        keepSeekGuardAlive(target, SEEK_BUSY_RETRY_MS + 2400);
        scheduleQueuedSeek(target, trackUrn, allowRecovery, SEEK_BUSY_RETRY_MS, retries, requestId);
      }
      return;
    }

    if (isUnbufferedSeekError(error)) {
      const reloaded = await reloadTrackAtSeekTarget(track, target, requestId);
      if (reloaded) {
        keepSeekGuardAlive(target, 2600);
        hasTrack = true;
        return;
      }

      pauseNativeForBufferedSeek();
      if (isActiveSeekRequest(trackUrn, requestId)) {
        keepSeekGuardAlive(target, SEEK_UNBUFFERED_RETRY_MS + 3200);
        scheduleQueuedSeek(
          target,
          trackUrn,
          false,
          SEEK_UNBUFFERED_RETRY_MS,
          retries + 1,
          requestId,
        );
      }
      return;
    }

    if (hasNoSeekFallbackSource(error)) {
      if (retries < SEEK_MAX_NO_SOURCE_RETRIES && isActiveSeekRequest(trackUrn, requestId)) {
        keepSeekGuardAlive(target, SEEK_NO_SOURCE_RETRY_MS + 2600);
        scheduleQueuedSeek(
          target,
          trackUrn,
          allowRecovery,
          SEEK_NO_SOURCE_RETRY_MS,
          retries + 1,
          requestId,
        );
        return;
      }

      if (!isActiveSeekRequest(trackUrn, requestId)) {
        return;
      }

      const recoveredFromCache = await loadTrackFromFullCacheAtSeekTarget(track, target, requestId);
      if (recoveredFromCache) {
        keepSeekGuardAlive(target, 2200);
        hasTrack = true;
        return;
      }

      console.warn('[Audio] Seek target is outside buffered audio, resyncing position', error);
      await resyncFromNativePosition();
      return;
    }

    if (!allowRecovery) {
      if (!isActiveSeekRequest(trackUrn, requestId)) {
        return;
      }

      console.warn('[Audio] seek failed without recovery', error);
      await resyncFromNativePosition();
      return;
    }

    if (retries < SEEK_MAX_RECOVERY_RETRIES && isActiveSeekRequest(trackUrn, requestId)) {
      keepSeekGuardAlive(target, SEEK_RECOVERY_RETRY_MS + 2800);
      scheduleQueuedSeek(
        target,
        trackUrn,
        allowRecovery,
        SEEK_RECOVERY_RETRY_MS,
        retries + 1,
        requestId,
      );
      return;
    }

    await delay(SEEK_RECOVERY_COALESCE_MS);
    if (
      !isActiveSeekRequest(trackUrn, requestId) ||
      (queuedSeekTarget >= 0 && queuedSeekTrackUrn === trackUrn && queuedSeekRequestId > requestId)
    ) {
      return;
    }

    console.warn('[Audio] seek failed, trying recover...', error);
    try {
      const recoveredAtTarget = await reloadTrackAtSeekTarget(track, target, requestId);
      if (recoveredAtTarget) {
        keepSeekGuardAlive(target, 3200);
        hasTrack = true;
        return;
      }

      if (
        activeRangedSeekLoad ||
        waitingForStartupProgress ||
        Date.now() - lastDownloadProgressAt < 1800
      ) {
        pauseNativeForBufferedSeek();
        if (isActiveSeekRequest(trackUrn, requestId)) {
          keepSeekGuardAlive(target, SEEK_UNBUFFERED_RETRY_MS + 3400);
          scheduleQueuedSeek(
            target,
            trackUrn,
            false,
            SEEK_UNBUFFERED_RETRY_MS,
            retries + 1,
            requestId,
          );
        }
        return;
      }

      keepSeekGuardAlive(target, 5000);
      await loadTrack(track);
      if (!isActiveSeekRequest(trackUrn, requestId)) {
        return;
      }
      scheduleQueuedSeek(target, trackUrn, false, SEEK_NO_SOURCE_RETRY_MS, 0, requestId);
    } catch (recoveryError) {
      if (!isActiveSeekRequest(trackUrn, requestId)) {
        return;
      }

      console.error('[Audio] seek recovery failed', recoveryError);
      await resyncFromNativePosition();
    }
  } finally {
    nativeSeekInFlight = false;
    if (
      queuedSeekTarget >= 0 &&
      queuedSeekTrackUrn === usePlayerStore.getState().currentTrack?.urn
    ) {
      clearQueuedSeekTimer();
      queuedSeekTimer = setTimeout(() => {
        queuedSeekTimer = null;
        void flushQueuedSeek();
      }, 0);
    }
  }
}

export function seek(seconds: number, allowRecovery = true, force = false) {
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;
  if (!force && isPlaybackInteractionLocked()) return;
  const requestId = ++latestSeekRequestId;

  isCrossfadingOut = false;
  crossfadeInProgress = false;
  pendingCrossfadeDurationSecs = null;

  const duration = getDuration();
  const maxSeek = duration > 0 ? Math.max(0, duration - 0.15) : Number.POSITIVE_INFINITY;
  const seekableLimit = force ? maxSeek : Math.min(getBufferedSeekWindowEnd(), maxSeek);
  const unclampedTarget = Math.max(0, Math.min(seconds, maxSeek));
  const currentPositionBeforeSeek = Math.max(cachedTime, getSmoothCurrentTime());
  const exactSourceRequired = isTauriRuntime() && !isCurrentPlaybackSourceSeekSafe();
  const hardReloadAtTrackStart =
    isTauriRuntime() && unclampedTarget <= 0.05 && currentPositionBeforeSeek > 1;
  const directSeekReload =
    exactSourceRequired ||
    hardReloadAtTrackStart ||
    shouldUseDirectSeekReload(unclampedTarget, force);
  const target = directSeekReload
    ? unclampedTarget
    : force
      ? unclampedTarget
      : Math.max(0, Math.min(unclampedTarget, seekableLimit));

  if (!force && !directSeekReload && !canSeekCurrentTrack(target)) {
    return;
  }

  endedGuardUntil = Date.now() + 2200;
  keepSeekGuardAlive(target, 4200);
  hasTrack = true;
  if (directSeekReload && isTauriRuntime()) {
    resetQueuedSeekQueue();
    cachedTime = target;
    lastSmoothTime = target;
    lastTickAt = Date.now();
    flushNotifyImmediate(); // Seek needs immediate feedback to UI
    setTimeout(() => updateMediaPosition(), 150);
    void reloadTrackAtSeekTarget(track, target, requestId).then((reloaded) => {
      if (reloaded || !isActiveSeekRequest(track.urn, requestId)) {
        return;
      }

      if (exactSourceRequired) {
        void resyncFromNativePosition();
        return;
      }

      scheduleQueuedSeek(target, track.urn, false, SEEK_UNBUFFERED_RETRY_MS, 0, requestId);
    });
    return;
  }

  if (isTauriRuntime()) {
    if (Math.abs(target - cachedTime) >= SEEK_IGNORE_DELTA_SEC || nativeSeekInFlight) {
      scheduleQueuedSeek(target, track.urn, allowRecovery, SEEK_DEBOUNCE_MS, 0, requestId);
    } else {
      seekPendingUntil = 0;
      seekTargetTime = -1;
    }
  }
  cachedTime = target;
  lastSmoothTime = target;
  lastTickAt = Date.now();
  flushNotifyImmediate(); // Seek needs immediate feedback to UI
  setTimeout(() => updateMediaPosition(), 150);
}

export function handlePrev() {
  if (getCurrentTime() > 3) {
    seek(0);
  } else {
    usePlayerStore.getState().prev();
  }
}

/* ── Native audio control ────────────────────────────────────── */

function stopTrack() {
  resetQueuedSeekQueue();
  clearBufferedSeekPauseState();
  clearStartupBufferPauseState();
  if (notifyRafId != null) cancelAnimationFrame(notifyRafId);
  if (notifyTimeout != null) clearTimeout(notifyTimeout);
  notifyRafId = null;
  notifyTimeout = null;
  notifyPending = false;
  if (isTauriRuntime()) {
    invoke('audio_stop').catch(console.error);
  }
  hasTrack = false;
  currentPlaybackSource = 'none';
  pendingCrossfadeDurationSecs = null;
  waitingForStartupProgress = false;
  startupProgressDeadline = 0;
  waitForReadyBuffer = false;
  readyBufferPromise = null;
  readyBufferResolver = null;
  cachedTime = 0;
  lastSmoothTime = 0;
  resetPlaybackBufferState();
}

/** Reload the current track on new audio device, preserving position */
export async function reloadCurrentTrack() {
  if (!isTauriRuntime()) return;
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;
  suppressStallDetection(4500);
  const wasPlaying = usePlayerStore.getState().isPlaying;
  // If a seek is pending, use the seek target instead of cachedTime
  // (cachedTime may have been overwritten by stale ticks from the old position)
  let pos = seekPendingUntil > Date.now() && seekTargetTime >= 0 ? seekTargetTime : cachedTime;
  if (wasPlaying && pos < 0.2) {
    try {
      const nativePos = await invoke<number>('audio_get_position');
      if (Number.isFinite(nativePos) && nativePos > pos) {
        pos = nativePos;
      }
    } catch (error) {
      console.warn('[Audio] Failed to query native position before reload', error);
    }
  }
  const duration = track.duration > 0 ? track.duration / 1000 : 0;
  const target =
    duration > 0 ? Math.max(0, Math.min(pos, Math.max(0, duration - 0.15))) : Math.max(0, pos);
  endedGuardUntil = Date.now() + 2200;
  const requestId = ++latestSeekRequestId;
  const recoveredAtTarget =
    target > 0.05 ? await reloadTrackAtSeekTarget(track, target, requestId) : false;

  if (!recoveredAtTarget) {
    await loadTrack(track);
    if (target > 0) seek(target, false, true);
  }
  if (!wasPlaying) invoke('audio_pause').catch(console.error);
}

type TrackMetadataPatch = Partial<Track> & { full_duration?: number };

function getResolvedDurationMs(track: {
  duration?: number;
  full_duration?: number;
}): number | null {
  if (typeof track.full_duration === 'number' && track.full_duration > 0)
    return track.full_duration;
  if (typeof track.duration === 'number' && track.duration > 0) return track.duration;
  return null;
}

function getPreviewResolveUrl(track: Pick<Track, 'duration' | 'permalink_url'>): string | null {
  if (track.duration !== API_PREVIEW_DURATION_MS || !track.permalink_url) return null;
  try {
    const url = new URL(track.permalink_url);
    return url.hostname.endsWith('soundcloud.com') ? url.toString() : null;
  } catch {
    return null;
  }
}

function mergeTrackMetadata(base: Track, patch: TrackMetadataPatch): Track {
  const resolvedDuration = getResolvedDurationMs(patch);
  return {
    ...base,
    ...patch,
    duration:
      resolvedDuration == null ||
      (resolvedDuration === API_PREVIEW_DURATION_MS && base.duration > API_PREVIEW_DURATION_MS)
        ? base.duration
        : resolvedDuration,
    permalink_url: patch.permalink_url ?? base.permalink_url,
    user: patch.user ? { ...base.user, ...patch.user } : base.user,
  };
}

function isLikelyFullTrackPlayback(
  track: Pick<Track, 'duration' | 'access'>,
  decodedDurationSecs: number | null | undefined,
): boolean {
  if (track.access !== 'preview') return false;

  const decodedDurationMs =
    typeof decodedDurationSecs === 'number' && decodedDurationSecs > 0
      ? Math.round(decodedDurationSecs * 1000)
      : 0;

  return (
    track.duration > API_PREVIEW_DURATION_MS + 1000 ||
    decodedDurationMs > API_PREVIEW_DURATION_MS + 1000
  );
}

function commitTrackMetadata(track: Track) {
  usePlayerStore.getState().replaceTrackMetadata(track);
  if (currentUrn !== track.urn) return;
  if (track.duration <= 0) {
    updateMetadata(track);
    return;
  }
  const durationSecs = track.duration / 1000;
  fallbackDuration = durationSecs;
  cachedDuration = durationSecs;
  updateMetadata(track, durationSecs);
  flushNotifyImmediate();
}

async function fetchFreshTrackMetadata(track: Track): Promise<Track> {
  try {
    const freshTrack = await api<Track>(`/tracks/${encodeURIComponent(track.urn)}`);
    return mergeTrackMetadata(track, freshTrack);
  } catch {
    return track;
  }
}

async function resolveTrackMetadata(track: Track): Promise<Track> {
  const resolveUrl = getPreviewResolveUrl(track);
  if (!resolveUrl) return track;
  try {
    const resolvedTrack = await resolveTrackFromStreaming(resolveUrl);
    return mergeTrackMetadata(track, resolvedTrack);
  } catch {
    return track;
  }
}

async function hydrateTrackMetadata(track: Track, gen: number) {
  let nextTrack = await fetchFreshTrackMetadata(track);
  if (gen !== loadGen || currentUrn !== track.urn) return;
  nextTrack = await resolveTrackMetadata(nextTrack);
  if (gen !== loadGen || currentUrn !== track.urn) return;
  commitTrackMetadata(nextTrack);
}

type AudioLoadInvokeResult = {
  duration_secs: number | null;
  stream_quality?: string | null;
  stream_content_type?: string | null;
  stream_codec?: string | null;
};

function syncNativeAudioRuntime() {
  if (!isTauriRuntime()) return;

  const { eqEnabled, eqGains, normalizeVolume } = useSettingsStore.getState();
  invoke('audio_set_eq', { enabled: eqEnabled, gains: eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: normalizeVolume }).catch(console.error);
  invoke('audio_set_volume', { volume: usePlayerStore.getState().volume }).catch(console.error);

  const playerState = usePlayerStore.getState();
  invoke('audio_set_playback_rate', { playbackRate: playerState.playbackRate }).catch(
    console.error,
  );
  invoke('audio_set_pitch', {
    pitchSemitones: getEffectivePitchSemitones(
      playerState.playbackRate,
      playerState.pitchControlMode,
      playerState.pitchSemitones,
    ),
  }).catch(console.error);
}

async function primeCachedPlaybackStart(trackUrn: string, expectedGen: number) {
  if (!isTauriRuntime() || !usePlayerStore.getState().isPlaying) return;
  if (expectedGen !== loadGen) return;
  if (currentUrn !== trackUrn || usePlayerStore.getState().currentTrack?.urn !== trackUrn) return;

  try {
    await invoke('audio_play');
  } catch (error) {
    console.warn('[Audio] Cached playback start prime failed', error);
  }
}

async function loadTrackAtImmediateSeekTarget(
  track: Track,
  target: number,
  requestId: number,
): Promise<boolean> {
  if (!isTauriRuntime() || !isActiveSeekRequest(track.urn, requestId)) {
    return false;
  }

  keepSeekGuardAlive(target, 12_000);
  pauseNativeForBufferedSeek();
  try {
    await fetchAndCacheTrack(track.urn);
  } catch (error) {
    if (isActiveSeekRequest(track.urn, requestId)) {
      console.warn('[Audio] Exact seek cache fill failed', error);
    }
    return false;
  }

  if (!isActiveSeekRequest(track.urn, requestId)) {
    return false;
  }

  keepSeekGuardAlive(target, 5200);
  return loadTrackFromFullCacheAtSeekTarget(track, target, requestId);
}

async function loadTrackFromFullCacheAtSeekTarget(
  track: Track,
  target: number,
  requestId: number,
): Promise<boolean> {
  if (!isTauriRuntime() || !isActiveSeekRequest(track.urn, requestId)) {
    return false;
  }

  const cachedPath = await getCacheFilePath(track.urn);
  if (!cachedPath) {
    return false;
  }

  suppressStallDetection(4500);
  const gen = ++loadGen;
  currentUrn = track.urn;
  fallbackDuration = track.duration / 1000;
  if (fallbackDuration > 0) {
    cachedDuration = fallbackDuration;
  }
  cachedTime = target;
  lastSmoothTime = target;
  waitingForStartupProgress = false;
  startupProgressDeadline = 0;
  seekTargetTime = target;
  seekPendingUntil = Math.max(seekPendingUntil, Date.now() + 4200);
  clearBufferedSeekPauseState();
  waitForReadyBuffer = false;
  readyBufferPromise = null;
  readyBufferResolver = null;
  beginPlaybackBufferTracking(fallbackDuration);
  usePlayerStore.setState({ downloadProgress: 1 });
  flushNotifyImmediate();

  setupTauriBindings();
  syncNativeAudioRuntime();

  try {
    const result = await invoke<AudioLoadInvokeResult>('audio_load_file', {
      eventToken: gen,
      path: cachedPath,
      cacheKey: track.urn,
      crossfadeSecs: null,
    });

    if (gen !== loadGen || !isActiveSeekRequest(track.urn, requestId)) {
      return false;
    }

    await invoke('audio_seek', { position: target });

    if (gen !== loadGen || !isActiveSeekRequest(track.urn, requestId)) {
      return false;
    }

    const resolvedQuality =
      track.streamQuality || (useSettingsStore.getState().highQualityStreaming ? 'hq' : 'lq');
    const resolvedCodec =
      inferCodecFromContentType(result.stream_content_type) ||
      track.streamCodec ||
      (resolvedQuality === 'hq' ? 'AAC' : 'MP3');

    usePlayerStore.getState().setCurrentTrackStreamQuality(resolvedQuality);
    usePlayerStore.getState().setCurrentTrackStreamCodec(resolvedCodec);
    currentPlaybackSource = 'cache-file';
    waitForReadyBuffer = false;
    waitingForStartupProgress = false;
    startupProgressDeadline = 0;
    readyBufferPromise = null;
    readyBufferResolver = null;
    finalizePlaybackBufferAsCached();
    hasTrack = true;
    lastTickAt = Date.now();

    if (!usePlayerStore.getState().isPlaying) {
      invoke('audio_pause').catch(console.error);
    }

    updatePlaybackState(usePlayerStore.getState().isPlaying);
    updateMediaPosition();
    return true;
  } catch (error) {
    if (gen === loadGen && isActiveSeekRequest(track.urn, requestId)) {
      await removeCachedTrack(track.urn).catch(() => {});
    }
    console.warn('[Audio] Full cache seek reload failed', error);
    return false;
  }
}

async function reloadTrackAtSeekTarget(track: Track, target: number, requestId: number) {
  const loadedFromFullCache = await loadTrackFromFullCacheAtSeekTarget(track, target, requestId);
  if (loadedFromFullCache) {
    return true;
  }

  return loadTrackAtImmediateSeekTarget(track, target, requestId);
}

async function loadTrack(track: Track, skipStop = false) {
  suppressStallDetection(4500);
  primeStartupRecoveryWindow(track.urn);
  const gen = ++loadGen;
  const urn = track.urn;
  if (skipStop) {
    pendingCrossfadeTrackUrn = urn;
  }

  try {
    if (!skipStop) stopTrack();
    isCrossfadingOut = false;
    currentUrn = track.urn;
    warmTrackTransitionProfile(track);

    fallbackDuration = track.duration / 1000;
    cachedDuration = fallbackDuration;
    cachedTime = 0;
    lastSmoothTime = 0;
    waitingForStartupProgress = true;
    startupProgressDeadline = Date.now() + 8000;
    seekTargetTime = -1;
    seekPendingUntil = 0;
    clearBufferedSeekPauseState();
    waitForReadyBuffer = true;
    startupBufferedSecs = 0;
    readyBufferPromise = null;
    readyBufferResolver = null;
    beginPlaybackBufferTracking(fallbackDuration);
    usePlayerStore.setState({ downloadProgress: null });
    usePlayerStore.getState().setCurrentTrackStreamQuality(undefined);
    usePlayerStore.getState().setCurrentTrackStreamCodec(undefined);
    flushNotifyImmediate();

    if (!isTauriRuntime()) {
      void hydrateTrackMetadata(track, gen);
      hasTrack = false;
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          if (isTauriRuntime() && usePlayerStore.getState().currentTrack?.urn === urn) {
            void loadTrack(track, skipStop);
          }
        }, 300);
      }
      return;
    }

    setupTauriBindings();
    syncNativeAudioRuntime();

    const cachedPath = await getCacheFilePath(urn);
    if (gen !== loadGen) return;
    if (!cachedPath) {
      void hydrateTrackMetadata(track, gen);
    }

    const settings = useSettingsStore.getState();
    const crossfadeSecs =
      skipStop && pendingCrossfadeDurationSecs != null
        ? pendingCrossfadeDurationSecs
        : resolveCrossfadeDurationForLoad(settings, track.duration / 1000, 0);
    const cacheTargetPath = await getCacheTargetPath(urn);
    if (gen !== loadGen) return;
    const loadFromNetworkWithFallback = async () => {
      usePlayerStore.setState({ downloadProgress: 0 });

      const directStreamSource = await getTrackStreamSource(urn);
      const backendProgressiveSource =
        directStreamSource.protocol === 'progressive'
          ? null
          : await getBackendProgressiveTrackStreamSource(urn);
      const streamSource = backendProgressiveSource ?? directStreamSource;
      updateEstimatedStreamTotalBytes(fallbackDuration, streamSource.format);
      console.log(
        `[Audio] Loading ${backendProgressiveSource ? 'backend progressive' : 'direct'} stream: ${urn} (${streamSource.protocol}/${streamSource.format})`,
      );
      try {
        const result = await invoke<AudioLoadInvokeResult>('audio_load_url', {
          progressToken: gen,
          url: streamSource.url,
          sessionId: getSessionId(),
          streamContentTypeHint: streamSource.mimeType,
          cachePath: cacheTargetPath,
          cacheKey: urn,
          crossfadeSecs,
          expectedDurationSecs: track.duration > 0 ? track.duration / 1000 : null,
        });
        const streamCodec =
          inferCodecFromContentType(result.stream_content_type) ||
          inferCodecFromContentType(streamSource.mimeType) ||
          inferCodecFromFormat(streamSource.format) ||
          undefined;
        console.log(
          `[Audio] Stream loaded: resolved=${result.stream_quality || 'unknown'}, codec=${streamCodec || 'unknown'}, mime=${result.stream_content_type || 'unknown'}`,
        );
        return {
          ...result,
          stream_quality:
            result.stream_quality === 'hq' || result.stream_quality === 'lq'
              ? result.stream_quality
              : streamSource.quality,
          stream_codec: streamCodec,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Audio] Stream load failed: error=${message}`);
        throw error;
      }
    };

    try {
      let result: {
        duration_secs: number | null;
        stream_quality?: string | null;
        stream_content_type?: string | null;
        stream_codec?: string | null;
      };
      let loadedFromCache = false;

      if (cachedPath) {
        try {
          result = await invoke<{
            duration_secs: number | null;
            stream_quality?: string | null;
            stream_content_type?: string | null;
            stream_codec?: string | null;
          }>('audio_load_file', {
            eventToken: gen,
            path: cachedPath,
            cacheKey: urn,
            crossfadeSecs,
          });
          loadedFromCache = true;
          currentPlaybackSource = 'cache-file';
        } catch (cacheError) {
          console.warn(
            '[Audio] Cached file failed to decode, retrying from network...',
            cacheError,
          );
          await removeCachedTrack(urn);
          result = await loadFromNetworkWithFallback();
          currentPlaybackSource = 'network';
        }
      } else {
        result = await loadFromNetworkWithFallback();
        currentPlaybackSource = 'network';
      }

      const resolvedQuality =
        result.stream_quality === 'hq' || result.stream_quality === 'lq'
          ? result.stream_quality
          : loadedFromCache
            ? track.streamQuality ||
              (useSettingsStore.getState().highQualityStreaming ? 'hq' : 'lq')
            : useSettingsStore.getState().highQualityStreaming
              ? 'hq'
              : 'lq';
      const resolvedCodec =
        result.stream_codec ||
        inferCodecFromContentType(result.stream_content_type) ||
        track.streamCodec ||
        (resolvedQuality === 'hq' ? 'AAC' : 'MP3');
      if (isLikelyFullTrackPlayback(track, result.duration_secs)) {
        usePlayerStore.getState().setTrackAccessByUrn(track.urn, 'playable');
      }
      usePlayerStore.getState().setCurrentTrackStreamQuality(resolvedQuality);
      usePlayerStore.getState().setCurrentTrackStreamCodec(resolvedCodec);
      if (loadedFromCache) {
        await primeCachedPlaybackStart(urn, gen);
        waitForReadyBuffer = false;
        waitingForStartupProgress = false;
        startupProgressDeadline = 0;
        readyBufferPromise = null;
        readyBufferResolver = null;
        finalizePlaybackBufferAsCached();
      } else if (await syncPlaybackBufferFromCompleteCache(urn, gen)) {
        // complete cache already exists for this track even though we kept network playback path
      } else {
        syncPlaybackBufferPhase(true);
        if (waitForReadyBuffer && usePlayerStore.getState().isPlaying) {
          pauseNativeForStartupBuffer();
        }
      }
      console.log(
        `[Audio] Active stream: quality=${resolvedQuality}, codec=${resolvedCodec || 'unknown'}, source=${loadedFromCache ? 'cache' : 'network'}, mime=${result.stream_content_type || 'unknown'}`,
      );
    } catch (e) {
      console.error('[Audio] Load failed:', e);
      usePlayerStore.setState({ downloadProgress: null });
      waitingForStartupProgress = false;
      startupProgressDeadline = 0;
      resetPlaybackBufferState();
      if (gen !== loadGen) return;
      if (isNotFoundLoadError(e)) {
        console.warn(`[Audio] Marking track as unavailable after stream 404: ${track.urn}`);
        usePlayerStore.getState().setTrackAccessByUrn(track.urn, 'blocked');
        void handleUnavailableTrack(track);
        return;
      }
      usePlayerStore.getState().pause();
      return;
    }

    // Stale check — another loadTrack started while we were loading
    if (gen !== loadGen) {
      if (isTauriRuntime()) {
        invoke('audio_stop').catch(console.error);
      }
      return;
    }
    hasTrack = true;
    lastTickAt = Date.now();
    if (waitForReadyBuffer && cachedDuration > 0) {
      readyBufferPromise = new Promise<void>((resolve) => {
        readyBufferResolver = resolve;
      });

      // Timeout: if buffer doesn't fill in time, start anyway
      const timeoutId = setTimeout(() => {
        if (waitForReadyBuffer && readyBufferResolver) {
          console.log(
            `[Audio] Prebuffer timeout after ${(currentBufferStrategy.startupTimeoutMs / 1000).toFixed(1)}s, starting playback...`,
          );
          resolveReadyBuffer('timeout');
        }
      }, currentBufferStrategy.startupTimeoutMs);

      // Wait for buffer to be ready
      await readyBufferPromise;
      clearTimeout(timeoutId);
      if (
        gen !== loadGen ||
        currentUrn !== urn ||
        usePlayerStore.getState().currentTrack?.urn !== urn
      ) {
        return;
      }
      console.log(`[Audio] Prebuffer ready: ${startupBufferedSecs.toFixed(1)}s buffered`);
    }

    if (
      gen !== loadGen ||
      currentUrn !== urn ||
      usePlayerStore.getState().currentTrack?.urn !== urn
    ) {
      return;
    }
    // Record to listening history (fire-and-forget)
    if (track.urn && track.title) {
      api('/history', {
        method: 'POST',
        body: JSON.stringify({
          scTrackId: track.urn,
          title: track.title,
          artistName: track.user?.username || '',
          artworkUrl: track.artwork_url || null,
          duration: track.duration || 0,
        }),
      }).catch(() => {});
    }

    if (!usePlayerStore.getState().isPlaying) {
      if (isTauriRuntime()) {
        invoke('audio_pause').catch(console.error);
      }
    }

    updatePlaybackState(usePlayerStore.getState().isPlaying);
    updateMediaPosition();
    preloadQueue();
    warmUpcomingTransitionProfiles();
    isCrossfadingOut = false;
  } finally {
    if (skipStop && pendingCrossfadeTrackUrn === urn) {
      pendingCrossfadeTrackUrn = null;
    }
    if (skipStop) {
      pendingCrossfadeDurationSecs = null;
    }
  }
}

function handleTrackEnd() {
  const state = usePlayerStore.getState();
  const sw = useSoundWaveStore.getState();

  if (state.currentTrack) {
    sw.markTrackPlayed(state.currentTrack);
    audioAnalyser.finalizeCurrentTrackIfReady();
    sw.ingestPlayedTrackFeatures(state.currentTrack);
  }

  if (sw.isActive && !sw.isSuspended && state.currentTrack) {
    sw.recordFeedback(state.currentTrack, 'positive');
  }

  if (state.repeat === 'one') {
    if (state.currentTrack) void loadTrack(state.currentTrack);
  } else {
    const { queue, queueIndex, queueSource } = state;
    const isLast = queueIndex >= queue.length - 1;
    const isSoundWave = queueSource === 'soundwave' && sw.isActive && !sw.isSuspended;

    if (isLast && queue.length > 0) {
      const lastTrack = queue[queueIndex];
      if (isSoundWave && lastTrack) {
        void continueSoundWaveQueue(lastTrack);
      } else if (state.repeat === 'off') {
        if (lastTrack) {
          void autoplayContinuation(lastTrack, 'queue-ended');
        } else {
          usePlayerStore.getState().pause();
        }
      } else {
        currentUrn = null;
        usePlayerStore.getState().next();
      }
    } else {
      currentUrn = null;
      usePlayerStore.getState().next();
    }
  }
}

/* ── Tauri event listeners ───────────────────────────────────── */
// Fallback stall detector: if playing but no ticks for a while, probe native position first.
const STALL_THRESHOLD_MS = 2400;
const STALL_COOLDOWN_MS = 10000; // after a stall reload, wait 10s before detecting again
const STALL_NATIVE_RESYNC_EPSILON_SEC = 0.35;
let stallCooldownUntil = 0;
let resumeGuardUntil = 0; // suppress stall detection right after visibility resume
let tauriBindingsReady = false;
let tauriBindingsPoll: ReturnType<typeof setInterval> | null = null;

async function recoverFromStall(elapsedMs: number) {
  if (stallProbeInFlight || stallRecoveryInFlight) return;
  if (hasPendingCrossfadeLoad()) return;
  if (nativeStartupPausedForBuffering) return;
  if (!playbackBufferSnapshot.fullyCached && Date.now() - lastDownloadProgressAt < 2200) {
    return;
  }

  stallProbeInFlight = true;
  try {
    const nativePos = await invoke<number>('audio_get_position');
    const now = Date.now();
    const duration = getDuration();
    const clampedNativePos =
      Number.isFinite(nativePos) && nativePos >= 0
        ? duration > 0
          ? Math.min(nativePos, duration)
          : nativePos
        : cachedTime;

    if (clampedNativePos > cachedTime + STALL_NATIVE_RESYNC_EPSILON_SEC) {
      cachedTime = clampedNativePos;
      lastSmoothTime = clampedNativePos;
      lastTickAt = now;
      if (clampedNativePos > 0.05) {
        waitingForStartupProgress = false;
      }
      flushNotifyImmediate();
      return;
    }

    if (waitingForStartupProgress && now < startupProgressDeadline) {
      return;
    }

    if (now < stallCooldownUntil || now < resumeGuardUntil || now < stallSuppressedUntil) return;
    if (!hasTrack || !usePlayerStore.getState().isPlaying) return;

    console.log(`[Audio] Stall detected (no ticks for ${elapsedMs}ms), reloading track...`);
    lastTickAt = now;
    stallCooldownUntil = now + STALL_COOLDOWN_MS;
    stallRecoveryInFlight = true;
    suppressStallDetection(5000);
    await reloadCurrentTrack();
  } catch (error) {
    const now = Date.now();
    if (now >= stallCooldownUntil && now >= resumeGuardUntil && now >= stallSuppressedUntil) {
      console.warn('[Audio] Stall probe failed, using reload fallback', error);
      lastTickAt = now;
      stallCooldownUntil = now + STALL_COOLDOWN_MS;
      stallRecoveryInFlight = true;
      suppressStallDetection(5000);
      await reloadCurrentTrack();
    }
  } finally {
    stallRecoveryInFlight = false;
    stallProbeInFlight = false;
  }
}

function setupTauriBindings() {
  if (tauriBindingsReady || !isTauriRuntime()) return;
  tauriBindingsReady = true;

  listen<AudioTickPayload>('audio:tick', (event) => {
    const payload = event.payload;
    const tickPos =
      typeof payload === 'number'
        ? payload
        : payload?.position != null && Number.isFinite(payload.position)
          ? payload.position
          : null;
    const tickGen = typeof payload === 'number' ? null : (payload?.gen ?? null);
    if (tickGen != null && tickGen !== loadGen) {
      return;
    }
    if (tickPos == null || !Number.isFinite(tickPos)) {
      return;
    }
    const now = Date.now();
    const durationLimit = cachedDuration > 0 ? cachedDuration : fallbackDuration;

    if (Number.isFinite(durationLimit) && durationLimit > 0 && tickPos > durationLimit + 1.5) {
      console.warn('[Audio] Ignoring out-of-range playback tick', {
        tickPos,
        durationLimit,
      });
      return;
    }

    if (
      waitingForStartupProgress &&
      !startupPlaybackTickReceived &&
      seekTargetTime < 0 &&
      cachedTime <= 0.1
    ) {
      const suspiciousStartupJumpLimit = Math.min(
        durationLimit > 0 ? Math.max(10, Math.min(durationLimit * 0.2, 45)) : 45,
        Math.max(currentBufferStrategy.seekUnlockBufferSecs * 1.5, 12),
      );
      if (tickPos > suspiciousStartupJumpLimit) {
        console.warn('[Audio] Ignoring stale startup playback tick', {
          tickPos,
          suspiciousStartupJumpLimit,
        });
        return;
      }
    }

    startupPlaybackTickReceived = true;
    startupRecoveryAttempts = 0;

    // Reject stale ticks from the old position while a queued/native seek is still settling.
    const hasQueuedSeek =
      queuedSeekTarget >= 0 && queuedSeekTrackUrn === usePlayerStore.getState().currentTrack?.urn;
    if ((seekPendingUntil > now || hasQueuedSeek) && seekTargetTime >= 0) {
      const drift = Math.abs(tickPos - seekTargetTime);
      if (drift > SEEK_TICK_SETTLE_EPSILON_SEC) {
        // Stale tick from pre-seek position — ignore it
        return;
      }
      // Tick is close to target — seek has landed, clear the guard
      seekPendingUntil = 0;
      seekTargetTime = -1;
    }

    if (
      !waitForReadyBuffer &&
      !waitingForStartupProgress &&
      !nativeSeekInFlight &&
      !hasQueuedSeek &&
      seekPendingUntil <= now &&
      tickPos + 0.18 < cachedTime
    ) {
      console.warn('[Audio] Ignoring regressive playback tick', {
        tickPos,
        cachedTime,
      });
      return;
    }

    cachedTime = tickPos;
    lastTickAt = now;
    if (tickPos > 0.05) {
      waitingForStartupProgress = false;
      updateTickDrivenBufferState(tickPos);
    }
    if (cachedDuration <= 0) cachedDuration = fallbackDuration;
    notify();

    const settings = useSettingsStore.getState();
    if (
      !hasActiveSeekTransition(usePlayerStore.getState().currentTrack?.urn) &&
      !isCrossfadeOffMode(settings.crossfadeMode) &&
      cachedDuration > 0
    ) {
      const currentTrack = usePlayerStore.getState().currentTrack;
      const transitionDuration =
        settings.crossfadeMode === 'manual'
          ? getManualCrossfadeDuration(settings)
          : getSmartCrossfadeDurationForTracks(currentTrack, cachedTime);
      const remaining = cachedDuration - cachedTime;
      if (remaining <= transitionDuration && remaining > 0 && !isCrossfadingOut) {
        isCrossfadingOut = true;
        crossfadeInProgress = true;
        pendingCrossfadeDurationSecs = transitionDuration;
        handleTrackEnd();
      }
    }
  });

  listen('audio:ended', () => {
    clearBufferedSeekPauseState();
    if (hasPendingCrossfadeLoad()) {
      console.log('[Audio] Ignoring ended event while crossfade transition is still loading');
      return;
    }
    const nearTrackEnd = cachedDuration > 0 && cachedTime >= Math.max(0, cachedDuration - 1.2);
    if (Date.now() < endedGuardUntil && !nearTrackEnd) {
      console.warn('[Audio] Ignoring spurious ended event during seek transition');
      return;
    }
    hasTrack = false;
    waitingForStartupProgress = false;
    waitForReadyBuffer = false;
    handleTrackEnd();
  });

  listen('audio:device-reconnected', () => {
    console.log('[Audio] Device reconnected (BT profile switch?), reloading track...');
    void reloadCurrentTrack();
  });

  listen<{
    gen: number;
    progress: number | null;
    downloadedBytes?: number;
    totalBytes?: number | null;
    done?: boolean;
    rangedSeekLoad?: boolean;
    cacheComplete?: boolean;
  }>('audio:download_progress', (event) => {
    const {
      gen,
      progress,
      downloadedBytes = 0,
      totalBytes = null,
      done = false,
      rangedSeekLoad = false,
      cacheComplete = false,
    } = event.payload;

    if (gen !== loadGen) {
      return;
    }

    activeRangedSeekLoad = rangedSeekLoad;
    updatePlaybackBufferProgress(progress, downloadedBytes, totalBytes, done, cacheComplete);
  });

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!hasTrack || !usePlayerStore.getState().isPlaying) return;

      const now = Date.now();
      if (now < deviceChangeCooldownUntil) return;
      deviceChangeCooldownUntil = now + 3000;

      console.log('[Audio] Media devices changed, re-binding output...');
      invoke('audio_switch_device', { deviceName: null })
        .then(() => {
          void reloadCurrentTrack();
        })
        .catch(() => {
          void reloadCurrentTrack();
        });
    });
  }

  setInterval(() => {
    if (!isTauriRuntime() || !hasTrack || !lastTickAt) return;
    if (hasPendingCrossfadeLoad()) return;
    if (nativeStartupPausedForBuffering) return;
    const { isPlaying } = usePlayerStore.getState();
    if (!isPlaying) return;
    const now = Date.now();
    if (now < stallCooldownUntil || now < resumeGuardUntil || now < stallSuppressedUntil) return;
    if (!playbackBufferSnapshot.fullyCached && Date.now() - lastDownloadProgressAt < 2200) return;
    const elapsed = now - lastTickAt;
    if (elapsed > STALL_THRESHOLD_MS) {
      void recoverFromStall(elapsed);
    }
  }, 1000);

  setInterval(() => {
    if (!isTauriRuntime() || !currentUrn) return;
    if (hasPendingCrossfadeLoad()) return;
    if (nativeStartupPausedForBuffering) return;
    const state = usePlayerStore.getState();
    if (!state.isPlaying || state.currentTrack?.urn !== currentUrn) return;
    if (playbackBufferSnapshot.phase === 'ready' || playbackBufferSnapshot.fullyCached) return;
    if (queuedSeekTarget >= 0 || nativeSeekInFlight || startupRecoveryInFlight) return;

    const now = Date.now();
    if (now < stallSuppressedUntil || now < resumeGuardUntil) return;

    const startupActive =
      waitForReadyBuffer ||
      waitingForStartupProgress ||
      !playbackBufferSnapshot.seekUnlocked ||
      !startupPlaybackTickReceived;
    if (!startupActive || bufferLoadStartedAt <= 0) return;

    const lastActivityAt = Math.max(bufferLoadStartedAt, lastDownloadProgressAt, lastTickAt);
    const activityIdleMs = now - lastActivityAt;
    const loadAgeMs = now - bufferLoadStartedAt;
    const noTickYet = !startupPlaybackTickReceived && cachedTime <= 0.05;

    if (activityIdleMs >= STARTUP_RECOVERY_ACTIVITY_TIMEOUT_MS) {
      void recoverFromStartupHang(`no activity for ${activityIdleMs}ms`);
      return;
    }

    const totalLoadBudgetMs = currentBufferStrategy.startupTimeoutMs + 3500;
    if (
      noTickYet &&
      loadAgeMs >= Math.max(totalLoadBudgetMs, STARTUP_RECOVERY_NO_TICK_TIMEOUT_MS)
    ) {
      void recoverFromStartupHang(`no playback tick after ${loadAgeMs}ms`);
    }
  }, 1000);

  setInterval(() => {
    if (!isTauriRuntime() || !currentUrn) return;
    if (playbackBufferSnapshot.fullyCached) return;
    const trackUrn = usePlayerStore.getState().currentTrack?.urn;
    if (!trackUrn || trackUrn !== currentUrn) return;
    void syncPlaybackBufferFromCompleteCache(trackUrn);
  }, 1200);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeGuardUntil = Date.now() + 5000;
      if (hasTrack && usePlayerStore.getState().isPlaying && lastTickAt > 0) {
        const idle = Date.now() - lastTickAt;
        if (idle > 30000) {
          console.log(
            `[Audio] Resuming after ${Math.round(idle / 1000)}s idle, forcing device reconnect...`,
          );
          invoke('audio_switch_device', { deviceName: null })
            .then(() => {
              console.log('[Audio] Device reconnected after idle, reloading track...');
              void reloadCurrentTrack();
            })
            .catch((e) => {
              console.error('[Audio] Device reconnect failed:', e);
              void reloadCurrentTrack();
            });
        }
      }
    }
  });

  listen('media:play', () => usePlayerStore.getState().resume());
  listen('media:pause', () => usePlayerStore.getState().pause());
  listen('media:toggle', () => usePlayerStore.getState().togglePlay());
  listen('media:next', () => usePlayerStore.getState().next());
  listen('media:prev', () => handlePrev());
  listen<number>('media:seek', (e) => seek(e.payload));
  listen<number>('media:seek-relative', (e) => {
    const offset = e.payload;
    if (offset > 0) {
      seek(Math.min(getCurrentTime() + offset, getDuration()));
    } else {
      seek(Math.max(getCurrentTime() + offset, 0));
    }
  });
}

function getContextualWavePreset() {
  return useSettingsStore.getState().soundwaveMode === 'diverse'
    ? CHARACTER_PRESETS.discover
    : CHARACTER_PRESETS.favorite;
}

function serializeStringList(values: string[]) {
  return [...values].sort().join('|');
}

function scheduleSoundWaveQueueRefresh(reason: string) {
  if (queuedSoundWaveRefreshTimer) {
    clearTimeout(queuedSoundWaveRefreshTimer);
  }

  queuedSoundWaveRefreshTimer = setTimeout(() => {
    queuedSoundWaveRefreshTimer = null;
    const sw = useSoundWaveStore.getState();
    const player = usePlayerStore.getState();
    if (!sw.isActive || sw.isSuspended || player.queueSource !== 'soundwave') {
      return;
    }

    void sw
      .refreshUpcomingQueue({ reason })
      .then((tail) => {
        if (tail.length > 0) {
          preloadQueue();
          warmUpcomingTransitionProfiles();
        }
      })
      .catch((error) => {
        console.error('[SoundWave] Scheduled queue refresh failed', error);
      });
  }, SOUNDWAVE_REFRESH_DEBOUNCE_MS);
}

async function ensureHiddenSoundWaveContinuation(
  anchorTrack: Track,
  reason: string,
): Promise<boolean> {
  if (!anchorTrack?.urn || backgroundContinuationInFlight) {
    return false;
  }

  const player = usePlayerStore.getState();
  if (!player.currentTrack || player.currentTrack.urn !== anchorTrack.urn) {
    return false;
  }

  backgroundContinuationInFlight = true;
  try {
    console.log(
      `[SoundWave] Preparing hidden continuation: reason=${reason}, anchor=${anchorTrack.urn}`,
    );

    const tail = await buildWaveQueueFromPlayerContext({
      languages: [...useSettingsStore.getState().soundwaveLanguages].sort(),
      mode: useSettingsStore.getState().soundwaveMode,
      hideLiked: useSettingsStore.getState().soundwaveHideLiked,
      targetSize: CONTEXTUAL_AUTOPLAY_TAIL_TARGET,
    });

    const latestPlayer = usePlayerStore.getState();
    if (!latestPlayer.currentTrack || latestPlayer.currentTrack.urn !== anchorTrack.urn) {
      console.log(
        `[SoundWave] Hidden continuation became stale: reason=${reason}, anchor=${anchorTrack.urn}`,
      );
      return false;
    }

    if (tail.length === 0) {
      console.warn(
        `[SoundWave] Hidden continuation produced no wave tail: reason=${reason}, anchor=${anchorTrack.urn}`,
      );
      return false;
    }

    const queueHead =
      latestPlayer.queueIndex >= 0
        ? latestPlayer.queue.slice(0, latestPlayer.queueIndex + 1)
        : [anchorTrack];
    const nextQueue = dedupeTracksByUrn([...queueHead, ...tail]);

    await useSoundWaveStore.getState().startFromQueue({
      queue: nextQueue,
      seedTracks: [anchorTrack],
      preserveCurrentTrack: true,
      preset: getContextualWavePreset(),
      launchContext: null,
    });

    backgroundContinuationPreparedUrn = anchorTrack.urn;
    preloadQueue();
    warmUpcomingTransitionProfiles();
    console.log(
      `[SoundWave] Hidden continuation activated: reason=${reason}, tail=${tail.length}, queue=${nextQueue.length}`,
    );
    return true;
  } catch (error) {
    console.error('[SoundWave] Hidden continuation failed', error);
    return false;
  } finally {
    backgroundContinuationInFlight = false;
  }
}

function maybePrepareBackgroundContinuation(
  state: ReturnType<typeof usePlayerStore.getState>,
  reason: string,
) {
  if (!state.currentTrack || state.repeat !== 'off' || state.queueSource === 'soundwave') {
    return;
  }

  if (state.queue.length === 0 || state.queueIndex < 0) {
    return;
  }

  const isLast = state.queueIndex >= state.queue.length - 1;
  if (!isLast) {
    return;
  }

  if (backgroundContinuationPreparedUrn === state.currentTrack.urn) {
    return;
  }

  void ensureHiddenSoundWaveContinuation(state.currentTrack, reason);
}

setupTauriBindings();
if (!tauriBindingsReady) {
  tauriBindingsPoll = setInterval(() => {
    setupTauriBindings();
    if (tauriBindingsReady && tauriBindingsPoll) {
      clearInterval(tauriBindingsPoll);
      tauriBindingsPoll = null;
    }
  }, 300);
}

/* ── Store subscriber ────────────────────────────────────────── */

usePlayerStore.subscribe((state, prev) => {
  const trackChanged = state.currentTrack?.urn !== currentUrn;
  const playToggled = state.isPlaying !== prev.isPlaying;
  const previousTrack = prev.currentTrack;
  const queueChanged =
    state.queue !== prev.queue ||
    state.queueIndex !== prev.queueIndex ||
    state.queueSource !== prev.queueSource;

  if (trackChanged) {
    backgroundContinuationPreparedUrn = null;
    if (state.currentTrack) {
      const sw = useSoundWaveStore.getState();
      if (sw.isActive && !sw.isSuspended && prev.queueSource === 'soundwave') {
        const switchedToExternalQueue = state.queueSource !== 'soundwave';
        if (switchedToExternalQueue) {
          sw.suspendForExternalPlayback(prev.queue, prev.queueIndex);
        }
      }
    }

    if (state.currentTrack) {
      updateMetadata(state.currentTrack);
      audioAnalyser.setTrack(state.currentTrack.urn);
      if (previousTrack && previousTrack.urn !== state.currentTrack.urn) {
        useSoundWaveStore.getState().ingestPlayedTrackFeatures(previousTrack);
      }
      const shouldSkipStop = crossfadeInProgress;
      crossfadeInProgress = false;
      void loadTrack(state.currentTrack, shouldSkipStop);
    } else {
      audioAnalyser.setTrack(null);
      if (previousTrack) {
        useSoundWaveStore.getState().ingestPlayedTrackFeatures(previousTrack);
      }
      stopTrack();
      currentUrn = null;
      fallbackDuration = 0;
      cachedDuration = 0;
      notify();
    }
    if (state.currentTrack) {
      maybePrepareBackgroundContinuation(state, 'track-change:last-manual-track');
    }
    return;
  }

  if (playToggled && !trackChanged) {
    if (state.isPlaying) {
      if (!hasTrack && state.currentTrack) {
        void loadTrack(state.currentTrack);
      } else {
        if (isTauriRuntime()) {
          invoke('audio_play').catch(console.error);
        }
      }
    } else {
      if (isTauriRuntime()) {
        invoke('audio_pause').catch(console.error);
      }
    }
    updatePlaybackState(state.isPlaying);
  }

  if (isTauriRuntime() && state.volume !== prev.volume) {
    invoke('audio_set_volume', { volume: state.volume }).catch(console.error);
  }

  if (isTauriRuntime() && state.playbackRate !== prev.playbackRate) {
    invoke('audio_set_playback_rate', { playbackRate: state.playbackRate }).catch(console.error);
  }

  if (
    isTauriRuntime() &&
    (state.pitchSemitones !== prev.pitchSemitones ||
      state.pitchControlMode !== prev.pitchControlMode ||
      state.playbackRate !== prev.playbackRate)
  ) {
    invoke('audio_set_pitch', {
      pitchSemitones: getEffectivePitchSemitones(
        state.playbackRate,
        state.pitchControlMode,
        state.pitchSemitones,
      ),
    }).catch(console.error);
  }

  if (queueChanged && state.currentTrack) {
    maybePrepareBackgroundContinuation(state, 'queue-update:last-manual-track');
    if (state.queue.length > prev.queue.length || state.queueSource !== prev.queueSource) {
      preloadQueue();
      warmUpcomingTransitionProfiles();
    }
  }
});

/* ── EQ settings subscriber ──────────────────────────────────── */

useSettingsStore.subscribe((state, prev) => {
  if (isTauriRuntime() && (state.eqEnabled !== prev.eqEnabled || state.eqGains !== prev.eqGains)) {
    invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  }
  if (isTauriRuntime() && state.normalizeVolume !== prev.normalizeVolume) {
    invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
  }

  const sw = useSoundWaveStore.getState();
  const player = usePlayerStore.getState();
  if (!sw.isActive || sw.isSuspended || player.queueSource !== 'soundwave') {
    return;
  }

  const contextualWaveSettingsChanged =
    state.soundwaveMode !== prev.soundwaveMode ||
    state.soundwaveHideLiked !== prev.soundwaveHideLiked ||
    serializeStringList(state.soundwaveLanguages) !== serializeStringList(prev.soundwaveLanguages);

  const presetWaveSettingsChanged =
    state.languageFilterEnabled !== prev.languageFilterEnabled ||
    state.soundwaveHideLiked !== prev.soundwaveHideLiked ||
    state.soundwaveGenreStrict !== prev.soundwaveGenreStrict ||
    serializeStringList(state.preferredLanguages) !==
      serializeStringList(prev.preferredLanguages) ||
    serializeStringList(state.soundwaveSelectedGenres) !==
      serializeStringList(prev.soundwaveSelectedGenres);

  if (sw.continuationStrategy === 'contextual-tail' && contextualWaveSettingsChanged) {
    scheduleSoundWaveQueueRefresh('settings:contextual-tail');
    return;
  }

  if (sw.continuationStrategy === 'preset-batch' && presetWaveSettingsChanged) {
    scheduleSoundWaveQueueRefresh('settings:preset-wave');
  }
});

/* ── Native Media Controls (souvlaki: MPRIS/SMTC) ───────────── */

function updateMetadata(track: Track, durationSecs?: number) {
  if (!isTauriRuntime()) return;
  const coverUrl = art(track.artwork_url, 't500x500') || undefined;
  invoke('audio_set_metadata', {
    title: track.title,
    artist: track.user.username,
    coverUrl: coverUrl || null,
    durationSecs: durationSecs ?? track.duration / 1000,
  }).catch(console.error);
}

function updatePlaybackState(playing: boolean) {
  if (!isTauriRuntime()) return;
  invoke('audio_set_playback_state', { playing }).catch(console.error);
}

function updateMediaPosition() {
  if (!isTauriRuntime()) return;
  const pos = getCurrentTime();
  if (pos > 0) {
    invoke('audio_set_media_position', { position: pos }).catch(console.error);
  }
}

// Listen for media control events from souvlaki (MPRIS/SMTC)

/* ── Autoplay ────────────────────────────────────────────────── */

let autoplayLoading = false;

async function handleUnavailableTrack(track: Track) {
  const state = usePlayerStore.getState();
  const sw = useSoundWaveStore.getState();
  const currentQueueIndex = state.queue.findIndex((queuedTrack) => queuedTrack.urn === track.urn);
  const effectiveIndex = currentQueueIndex >= 0 ? currentQueueIndex : state.queueIndex;
  const isLast = effectiveIndex < 0 || effectiveIndex >= state.queue.length - 1;

  if (!isLast) {
    console.log('[Audio] Skipping unavailable track and moving to the next queue item');
    currentUrn = null;
    state.next();
    return;
  }

  if (state.repeat === 'off' && state.queue.length > 0) {
    if (state.queueSource === 'soundwave' && sw.isActive && !sw.isSuspended) {
      await continueSoundWaveQueue(track);
      return;
    }
    await autoplayContinuation(track, 'unavailable-last-track');
    return;
  }

  usePlayerStore.getState().pause();
}

async function continueSoundWaveQueue(lastTrack: Track) {
  const sw = useSoundWaveStore.getState();
  const before = usePlayerStore.getState();

  try {
    console.log(
      `[SoundWave] Queue exhausted, refreshing continuation strategy=${sw.continuationStrategy ?? 'none'}...`,
    );
    const tail = await sw.refreshUpcomingQueue({ reason: 'queue-exhausted' });

    if (tail.length > 0) {
      preloadQueue();
      warmUpcomingTransitionProfiles();
      const after = usePlayerStore.getState();
      if (after.queue.length > before.queue.length && after.queueIndex < after.queue.length - 1) {
        currentUrn = null;
        after.next();
        return;
      }
      console.warn('[SoundWave] Refreshed queue tail contained no playable next track');
    } else {
      console.warn('[SoundWave] Queue refresh returned no tracks');
    }
  } catch (error) {
    console.error('[SoundWave] Queue refill failed', error);
  }

  if (await ensureHiddenSoundWaveContinuation(lastTrack, 'soundwave-tail-fallback')) {
    const after = usePlayerStore.getState();
    if (after.queueIndex < after.queue.length - 1) {
      currentUrn = null;
      after.next();
      return;
    }
  }

  await autoplayRelated(lastTrack);
}

async function autoplayContinuation(lastTrack: Track, reason: string) {
  if (await ensureHiddenSoundWaveContinuation(lastTrack, reason)) {
    const state = usePlayerStore.getState();
    if (state.queueIndex < state.queue.length - 1) {
      currentUrn = null;
      state.next();
      return;
    }
  }

  await autoplayRelated(lastTrack);
}

async function autoplayRelated(lastTrack: Track) {
  if (autoplayLoading) return;
  autoplayLoading = true;

  try {
    const { queue } = usePlayerStore.getState();
    const existingUrns = new Set(queue.map((t) => t.urn));
    const res = await api<{ collection: Track[] }>(
      `/tracks/${encodeURIComponent(lastTrack.urn)}/related?limit=20`,
    );
    const fresh = res.collection.filter((t) => !existingUrns.has(t.urn));
    if (fresh.length === 0) {
      usePlayerStore.getState().pause();
      return;
    }

    usePlayerStore.getState().addToQueue(fresh);
    usePlayerStore.getState().next();
  } catch (e) {
    console.error('Autoplay related failed:', e);
    usePlayerStore.getState().pause();
  } finally {
    autoplayLoading = false;
  }
}

/* ── Preloading ──────────────────────────────────────────────── */

let preloadTimer: ReturnType<typeof setTimeout> | null = null;
let hoverPreloadTimer: ReturnType<typeof setTimeout> | null = null;
let hoverPreloadCandidate: string | null = null;
const MAX_CONCURRENT_PRELOADS = 3;
const PRELOAD_LOOKAHEAD_TRACKS = 5;
const HOVER_PRELOAD_DWELL_MS = 120;
const HOVER_PRELOAD_PUMP_DELAY_MS = 120;
let activePreloads = 0;
const preloadPendingUrns: string[] = [];
const preloadPendingSet = new Set<string>();
const preloadInFlightSet = new Set<string>();
const preloadSourceMap = new Map<string, { hover: boolean; queue: boolean }>();

function queuePreload(urn: string, source: 'hover' | 'queue' = 'queue', priority = false) {
  if (!urn || urn === currentUrn) return;

  const flags = preloadSourceMap.get(urn) ?? { hover: false, queue: false };
  flags[source] = true;
  preloadSourceMap.set(urn, flags);

  if (preloadPendingSet.has(urn) || preloadInFlightSet.has(urn)) return;
  preloadPendingSet.add(urn);
  if (priority) {
    preloadPendingUrns.unshift(urn);
  } else {
    preloadPendingUrns.push(urn);
  }
}

function clearHoverOnlyPendingPreloads(exceptUrn?: string) {
  for (let i = preloadPendingUrns.length - 1; i >= 0; i -= 1) {
    const urn = preloadPendingUrns[i];
    if (urn === exceptUrn) continue;

    const flags = preloadSourceMap.get(urn);
    if (!flags?.hover || flags.queue) continue;

    preloadPendingUrns.splice(i, 1);
    preloadPendingSet.delete(urn);
    preloadSourceMap.delete(urn);
  }
}

function schedulePreloadPump(delayMs = 260) {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    void pumpPreloads();
  }, delayMs);
}

async function pumpPreloads() {
  if (!isTauriRuntime()) return;

  while (activePreloads < MAX_CONCURRENT_PRELOADS && preloadPendingUrns.length > 0) {
    const urn = preloadPendingUrns.shift();
    if (!urn) break;
    preloadPendingSet.delete(urn);

    if (urn === currentUrn || preloadInFlightSet.has(urn)) {
      continue;
    }

    preloadInFlightSet.add(urn);
    activePreloads++;

    void isCached(urn)
      .then((hit) => {
        if (!hit) {
          return fetchAndCacheTrack(urn);
        }
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        activePreloads = Math.max(0, activePreloads - 1);
        preloadInFlightSet.delete(urn);
        preloadSourceMap.delete(urn);
        if (preloadPendingUrns.length > 0) {
          schedulePreloadPump(220);
        }
      });
  }
}

export function preloadTrack(urn: string) {
  if (!isTauriRuntime()) return;

  hoverPreloadCandidate = urn;
  if (hoverPreloadTimer) clearTimeout(hoverPreloadTimer);
  hoverPreloadTimer = setTimeout(() => {
    hoverPreloadTimer = null;
    const candidate = hoverPreloadCandidate;
    hoverPreloadCandidate = null;
    if (!candidate || candidate === currentUrn) return;

    clearHoverOnlyPendingPreloads(candidate);
    queuePreload(candidate, 'hover', true);
    schedulePreloadPump(HOVER_PRELOAD_PUMP_DELAY_MS);
  }, HOVER_PRELOAD_DWELL_MS);
}

export function preloadQueue() {
  if (!isTauriRuntime()) return;
  const { queue, queueIndex } = usePlayerStore.getState();
  for (let i = 1; i <= PRELOAD_LOOKAHEAD_TRACKS; i++) {
    const idx = queueIndex + i;
    if (idx < queue.length) {
      queuePreload(queue[idx].urn, 'queue');
      if (i <= 2) {
        warmTrackTransitionProfile(queue[idx]);
      }
    }
  }
  schedulePreloadPump(420);
}
