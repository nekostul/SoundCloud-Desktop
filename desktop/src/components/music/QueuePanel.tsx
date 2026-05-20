import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { art, dur } from '../../lib/formatters';
import { GripVertical, pauseTextWhite12, playIcon32, Trash2, X } from '../../lib/icons';
import { usePlayerStore } from '../../stores/player';
import {
  toContextMenuUserEntity,
  useContextMenuTarget,
} from '../context-menu/context-menu-registry';

/* ── Now Playing (single, non-draggable) ─────────────────────────── */
const NowPlayingItem = React.memo(() => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const trackContextProps = useContextMenuTarget(
    React.useMemo(
      () =>
        currentTrack
          ? {
              type: 'track' as const,
              track: currentTrack,
              queue,
              queueIndex: queueIndex >= 0 ? queueIndex : undefined,
            }
          : null,
      [currentTrack, queue, queueIndex],
    ),
  );
  const artistContextProps = useContextMenuTarget(
    React.useMemo(() => {
      const user = currentTrack ? toContextMenuUserEntity(currentTrack.user) : null;
      return user ? { type: 'user' as const, user } : null;
    }, [currentTrack]),
  );

  if (!currentTrack) return null;
  const artwork = art(currentTrack.artwork_url, 't200x200');

  const handleClick = () => {
    const { pause, resume } = usePlayerStore.getState();
    isPlaying ? pause() : resume();
  };

  return (
    <div
      {...trackContextProps}
      className="flex items-center gap-3 px-1 py-2.5 cursor-pointer"
      onClick={handleClick}
    >
      <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 relative bg-white/[0.025] ring-1 ring-white/[0.04]">
        {artwork ? (
          <img src={artwork} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full" />
        )}
        <div className="absolute inset-0 bg-black/42 flex items-center justify-center">
          {isPlaying ? (
            <div className="flex items-center gap-[2px]">
              <div className="w-[2px] h-3 bg-accent rounded-full animate-pulse" />
              <div className="w-[2px] h-2 bg-accent rounded-full animate-pulse [animation-delay:150ms]" />
              <div className="w-[2px] h-3.5 bg-accent rounded-full animate-pulse [animation-delay:300ms]" />
            </div>
          ) : (
            pauseTextWhite12
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-white/88 font-medium truncate leading-snug">
          {currentTrack.title}
        </p>
        <p {...artistContextProps} className="text-[10px] text-white/34 truncate mt-0.5">
          {currentTrack.user.username}
        </p>
      </div>
      <span className="text-[10px] text-white/24 tabular-nums shrink-0">
        {dur(currentTrack.duration)}
      </span>
    </div>
  );
});

const QueueItemRow = React.memo(function QueueItemRow({
  track,
  queue,
  absIdx,
  isCurrent,
  isDragging,
  isOver,
  isPlaying,
  onGripDown,
  onClick,
  onRemove,
}: {
  track: ReturnType<typeof usePlayerStore.getState>['queue'][number];
  queue: ReturnType<typeof usePlayerStore.getState>['queue'];
  absIdx: number;
  isCurrent: boolean;
  isDragging: boolean;
  isOver: boolean;
  isPlaying: boolean;
  onGripDown: (event: React.PointerEvent, absIdx: number) => void;
  onClick: (absIdx: number) => void;
  onRemove: (absIdx: number) => void;
}) {
  const artwork = art(track.artwork_url, 't200x200');
  const trackContextProps = useContextMenuTarget(
    React.useMemo(
      () => ({
        type: 'track' as const,
        track,
        queue,
        queueIndex: absIdx,
      }),
      [absIdx, queue, track],
    ),
  );
  const artistContextProps = useContextMenuTarget(
    React.useMemo(() => {
      const user = toContextMenuUserEntity(track.user);
      return user ? { type: 'user' as const, user } : null;
    }, [track.user]),
  );

  return (
    <div
      {...trackContextProps}
      data-queue-item
      className={`flex items-center gap-3 px-1 py-2.5 rounded-[14px] group transition-all duration-150 select-none ${
        isDragging
          ? 'opacity-40 scale-[0.97]'
          : isCurrent
            ? 'bg-transparent'
            : 'hover:bg-white/[0.012]'
      } ${isOver ? 'border-t-2 border-accent' : ''}`}
    >
      <div
        className="text-white/12 group-hover:text-white/24 hover:!text-white/42 cursor-grab active:cursor-grabbing transition-colors touch-none"
        onPointerDown={(event) => onGripDown(event, absIdx)}
      >
        <GripVertical size={14} />
      </div>

      <div
        className={`w-10 h-10 rounded-xl overflow-hidden shrink-0 relative cursor-pointer ${
          isCurrent ? 'bg-white/[0.03] ring-1 ring-white/[0.06]' : 'bg-white/[0.02] ring-1 ring-white/[0.035]'
        }`}
        onClick={() => onClick(absIdx)}
      >
        {artwork ? (
          <img src={artwork} alt="" className="w-full h-full object-cover" decoding="async" />
        ) : (
          <div className="w-full h-full" />
        )}
        {isCurrent && (
          <div className="absolute inset-0 bg-black/42 flex items-center justify-center">
            {isPlaying ? (
              <div className="flex items-center gap-[2px]">
                <div className="w-[2px] h-3 bg-accent rounded-full animate-pulse" />
                <div className="w-[2px] h-2 bg-accent rounded-full animate-pulse [animation-delay:150ms]" />
                <div className="w-[2px] h-3.5 bg-accent rounded-full animate-pulse [animation-delay:300ms]" />
              </div>
            ) : (
              pauseTextWhite12
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onClick(absIdx)}>
        <p
          className={`text-[12px] truncate leading-snug ${isCurrent ? 'text-white/90 font-medium' : 'text-white/78'}`}
        >
          {track.title}
        </p>
        <p {...artistContextProps} className="text-[10px] text-white/30 truncate mt-0.5">
          {track.user.username}
        </p>
      </div>

      <span className="text-[10px] text-white/22 tabular-nums shrink-0">{dur(track.duration)}</span>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(absIdx);
        }}
        className="w-6 h-6 rounded-md flex items-center justify-center text-white/0 opacity-0 group-hover:opacity-100 group-hover:text-white/18 hover:!text-white/45 hover:!bg-white/[0.05] transition-all duration-150 cursor-pointer shrink-0"
      >
        <X size={12} />
      </button>
    </div>
  );
});

/* ── Draggable queue list ────────────────────────────────────────── */
const DraggableQueue = React.memo(({ startIndex }: { startIndex: number }) => {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const items = queue.slice(startIndex);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dragStartY = useRef(0);
  const dragElRef = useRef<HTMLDivElement | null>(null);

  const handleGripDown = (e: React.PointerEvent, absIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragIdx(absIdx);
    setOverIdx(absIdx);
    dragStartY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragIdx === null || !dragElRef.current) return;
    const container = dragElRef.current;
    const children = container.querySelectorAll('[data-queue-item]');
    const y = e.clientY;

    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (y < mid) {
        setOverIdx(startIndex + i);
        return;
      }
    }
    setOverIdx(startIndex + children.length - 1);
  };

  const handlePointerUp = () => {
    if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      usePlayerStore.getState().moveInQueue(dragIdx, overIdx);
    }
    setDragIdx(null);
    setOverIdx(null);
  };

  const handleClick = (absIdx: number) => {
    const { playFromQueue, pause, resume } = usePlayerStore.getState();
    if (absIdx === queueIndex && isPlaying) pause();
    else if (absIdx === queueIndex) resume();
    else playFromQueue(absIdx);
  };

  const handleRemove = (absIdx: number) => {
    usePlayerStore.getState().removeFromQueue(absIdx);
  };

  return (
    <div
      ref={dragElRef}
      className="flex flex-col gap-0.5"
      onPointerMove={dragIdx !== null ? handlePointerMove : undefined}
      onPointerUp={dragIdx !== null ? handlePointerUp : undefined}
    >
      {items.map((track, localIdx) => {
        const absIdx = startIndex + localIdx;
        const isCurrent = absIdx === queueIndex;
        const isDragging = absIdx === dragIdx;
        const isOver = absIdx === overIdx && dragIdx !== null && dragIdx !== overIdx;

        return (
          <QueueItemRow
            key={track.urn}
            track={track}
            queue={queue}
            absIdx={absIdx}
            isCurrent={isCurrent}
            isDragging={isDragging}
            isOver={isOver}
            isPlaying={isPlaying}
            onGripDown={handleGripDown}
            onClick={handleClick}
            onRemove={handleRemove}
          />
        );
      })}
    </div>
  );
});

