import { getProxyPort } from './constants';
import { isTauriRuntime } from './runtime';

const WHITELIST = [
  'localhost',
  '127.0.0.1',
  'tauri.localhost',
  'scproxy.localhost',
  'unpkg.com',
];
const IS_WINDOWS = navigator.userAgent.includes('Windows');
const ENABLED = isTauriRuntime();
const MEDIA_IMAGE_HOSTS = ['sndcdn.com', 'sndcdn.net', 'soundcloudcdn.com'];

function isWhitelisted(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return WHITELIST.some((w) => h === w || h.endsWith(`.${w}`));
  } catch {
    return true;
  }
}

function shouldProxyImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return MEDIA_IMAGE_HOSTS.some((value) => host === value || host.endsWith(`.${value}`));
  } catch {
    return false;
  }
}

// 7.1.0 port: route image requests through the permanent image_cache. Payload
// shape matches `image_cache::handle` — JSON [target_url], base64-wrapped.
// The cache key is the original URL and the local proxy fetches it directly.
function scproxyImageUrl(url: string): string {
  const payload = JSON.stringify([url]);
  const encoded = btoa(payload);
  const proxyPort = getProxyPort();
  if (IS_WINDOWS && proxyPort) {
    return `http://127.0.0.1:${proxyPort}/img/${encoded}`;
  }
  return IS_WINDOWS ? url : `scproxy://localhost/img/${encoded}`;
}

type ProxyImage = HTMLImageElement & { __origSrc?: string; __origRetryDone?: boolean };

// Hook <img>.src — store original URL to enable retry on error
const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
Object.defineProperty(HTMLImageElement.prototype, 'src', {
  set(url: string) {
    if (ENABLED && url?.startsWith('http') && !isWhitelisted(url) && shouldProxyImage(url)) {
      const img = this as ProxyImage;
      img.__origSrc = url;
      img.__origRetryDone = false;
      img.style.display = '';
      url = scproxyImageUrl(url);
    }
    imgSrcDesc.set!.call(this, url);
  },
  get() {
    return imgSrcDesc.get!.call(this);
  },
});

// Global: hide broken images (proxy error, CDN blocked, etc.)
document.addEventListener(
  'error',
  (e) => {
    if (e.target instanceof HTMLImageElement) {
      const img = e.target as ProxyImage;
      const current = img.currentSrc || img.src;
      if (!img.__origRetryDone && img.__origSrc && (current.includes('scproxy.localhost') || current.startsWith('scproxy://'))) {
        img.__origRetryDone = true;
        img.style.display = '';
        imgSrcDesc.set!.call(img, img.__origSrc);
        return;
      }
      img.style.display = 'none';
    }
  },
  true,
);

export {};
