import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getEffectivePitchSemitones, type Track, usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { useSoundWaveStore } from '../stores/soundwave';
import { api, getSessionId, resolveTrackFromStreaming, streamUrl } from './api';
import { audioAnalyser } from './audio-analyser';
import {
  fetchAndCacheTrack,
  getCacheFilePath,
  getCacheTargetPath,
  isCached,
  removeCachedTrack,
} from './cache';
import { art } from './formatters';
import { isTauriRuntime } from './runtime';

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
const listeners = new Set<() => void>();
const SEEK_DEBOUNCE_MS = 120;
const SEEK_BUSY_RETRY_MS = 80;
const SEEK_NO_SOURCE_RETRY_MS = 220;
const SEEK_UNBUFFERED_RETRY_MS = 260;
const SEEK_RECOVERY_RETRY_MS = 140;
const SEEK_RECOVERY_COALESCE_MS = 180;
const SEEK_MAX_NO_SOURCE_RETRIES = 8;
const SEEK_MAX_RECOVERY_RETRIES = 2;
const SEEK_IGNORE_DELTA_SEC = 0.12;

function notify() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  if (lastTickAt === 0 || now < lastTickAt) return cachedTime;
  const elapsed = (now - lastTickAt) / 1000;
  const raw = Math.min(cachedTime + elapsed, cachedTime + 1.0);

  if (raw + 0.08 < lastSmoothTime && lastSmoothTime - raw < 1.25) {
    return lastSmoothTime;
  }

  lastSmoothTime = raw;
  return raw;
}

export function getDuration(): number {
  return cachedDuration;
}

function suppressStallDetection(ms: number) {
  stallSuppressedUntil = Math.max(stallSuppressedUntil, Date.now() + ms);
}

function inferCodecFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase();
  if (normalized.includes('opus')) return 'OPUS';
  if (normalized.includes('ogg')) return 'OGG';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'MP3';
  if (normalized.includes('aac') || normalized.includes('mp4a') || normalized.includes('audio/mp4')) {
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

function keepSeekGuardAlive(target: number, ms: number) {
  seekTargetTime = target;
  seekPendingUntil = Math.max(seekPendingUntil, Date.now() + ms);
  lastTickAt = Date.now();
  suppressStallDetection(Math.max(ms + 800, 1800));
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
    notify();
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
        scheduleQueuedSeek(
          target,
          trackUrn,
          allowRecovery,
          SEEK_BUSY_RETRY_MS,
          retries,
          requestId,
        );
      }
      return;
    }

    if (isUnbufferedSeekError(error)) {
      const reloaded = await loadTrackAtImmediateSeekTarget(track, target, requestId);
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
      (queuedSeekTarget >= 0 &&
        queuedSeekTrackUrn === trackUrn &&
        queuedSeekRequestId > requestId)
    ) {
      return;
    }

    console.warn('[Audio] seek failed, trying recover...', error);
    try {
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
    if (queuedSeekTarget >= 0 && queuedSeekTrackUrn === usePlayerStore.getState().currentTrack?.urn) {
      clearQueuedSeekTimer();
      queuedSeekTimer = setTimeout(() => {
        queuedSeekTimer = null;
        void flushQueuedSeek();
      }, 0);
    }
  }
}

export function seek(seconds: number, allowRecovery = true) {
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;
  const requestId = ++latestSeekRequestId;

  const duration = getDuration();
  const maxSeek = duration > 0 ? Math.max(0, duration - 0.15) : Number.POSITIVE_INFINITY;
  const target = Math.max(0, Math.min(seconds, maxSeek));

  endedGuardUntil = Date.now() + 2200;
  keepSeekGuardAlive(target, 4200);
  hasTrack = true;
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
  notify();
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
  if (isTauriRuntime()) {
    invoke('audio_stop').catch(console.error);
  }
  hasTrack = false;
  waitingForStartupProgress = false;
  startupProgressDeadline = 0;
  cachedTime = 0;
  lastSmoothTime = 0;
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
  await loadTrack(track);
  if (pos > 0) seek(pos, false);
  if (!wasPlaying) invoke('audio_pause').catch(console.error);
}

type TrackMetadataPatch = Partial<Track> & { full_duration?: number };

