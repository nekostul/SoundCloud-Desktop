import { useEffect, useState } from 'react';

export function useMountFrameGate(enabled: boolean, frames = 2) {
  const [ready, setReady] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setReady(true);
      return;
    }

    let cancelled = false;
    const rafIds: number[] = [];

    const schedule = (remaining: number) => {
      const rafId = window.requestAnimationFrame(() => {
        if (cancelled) return;
        if (remaining <= 1) {
          setReady(true);
          return;
        }
        schedule(remaining - 1);
      });
      rafIds.push(rafId);
    };

    schedule(Math.max(1, frames));

    return () => {
      cancelled = true;
      for (const rafId of rafIds) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled, frames]);

  return ready;
}
