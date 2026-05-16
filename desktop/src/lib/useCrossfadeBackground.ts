import { useEffect, useRef, useState } from 'react';

export const ARTWORK_CROSSFADE_MS = 5000;

export function useCrossfadeBackground(targetValue: string, durationMs = 420) {
  const [baseValue, setBaseValue] = useState(targetValue);
  const [overlayValue, setOverlayValue] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const commitTimeoutRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (targetValue === baseValue) return;

    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = null;
    }

    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    setOverlayValue(targetValue);
    setOverlayVisible(false);

    rafRef.current = window.requestAnimationFrame(() => {
      setOverlayVisible(true);
      commitTimeoutRef.current = window.setTimeout(() => {
        setBaseValue(targetValue);

        rafRef.current = window.requestAnimationFrame(() => {
          setOverlayVisible(false);
          setOverlayValue(null);
          rafRef.current = null;
        });

        commitTimeoutRef.current = null;
      }, durationMs);
    });

    return () => {
      if (commitTimeoutRef.current !== null) {
        window.clearTimeout(commitTimeoutRef.current);
        commitTimeoutRef.current = null;
      }

      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [baseValue, durationMs, targetValue]);

  return { baseValue, overlayValue, overlayVisible };
}