function getResolvedDurationMs(track: { duration?: number; full_duration?: number }): number | null {
  if (typeof track.full_duration === 'number' && track.full_duration > 0) return track.full_duration;
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
  notify();
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

type StreamAttempt = { format: string; hq: boolean };

function getNetworkStreamAttempts(preferHq: boolean): StreamAttempt[] {
  return preferHq
    ? [
        { format: 'hls_aac_160', hq: true },
        { format: 'http_mp3_128', hq: false },
        { format: 'hls_mp3_128', hq: false },
        { format: 'hls_opus_64', hq: false },
      ]
    : [
        { format: 'http_mp3_128', hq: false },
        { format: 'hls_aac_160', hq: true },
        { format: 'hls_mp3_128', hq: false },
        { format: 'hls_opus_64', hq: false },
      ];
}

function syncNativeAudioRuntime() {
  if (!isTauriRuntime()) return;

  const { eqEnabled, eqGains, normalizeVolume } = useSettingsStore.getState();
  invoke('audio_set_eq', { enabled: eqEnabled, gains: eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: normalizeVolume }).catch(console.error);
  invoke('audio_set_volume', { volume: usePlayerStore.getState().volume }).catch(console.error);

  const playerState = usePlayerStore.getState();
  invoke('audio_set_playback_rate', { playbackRate: playerState.playbackRate }).catch(console.error);
  invoke('audio_set_pitch', {
    pitchSemitones: getEffectivePitchSemitones(
      playerState.playbackRate,
      playerState.pitchControlMode,
      playerState.pitchSemitones,
    ),
  }).catch(console.error);
}

async function loadTrackAtImmediateSeekTarget(
  track: Track,
  target: number,
  requestId: number,
): Promise<boolean> {
  if (!isTauriRuntime() || !isActiveSeekRequest(track.urn, requestId)) {
    return false;
  }

  suppressStallDetection(5000);
  const gen = ++loadGen;
  currentUrn = track.urn;
  fallbackDuration = track.duration / 1000;
  if (fallbackDuration > 0) {
    cachedDuration = fallbackDuration;
  }
  cachedTime = target;
  lastSmoothTime = target;
  waitingForStartupProgress = true;
  startupProgressDeadline = Date.now() + 8000;
  seekTargetTime = target;
  seekPendingUntil = Math.max(seekPendingUntil, Date.now() + 5200);
  clearBufferedSeekPauseState();
  usePlayerStore.setState({ downloadProgress: 0 });
  notify();

  setupTauriBindings();
  syncNativeAudioRuntime();

  try {
    await invoke('audio_begin_stream_reload');
    const result = await invoke<AudioLoadInvokeResult>('audio_load_url', {
      url: streamUrl(track.urn, 'http_mp3_128', false),
      sessionId: getSessionId(),
      cachePath: null,
      cacheKey: null,
      crossfadeSecs: null,
      expectedDurationSecs: track.duration > 0 ? track.duration / 1000 : null,
      rangeSeekTargetSecs: target,
    });

    if (gen !== loadGen || !isActiveSeekRequest(track.urn, requestId)) {
      return false;
    }

    const resolvedQuality =
      result.stream_quality === 'hq' || result.stream_quality === 'lq'
        ? result.stream_quality
        : 'lq';
    const resolvedCodec =
      inferCodecFromContentType(result.stream_content_type) ||
      inferCodecFromFormat('http_mp3_128') ||
      'MP3';

    usePlayerStore.getState().setCurrentTrackStreamQuality(resolvedQuality);
    usePlayerStore.getState().setCurrentTrackStreamCodec(resolvedCodec);
    hasTrack = true;
    lastTickAt = Date.now();

    if (!usePlayerStore.getState().isPlaying) {
      invoke('audio_pause').catch(console.error);
    }

    updatePlaybackState(usePlayerStore.getState().isPlaying);
    updateMediaPosition();
    return true;
  } catch (error) {
    if (gen === loadGen) {
      waitingForStartupProgress = false;
      startupProgressDeadline = 0;
    }
    console.warn('[Audio] Immediate ranged seek reload failed', error);
    return false;
  }
}

async function loadTrack(track: Track, skipStop = false) {
  suppressStallDetection(4500);
  const gen = ++loadGen;
  if (!skipStop) stopTrack();
  currentUrn = track.urn;
  const urn = track.urn;

  void hydrateTrackMetadata(track, gen);

  fallbackDuration = track.duration / 1000;
  cachedDuration = fallbackDuration;
  cachedTime = 0;
  lastSmoothTime = 0;
  waitingForStartupProgress = true;
  startupProgressDeadline = Date.now() + 8000;
  seekTargetTime = -1;
  seekPendingUntil = 0;
  clearBufferedSeekPauseState();
  usePlayerStore.setState({ downloadProgress: null });
  usePlayerStore.getState().setCurrentTrackStreamQuality(undefined);
  usePlayerStore.getState().setCurrentTrackStreamCodec(undefined);
  notify();

  if (!isTauriRuntime()) {
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

  // Try cached file first
  const cachedPath = await getCacheFilePath(urn);
  if (gen !== loadGen) return;

  const settings = useSettingsStore.getState();
  const crossfadeSecs = settings.crossfadeEnabled ? settings.crossfadeDuration : null;
  const cacheTargetPath = await getCacheTargetPath(urn);

  const loadFromNetworkWithFallback = async () => {
    usePlayerStore.setState({ downloadProgress: 0 });
    const attempts = getNetworkStreamAttempts(useSettingsStore.getState().highQualityStreaming);

    let lastError: unknown = null;
    for (const attempt of attempts) {
      const qualityLabel = attempt.hq ? 'hq' : 'lq';
      const url = streamUrl(urn, attempt.format, attempt.hq);
      console.log(`[Audio] Stream attempt: quality=${qualityLabel}, format=${attempt.format}`);
      try {
        const result = await invoke<AudioLoadInvokeResult>('audio_load_url', {
          url,
          sessionId: getSessionId(),
          cachePath: cacheTargetPath,
          cacheKey: urn,
          crossfadeSecs,
          expectedDurationSecs: track.duration > 0 ? track.duration / 1000 : null,
        });
        const streamCodec =
          inferCodecFromContentType(result.stream_content_type) ||
          inferCodecFromFormat(attempt.format) ||
          undefined;
        console.log(
          `[Audio] Stream loaded: requested=${attempt.format}, pref=${qualityLabel}, resolved=${result.stream_quality || 'unknown'}, codec=${streamCodec || 'unknown'}, mime=${result.stream_content_type || 'unknown'}`,
        );
        return { ...result, stream_codec: streamCodec };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Audio] Stream attempt failed: quality=${qualityLabel}, format=${attempt.format}, error=${message}`,
        );
      }
    }

    throw lastError || new Error('All stream attempts failed');
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
          path: cachedPath,
          cacheKey: urn,
          crossfadeSecs,
        });
        loadedFromCache = true;
      } catch (cacheError) {
        console.warn('[Audio] Cached file failed to decode, retrying from network...', cacheError);
        await removeCachedTrack(urn);
        result = await loadFromNetworkWithFallback();
      }
    } else {
      result = await loadFromNetworkWithFallback();
    }

    const resolvedQuality =
      result.stream_quality === 'hq' || result.stream_quality === 'lq'
        ? result.stream_quality
        : loadedFromCache
          ? track.streamQuality || (useSettingsStore.getState().highQualityStreaming ? 'hq' : 'lq')
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
    console.log(
      `[Audio] Active stream: quality=${resolvedQuality}, codec=${resolvedCodec || 'unknown'}, source=${loadedFromCache ? 'cache' : 'network'}, mime=${result.stream_content_type || 'unknown'}`,
    );
  } catch (e) {
    console.error('[Audio] Load failed:', e);
    usePlayerStore.setState({ downloadProgress: null });
    waitingForStartupProgress = false;
    startupProgressDeadline = 0;
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
  isCrossfadingOut = false;
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
          void autoplayRelated(lastTrack);
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
  if (usePlayerStore.getState().downloadProgress !== null) return;

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
      notify();
      return;
    }

    if (waitingForStartupProgress && now < startupProgressDeadline) {
      lastTickAt = now;
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

  listen<number>('audio:tick', (event) => {
    const tickPos = event.payload;

    if (usePlayerStore.getState().downloadProgress !== null && hasTrack) {
      usePlayerStore.setState({ downloadProgress: null });
    }

    // Reject stale ticks from the old position while a queued/native seek is still settling.
    const hasQueuedSeek =
      queuedSeekTarget >= 0 && queuedSeekTrackUrn === usePlayerStore.getState().currentTrack?.urn;
    if ((seekPendingUntil > Date.now() || hasQueuedSeek) && seekTargetTime >= 0) {
      const drift = Math.abs(tickPos - seekTargetTime);
      if (drift > 2.0) {
        // Stale tick from pre-seek position — ignore it
        return;
      }
      // Tick is close to target — seek has landed, clear the guard
      seekPendingUntil = 0;
      seekTargetTime = -1;
    }

    cachedTime = tickPos;
    lastTickAt = Date.now();
    if (tickPos > 0.05) {
      waitingForStartupProgress = false;
    }
    if (cachedDuration <= 0) cachedDuration = fallbackDuration;
    notify();

    const settings = useSettingsStore.getState();
    if (settings.crossfadeEnabled && cachedDuration > 0) {
      const remaining = cachedDuration - cachedTime;
      if (remaining <= settings.crossfadeDuration && remaining > 0 && !isCrossfadingOut) {
        isCrossfadingOut = true;
        crossfadeInProgress = true;
        handleTrackEnd();
      }
    }
  });

  listen('audio:ended', () => {
    clearBufferedSeekPauseState();
    const nearTrackEnd =
      cachedDuration > 0 && cachedTime >= Math.max(0, cachedDuration - 1.2);
    if (Date.now() < endedGuardUntil && !nearTrackEnd) {
      console.warn('[Audio] Ignoring spurious ended event during seek transition');
      return;
    }
    hasTrack = false;
    waitingForStartupProgress = false;
    handleTrackEnd();
  });

  listen('audio:device-reconnected', () => {
    console.log('[Audio] Device reconnected (BT profile switch?), reloading track...');
    void reloadCurrentTrack();
  });

  listen<{ gen: number; progress: number }>('audio:download_progress', (event) => {
    const { progress: p } = event.payload;
    if (usePlayerStore.getState().downloadProgress === null) return;
    if (p < 0) {
      usePlayerStore.setState({ downloadProgress: 0.05 });
    } else {
      usePlayerStore.setState({ downloadProgress: p });
    }
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
    const { isPlaying } = usePlayerStore.getState();
    if (!isPlaying) return;
    const now = Date.now();
    if (now < stallCooldownUntil || now < resumeGuardUntil || now < stallSuppressedUntil) return;
    if (usePlayerStore.getState().downloadProgress !== null) return;
    const elapsed = now - lastTickAt;
    if (elapsed > STALL_THRESHOLD_MS) {
      void recoverFromStall(elapsed);
    }
  }, 1000);

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

  if (trackChanged) {
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
});

/* ── EQ settings subscriber ──────────────────────────────────── */

useSettingsStore.subscribe((state, prev) => {
  if (!isTauriRuntime()) return;
  if (state.eqEnabled !== prev.eqEnabled || state.eqGains !== prev.eqGains) {
    invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  }
  if (state.normalizeVolume !== prev.normalizeVolume) {
    invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
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
    await autoplayRelated(track);
    return;
  }

  usePlayerStore.getState().pause();
}

async function continueSoundWaveQueue(lastTrack: Track) {
  const sw = useSoundWaveStore.getState();
  const before = usePlayerStore.getState();

  try {
    console.log('[SoundWave] Queue exhausted, generating next batch...');
    const batch = await sw.generateBatch();

    if (batch.length > 0) {
      usePlayerStore.getState().addToQueue(batch);
      const after = usePlayerStore.getState();
      if (after.queue.length > before.queue.length && after.queueIndex < after.queue.length - 1) {
        currentUrn = null;
        after.next();
        return;
      }
      console.warn('[SoundWave] Generated batch contained no fresh queue additions');
    } else {
      console.warn('[SoundWave] Queue refill returned no tracks');
    }
  } catch (error) {
    console.error('[SoundWave] Queue refill failed', error);
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
const MAX_CONCURRENT_PRELOADS = 1;
const PRELOAD_LOOKAHEAD_TRACKS = 3;
const HOVER_PRELOAD_DWELL_MS = 180;
const HOVER_PRELOAD_PUMP_DELAY_MS = 220;
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
    }
  }
  schedulePreloadPump(420);
}
