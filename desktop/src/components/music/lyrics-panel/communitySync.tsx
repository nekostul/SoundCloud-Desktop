import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getConfirmedCurrentTime,
  getCurrentTime,
  isPlaybackSeekSettling,
} from '../../../lib/audio';
import { formatTime } from '../../../lib/formatters';
import { Loader2, PencilLine } from '../../../lib/icons';
import type { LyricLine, LyricsSource } from '../../../lib/lyrics';
import type { CommunityLyricsDraft } from '../../../stores/communityLyricsDrafts';
import { type ResolvedLyricsData, shouldRenderPlainLyrics } from './lyricsData';
import { isPauseMarkerText } from './syncedLyrics';

export type CommunitySyncSource = 'genius' | 'soundcloud' | 'local';

export type CommunitySyncLine = {
  kind: 'lyric' | 'pause';
  text: string;
  time: number | null;
};

export type CommunitySyncSession = {
  plainLyrics: string;
  lines: CommunitySyncLine[];
  activeIndex: number;
  source: CommunitySyncSource;
};

export type CommunitySyncTrackMeta = {
  trackUrn: string;
  artistName: string;
  trackName: string;
  durationSec: number;
};

export function isCommunitySyncSource(
  source: LyricsSource | null | undefined,
): source is CommunitySyncSource {
  return source === 'genius' || source === 'soundcloud' || source === 'local';
}

export function canCreateCommunitySync(
  lyrics: ResolvedLyricsData,
): lyrics is { plain: string; source: CommunitySyncSource; synced: null } {
  return shouldRenderPlainLyrics(lyrics) && isCommunitySyncSource(lyrics.source);
}

