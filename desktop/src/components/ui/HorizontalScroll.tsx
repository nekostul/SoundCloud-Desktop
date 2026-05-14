import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

interface HorizontalScrollProps {
  children: ReactNode;
  className?: string;
}

export function HorizontalScroll({
  children,
  className = '',
}: HorizontalScrollProps) {
  const ref = useRef<HTMLDivElement>(null);

  const scrollLeft = () => {
    ref.current?.scrollBy({
      left: -600,
      behavior: 'smooth',
    });
  };

  const scrollRight = () => {
    ref.current?.scrollBy({
      left: 600,
      behavior: 'smooth',
    });
  };

  return (
    <div className="relative">
      <div className="absolute right-0 -top-12 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={scrollLeft}
          className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.05] flex items-center justify-center text-white/60 hover:text-white/90 transition-all duration-200"
        >
          <ChevronLeft size={16} />
        </button>

        <button
          type="button"
          onClick={scrollRight}
          className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.05] flex items-center justify-center text-white/60 hover:text-white/90 transition-all duration-200"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div
        ref={ref}
        className={`flex gap-4 overflow-x-auto scroll-smooth scrollbar-hide pb-2 ${className}`}
      >
        {children}
      </div>
    </div>
  );
}