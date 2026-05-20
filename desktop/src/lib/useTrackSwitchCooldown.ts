import { useCallback, useSyncExternalStore } from 'react';

export const TRACK_SWITCH_COOLDOWN_MS = 1000;
export const TRACK_SWITCH_NEXT_SCOPE = 'player-next';
export const TRACK_SWITCH_PREV_SCOPE = 'player-prev';

type CooldownEntry = {
  listeners: Set<() => void>;
  timerId: number | null;
  until: number;
};

const cooldownEntries = new Map<string, CooldownEntry>();

function getCooldownEntry(scope: string): CooldownEntry {
  let entry = cooldownEntries.get(scope);
  if (!entry) {
    entry = {
      listeners: new Set(),
      timerId: null,
      until: 0,
    };
    cooldownEntries.set(scope, entry);
  }
  return entry;
}

function emitCooldown(entry: CooldownEntry) {
  for (const listener of entry.listeners) {
    listener();
  }
}

function subscribeTrackSwitchCooldown(scope: string, listener: () => void) {
  const entry = getCooldownEntry(scope);
  entry.listeners.add(listener);
  scheduleCooldownUnlock(entry);

  return () => {
    entry.listeners.delete(listener);
  };
}

export function isTrackSwitchCooldownActive(scope: string) {
  return getCooldownEntry(scope).until > Date.now();
}

export function runTrackSwitchCooldown(scope: string, action: () => void) {
  const entry = getCooldownEntry(scope);
  if (entry.until > Date.now()) return false;

  entry.until = Date.now() + TRACK_SWITCH_COOLDOWN_MS;
  emitCooldown(entry);
  scheduleCooldownUnlock(entry);
  action();
  return true;
}

function scheduleCooldownUnlock(entry: CooldownEntry) {
  if (entry.timerId !== null) {
    window.clearTimeout(entry.timerId);
  }

  const remainingMs = entry.until - Date.now();
  if (remainingMs <= 0) {
    entry.until = 0;
    entry.timerId = null;
    emitCooldown(entry);
    return;
  }

  entry.timerId = window.setTimeout(() => {
    entry.until = 0;
    entry.timerId = null;
    emitCooldown(entry);
  }, remainingMs);
}

export function useTrackSwitchCooldown(scope: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeTrackSwitchCooldown(scope, onStoreChange),
    [scope],
  );
  const getSnapshot = useCallback(() => getCooldownEntry(scope).until > Date.now(), [scope]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
