import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Compass } from '../../../lib/icons';
import { useSettingsStore } from '../../../stores/settings';

/**
 * Two-state toggle "Похожее / Разное" для SoundWave. Один клик = одно
 * изменение store. Без слайдеров, без дебаунсов, без ре-рендеров во время драга.
 */
export const ModeToggle = React.memo(function ModeToggle() {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.soundwaveMode);
  const setMode = useSettingsStore((s) => s.setSoundwaveMode);

  const isSimilar = mode === 'similar';

  return (
    <div
      className="relative grid grid-cols-2 items-center p-1 rounded-full bg-white/[0.04] border border-white/[0.08] overflow-hidden"
      title={t('soundwave.modeTitle')}
    >
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 rounded-full border border-white/[0.08] bg-white/[0.12] shadow-[0_8px_24px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.08)]"
        style={{
          width: 'calc(50% - 4px)',
          transform: `translateX(${isSimilar ? '0%' : '100%'})`,
          transition:
            'transform 420ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 320ms var(--ease-apple), background-color 320ms var(--ease-apple)',
          willChange: 'transform',
        }}
      />
      <button
        type="button"
        onClick={() => setMode('similar')}
        className="relative z-10 flex items-center justify-center gap-1.5 px-3 h-7 rounded-full text-[11px] font-medium cursor-pointer transition-[color,transform] duration-300 ease-[var(--ease-apple)] hover:text-white/88 active:scale-[0.985]"
        aria-pressed={isSimilar}
        style={{
          color: isSimilar ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)',
        }}
      >
        <AudioLines
          size={11}
          style={{
            color: isSimilar ? 'var(--color-accent)' : 'rgba(255,255,255,0.45)',
            transition: 'color 280ms var(--ease-apple)',
          }}
        />
        <span>{t('soundwave.modeSimilar')}</span>
      </button>
      <button
        type="button"
        onClick={() => setMode('diverse')}
        className="relative z-10 flex items-center justify-center gap-1.5 px-3 h-7 rounded-full text-[11px] font-medium cursor-pointer transition-[color,transform] duration-300 ease-[var(--ease-apple)] hover:text-white/88 active:scale-[0.985]"
        aria-pressed={!isSimilar}
        style={{
          color: !isSimilar ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)',
        }}
      >
        <Compass
          size={11}
          style={{
            color: !isSimilar ? 'var(--color-accent)' : 'rgba(255,255,255,0.45)',
            transition: 'color 280ms var(--ease-apple)',
          }}
        />
        <span>{t('soundwave.modeDiverse')}</span>
      </button>
    </div>
  );
});
