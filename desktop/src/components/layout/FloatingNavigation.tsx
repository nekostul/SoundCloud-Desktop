import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from '../../lib/icons';
import { useHeaderState } from '../../stores/header';

export const FloatingNavigation = React.memo(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const compactHeaderVisible = useHeaderState((s) => s.compactHeaderVisible);

  const canGoBack = location.key !== 'default';

  return (
    <div
      className={`absolute top-3 left-3 z-40 flex items-center gap-1.5 pointer-events-auto transition-all duration-300 ${
        compactHeaderVisible ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
      }`}
    >
      <button
        type="button"
        disabled={!canGoBack}
        onClick={() => navigate(-1)}
        className="w-8 h-8 rounded-full backdrop-blur-sm bg-black/20 hover:bg-black/30 border border-white/[0.12] hover:border-white/[0.18] flex items-center justify-center transition-all duration-200 cursor-pointer disabled:opacity-35 disabled:cursor-default text-white/50 hover:text-white/80 disabled:hover:bg-black/20 disabled:hover:border-white/[0.12]"
        aria-label="Go back"
      >
        <ChevronLeft size={16} strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={() => navigate(1)}
        className="w-8 h-8 rounded-full backdrop-blur-sm bg-black/20 hover:bg-black/30 border border-white/[0.12] hover:border-white/[0.18] flex items-center justify-center transition-all duration-200 cursor-pointer text-white/50 hover:text-white/80"
        aria-label="Go forward"
      >
        <ChevronRight size={16} strokeWidth={2} />
      </button>
    </div>
  );
});

FloatingNavigation.displayName = 'FloatingNavigation';
