import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { isTauriRuntime } from './runtime';

export type MediaProxyMode = 'off' | 'manual';

export type MediaProxyStatus = {
  mode: MediaProxyMode | string;
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
};

type MediaProxySettingsPayload = {
  mode: MediaProxyMode;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
};

type MediaHttpResponse = {
  status: number;
  content_type?: string;
  body: string;
};

type MediaHttpHeadResponse = {
  status: number;
  content_type?: string;
  body?: string;
};

type MediaStreamProbeResponse = {
  url: string;
  status: number;
  bytes_read: number;
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

  await listen<MediaProxyStatus>('media-proxy:status', (event) => {
    lastStatus = event.payload;
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
    return status;
  } catch {
    return lastStatus;
  }
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

export async function probeMediaHead(
  url: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<MediaHttpHeadResponse> {
  if (!isTauriRuntime()) {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: options?.headers,
      signal:
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
    });
    return {
      status: response.status,
      content_type: response.headers.get('content-type') || '',
    };
  }

  return await invoke<MediaHttpHeadResponse>('media_proxy_http_head', {
    url,
    headers: options?.headers,
    timeoutMs: options?.timeoutMs,
  });
}

export async function probeRememberedMediaStream(options?: {
  timeoutMs?: number;
}): Promise<MediaStreamProbeResponse> {
  if (!isTauriRuntime()) {
    throw new Error('stream probe is only available in Tauri runtime');
  }

  return await invoke<MediaStreamProbeResponse>('media_proxy_probe_stream', {
    timeoutMs: options?.timeoutMs,
  });
}

export async function probeMediaStreamUrl(
  url: string,
  options?: {
    timeoutMs?: number;
  },
): Promise<MediaStreamProbeResponse> {
  if (!isTauriRuntime()) {
    throw new Error('stream probe is only available in Tauri runtime');
  }

  return await invoke<MediaStreamProbeResponse>('media_proxy_probe_stream_url', {
    url,
    timeoutMs: options?.timeoutMs,
  });
}
