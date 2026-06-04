import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import {
  getSoundWaveVisibleQueueTracks,
  replaceSoundWaveVisibleQueue,
  useSoundWaveStore,
} from '../stores/soundwave';
import { dedupeTracksByUrn } from './soundwave-queue';

function isActiveSoundWaveRadio() {
  const player = usePlayerStore.getState();
  const soundWave = useSoundWaveStore.getState();

  return (
    player.queueSource === 'soundwave' &&
    soundWave.isActive &&
    !soundWave.isSuspended &&
    Boolean(player.currentTrack)
  );
}

function sanitizeTracks(tracks: Track[]) {
  return dedupeTracksByUrn(tracks).filter((track) => !!track?.urn);
}

export function addTracksToQueueWithSoundWavePriority(tracks: Track[]) {
  const incoming = sanitizeTracks(tracks);
  if (incoming.length === 0) return;

  if (!isActiveSoundWaveRadio()) {
    usePlayerStore.getState().addToQueue(incoming);
    return;
  }

  const manualUpcoming = getSoundWaveVisibleQueueTracks();
  replaceSoundWaveVisibleQueue(sanitizeTracks([...manualUpcoming, ...incoming]), 'manual-queue:append');
}

export function addTracksToQueueNextWithSoundWavePriority(tracks: Track[]) {
  const incoming = sanitizeTracks(tracks);
  if (incoming.length === 0) return;

  if (!isActiveSoundWaveRadio()) {
    usePlayerStore.getState().addToQueueNext(incoming);
    return;
  }

  const manualUpcoming = getSoundWaveVisibleQueueTracks();
  replaceSoundWaveVisibleQueue(sanitizeTracks([...incoming, ...manualUpcoming]), 'manual-queue:next');
}

export function clearVisibleQueueWithSoundWavePriority() {
  if (!isActiveSoundWaveRadio()) {
    usePlayerStore.getState().clearQueue();
    return;
  }

  replaceSoundWaveVisibleQueue([], 'manual-queue:clear');
}
