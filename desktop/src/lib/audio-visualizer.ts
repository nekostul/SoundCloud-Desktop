import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isAppVisible, subscribeAppVisibility } from './app-visibility';
import { isTauriRuntime } from './runtime';

type AudioVisualizerListener = (bins: readonly number[]) => void;

const listeners = new Set<AudioVisualizerListener>();

let nativeUnlisten: (() => void) | null = null;
let visibilityUnsubscribe: (() => void) | null = null;
let nativeListenerPending: Promise<void> | null = null;
let lastNativeEnabled: boolean | null = null;

function emitBins(bins: readonly number[]) {
  for (const listener of listeners) {
    listener(bins);
  }
}

function shouldEnableNativeVisualizer() {
  return listeners.size > 0 && isAppVisible();
}

async function syncNativeVisualizerEnabled(force = false) {
  if (!isTauriRuntime()) return;

  const enabled = shouldEnableNativeVisualizer();
  if (!force && lastNativeEnabled === enabled) return;

  lastNativeEnabled = enabled;

  try {
    await invoke('audio_set_visualizer_enabled', { enabled });
  } catch (error) {
    console.warn('[AudioVisualizer] Failed to update native visualizer state', error);
  }
}

async function ensureNativeListener() {
  if (!isTauriRuntime() || nativeUnlisten || nativeListenerPending || listeners.size === 0) {
    void syncNativeVisualizerEnabled();
    return;
  }

  nativeListenerPending = listen<number[]>('audio:visualizer', (event) => {
    const bins = event.payload;
    if (!bins?.length) return;
    emitBins(bins);
  })
    .then((unlisten) => {
      nativeUnlisten = unlisten;
    })
    .catch((error) => {
      console.warn('[AudioVisualizer] Failed to subscribe to audio:visualizer', error);
    })
    .finally(() => {
      nativeListenerPending = null;
      void syncNativeVisualizerEnabled(true);
    });
}

function ensureVisibilitySubscription() {
  if (visibilityUnsubscribe) return;

  visibilityUnsubscribe = subscribeAppVisibility(() => {
    void syncNativeVisualizerEnabled();
  });
}

function cleanupNativeListener() {
  nativeUnlisten?.();
  nativeUnlisten = null;
  visibilityUnsubscribe?.();
  visibilityUnsubscribe = null;
}

export function subscribeAudioVisualizer(listener: AudioVisualizerListener) {
  listeners.add(listener);
  ensureVisibilitySubscription();
  void ensureNativeListener();

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      cleanupNativeListener();
    }

    void syncNativeVisualizerEnabled(true);
  };
}

import.meta.hot?.dispose(() => {
  cleanupNativeListener();
  listeners.clear();
  lastNativeEnabled = null;
  void syncNativeVisualizerEnabled(true);
});
