import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import i18n from '../i18n';
import {
  useSettingsStore,
  type LastKnownWorkingMediaProxy,
  type MediaProxyRouting,
  type MediaProxyTypeLabel,
} from '../stores/settings';
import { isTauriRuntime } from './runtime';

export type MediaProxyMode = 'off' | 'auto' | 'manual';

type MediaProxySnapshot = {
  mode: MediaProxyMode;
  routing: MediaProxyRouting;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  proxy_type: MediaProxyTypeLabel;
  latency_ms?: number | null;
  throughput_kbps?: number | null;
  last_checked_at?: number | null;
};

export type MediaProxyStatus = {
  mode: MediaProxyMode;
  routing: 'direct' | 'proxy' | string;
  state: string;
  proxy_type?: string | null;
  endpoint?: string | null;
  latency_ms?: number | null;
  throughput_kbps?: number | null;
  proxy_pool_size: number;
  last_checked_at?: number | null;
  message?: string | null;
  message_key?: string | null;
  message_args?: Record<string, string> | null;
  last_known_working_proxy?: MediaProxySnapshot | null;
};

type MediaProxySettingsPayload = {
  mode: MediaProxyMode;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  last_known_working_proxy?: MediaProxySnapshot | null;
};

type MediaHttpResponse = {
  status: number;
  content_type?: string;
  body: string;
};

let listenersReady = false;
let lastStatus: MediaProxyStatus | null = null;
let applyInFlightKey: string | null = null;
let applyInFlight: Promise<MediaProxyStatus | null> | null = null;
let lastAppliedKey: string | null = null;
let lastAppliedAt = 0;

function hasInlineProxyPort(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (trimmed.startsWith('[')) return /\]:\d{1,5}$/.test(trimmed);

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return false;

  return /^\d{1,5}$/.test(trimmed.slice(lastColon + 1));
}

function toMediaProxySnapshot(
  proxy: LastKnownWorkingMediaProxy | null,
): MediaProxySnapshot | null {
  if (!proxy) return null;

  return {
    mode: proxy.mode,
    routing: proxy.routing,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || null,
    password: proxy.password || null,
    proxy_type: proxy.proxyType,
    latency_ms: proxy.latencyMs,
    throughput_kbps: proxy.throughputKbps,
    last_checked_at: proxy.lastCheckedAt,
  };
}

function fromMediaProxySnapshot(
  snapshot: MediaProxySnapshot | null | undefined,
): LastKnownWorkingMediaProxy | null {
  if (!snapshot) return null;

  const host = snapshot.host.trim();
  if (!host || !Number.isFinite(snapshot.port) || snapshot.port <= 0) {
    return null;
  }

  return {
    mode: snapshot.mode,
    routing: snapshot.routing === 'proxy' ? 'proxy' : 'direct',
    host,
    port: snapshot.port,
    username: snapshot.username?.trim() || '',
    password: snapshot.password || '',
    proxyType: snapshot.proxy_type,
    latencyMs: typeof snapshot.latency_ms === 'number' ? snapshot.latency_ms : null,
    throughputKbps: typeof snapshot.throughput_kbps === 'number' ? snapshot.throughput_kbps : null,
    lastCheckedAt: typeof snapshot.last_checked_at === 'number' ? snapshot.last_checked_at : null,
  };
}

function syncLastKnownWorkingProxy(status: MediaProxyStatus | null) {
  if (!status) return;

  if (status.mode !== 'auto') return;

  const snapshot = fromMediaProxySnapshot(status.last_known_working_proxy);
  if (!snapshot) return;

  useSettingsStore.setState({ lastKnownWorkingMediaProxy: snapshot });
}

export function rememberLastKnownWorkingMediaProxy(
  status: MediaProxyStatus | null | undefined,
): void {
  if (!status || status.mode !== 'auto') return;

  const snapshot = fromMediaProxySnapshot(status.last_known_working_proxy);
  if (!snapshot) return;

  useSettingsStore.setState({ lastKnownWorkingMediaProxy: snapshot });
}

