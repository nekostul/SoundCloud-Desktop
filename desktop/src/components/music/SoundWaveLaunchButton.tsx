import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AudioLines, Loader2 } from '../../lib/icons';
import {
  buildWaveQueueFromPlayerContext,
  createInitialSoundWaveQueue,
  dedupeTracksByUrn,
} from '../../lib/soundwave-queue';
import type { Track } from '../../stores/player';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { CHARACTER_PRESETS, useSoundWaveStore } from '../../stores/soundwave';

type SoundWaveLaunchKind = 'playlist' | 'artist';

interface SoundWaveLaunchButtonProps {
  seedTracks: Track[];
  context: {
    kind: SoundWaveLaunchKind;
    key: string;
    title: string;
    subtitle?: string;
  };
  variant?: 'playlist' | 'hero';
}

function pickDistributedSeeds(tracks: Track[], maxSeeds = 4): Track[] {
  const unique = dedupeTracksByUrn(tracks);
  if (unique.length <= maxSeeds) return unique;

  const picked: Track[] = [];
  const used = new Set<number>();

  for (let index = 0; index < maxSeeds; index += 1) {
    const position =
      maxSeeds === 1 ? 0 : Math.round((index * (unique.length - 1)) / (maxSeeds - 1));
    if (used.has(position)) continue;
    used.add(position);
    picked.push(unique[position]);
  }

  return picked;
}

export function SoundWaveLaunchButton({
  seedTracks,
  context,
  variant = 'playlist',
}: SoundWaveLaunchButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const selectedLanguages = useSettingsStore((s) => s.soundwaveLanguages);
  const mode = useSettingsStore((s) => s.soundwaveMode);
  const hideLiked = useSettingsStore((s) => s.soundwaveHideLiked);
  const startFromQueue = useSoundWaveStore((s) => s.startFromQueue);
  const isWaveActive = useSoundWaveStore((s) => s.isActive);
  const launchContext = useSoundWaveStore((s) => s.launchContext);
  const queueSource = usePlayerStore((s) => s.queueSource);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const [isLoading, setIsLoading] = useState(false);

  const playableSeeds = useMemo(
    () =>
      dedupeTracksByUrn(seedTracks).filter((track) => track?.urn && track.access !== 'blocked'),
    [seedTracks],
  );

  const selectedSeedTracks = useMemo(() => pickDistributedSeeds(playableSeeds), [playableSeeds]);
  const waveSessionPreset =
    mode === 'diverse' ? CHARACTER_PRESETS.discover : CHARACTER_PRESETS.favorite;
  const isCurrentContextWave =
    isWaveActive &&
    queueSource === 'soundwave' &&
    launchContext?.kind === context.kind &&
    launchContext.key === context.key;

  const handleClick = async () => {
    if (isLoading || selectedSeedTracks.length === 0) return;

    if (isCurrentContextWave) {
      if (!isPlaying && currentTrack) {
        usePlayerStore.getState().resume();
      }
      navigate('/');
      return;
    }

    setIsLoading(true);
    try {
      const initialQueue = createInitialSoundWaveQueue(selectedSeedTracks, mode);
      if (initialQueue.length === 0) return;

      await startFromQueue({
        queue: initialQueue,
        seedTracks: selectedSeedTracks,
        preset: waveSessionPreset,
        launchContext: context,
      });

      navigate('/');

      void buildWaveQueueFromPlayerContext({
        languages: selectedLanguages,
        mode,
        hideLiked,
        targetSize: 18,
      }).then((tail) => {
        if (tail.length === 0) return;

        const player = usePlayerStore.getState();
        if (player.queueSource !== 'soundwave') return;

        const existing = new Set(player.queue.map((track) => track.urn));
        const fresh = tail.filter((track) => !existing.has(track.urn));
        if (fresh.length > 0) {
          player.addToQueue(fresh);
        }
      });
    } finally {
      setIsLoading(false);
    }
  };

  const baseClass =
    variant === 'hero'
      ? `inline-flex items-center justify-center gap-2 h-12 px-5 rounded-full text-[13px] font-semibold transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer ${
          isCurrentContextWave
            ? 'bg-[#ffd047]/16 text-[#ffe08a] border border-[#ffd047]/28 hover:bg-[#ffd047]/22'
            : 'bg-white/[0.06] text-white border border-white/[0.08] hover:bg-white/[0.1]'
        }`
      : `inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer ${
          isCurrentContextWave
            ? 'bg-accent/15 text-accent border border-accent/20 shadow-[0_0_20px_rgba(255,85,0,0.1)]'
            : 'glass hover:bg-white/[0.05] text-white/60 hover:text-white/80'
        }`;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading || selectedSeedTracks.length === 0}
      className={`${baseClass} disabled:opacity-40 disabled:cursor-not-allowed`}
      title={context.title}
    >
      {isLoading ? (
        <Loader2 size={variant === 'hero' ? 16 : 15} className="animate-spin" />
      ) : (
        <AudioLines size={variant === 'hero' ? 16 : 15} />
      )}
      {t('visualizer.wave')}
    </button>
  );
}
