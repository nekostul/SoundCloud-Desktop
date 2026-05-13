import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from './runtime';

type VisibilityListener = () => void;

let appVisible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
const listeners = new Set<VisibilityListener>();
let initialized = false;
let tauriUnlisten: (() => void) | null = null;

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function setAppVisible(nextVisible: boolean) {
  if (appVisible === nextVisible) return;
  appVisible = nextVisible;
  emitChange();
}

export function isAppVisible() {
  return appVisible;
}

export function isAppBackgrounded() {
  return !appVisible;
}

export function subscribeAppVisibility(listener: VisibilityListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function initAppVisibilityBridge() {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  initialized = true;

  const syncFromDocument = () => {
    setAppVisible(document.visibilityState !== 'hidden');
  };

  const markVisible = () => {
    setAppVisible(true);
  };

  document.addEventListener('visibilitychange', syncFromDocument);
  window.addEventListener('focus', markVisible);
  window.addEventListener('pageshow', markVisible);
  syncFromDocument();

  if (isTauriRuntime()) {
    try {
      tauriUnlisten = await listen<boolean>('app:window-visibility', (event) => {
        setAppVisible(Boolean(event.payload));
      });
    } catch (error) {
      console.warn('[Visibility] Failed to subscribe to app:window-visibility', error);
    }
  }

  import.meta.hot?.dispose(() => {
    document.removeEventListener('visibilitychange', syncFromDocument);
    window.removeEventListener('focus', markVisible);
    window.removeEventListener('pageshow', markVisible);
    tauriUnlisten?.();
    tauriUnlisten = null;
    initialized = false;
  });
}

void initAppVisibilityBridge();
