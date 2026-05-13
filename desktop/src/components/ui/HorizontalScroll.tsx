import { type ReactNode, useEffect, useRef } from 'react';

interface HorizontalScrollProps {
  children: ReactNode;
  className?: string;
}

export function HorizontalScroll({ children, className = '' }: HorizontalScrollProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      if (maxScrollLeft <= 0) return;

      const movingRight = e.deltaY > 0;
      const atLeftEdge = el.scrollLeft <= 0;
      const atRightEdge = el.scrollLeft >= maxScrollLeft - 1;

      if ((movingRight && atRightEdge) || (!movingRight && atLeftEdge)) {
        return;
      }

      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div ref={ref} className={`flex gap-4 overflow-x-auto pb-2 scrollbar-hide ${className}`}>
      {children}
    </div>
  );
}
