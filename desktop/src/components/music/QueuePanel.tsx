import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { art, dur } from '../../lib/formatters';
import {
  GripVertical,
  pauseTextWhite12,
  playIcon32,
  Trash2,
  X,
} from '../../lib/icons';
import { clearVisibleQueueWithSoundWavePriority } from '../../lib/soundwave-radio';
import { usePlayerStore } from '../../stores/player';
import { useSoundWaveStore } from '../../stores/soundwave';
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
          isCurrent
            ? 'bg-white/[0.03] ring-1 ring-white/[0.06]'
            : 'bg-white/[0.02] ring-1 ring-white/[0.035]'
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
const DraggableQueue = React.memo(
  ({
    items,
  }: {
    items: Array<{
      track: ReturnType<typeof usePlayerStore.getState>['queue'][number];
      absIdx: number;
    }>;
  }) => {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

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
        setOverIdx(items[i]?.absIdx ?? null);
        return;
      }
    }
    setOverIdx(items[children.length - 1]?.absIdx ?? null);
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
      {items.map((item) => {
        const absIdx = item.absIdx;
        const isCurrent = absIdx === queueIndex;
        const isDragging = absIdx === dragIdx;
        const isOver = absIdx === overIdx && dragIdx !== null && dragIdx !== overIdx;

        return (
          <QueueItemRow
            key={item.track.urn}
            track={item.track}
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
  },
);

const WaveRadioState = React.memo(function WaveRadioState({ refilling }: { refilling: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center pb-6 pt-2">
      <style>
        {`
          @keyframes flowRadioAura {
            0%, 100% { transform: scale(0.985); opacity: 0.78; }
            50% { transform: scale(1.015); opacity: 1; }
          }

          @keyframes flowRadioArcSpin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          @keyframes flowRadioArcSpinReverse {
            from { transform: rotate(360deg); }
            to { transform: rotate(0deg); }
          }

          @keyframes flowRadioOrbit {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          @keyframes flowRadioBar {
            0%, 100% { transform: scaleY(0.32); opacity: 0.72; }
            20% { transform: scaleY(0.96); opacity: 1; }
            45% { transform: scaleY(0.54); opacity: 0.8; }
            70% { transform: scaleY(1); opacity: 1; }
          }

          @keyframes flowRadioCaption {
            0%, 100% { opacity: 0.72; transform: translateY(0); }
            50% { opacity: 1; transform: translateY(-1px); }
          }
        `}
      </style>

      <div className="relative flex w-full flex-1 items-center justify-center overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,116,24,0.18)_0%,rgba(255,116,24,0.07)_40%,rgba(255,116,24,0)_76%)] blur-3xl"
          style={{ animation: `flowRadioAura ${refilling ? '2.1s' : '3.6s'} ease-in-out infinite` }}
        />

        <div className="relative h-[152px] w-[152px]">
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="h-[122px] w-[122px] rounded-full border border-white/[0.05]" />
          </div>

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div
              className="h-[152px] w-[152px] rounded-full opacity-90"
              style={{
                animation: `flowRadioArcSpin ${refilling ? '3.1s' : '5.6s'} linear infinite`,
                background:
                  'conic-gradient(from 210deg, rgba(255,124,32,0) 0deg, rgba(255,124,32,0) 42deg, rgba(255,124,32,0.55) 96deg, rgba(255,213,176,0.18) 128deg, rgba(255,124,32,0) 176deg, rgba(255,124,32,0) 360deg)',
                WebkitMask:
                  'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 0.5px))',
                mask:
                  'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 0.5px))',
              }}
            />
          </div>

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div
              className="h-[116px] w-[116px] rounded-full opacity-70"
              style={{
                animation: `flowRadioArcSpinReverse ${refilling ? '2.5s' : '4.4s'} linear infinite`,
                background:
                  'conic-gradient(from 18deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,0.34) 46deg, rgba(255,255,255,0.04) 86deg, rgba(255,255,255,0) 126deg, rgba(255,255,255,0) 360deg)',
                WebkitMask:
                  'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 0.5px))',
                mask:
                  'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 0.5px))',
              }}
            />
          </div>

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div
              className="relative h-[132px] w-[132px]"
              style={{ animation: `flowRadioOrbit ${refilling ? '2.9s' : '5s'} linear infinite` }}
            >
              <div className="absolute left-1/2 top-[5px] h-2 w-2 -translate-x-1/2 rounded-full bg-[#ff8d3f] shadow-[0_0_16px_rgba(255,141,63,0.7)]" />
            </div>
          </div>

          <div className="absolute left-1/2 top-1/2 h-px w-[86px] -translate-x-1/2 -translate-y-1/2 bg-[linear-gradient(90deg,rgba(255,255,255,0)_0%,rgba(255,167,97,0.4)_50%,rgba(255,255,255,0)_100%)] opacity-70" />

          <div
            className="absolute left-1/2 top-1/2 flex h-[66px] w-[82px] -translate-x-1/2 -translate-y-1/2 items-end justify-center gap-[6px] rounded-[24px] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.04)_0%,rgba(7,7,10,0.28)_100%)] px-3 py-3 backdrop-blur-xl shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
            style={{ animation: `flowRadioAura ${refilling ? '1.9s' : '3.3s'} ease-in-out infinite` }}
          >
            {[22, 36, 46, 30].map((height, index) => (
              <span
                key={`${height}-${index}`}
                className="origin-bottom rounded-full"
                style={{
                  width: index === 2 ? 6 : 5,
                  height,
                  background:
                    index === 2
                      ? 'linear-gradient(180deg, rgba(255,230,200,0.96) 0%, rgba(255,130,34,1) 100%)'
                      : 'linear-gradient(180deg, rgba(255,190,136,0.9) 0%, rgba(255,115,16,0.95) 100%)',
                  animation: `flowRadioBar ${refilling ? '0.74s' : '1.06s'} cubic-bezier(0.4, 0, 0.2, 1) infinite`,
                  animationDelay: `${index * 0.1}s`,
                  boxShadow:
                    index === 2
                      ? '0 0 14px rgba(255, 140, 44, 0.42)'
                      : '0 0 12px rgba(255, 122, 26, 0.24)',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div
        className="mt-1 flex items-center gap-2 text-[13px] font-medium text-white/88"
        style={{ animation: 'flowRadioCaption 2.6s ease-in-out infinite' }}
      >
        <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_16px_rgba(255,109,0,0.7)]" />
        <span>{t('player.waveLiveTitle')}</span>
      </div>
    </div>
  );
});

/* ── Panel ───────────────────────────────────────────────────────── */
export const QueuePanel = React.memo(
  ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const { t } = useTranslation();
    const queue = usePlayerStore((s) => s.queue);
    const queueIndex = usePlayerStore((s) => s.queueIndex);
    const queueSource = usePlayerStore((s) => s.queueSource);
    const currentTrack = usePlayerStore((s) => s.currentTrack);
    const isWaveActive = useSoundWaveStore((s) => s.isActive);
    const flowManagedUrns = useSoundWaveStore((s) => s.flowManagedUrns);
    const isQueueRefilling = useSoundWaveStore((s) => s.isQueueRefilling);
    const isWaveQueue = queueSource === 'soundwave' && isWaveActive && Boolean(currentTrack);
    const visibleUpcomingEntries = React.useMemo(() => {
      const entries: Array<{
        track: ReturnType<typeof usePlayerStore.getState>['queue'][number];
        absIdx: number;
      }> = [];
      const startIndex = Math.max(0, queueIndex + 1);

      for (let absIdx = startIndex; absIdx < queue.length; absIdx += 1) {
        const track = queue[absIdx];
        if (!track?.urn) continue;
        if (isWaveQueue && flowManagedUrns.has(track.urn)) continue;
        entries.push({ track, absIdx });
      }

      return entries;
    }, [flowManagedUrns, isWaveQueue, queue, queueIndex]);
    const upNextCount = visibleUpcomingEntries.length;
    const showWaveRadioState = Boolean(currentTrack) && isWaveQueue && upNextCount === 0;
    const canClearQueue = isWaveQueue ? upNextCount > 0 : queue.length > 0;

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
            role="dialog"
            aria-modal="true"
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
                {canClearQueue && (
                  <button
                    type="button"
                    onClick={() => {
                      if (isWaveQueue) {
                        clearVisibleQueueWithSoundWavePriority();
                        return;
                      }
                      usePlayerStore.getState().clearQueue();
                    }}
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
            {showWaveRadioState ? (
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <WaveRadioState refilling={isQueueRefilling} />
                </div>
              </div>
            ) : (
              <div className="relative flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pr-3 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.08)_transparent]">
                {upNextCount > 0 && (
                  <>
                    <p className="text-[10px] text-white/24 uppercase tracking-[0.18em] font-medium mb-2 mt-3 px-1">
                      {t('player.upNext')} - {upNextCount}
                    </p>
                    <DraggableQueue items={visibleUpcomingEntries} />
                  </>
                )}

                {queue.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full rounded-[24px] border border-white/[0.04] bg-black/10 text-white/15 backdrop-blur-[8px]">
                    {playIcon32}
                    <p className="text-sm mt-3">{t('player.queueEmpty')}</p>
                  </div>
                )}
              </div>
            )}

            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/22 via-black/8 to-transparent" />
          </div>
        </div>
      </>
    );
  },
);
