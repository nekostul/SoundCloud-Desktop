import { getCurrentWindow } from '@tauri-apps/api/window';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Disc3, Fullscreen, Minus, Square, X } from '../../lib/icons';
import { toggleWindowFullscreen } from '../../lib/window';

export const Titlebar = React.memo(() => {
  const { t } = useTranslation();
  const minimize = () => getCurrentWindow().minimize();
  const toggleMaximize = () => getCurrentWindow().toggleMaximize();
  const toggleFullscreen = () => void toggleWindowFullscreen();
  const close = () => getCurrentWindow().close();

  return (
    <div className="relative z-50 h-10 shrink-0 select-none border-b border-white/[0] px-4 flex items-center">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0" data-tauri-drag-region>
          <Disc3 size={14} className="text-accent" strokeWidth={2} />
          <span className="text-[11px] font-semibold tracking-tight text-white/30">SoundCloud</span>
        </div>
      </div>

      <div className="flex-1 h-full mx-3" data-tauri-drag-region />

      <div className="flex items-center">
        <button
          type="button"
          title={t('kb.fullscreen')}
          aria-label={t('kb.fullscreen')}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={toggleFullscreen}
        >
          <Fullscreen size={12} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={minimize}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={toggleMaximize}
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150 cursor-pointer"
          onClick={close}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
});
