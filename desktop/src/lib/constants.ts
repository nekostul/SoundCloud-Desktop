export const LOCAL_API_BASE = (
  import.meta.env.VITE_LOCAL_API_BASE || 'http://localhost:3000'
).replace(/\/$/, '');
export const DEFAULT_API_BASE = LOCAL_API_BASE;

export function normalizeApiBase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return url.origin.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function getApiBase() {
  return LOCAL_API_BASE;
}

export function buildApiUrl(path: string) {
  return `${getApiBase()}${path}`;
}

export const GITHUB_OWNER = 'nekostul';
export const GITHUB_REPO = 'SoundCloud-Desktop';
export const GITHUB_REPO_EN = 'SoundCloud-Desktop-EN';
export const APP_VERSION = __APP_VERSION__;

let _staticPort: number | null = null;
let _proxyPort: number | null = null;

export function setServerPorts(staticP: number, proxy: number) {
  _staticPort = staticP;
  _proxyPort = proxy;
}

export function getStaticPort(): number | null {
  return _staticPort;
}

export function getProxyPort(): number | null {
  return _proxyPort;
}
