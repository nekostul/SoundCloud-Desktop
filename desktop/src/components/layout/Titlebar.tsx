import { getCurrentWindow } from '@tauri-apps/api/window';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc3, Fullscreen, Minus, Search, Square, X } from '../../lib/icons';
import { art } from '../../lib/formatters';
import { useSearchTracks } from '../../lib/hooks';
import { isTauriRuntime } from '../../lib/runtime';
import { toggleWindowFullscreen } from '../../lib/window';
import { type Track, usePlayerStore } from '../../stores/player';

export const Titlebar = React.memo(() => {
  const { t } = useTranslation();
  const minimize = () => getCurrentWindow().minimize();
  const toggleMaximize = () => getCurrentWindow().toggleMaximize();
  const toggleFullscreen = () => void toggleWindowFullscreen();
  const close = () => getCurrentWindow().close();
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const play = usePlayerStore((s) => s.play);

  const activeSearchQuery = isExpanded ? searchQuery.trim() : '';

  const clearFocusTimer = useCallback(() => {
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
  }, []);

  const collapseSearch = useCallback(() => {
    clearFocusTimer();
    setIsExpanded(false);
    setSearchQuery('');
    inputRef.current?.blur();
  }, [clearFocusTimer]);

  useEffect(() => {
    function handleOutside(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (containerRef.current?.contains(target)) return;
      collapseSearch();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        collapseSearch();
      }
    }

    window.addEventListener('pointerdown', handleOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handleOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
      clearFocusTimer();
    };
  }, [clearFocusTimer, collapseSearch]);

  const searchResults = useSearchTracks(activeSearchQuery);
  const filteredTracks = useMemo(() => searchResults.tracks.slice(0, 5), [searchResults.tracks]);

  const handleSearchToggle = useCallback(() => {
    if (isExpanded) {
      collapseSearch();
      return;
    }

    setIsExpanded(true);
    clearFocusTimer();

    focusTimerRef.current = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, [clearFocusTimer, collapseSearch, isExpanded]);

  const handleTrackSelect = useCallback(
    (track: Track) => {
      play(track, searchResults.tracks.length > 0 ? searchResults.tracks : [track]);
      collapseSearch();
    },
    [collapseSearch, play, searchResults.tracks],
  );

  const handleTitlebarPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isTauriRuntime()) return;
      if (!event.isPrimary) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const target = event.target as Element | null;
      if (!target || target.closest('[data-titlebar-interactive="true"]')) return;

      collapseSearch();
      event.preventDefault();
      void getCurrentWindow().startDragging().catch(() => {});
    },
    [collapseSearch],
  );

  return (
    <div
      className="relative z-50 h-10 shrink-0 select-none border-b border-white/[0] px-4 flex items-center"
      onPointerDownCapture={handleTitlebarPointerDownCapture}
    >
      <div className="flex items-center gap-1.5 translate-y-[3px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Disc3 size={14} className="text-accent" strokeWidth={2} />
          <span className="text-[11px] font-semibold tracking-tight text-white/30">SoundCloud Desktop</span>
        </div>
      </div>

      <div className="flex-1 h-full mx-4 flex items-center justify-center relative translate-y-[3px]">
        <div
          ref={containerRef}
          data-titlebar-interactive="true"
          className={`relative flex items-center rounded-full transition-all duration-300 ease-[var(--ease-apple)] overflow-visible ${
            isExpanded
              ? 'w-[280px] max-w-full h-[26px] bg-white/[0.025] border border-white/[0.05] pl-2.5 pr-1.5'
              : 'w-8 h-8 bg-transparent border border-transparent'
          }`}
        >
          <button
            type="button"
            onClick={handleSearchToggle}
            onMouseDown={(e) => e.preventDefault()}
            data-titlebar-interactive="true"
            className={`flex shrink-0 items-center justify-center rounded-full transition-all duration-200 cursor-pointer outline-none shadow-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 ${
              isExpanded
                ? 'text-white/35 hover:text-white/70 w-[22px] h-[22px] mr-1'
                : 'text-white/20 hover:text-white/60 hover:bg-white/[0.04] w-8 h-8'
            }`}
            title={t('kb.search', 'Search')}
            aria-label={t('kb.search', 'Search')}
            aria-expanded={isExpanded}
          >
            <Search size={13} />
          </button>

          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            spellCheck={false}
            autoComplete="off"
            data-titlebar-interactive="true"
            className={`w-full min-w-0 bg-transparent border-none text-[10px] leading-none text-white/92 select-none appearance-none outline-none shadow-none caret-transparent focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder-white/30 transition-all duration-300 ${
              isExpanded ? 'opacity-100 pointer-events-auto' : 'opacity-0 w-0 pointer-events-none'
            }`}
            style={{ outline: 'none' }}
          />

          {isExpanded && searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              onMouseDown={(e) => e.preventDefault()}
              data-titlebar-interactive="true"
              className="text-white/20 hover:text-white/60 p-0.5 ml-1 transition-all rounded-full hover:bg-white/[0.06] cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
              aria-label={t('search.clear', 'Clear search')}
              title={t('search.clear', 'Clear search')}
            >
              <X size={10} />
            </button>
          )}

          {isExpanded && activeSearchQuery !== '' && (
            <div
              className="absolute top-8 left-0 right-0 max-h-[280px] overflow-y-auto bg-[#101115] border border-white/[0.08] rounded-xl p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.6)] backdrop-blur-xl flex flex-col z-[100] animate-in fade-in slide-in-from-top-1 duration-150"
              data-titlebar-interactive="true"
            >
              <div className="text-[9px] font-semibold text-white/30 px-2 py-1 tracking-wider uppercase">
                Search Results ({filteredTracks.length})
              </div>

              {searchResults.isLoading ? (
                <div className="text-[11px] text-white/40 px-2.5 py-3 text-center">
                  {t('search.searching', 'Searching...')}
                </div>
              ) : filteredTracks.length === 0 ? (
                <div className="text-[11px] text-white/40 px-2.5 py-3 text-center">
                  No tracks found for &quot;{activeSearchQuery}&quot;
                </div>
              ) : (
                filteredTracks.map((track) => (
                  <button
                    key={track.urn}
                    type="button"
                    onClick={() => handleTrackSelect(track)}
                    onMouseDown={(e) => e.preventDefault()}
                    data-titlebar-interactive="true"
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] active:bg-white/[0.08] transition-all text-left text-white/90 group cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
                  >
                    <div className="relative w-7 h-7 rounded overflow-hidden flex-none bg-white/[0.04] border border-white/[0.06]">
                      {track.artwork_url ? (
                        <img
                          src={art(track.artwork_url, 't120x120') || ''}
                          alt={track.title}
                          className="w-full h-full object-cover transition-transform group-hover:scale-105"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-white/[0.02]">
                          <Search size={10} className="text-white/20" />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-white/95 truncate group-hover:text-accent transition-colors">
                        {track.title}
                      </div>
                      <div className="text-[9px] text-white/40 truncate">
                        {track.user?.username || 'Unknown Artist'}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center translate-y-[3px]">
        <button
          type="button"
          title={t('kb.fullscreen')}
          aria-label={t('kb.fullscreen')}
          onMouseDown={(e) => e.preventDefault()}
          data-titlebar-interactive="true"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
          onClick={toggleFullscreen}
        >
          <Fullscreen size={12} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          data-titlebar-interactive="true"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
          onClick={minimize}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          data-titlebar-interactive="true"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
          onClick={toggleMaximize}
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          data-titlebar-interactive="true"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150 cursor-pointer outline-none focus:outline-none focus-visible:outline-none"
          onClick={close}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
});
