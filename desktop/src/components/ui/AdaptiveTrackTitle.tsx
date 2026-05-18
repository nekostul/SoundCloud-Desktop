import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

type AdaptiveTrackTitleProps = Omit<React.ComponentPropsWithoutRef<'p'>, 'children'> & {
  text: string;
  baseSize: number;
  minSize: number;
  maxAdaptiveCharacters?: number;
  step?: number;
};

function formatFontSize(size: number): string {
  return `${size.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}px`;
}

function setAdaptiveFontSize(element: HTMLElement, size: number) {
  element.style.setProperty('font-size', formatFontSize(size), 'important');
}

export const AdaptiveTrackTitle = React.memo(function AdaptiveTrackTitle({
  text,
  baseSize,
  minSize,
  maxAdaptiveCharacters = 26,
  step = 0.25,
  title,
  ...props
}: AdaptiveTrackTitleProps) {
  const titleRef = useRef<HTMLParagraphElement | null>(null);

  const applyAdaptiveSize = useCallback(() => {
    const element = titleRef.current;
    if (!element) return;

    let nextSize = baseSize;
    setAdaptiveFontSize(element, baseSize);

    if (Array.from(text).length > maxAdaptiveCharacters || element.clientWidth <= 0) {
      return;
    }

    while (element.scrollWidth - element.clientWidth > 1 && nextSize > minSize) {
      nextSize = Math.max(minSize, Math.round((nextSize - step) * 100) / 100);
      setAdaptiveFontSize(element, nextSize);
    }
  }, [baseSize, maxAdaptiveCharacters, minSize, step, text]);

  useLayoutEffect(() => {
    applyAdaptiveSize();
  }, [applyAdaptiveSize]);

  useEffect(() => {
    const ready = document.fonts?.ready;
    if (!ready) return;

    let cancelled = false;
    void ready.then(() => {
      if (!cancelled) applyAdaptiveSize();
    });

    return () => {
      cancelled = true;
    };
  }, [applyAdaptiveSize]);

  useEffect(() => {
    const container = titleRef.current?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let lastWidth = container.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? container.clientWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      applyAdaptiveSize();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [applyAdaptiveSize]);

  return (
    <p ref={titleRef} title={title ?? text} {...props}>
      {text}
    </p>
  );
});
