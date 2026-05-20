import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getCurrentTime,
  getDuration,
  subscribe,
} from '../../../lib/audio';
import { art, dur } from '../../../lib/formatters';
import { playBlack14 } from '../../../lib/icons';
import { usePlayerStore } from '../../../stores/player';
import type { Track } from '../../../stores/player';
import {
  toContextMenuUserEntity,
  useContextMenuTarget,
} from '../../context-menu/context-menu-registry';

function formatMMSS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function uniqueCoverSources(values: Array<string | null | undefined>): string[] {
  return values.filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
  );
}

function buildCoverSources(url: string | null | undefined): string[] {
  if (!url) return [];
  return uniqueCoverSources([
    url,
    art(url, 't500x500'),
    art(url, 't300x300'),
    art(url, 't200x200'),
    art(url, 't120x120'),
  ]);
}

/** Elapsed / total time readout. DOM-ref updates — zero React re-renders. */
const CurrentTimeDisplay = React.memo(function CurrentTimeDisplay() {
  const tRef = useRef<HTMLSpanElement>(null);
  const dRef = useRef<HTMLSpanElement>(null);
  const lastCurrentSecondRef = useRef<number | null>(null);
  const lastDurationSecondRef = useRef<number | null>(null);

  useEffect(() => {
    const paint = () => {
      const currentSecond = Math.floor(getCurrentTime());
      const durationSecond = Math.floor(getDuration());
      if (tRef.current && lastCurrentSecondRef.current !== currentSecond) {
        lastCurrentSecondRef.current = currentSecond;
        tRef.current.textContent = formatMMSS(currentSecond);
      }
      if (dRef.current && lastDurationSecondRef.current !== durationSecond) {
        lastDurationSecondRef.current = durationSecond;
        dRef.current.textContent = formatMMSS(durationSecond);
      }
    };

    paint();
    return subscribe(paint);
  }, []);

  return (
    <span className="text-[11px] tabular-nums text-white/50 shrink-0 font-medium">
      <span ref={tRef} style={{ color: 'var(--color-accent)' }}>
        0:00
      </span>
      <span className="text-white/25 mx-1">/</span>
      <span ref={dRef}>0:00</span>
    </span>
  );
});

interface Props {
  track: Track;
  queue: Track[];
  isCurrent: boolean;
}

