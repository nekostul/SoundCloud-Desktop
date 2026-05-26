import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from '../../../lib/icons';
import type { LyricsSource } from '../../../lib/lyrics';
import { SOURCE_LABELS } from './sourceLabels';

export const LyricsSearchModal = React.memo(
  ({
    isOpen,
    onClose,
    initialArtist = '',
    initialTitle = '',
    onSearch,
    isSearching = false,
    resultState = 'idle',
    resultSource = null,
  }: {
    isOpen: boolean;
    onClose: () => void;
    initialArtist?: string;
    initialTitle?: string;
    onSearch: (artist: string, title: string) => void;
    isSearching?: boolean;
    resultState?: 'idle' | 'loading' | 'found' | 'not_found';
    resultSource?: LyricsSource | null;
  }) => {
    const [artist, setArtist] = useState(initialArtist);
    const [title, setTitle] = useState(initialTitle);
    const { t } = useTranslation();

    useEffect(() => {
      if (isOpen) {
        setArtist(initialArtist);
        setTitle(initialTitle);
      }
    }, [isOpen, initialArtist, initialTitle]);

    if (!isOpen) return null;

    return typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-xl transition-opacity duration-300"
            onClick={onClose}
          >
            <div
              role="dialog"
              aria-modal="true"
              className="relative w-[min(560px,calc(100vw-3rem))] rounded-[28px] border border-white/10 bg-[#101012]/98 p-8 shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-zoom-in"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={onClose}
                className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/50 transition-all hover:bg-white/20 hover:text-white/80 outline-none"
              >
                <X size={20} />
              </button>

              <h2 className="mb-6 text-[18px] font-bold text-white/92">
                {t('track.manualSearch', 'Manual Search')}
              </h2>

              <div className="mb-5 rounded-[18px] border border-white/[0.08] bg-white/[0.04] px-4 py-3 backdrop-blur-md">
                {resultState === 'loading' ? (
                  <div className="flex items-center gap-2 text-[13px] text-white/62">
                    <Loader2 size={14} className="animate-spin" />
                    <span>{t('track.lyricsSearchLoading')}</span>
                  </div>
                ) : resultState === 'found' ? (
                  <div className="flex items-center gap-2 text-[13px] text-white/72">
                    <span className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-white/50">
                      {resultSource ? SOURCE_LABELS[resultSource] : t('track.lyrics')}
                    </span>
                    <span>{t('track.lyricsSearchFound')}</span>
                  </div>
                ) : resultState === 'not_found' ? (
                  <div className="text-[13px] text-white/46">{t('track.lyricsSearchNotFound')}</div>
                ) : (
                  <div className="text-[13px] text-white/38">{t('track.lyricsSearchIdle')}</div>
                )}
              </div>

              <div className="space-y-3 mb-6">
                <input
                  type="text"
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder={t('track.artist', 'Artist')}
                  className="w-full bg-white/10 px-4 py-3 rounded-[14px] text-white text-[14px] outline-none border border-white/10 focus:border-white/30 placeholder:text-white/30 transition-colors"
                  autoFocus
                />
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('track.title', 'Title')}
                  className="w-full bg-white/10 px-4 py-3 rounded-[14px] text-white text-[14px] outline-none border border-white/10 focus:border-white/30 placeholder:text-white/30 transition-colors"
                />
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-full text-[13px] font-medium text-white/50 hover:text-white hover:bg-white/10 transition-colors outline-none"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => onSearch(artist, title)}
                  disabled={isSearching || !artist.trim() || !title.trim()}
                  className="px-6 py-2.5 rounded-full text-[13px] font-bold bg-white/20 hover:bg-white/30 text-white transition-colors outline-none disabled:cursor-default disabled:opacity-45"
                >
                  {t('track.search', 'Search')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;
  },
);