/* ── Panel ───────────────────────────────────────────────────────── */
export const QueuePanel = React.memo(
  ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const { t } = useTranslation();
    const queue = usePlayerStore((s) => s.queue);
    const queueIndex = usePlayerStore((s) => s.queueIndex);
    const currentTrack = usePlayerStore((s) => s.currentTrack);

    const upNextCount = queue.length - queueIndex - 1;

    return (
      <>
        {/* Backdrop */}
        <div
          className={`fixed inset-0 bg-black/26 backdrop-blur-[4px] z-40 transition-opacity duration-300 ${
            open ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={onClose}
        />

        {/* Panel */}
        <div
          className="pointer-events-none fixed inset-y-0 right-0 z-50 flex w-full justify-end p-3 pl-10"
          aria-hidden={!open}
        >
          <div
            className={`pointer-events-auto relative flex h-full w-[368px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[30px] border border-white/[0.08] transition-all duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              open
                ? 'translate-x-0 scale-100 opacity-100'
                : 'translate-x-10 scale-[0.985] opacity-0'
            }`}
            style={{
              background:
                'linear-gradient(180deg, rgba(18, 19, 24, 0.7) 0%, rgba(11, 12, 16, 0.82) 100%)',
              backdropFilter: 'blur(22px) saturate(1.12)',
              boxShadow:
                '0 28px 72px rgba(0, 0, 0, 0.46), 0 8px 24px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.045)',
              pointerEvents: open ? 'auto' : 'none',
              willChange: 'transform, opacity',
            }}
          >
            <div className="pointer-events-none absolute left-1/2 top-0 h-24 w-[74%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.035] blur-3xl" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/[0.035] via-white/[0.012] to-transparent" />

            {/* Header */}
            <div className="relative flex items-center justify-between px-5 pt-5 pb-3">
              <h2 className="text-[17px] font-semibold tracking-tight text-white/92">
                {t('player.queue')}
              </h2>
              <div className="flex items-center gap-1.5">
                {queue.length > 0 && (
                  <button
                    type="button"
                    onClick={() => usePlayerStore.getState().clearQueue()}
                    className="h-8 px-2.5 rounded-xl text-[11px] text-white/30 hover:text-white/60 hover:bg-white/[0.045] transition-all duration-150 cursor-pointer flex items-center gap-1.5"
                  >
                    <Trash2 size={12} />
                    {t('player.clearQueue')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/[0.045] transition-all duration-150 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Now Playing (single item, not draggable) */}
            {currentTrack && (
              <div className="relative px-4 pb-2">
                <p className="text-[10px] text-white/24 uppercase tracking-[0.18em] font-medium mb-2 px-1">
                  {t('player.nowPlaying')}
                </p>
                <NowPlayingItem />
              </div>
            )}

            {/* Up Next (draggable) */}
            <div className="relative flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pr-3 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.08)_transparent]">
              {upNextCount > 0 && (
                <>
                  <p className="text-[10px] text-white/24 uppercase tracking-[0.18em] font-medium mb-2 mt-3 px-1">
                    {t('player.upNext')} - {upNextCount}
                  </p>
                  <DraggableQueue startIndex={queueIndex + 1} />
                </>
              )}

              {queue.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full rounded-[24px] border border-white/[0.04] bg-black/10 text-white/15 backdrop-blur-[8px]">
                  {playIcon32}
                  <p className="text-sm mt-3">{t('player.queueEmpty')}</p>
                </div>
              )}
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/22 via-black/8 to-transparent" />
          </div>
        </div>
      </>
    );
  },
);