/** Cover + title/artist row rendered above the waveform. */
export const WaveTrackHeader = React.memo(
  function WaveTrackHeader({ track, queue, isCurrent }: Props) {
    const navigate = useNavigate();
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const previousCoverClearTimeoutRef = useRef<number | null>(null);
    const lastResolvedCoverRef = useRef<string | null>(null);
    const coverImgRef = useRef<HTMLImageElement | null>(null);
    const trackContextProps = useContextMenuTarget(
      useMemo(
        () => ({
          type: 'track' as const,
          track,
          queue,
        }),
        [queue, track],
      ),
    );
    const artistContextProps = useContextMenuTarget(
      useMemo(() => {
        const user = toContextMenuUserEntity(track.user);
        return user ? { type: 'user' as const, user } : null;
      }, [track.user]),
    );
    const coverSources = useMemo(
      () =>
        uniqueCoverSources([
          ...buildCoverSources(track.artwork_url),
          ...buildCoverSources(track.user.avatar_url),
        ]),
      [track.artwork_url, track.user.avatar_url],
    );
    const coverSourcesKey = useMemo(() => coverSources.join('|'), [coverSources]);
    const [coverIndex, setCoverIndex] = useState(0);
    const [coverLoaded, setCoverLoaded] = useState(false);
    const [previousCover, setPreviousCover] = useState<string | null>(null);
    const [previousCoverVisible, setPreviousCoverVisible] = useState(false);
    const isThisPlaying = isCurrent && isPlaying;

    useLayoutEffect(() => {
      if (previousCoverClearTimeoutRef.current !== null) {
        window.clearTimeout(previousCoverClearTimeoutRef.current);
        previousCoverClearTimeoutRef.current = null;
      }
      const nextCover = coverSources[0] ?? null;
      const previousResolvedCover = lastResolvedCoverRef.current;
      const shouldCrossfade = Boolean(
        previousResolvedCover && nextCover && previousResolvedCover !== nextCover,
      );

      setPreviousCover(shouldCrossfade ? previousResolvedCover : null);
      setPreviousCoverVisible(shouldCrossfade);
      setCoverIndex(0);
      setCoverLoaded(Boolean(nextCover && previousResolvedCover === nextCover));
    }, [coverSources, track.urn]);

    useEffect(() => {
      return () => {
        if (previousCoverClearTimeoutRef.current !== null) {
          window.clearTimeout(previousCoverClearTimeoutRef.current);
        }
      };
    }, []);

    const cover = coverSources[coverIndex] ?? null;
    const handleCoverLoad = useMemo(
      () => () => {
        if (!cover) return;

        lastResolvedCoverRef.current = cover;
        setCoverLoaded(true);
        if (previousCover) {
          requestAnimationFrame(() => {
            setPreviousCoverVisible(false);
          });
          previousCoverClearTimeoutRef.current = window.setTimeout(() => {
            setPreviousCover(null);
            previousCoverClearTimeoutRef.current = null;
          }, 420);
        }
      },
      [cover, previousCover],
    );

    useEffect(() => {
      const image = coverImgRef.current;
      if (!image || !cover) return;

      if (image.complete && image.naturalWidth > 0) {
        handleCoverLoad();
      }
    }, [cover, handleCoverLoad, track.urn]);

    const handleCoverError = () => {
      setCoverLoaded(false);
      setCoverIndex((current) => (current + 1 < coverSources.length ? current + 1 : current));
    };

    return (
      <div {...trackContextProps} className="flex items-center gap-3 min-w-0">
        <div className="relative block w-14 h-14 rounded-xl overflow-hidden shrink-0 ring-1 ring-white/[0.12] shadow-lg">
          <div className="absolute inset-0 bg-white/[0.04]" />
          {previousCover ? (
            <img
              key={`${track.urn}-previous-${previousCover}`}
              src={previousCover}
              alt=""
              className={`absolute inset-0 block w-full h-full object-cover transition-opacity duration-[420ms] ease-[var(--ease-apple)] ${
                previousCoverVisible ? 'opacity-100' : 'opacity-0'
              }`}
              decoding="async"
              draggable={false}
            />
          ) : null}
          {cover ? (
            <img
              key={`${track.urn}-${coverSourcesKey}-${coverIndex}`}
              ref={coverImgRef}
              src={cover}
              alt={track.title}
              onLoad={handleCoverLoad}
              onError={handleCoverError}
              className={`absolute inset-0 block w-full h-full object-cover transition-opacity duration-[420ms] ease-[var(--ease-apple)] ${
                coverLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              decoding="async"
              loading="eager"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 bg-white/[0.04]" />
          )}
          <span
            className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${
              isThisPlaying ? 'bg-black/35' : 'bg-black/0'
            }`}
          >
            <span
              className={`w-9 h-9 rounded-full bg-white flex items-center justify-center shadow-lg transition-transform duration-200 ${
                'scale-0 opacity-0'
              }`}
            >
              {playBlack14}
            </span>
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p
            className="text-[15px] font-semibold text-white/95 truncate leading-tight cursor-pointer hover:text-white transition-colors"
            onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          >
            {track.title}
          </p>
          <p
            {...artistContextProps}
            className="text-[12px] text-white/50 truncate mt-0.5 cursor-pointer hover:text-white/80 transition-colors"
            onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
          >
            {track.user.username}
          </p>
        </div>

        {isCurrent ? (
          <CurrentTimeDisplay />
        ) : (
          <span className="text-[11px] tabular-nums text-white/35 shrink-0">
            {dur(track.duration)}
          </span>
        )}
      </div>
    );
  },
  (prev, next) => prev.track.urn === next.track.urn && prev.isCurrent === next.isCurrent,
);
