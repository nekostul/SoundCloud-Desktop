import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLAYBACK_SPEED_PRESET_RATES,
  type PlaybackSpeedPreset,
  usePlayerStore,
} from '../../stores/player';

const PRESET_ORDER: PlaybackSpeedPreset[] = ['slowed', 'default', 'sped_up'];

function presetLabel(preset: PlaybackSpeedPreset) {
  switch (preset) {
    case 'slowed':
      return 'Slowed';
    case 'sped_up':
      return 'Sped Up';
    default:
      return 'Default Speed';
  }
}

function presetCaption(rate: number) {
  return `${rate.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}x`;
}

interface PlaybackSpeedPresetsProps {
  variant?: 'panel' | 'compact';
}

export const PlaybackSpeedPresets = React.memo(function PlaybackSpeedPresets({
  variant = 'panel',
}: PlaybackSpeedPresetsProps) {
  const { t } = useTranslation();
  const activePreset = usePlayerStore((s) => s.playbackSpeedPreset);
  const setPlaybackSpeedPreset = usePlayerStore((s) => s.setPlaybackSpeedPreset);
  const isCompact = variant === 'compact';

  return (
    <div className={isCompact ? 'w-full max-w-[320px]' : 'rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-3 py-2.5'}>
      {!isCompact && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/38">
              {t('player.playbackSpeed', 'Playback speed')}
            </p>
            <p className="pt-1 text-[10px] text-white/32">
              {t(
                'player.playbackSpeedPresetHint',
                'Speed stays active between tracks and after restart.',
              )}
            </p>
          </div>
        </div>
      )}

      <div className={`grid grid-cols-3 gap-2 ${isCompact ? '' : ''}`}>
        {PRESET_ORDER.map((preset) => {
          const active = activePreset === preset;
          const rate = PLAYBACK_SPEED_PRESET_RATES[preset];

          return (
            <button
              key={preset}
              type="button"
              onClick={() => setPlaybackSpeedPreset(preset)}
              className={`flex flex-col items-center justify-center rounded-2xl border w-[90px] py-2.5 text-center transition-all duration-200 ${
                active
                  ? 'border-accent/35 bg-accent/18 text-white shadow-[0_0_24px_var(--color-accent-glow)]'
                  : 'border-white/[0.08] bg-white/[0.03] text-white/55 hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-white/82'
              } ${isCompact ? 'min-h-[64px]' : 'min-h-[72px]'}`}
            >
              <div className="text-[11px] font-semibold leading-tight">{presetLabel(preset)}</div>
              <div className={`pt-1 text-[10px] ${active ? 'text-white/72' : 'text-white/34'}`}>
                {presetCaption(rate)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
