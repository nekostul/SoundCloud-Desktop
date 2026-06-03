import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from './runtime';

type VisibilityListener = () => void;

let documentVisible =
  typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
let nativeWindowVisible = true;
let appVisible = documentVisible && nativeWindowVisible;
let backgrounded = !documentVisible;
const listeners = new Set<VisibilityListener>();
let initialized = false;
let tauriUnlisten: (() => void) | null = null;

function applyVisibilityClass() {
  if (typeof document === 'undefined') return;

  document.documentElement.classList.toggle('app-backgrounded', backgrounded);
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function setAppVisible(nextVisible: boolean) {
  if (appVisible === nextVisible) return;
  appVisible = nextVisible;
}

function updateAppVisible() {
  setAppVisible(documentVisible && nativeWindowVisible);
}

function setBackgrounded(nextBackgrounded: boolean) {
  if (backgrounded === nextBackgrounded) return;
  backgrounded = nextBackgrounded;
  applyVisibilityClass();
}

function updateBackgrounded() {
  // Native occlusion/minimize is too noisy on Windows while fullscreen games
  // are running. Treat only actual document hidden state as "backgrounded"
  // for UI/rAF throttling so we match upstream behavior.
  setBackgrounded(!documentVisible);
}

export function getAppVisibilitySnapshot() {
  return {
    documentVisible,
    nativeWindowVisible,
    appVisible,
    backgrounded,
  };
}

export function isAppVisible() {
  return appVisible;
}

export function isAppBackgrounded() {
  return backgrounded;
}

export function subscribeAppVisibility(listener: VisibilityListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function syncVisibilityState(forceEmit = false) {
  const prevAppVisible = appVisible;
  const prevBackgrounded = backgrounded;

  updateAppVisible();
  updateBackgrounded();

  if (forceEmit || appVisible !== prevAppVisible || backgrounded !== prevBackgrounded) {
    emitChange();
  }
}

async function initAppVisibilityBridge() {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  initialized = true;

  const syncFromDocument = () => {
    documentVisible = document.visibilityState !== 'hidden';
    syncVisibilityState();
  };

  const markVisible = () => {
    documentVisible = true;
    syncVisibilityState();
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
        syncVisibilityState(true);
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