function splitCommunitySyncLines(plainLyrics: string): string[] {
  const lines = String(plainLyrics || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0 ? lines : [];
}

export function updateCommunitySyncSessionPlainLyrics(
  session: CommunitySyncSession,
  plainLyrics: string,
): CommunitySyncSession | null {
  const nextPlainLines = splitCommunitySyncLines(plainLyrics);
  if (nextPlainLines.length === 0) return null;

  const previousLyricLines = session.lines.filter((line) => line.kind === 'lyric');
  const pausesByLyricIndex = new Map<number, CommunitySyncLine[]>();
  let lyricIndex = 0;

  for (const line of session.lines) {
    if (line.kind === 'pause') {
      const pauses = pausesByLyricIndex.get(lyricIndex) ?? [];
      pauses.push(line);
      pausesByLyricIndex.set(lyricIndex, pauses);
      continue;
    }
    lyricIndex += 1;
  }

  const nextLines: CommunitySyncLine[] = [];
  for (let index = 0; index < nextPlainLines.length; index += 1) {
    nextLines.push(...(pausesByLyricIndex.get(index) ?? []));
    nextLines.push(
      createCommunitySyncLyricLine(nextPlainLines[index], previousLyricLines[index]?.time ?? null),
    );
  }
  for (const [anchorIndex, pauses] of pausesByLyricIndex) {
    if (anchorIndex >= nextPlainLines.length) {
      nextLines.push(...pauses);
    }
  }

  const activeIndex = resolveCommunitySyncActiveIndex(
    nextLines,
    Math.min(Math.max(session.activeIndex, -1), nextLines.length - 1),
  );

  return {
    ...session,
    plainLyrics: nextPlainLines.join('\n'),
    lines: nextLines,
    activeIndex,
  };
}

function normalizeCommunitySyncComparableText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createCommunitySyncLyricLine(
  text: string,
  time: number | null = null,
): CommunitySyncLine {
  return {
    kind: 'lyric',
    text,
    time,
  };
}

export function createCommunitySyncPauseLine(time: number): CommunitySyncLine {
  return {
    kind: 'pause',
    text: '',
    time,
  };
}

export function createCommunitySyncSession(
  plainLyrics: string,
  source: CommunitySyncSource,
): CommunitySyncSession | null {
  const lines = splitCommunitySyncLines(plainLyrics);
  if (lines.length === 0) return null;

  return {
    plainLyrics,
    lines: lines.map((line) => createCommunitySyncLyricLine(line)),
    activeIndex: -1,
    source,
  };
}

export function createCommunitySyncSessionFromDraft(
  draft: CommunityLyricsDraft,
): CommunitySyncSession | null {
  const lines = splitCommunitySyncLines(draft.plainLyrics);
  if (lines.length === 0) return null;

  const nextLines: CommunitySyncLine[] = [];
  let plainIndex = 0;

  for (const syncedLine of draft.syncedLyrics) {
    if (isPauseMarkerText(syncedLine.text)) {
      nextLines.push(createCommunitySyncPauseLine(syncedLine.time));
      continue;
    }

    const nextPlainLine = lines[plainIndex];
    if (nextPlainLine) {
      const normalizedSynced = normalizeCommunitySyncComparableText(syncedLine.text);
      const normalizedPlain = normalizeCommunitySyncComparableText(nextPlainLine);
      if (normalizedSynced === normalizedPlain || !normalizedSynced) {
        nextLines.push(createCommunitySyncLyricLine(nextPlainLine, syncedLine.time));
        plainIndex += 1;
        continue;
      }

      nextLines.push(createCommunitySyncLyricLine(nextPlainLine, syncedLine.time));
      plainIndex += 1;
      continue;
    }

    nextLines.push(createCommunitySyncLyricLine(syncedLine.text, syncedLine.time));
  }

  while (plainIndex < lines.length) {
    nextLines.push(createCommunitySyncLyricLine(lines[plainIndex]));
    plainIndex += 1;
  }

  const firstPendingIndex = nextLines.findIndex((line) => line.time === null);
  const hasStampedLines = nextLines.some((line) => typeof line.time === 'number');

  return {
    plainLyrics: draft.plainLyrics,
    lines: nextLines,
    activeIndex: !hasStampedLines
      ? -1
      : firstPendingIndex >= 0
        ? firstPendingIndex
        : Math.max(Math.min(nextLines.length - 1, 0), 0),
    source: draft.source,
  };
}

export function toCommunitySyncDraft(
  trackMeta: CommunitySyncTrackMeta,
  session: CommunitySyncSession,
): CommunityLyricsDraft {
  return {
    trackUrn: trackMeta.trackUrn,
    artistName: trackMeta.artistName,
    trackName: trackMeta.trackName,
    durationSec: trackMeta.durationSec,
    plainLyrics: session.plainLyrics,
    syncedLyrics: session.lines.flatMap((line) => {
      return typeof line.time === 'number'
        ? [{ time: line.time, text: line.kind === 'pause' ? '' : line.text }]
        : [];
    }),
    createdAt: new Date().toISOString(),
    source: session.source,
  };
}

const COMMUNITY_SYNC_MIN_GAP_SEC = 0.001;

export function formatCommunitySyncTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

  const totalMilliseconds = Math.round(safe * 1000);

  const minutes = Math.floor(totalMilliseconds / 60000);
  const wholeSeconds = Math.floor(totalMilliseconds / 1000) % 60;
  const milliseconds = totalMilliseconds % 1000;

  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(
    2,
    '0',
  )}.${String(milliseconds).padStart(3, '0')}`;
}

export function serializeCommunitySyncedLyrics(lines: LyricLine[]): string {
  return lines.map((line) => `[${formatCommunitySyncTimestamp(line.time)}]${line.text}`).join('\n');
}

export function isCommunitySyncSessionComplete(session: CommunitySyncSession | null): boolean {
  return Boolean(
    session &&
      session.lines.length > 0 &&
      session.lines.every((line) => typeof line.time === 'number'),
  );
}

export function parseCommunitySyncTimestampInput(value: string): number | null {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,3}):([0-5]\d)(?::|[.,])(\d{1,3})$/);
  if (!match) return null;

  const [, minutes, seconds, milliseconds] = match;
  return Number(minutes) * 60 + Number(seconds) + Number(milliseconds.padEnd(3, '0')) / 1000;
}

export function roundCommunitySyncTimestamp(seconds: number): number {
  return Number(Math.max(0, seconds).toFixed(3));
}

export function hasCommunitySyncStampedLines(lines: CommunitySyncLine[]): boolean {
  return lines.some((line) => typeof line.time === 'number');
}

export function resolveCommunitySyncActiveIndex(
  lines: CommunitySyncLine[],
  preferredIndex: number,
): number {
  if (lines.length === 0 || !hasCommunitySyncStampedLines(lines)) return -1;
  return Math.max(0, Math.min(preferredIndex, lines.length - 1));
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ),
  );
}

export function findCommunitySyncPreviousStampedIndex(
  lines: CommunitySyncLine[],
  startIndex: number,
): number {
  for (let index = Math.min(startIndex, lines.length - 1); index >= 0; index -= 1) {
    if (typeof lines[index]?.time === 'number') return index;
  }

  return -1;
}

export function findCommunitySyncNextStampedIndex(
  lines: CommunitySyncLine[],
  startIndex: number,
): number {
  for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
    if (typeof lines[index]?.time === 'number') return index;
  }

  return -1;
}

export function findCommunitySyncNextPendingIndex(
  lines: CommunitySyncLine[],
  startIndex: number,
): number {
  for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
    if (lines[index]?.time === null) return index;
  }

  return -1;
}

export function getCommunitySyncTimeBounds(lines: CommunitySyncLine[], index: number) {
  const previousIndex = findCommunitySyncPreviousStampedIndex(lines, index - 1);
  const nextIndex = findCommunitySyncNextStampedIndex(lines, index + 1);

  return {
    previousTime: previousIndex >= 0 ? (lines[previousIndex]?.time ?? null) : null,
    nextTime: nextIndex >= 0 ? (lines[nextIndex]?.time ?? null) : null,
  };
}

export function getStampedCommunitySyncTime(
  currentTime: number,
  previousTime: number | null,
  nextTime: number | null,
): number {
  const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const minimum = previousTime === null ? 0 : previousTime + COMMUNITY_SYNC_MIN_GAP_SEC;
  const maximum =
    nextTime === null
      ? Number.POSITIVE_INFINITY
      : Math.max(minimum, nextTime - COMMUNITY_SYNC_MIN_GAP_SEC);
  return roundCommunitySyncTimestamp(Math.min(Math.max(safeCurrentTime, minimum), maximum));
}

export function getCommunitySyncPlaybackIndex(
  lines: CommunitySyncLine[],
  currentTime: number,
  fallbackIndex: number,
): number {
  const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  let firstStampedIndex = -1;
  let firstStampedTime: number | null = null;
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const lineTime = lines[index]?.time;
    if (typeof lineTime !== 'number') continue;
    if (firstStampedIndex < 0) {
      firstStampedIndex = index;
      firstStampedTime = lineTime;
    }
    if (lineTime <= safeCurrentTime + 0.02) {
      activeIndex = index;
      continue;
    }
    break;
  }

  if (activeIndex >= 0) return activeIndex;
  if (firstStampedIndex >= 0) {
    if (firstStampedTime !== null && safeCurrentTime + 0.02 < firstStampedTime) return -1;
    return firstStampedIndex;
  }
  if (fallbackIndex < 0) return -1;
  return Math.max(0, Math.min(fallbackIndex, lines.length - 1));
}

export function getCommunitySyncStampTargetIndex(session: CommunitySyncSession): number {
  if (session.lines.length === 0) return -1;
  if (session.activeIndex < 0) {
    return findCommunitySyncNextPendingIndex(session.lines, 0);
  }
  const activeLine =
    session.lines[Math.max(0, Math.min(session.activeIndex, session.lines.length - 1))];
  if (!activeLine) return -1;
  if (activeLine.time === null)
    return Math.max(0, Math.min(session.activeIndex, session.lines.length - 1));

  const nextPendingIndex = findCommunitySyncNextPendingIndex(
    session.lines,
    session.activeIndex + 1,
  );
  if (nextPendingIndex >= 0) return nextPendingIndex;

  return -1;
}

export function getCommunitySyncPauseInsertIndex(session: CommunitySyncSession): number {
  if (session.lines.length === 0) return 0;
  if (session.activeIndex < 0) return 0;
  const activeLine =
    session.lines[Math.max(0, Math.min(session.activeIndex, session.lines.length - 1))];
  if (!activeLine || activeLine.time === null) {
    return Math.max(0, Math.min(session.activeIndex, session.lines.length));
  }

  const nextPendingIndex = findCommunitySyncNextPendingIndex(
    session.lines,
    session.activeIndex + 1,
  );
  if (nextPendingIndex >= 0) return nextPendingIndex;

  return Math.min(session.activeIndex + 1, session.lines.length);
}

/* ── Lyrics Search Modal ──────────────────────────────────── */

const CommunitySyncLiveClock = React.memo(
  ({
    seekPending,
    syncedCount,
    totalLines,
  }: {
    seekPending: boolean;
    syncedCount: number;
    totalLines: number;
  }) => {
    const [currentTime, setCurrentTime] = useState(() =>
      isPlaybackSeekSettling() ? getConfirmedCurrentTime() : getCurrentTime(),
    );

    useEffect(() => {
      const tick = () =>
        setCurrentTime(isPlaybackSeekSettling() ? getConfirmedCurrentTime() : getCurrentTime());
      tick();
      const intervalId = window.setInterval(tick, 90);
      return () => window.clearInterval(intervalId);
    }, []);

    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/[0.22] px-3 py-1.5 text-[11px] font-medium text-white/68 shadow-[0_12px_34px_rgba(0,0,0,0.26)] backdrop-blur-xl">
        <span className="tabular-nums">{formatTime(currentTime)}</span>
        {seekPending ? (
          <>
            <span className="h-1 w-1 rounded-full bg-amber-300/70" />
            <Loader2 size={11} className="animate-spin text-amber-200/70" />
          </>
        ) : (
          <span className="h-1 w-1 rounded-full bg-white/16" />
        )}
        <span className="tabular-nums text-white/42">
          {syncedCount}/{totalLines}
        </span>
      </div>
    );
  },
);

const CommunitySyncTimestampChip = React.memo(
  ({ value, onCommit }: { value: number; onCommit: (nextTime: number) => void }) => {
    const [editing, setEditing] = useState(false);
    const [draftValue, setDraftValue] = useState(() => formatCommunitySyncTimestamp(value));
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      if (!editing) {
        setDraftValue(formatCommunitySyncTimestamp(value));
      }
    }, [editing, value]);

    useEffect(() => {
      if (!editing) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    }, [editing]);

    const cancelEditing = useCallback(() => {
      setDraftValue(formatCommunitySyncTimestamp(value));
      setEditing(false);
    }, [value]);

    const submitEditing = useCallback(() => {
      const parsed = parseCommunitySyncTimestampInput(draftValue);
      if (parsed == null) {
        cancelEditing();
        return;
      }

      onCommit(parsed);
      setEditing(false);
    }, [cancelEditing, draftValue, onCommit]);

    const sharedClassName =
      'inline-flex h-7 min-w-[82px] items-center justify-center rounded-full border border-white/[0.08] bg-black/[0.18] px-2.5 text-[10px] font-semibold tabular-nums text-white/52 shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-200 hover:border-white/[0.12] hover:bg-black/[0.26] hover:text-white/78';

    if (editing) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={draftValue}
          inputMode="numeric"
          spellCheck={false}
          aria-label="Edit lyric timestamp"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={submitEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitEditing();
              return;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              cancelEditing();
            }
          }}
          className={`${sharedClassName} w-[82px] outline-none ring-1 ring-white/[0.14]`}
        />
      );
    }

    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        className={sharedClassName}
      >
        {formatCommunitySyncTimestamp(value)}
      </button>
    );
  },
);

export const CommunitySyncEditor = React.memo(
  ({
    session,
    onSyncLine,
    onInsertPause,
    onUndo,
    onPublish,
    publishPending,
    seekPending,
    onSeekLine,
    onUpdateTimestamp,
    onUpdatePlainLyrics,
    onReset,
    onCancel,
    t,
  }: {
    session: CommunitySyncSession;
    onSyncLine: () => void;
    onInsertPause: () => void;
    onUndo: () => void;
    onPublish: () => void;
    publishPending: boolean;
    seekPending: boolean;
    onSeekLine: (index: number) => void;
    onUpdateTimestamp: (index: number, nextTime: number) => void;
    onUpdatePlainLyrics: (plainLyrics: string) => void;
    onReset: () => void;
    onCancel: () => void;
    t: TFunction;
  }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [textEditorOpen, setTextEditorOpen] = useState(false);
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
    const [textEditorValue, setTextEditorValue] = useState(session.plainLyrics);
    const syncedCount = session.lines.filter((line) => typeof line.time === 'number').length;
    const canPublish = isCommunitySyncSessionComplete(session);

    useEffect(() => {
      if (!textEditorOpen) {
        setTextEditorValue(session.plainLyrics);
      }
    }, [session.plainLyrics, textEditorOpen]);

    const openTextEditor = useCallback(() => {
      setTextEditorValue(session.plainLyrics);
      setTextEditorOpen(true);
    }, [session.plainLyrics]);

    const saveTextEditor = useCallback(() => {
      onUpdatePlainLyrics(textEditorValue);
      setTextEditorOpen(false);
    }, [onUpdatePlainLyrics, textEditorValue]);

    const confirmReset = useCallback(() => {
      onReset();
      setResetConfirmOpen(false);
    }, [onReset]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const activeLine = container.querySelector<HTMLElement>(
        `[data-sync-line-index="${session.activeIndex}"]`,
      );
      activeLine?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [session.activeIndex]);

    return (
      <div className="relative mx-auto flex h-full w-full max-w-[960px] select-none flex-col overflow-hidden animate-fade-in-up">
        <div className="flex items-start justify-between gap-4 px-[clamp(8px,1.4vw,18px)] pt-3 pb-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
                {t('track.communitySyncMode', 'Sync mode')}
              </div>
              <button
                type="button"
                onClick={openTextEditor}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-[11px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white"
              >
                <PencilLine size={12} />
                <span>{t('track.communitySyncEditText', 'Редактировать текст')}</span>
              </button>
            </div>
            <div className="mt-1 text-[12px] text-white/40">
              {t('track.communitySyncModeHint', 'Отмечайте строки прямо по ходу трека.')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CommunitySyncLiveClock
              seekPending={seekPending}
              syncedCount={syncedCount}
              totalLines={session.lines.length}
            />
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-[12px] font-medium text-white/58 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white/84"
            >
              {t('track.communitySyncExit', 'Выйти')}
            </button>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[880px] flex-wrap items-center justify-center gap-2 px-4 pb-4 text-[11px] text-white/34">
          {[
            ['SPACE', t('track.communitySyncHintNext', 'следующая строка')],
            ['BACKSPACE', t('track.communitySyncHintUndo', 'отменить последнюю')],
            ['ESC', t('track.communitySyncHintCancel', 'выйти без сохранения')],
          ].map(([key, label]) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 backdrop-blur-md"
            >
              <span className="font-semibold text-white/54">{key}</span>
              <span>{label}</span>
            </span>
          ))}
        </div>

        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto px-[clamp(20px,4vw,56px)] pb-8 scrollbar-hide"
        >
          <div className="mx-auto flex max-w-[880px] flex-col gap-2 pt-6">
            {session.lines.map((line, index) => {
              const timestamp = line.time;
              const canSeekToLine = typeof timestamp === 'number';
              const hasActiveLine = session.activeIndex >= 0;
              const distance = hasActiveLine ? index - session.activeIndex : 0;
              const isActive = hasActiveLine && distance === 0;
              const isPast = hasActiveLine && distance < 0;
              const isPauseLine = line.kind === 'pause';
              const stateClassName = !hasActiveLine
                ? 'opacity-[0.58] scale-[0.98] text-white/[0.62]'
                : isActive
                  ? 'opacity-100 scale-[1.08] text-white [text-shadow:0_0_34px_rgba(255,255,255,0.2)]'
                  : isPast
                    ? distance === -1
                      ? 'opacity-[0.72] scale-[0.995] text-white/[0.78]'
                      : 'opacity-[0.42] scale-[0.97] text-white/[0.48]'
                    : distance === 1
                      ? 'opacity-[0.78] scale-[0.995] text-white/[0.84]'
                      : 'opacity-[0.46] scale-[0.97] text-white/[0.54]';

              return (
                <div
                  key={`${index}-${line.kind}-${line.text}-${line.time ?? 'pending'}`}
                  data-sync-line-index={index}
                  onClick={canSeekToLine ? () => onSeekLine(index) : undefined}
                  className={`relative flex w-full items-center justify-center px-[72px] py-3 text-center text-[clamp(24px,3vw,42px)] font-bold tracking-tight transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    canSeekToLine ? 'cursor-pointer' : 'cursor-default'
                  } ${stateClassName}`}
                >
                  {timestamp !== null ? (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2">
                      <CommunitySyncTimestampChip
                        value={timestamp}
                        onCommit={(nextTime) => onUpdateTimestamp(index, nextTime)}
                      />
                    </div>
                  ) : null}
                  {isPauseLine ? (
                    <span className="block min-h-[1.15em] w-full select-none whitespace-pre-wrap text-center">
                      {'\u00A0'}
                    </span>
                  ) : (
                    <span className="block whitespace-pre-wrap text-center">{line.text}</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="h-[34vh]" />
        </div>

        <div className="px-[clamp(20px,4vw,56px)] pb-[clamp(132px,18vh,172px)] pt-4">
          <div className="mx-auto flex max-w-[880px] flex-wrap items-center justify-between gap-3 rounded-[28px] border border-white/[0.08] bg-[rgba(8,8,10,0.3)] px-4 py-4 shadow-[0_28px_90px_rgba(0,0,0,0.34)] backdrop-blur-[26px]">
            <div className="text-[12px] text-white/42">
              {t('track.communitySyncProgress', 'Строка {{current}} из {{total}}')
                .replace(
                  '{{current}}',
                  String(
                    session.activeIndex < 0
                      ? 0
                      : Math.min(session.activeIndex + 1, session.lines.length),
                  ),
                )
                .replace('{{total}}', String(session.lines.length))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={onUndo}
                disabled={syncedCount === 0}
                className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white disabled:cursor-default disabled:opacity-38"
              >
                {t('track.communitySyncUndo', 'Отменить')}
              </button>
              <button
                type="button"
                onClick={() => setResetConfirmOpen(true)}
                disabled={syncedCount === 0}
                className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white disabled:cursor-default disabled:opacity-38"
              >
                {t('track.communitySyncRestart', 'Начать заново')}
              </button>
              <button
                type="button"
                onClick={onInsertPause}
                disabled={seekPending}
                className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.05] px-4 text-[12px] font-medium text-white/66 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.09] hover:text-white disabled:cursor-default disabled:opacity-42"
              >
                {t('track.communitySyncPause', 'Пауза')}
              </button>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={onSyncLine}
                  disabled={seekPending}
                  className={`inline-flex h-10 items-center rounded-full px-5 text-[12px] font-semibold transition-all duration-300 ${
                    seekPending
                      ? 'cursor-default border border-amber-200/[0.12] bg-amber-200/[0.07] text-amber-100/48'
                      : canPublish
                        ? 'border border-white/[0.08] bg-white/[0.05] text-white/66 hover:border-white/[0.12] hover:bg-white/[0.09] hover:text-white'
                        : 'border border-white/[0.1] bg-white/[0.12] text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)]'
                  }`}
                >
                  {t('track.communitySyncNextButton', 'Следующая строка')}
                </button>
                <div
                  className={`overflow-hidden rounded-full transition-[max-width,opacity,margin,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    canPublish
                      ? 'ml-2 max-w-[156px] opacity-100 translate-x-0'
                      : 'ml-0 max-w-0 opacity-0 translate-x-3 pointer-events-none'
                  }`}
                >
                  <button
                    type="button"
                    onClick={onPublish}
                    disabled={publishPending}
                    className={`inline-flex h-10 w-[156px] items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-300 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)] disabled:cursor-default disabled:opacity-60 ${
                      canPublish
                        ? 'translate-x-0 opacity-100 delay-75'
                        : 'translate-x-3 opacity-0 delay-0'
                    }`}
                  >
                    {publishPending ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 size={13} className="animate-spin" />
                        <span>{t('track.communitySyncPublishing', 'Публикация...')}</span>
                      </span>
                    ) : (
                      t('track.communitySyncPublish', 'Опубликовать')
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        {textEditorOpen && typeof document !== 'undefined'
          ? createPortal(
              <div
                className="fixed inset-0 z-[95] flex items-center justify-center bg-black/72 backdrop-blur-[18px]"
                onClick={() => setTextEditorOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  className="flex h-[min(82vh,720px)] w-[min(92vw,720px)] flex-col rounded-[28px] border border-white/[0.08] bg-[rgba(12,12,16,0.88)] p-5 shadow-[0_42px_160px_rgba(0,0,0,0.64)] backdrop-blur-[30px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
                        {t('track.communitySyncTextEditorLabel', 'Lyrics')}
                      </div>
                      <div className="mt-1 text-[18px] font-semibold text-white/88">
                        {t('track.communitySyncEditText', 'Редактировать текст')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTextEditorOpen(false)}
                      className="inline-flex h-9 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-[12px] font-medium text-white/58 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white/84"
                    >
                      {t('common.cancel', 'Отмена')}
                    </button>
                  </div>
                  <textarea
                    value={textEditorValue}
                    onChange={(event) => setTextEditorValue(event.target.value)}
                    spellCheck={false}
                    className="mt-5 min-h-0 flex-1 resize-none rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[14px] leading-6 text-white/90 outline-none transition-all duration-200 placeholder:text-white/28 focus:border-white/[0.14] focus:bg-white/[0.06]"
                  />
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setTextEditorOpen(false)}
                      className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white"
                    >
                      {t('common.cancel', 'Отмена')}
                    </button>
                    <button
                      type="button"
                      onClick={saveTextEditor}
                      className="inline-flex h-10 items-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)]"
                    >
                      {t('common.save', 'Сохранить')}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
        {resetConfirmOpen && typeof document !== 'undefined'
          ? createPortal(
              <div
                className="fixed inset-0 z-[96] flex items-center justify-center bg-black/72 backdrop-blur-[18px]"
                onClick={() => setResetConfirmOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  className="w-[min(92vw,460px)] rounded-[30px] border border-white/[0.08] bg-[rgba(12,12,16,0.88)] px-6 py-6 shadow-[0_42px_160px_rgba(0,0,0,0.64)] backdrop-blur-[30px] animate-fade-in-up"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="text-[18px] font-semibold text-white/90">
                    {t('track.communitySyncRestartConfirmTitle', 'Начать заново?')}
                  </div>
                  <div className="mt-3 text-[13px] leading-6 text-white/54">
                    {t(
                      'track.communitySyncRestartConfirmText',
                      'Это очистит все синхронизированные строчки. Текст останется, но тайминги нужно будет поставить заново.',
                    )}
                  </div>
                  <div className="mt-6 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setResetConfirmOpen(false)}
                      className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white"
                    >
                      {t('common.no', 'Нет')}
                    </button>
                    <button
                      type="button"
                      onClick={confirmReset}
                      className="inline-flex h-10 items-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)]"
                    >
                      {t('common.yes', 'Да')}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  },
);

export const CommunitySyncPublishConfirm = React.memo(
  ({
    open,
    pending,
    onClose,
    onConfirm,
    t,
    trackName,
    artistName,
    albumName,
    duration,
    onTrackNameChange,
    onArtistNameChange,
    onAlbumNameChange,
    onDurationChange,
  }: {
    open: boolean;
    pending: boolean;
    onClose: () => void;
    onConfirm: () => void;
    t: TFunction;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: string;
    onTrackNameChange: (value: string) => void;
    onArtistNameChange: (value: string) => void;
    onAlbumNameChange: (value: string) => void;
    onDurationChange: (value: string) => void;
  }) => {
    if (!open || typeof document === 'undefined') return null;

    return createPortal(
      <div
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/72 backdrop-blur-[18px]"
        onClick={pending ? undefined : onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          className="w-[min(92vw,560px)] rounded-[30px] border border-white/[0.08] bg-[rgba(12,12,16,0.82)] px-6 py-6 shadow-[0_42px_160px_rgba(0,0,0,0.64)] backdrop-blur-[30px] animate-fade-in-up"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/28">
            {t('track.communitySyncPublishConfirmLabel', 'Подтверждение')}
          </div>
          <div className="mt-3 text-[22px] font-semibold tracking-tight text-white/92">
            {t(
              'track.communitySyncPublishConfirmTitle',
              'Проверьте синхронизацию перед публикацией',
            )}
          </div>
          <div className="mt-3 text-[13px] leading-6 text-white/54">
            {t(
              'track.communitySyncPublishConfirmText',
              'После отправки синхронизацию нельзя будет изменить через LRCLIB API. Если всё звучит точно, можно публиковать.',
            )}
          </div>

          <div className="mt-6 space-y-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncTrackName', 'Track Name')}
              </label>
              <input
                type="text"
                value={trackName}
                onChange={(e) => onTrackNameChange(e.target.value)}
                disabled={pending}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncArtistName', 'Artist Name')}
              </label>
              <input
                type="text"
                value={artistName}
                onChange={(e) => onArtistNameChange(e.target.value)}
                disabled={pending}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncAlbumName', 'Album Name')}
              </label>
              <input
                type="text"
                value={albumName}
                onChange={(e) => onAlbumNameChange(e.target.value)}
                disabled={pending}
                placeholder={t('track.communitySyncAlbumNamePlaceholder', 'Optional')}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/38 mb-1">
                {t('track.communitySyncDuration', 'Duration (seconds)')}
              </label>
              <input
                type="number"
                value={duration}
                onChange={(e) => onDurationChange(e.target.value)}
                disabled={pending}
                min="0"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-white/92 placeholder-white/28 transition-all duration-200 focus:border-white/[0.12] focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-medium text-white/62 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.08] hover:text-white disabled:cursor-default disabled:opacity-38"
            >
              {t('common.cancel', 'Отменить')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-full border border-white/[0.1] bg-white/[0.12] px-5 text-[12px] font-semibold text-white shadow-[0_14px_40px_rgba(255,255,255,0.08)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.18] hover:shadow-[0_0_26px_rgba(255,255,255,0.12)] disabled:cursor-default disabled:opacity-38"
            >
              {pending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={13} className="animate-spin" />
                  <span>{t('track.communitySyncPublishing', 'Публикация...')}</span>
                </span>
              ) : (
                t('track.communitySyncPublishNow', 'Опубликовать')
              )}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  },
);