function buildPayloadFromStore(): MediaProxySettingsPayload {
  const state = useSettingsStore.getState();
  const trimmedHost = state.mediaProxyHost.trim();
  const trimmedPort = state.mediaProxyPort.trim();
  const port = Number(trimmedPort);
  const useInlinePort = state.mediaProxyMode === 'manual' && hasInlineProxyPort(trimmedHost);
  const resolvedPort =
    state.mediaProxyMode === 'manual'
      ? null
      : useInlinePort
        ? null
        : Number.isFinite(port) && port > 0
          ? port
          : null;

  return {
    mode: state.mediaProxyMode,
    host: trimmedHost || null,
    port: resolvedPort,
    username: state.mediaProxyUsername.trim() || null,
    password: state.mediaProxyPassword || null,
    last_known_working_proxy:
      state.mediaProxyMode === 'auto'
        ? toMediaProxySnapshot(state.lastKnownWorkingMediaProxy)
        : null,
  };
}

function buildPayloadKey(payload: MediaProxySettingsPayload): string {
  return JSON.stringify(payload);
}

export function resolveMediaProxyStatusMessage(
  status: MediaProxyStatus | null | undefined,
): string | null {
  if (!status) return null;
  if (status.message_key) {
    return i18n.t(status.message_key, status.message_args ?? undefined);
  }

  const rawMessage = status.message?.trim();
  return rawMessage || null;
}

export async function initMediaProxyRuntime() {
  if (!isTauriRuntime() || listenersReady) return;
  listenersReady = true;

  await listen<MediaProxyStatus>('media-proxy:auto-fallback', (event) => {
    lastStatus = event.payload;
    syncLastKnownWorkingProxy(event.payload);
    toast.message(
      resolveMediaProxyStatusMessage(event.payload) ??
        i18n.t('settings.mediaProxyNoticeAutoFallback'),
    );
  }).catch(console.error);

  await listen<MediaProxyStatus>('media-proxy:status', (event) => {
    lastStatus = event.payload;
    syncLastKnownWorkingProxy(event.payload);
  }).catch(console.error);
}

export async function applyMediaProxySettings(): Promise<MediaProxyStatus | null> {
  if (!isTauriRuntime()) return null;
  const payload = buildPayloadFromStore();
  const payloadKey = buildPayloadKey(payload);
  const now = Date.now();

  if (applyInFlight && applyInFlightKey === payloadKey) {
    return applyInFlight;
  }

  if (lastStatus && lastAppliedKey === payloadKey && now - lastAppliedAt < 1500) {
    return lastStatus;
  }

  const request = invoke<MediaProxyStatus>('media_proxy_apply_settings', {
    settings: payload,
  })
    .then((status) => {
      lastStatus = status;
      syncLastKnownWorkingProxy(status);
      lastAppliedKey = payloadKey;
      lastAppliedAt = Date.now();
      return status;
    })
    .finally(() => {
      if (applyInFlight === request) {
        applyInFlight = null;
        applyInFlightKey = null;
      }
    });

  applyInFlight = request;
  applyInFlightKey = payloadKey;
  return request;
}

export async function getMediaProxyStatus(): Promise<MediaProxyStatus | null> {
  if (!isTauriRuntime()) return lastStatus;
  try {
    const status = await invoke<MediaProxyStatus>('media_proxy_get_status');
    lastStatus = status;
    syncLastKnownWorkingProxy(status);
    return status;
  } catch {
    return lastStatus;
  }
}

export async function refreshMediaProxyPool(): Promise<MediaProxyStatus | null> {
  if (!isTauriRuntime()) return null;
  const status = await invoke<MediaProxyStatus>('media_proxy_refresh_auto');
  lastStatus = status;
  syncLastKnownWorkingProxy(status);
  return status;
}

async function mediaProxyHttpGet(
  url: string,
  options?: {
    accept?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<MediaHttpResponse> {
  if (!isTauriRuntime()) {
    const response = await fetch(url, {
      method: 'GET',
      headers: options?.headers,
      signal:
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
    });
    return {
      status: response.status,
      content_type: response.headers.get('content-type') || '',
      body: await response.text(),
    };
  }

  return await invoke<MediaHttpResponse>('media_proxy_http_get', {
    url,
    accept: options?.accept,
    headers: options?.headers,
    timeoutMs: options?.timeoutMs,
  });
}

export async function fetchMediaText(
  url: string,
  options?: {
    accept?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<string> {
  const response = await mediaProxyHttpGet(url, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.body;
}

export async function fetchMediaJson<T>(
  url: string,
  options?: {
    accept?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<T> {
  return JSON.parse(await fetchMediaText(url, options)) as T;
}
