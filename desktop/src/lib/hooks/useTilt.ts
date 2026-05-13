import { useCallback, useEffect, useRef } from 'react';

export function useTilt() {
  const ref = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const enabledRef = useRef<boolean>(true);

  const resetTilt = useCallback((animated: boolean) => {
    const el = ref.current;
    if (!el) return;

    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    rectRef.current = null;
    el.style.transition = animated
      ? 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)'
      : 'none';
    el.style.transform = 'perspective(500px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    el.style.willChange = 'auto';
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    enabledRef.current =
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return () => {
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const flushFrame = useCallback(() => {
    frameRef.current = null;
    const el = ref.current;
    const rect = rectRef.current;
    if (!el || !rect) return;

    const x = pointRef.current.x - rect.left;
    const y = pointRef.current.y - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    if (centerX <= 0 || centerY <= 0) return;

    const rotateX = ((y - centerY) / centerY) * -12;
    const rotateY = ((x - centerX) / centerX) * 12;

    el.style.transition = 'none';
    el.style.transform =
      `perspective(500px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) ` +
      'scale3d(1.03, 1.03, 1.03)';
  }, []);

  const ensureMeasured = useCallback(() => {
    const el = ref.current;
    if (!el) return null;

    if (!rectRef.current) {
      rectRef.current = el.getBoundingClientRect();
    }

    return el;
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!enabledRef.current) return;
    const el = ref.current;
    if (!el) return;
    rectRef.current = el.getBoundingClientRect();
    el.style.willChange = 'transform';
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!enabledRef.current) return;
    if (e.buttons !== 0) {
      resetTilt(false);
      return;
    }
    if (!ensureMeasured()) return;

    pointRef.current.x = e.clientX;
    pointRef.current.y = e.clientY;

    if (frameRef.current == null) {
      frameRef.current = window.requestAnimationFrame(flushFrame);
    }
  }, [ensureMeasured, flushFrame, resetTilt]);

  const handleMouseLeave = useCallback(() => {
    if (!enabledRef.current || !ref.current) return;
    resetTilt(true);
  }, [resetTilt]);

  return {
    ref,
    onMouseEnter: handleMouseEnter,
    onMouseMove: handleMouseMove,
    onMouseLeave: handleMouseLeave,
  };
}
