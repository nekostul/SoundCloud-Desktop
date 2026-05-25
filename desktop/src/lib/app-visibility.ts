import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from './runtime';

type VisibilityListener = () => void;

let documentVisible =
  typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
let nativeWindowVisible = true;
let appVisible = documentVisible && nativeWindowVisible;
const listeners = new Set<VisibilityListener>();
let initialized = false;
let tauriUnlisten: (() => void) | null = null;

function applyVisibilityClass() {
  if (typeof document === 'undefined') return;

  document.documentElement.classList.toggle('app-backgrounded', !appVisible);
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function setAppVisible(nextVisible: boolean) {
  if (appVisible === nextVisible) return;
  appVisible = nextVisible;
  applyVisibilityClass();
  emitChange();
}

function updateAppVisible() {
  setAppVisible(documentVisible && nativeWindowVisible);
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
    documentVisible = document.visibilityState !== 'hidden';
    updateAppVisible();
  };

  const markVisible = () => {
    documentVisible = true;
    updateAppVisible();
  };

  document.addEventListener('visibilitychange', syncFromDocument);
  window.addEventListener('focus', markVisible);
  window.addEventListener('pageshow', markVisible);
  syncFromDocument();
  applyVisibilityClass();

  if (isTauriRuntime()) {
    try {
      tauriUnlisten = await listen<boolean>('app:window-visibility', (event) => {
        nativeWindowVisible = Boolean(event.payload);
        updateAppVisible();
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
    document.documentElement.classList.remove('app-backgrounded');
  });
}

void initAppVisibilityBridge();
