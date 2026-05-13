import { PassThrough, Readable } from 'node:stream';
import { firstValueFrom } from 'rxjs';

export interface ScTranscodingInfo {
  url: string;
  preset?: string;
  duration?: number;
  snipped?: boolean;
  format?: { protocol?: string; mime_type?: string };
  quality?: string;
}

interface PickTranscodingOptions {
  allowEncrypted?: boolean;
  allowPreview?: boolean;
}

const FORMAT_TO_PRESETS: Record<string, string[]> = {
  hls_aac_160: ['aac_160k'],
  hls_aac_96: ['aac_96k'],
  hls_mp3_128: ['mp3_1_0'],
  http_mp3_128: ['mp3_1_0'],
  hls_opus_64: ['opus_0_0'],
};

const PRESET_FALLBACK_ORDER = ['aac_160k', 'aac_96k', 'mp3_1_0', 'opus_0_0', 'abr_sq'];

const MIME_TO_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp4; codecs="mp4a.40.2"': 'audio/mp4',
  'audio/ogg; codecs="opus"': 'audio/ogg',
  'audio/mpegurl': 'audio/mpeg',
};

export function rankTranscodings(
  transcodings: ScTranscodingInfo[],
  preferredFormat?: string,
  options: PickTranscodingOptions = {},
): ScTranscodingInfo[] {
  const allowEncrypted = options.allowEncrypted ?? false;
  const allowPreview = options.allowPreview ?? false;

  const candidates = transcodings.filter((transcoding) => {
    const protocol = transcoding.format?.protocol ?? '';
    const isEncrypted = protocol.includes('encrypted');
    const isPreview = transcoding.url.includes('/preview');

    if (!allowEncrypted && isEncrypted) return false;
    if (!allowPreview && (transcoding.snipped || isPreview)) return false;
    return true;
  });

  if (!candidates.length) return [];

  const preferredPresets = FORMAT_TO_PRESETS[preferredFormat ?? ''] ?? [];
  const preferredProtocol = preferredFormat?.startsWith('http_')
    ? 'progressive'
    : preferredFormat?.startsWith('hls_')
      ? 'hls'
      : null;

  const score = (transcoding: ScTranscodingInfo) => {
    let value = 1000;
    const preset = transcoding.preset ?? '';
    const protocol = transcoding.format?.protocol ?? '';

    if (preferredPresets.includes(preset)) value -= 500;
    if (preferredProtocol === 'progressive' && protocol === 'progressive') value -= 250;
    if (preferredProtocol === 'hls' && protocol !== 'progressive') value -= 250;

    const presetIndex = PRESET_FALLBACK_ORDER.indexOf(preset);
    value += presetIndex === -1 ? PRESET_FALLBACK_ORDER.length + 10 : presetIndex;

    if (transcoding.quality === 'hq') value -= 5;
    return value;
  };

  return [...candidates].sort((left, right) => score(left) - score(right));
}

export function pickTranscoding(
  transcodings: ScTranscodingInfo[],
  preferredFormat?: string,
  options?: PickTranscodingOptions,
): ScTranscodingInfo | null {
  return rankTranscodings(transcodings, preferredFormat, options)[0] ?? null;
}

export function getContentTypeForMime(mimeType: string): string {
  return MIME_TO_CONTENT_TYPE[mimeType] ?? 'application/octet-stream';
}

function proxyTarget(
  targetUrl: string,
  extra: Record<string, string> = {},
): { url: string; headers: Record<string, string> } {
  return { url: targetUrl, headers: extra };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [300, 800, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type HlsHttpService = { get: (...args: any[]) => any };

async function proxyGetWithRetry<T = unknown>(
  httpService: HlsHttpService,
  targetUrl: string,
  extra: Record<string, string> = {},
  config: Record<string, unknown> = {},
): Promise<{ data: T; headers: Record<string, string> }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { url, headers } = proxyTarget(targetUrl, extra);
    try {
      const response = (await firstValueFrom(httpService.get(url, { ...config, headers }))) as {
        data: T;
        headers?: Record<string, string>;
      };
      return { data: response.data, headers: response.headers ?? {} };
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status ?? error?.status;
      if (status && !isRetryableStatus(status)) {
        throw error;
      }
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAYS[attempt] ?? 2000);
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${targetUrl}`);
}

function parseM3u8(content: string, baseUrl: string): { initUrl: string | null; segmentUrls: string[] } {
  const lines = content.split('\n').map((line) => line.trim());
  let initUrl: string | null = null;
  const segmentUrls: string[] = [];
  const base = new URL(baseUrl);

  for (const line of lines) {
    const mapMatch = line.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (mapMatch) {
      initUrl = resolveSegmentUrl(mapMatch[1], base);
      continue;
    }
    if (line.startsWith('#') || !line) continue;
    segmentUrls.push(resolveSegmentUrl(line, base));
  }

  return { initUrl, segmentUrls };
}

function resolveSegmentUrl(url: string, base: URL): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, base).href;
}

const HLS_PREFETCH_SEGMENTS = 3;

async function downloadSegment(
  httpService: HlsHttpService,
  segmentUrl: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const { data } = await proxyGetWithRetry<ArrayBuffer>(
    httpService,
    segmentUrl,
    headers,
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(data);
}

async function pipeSegments(
  httpService: HlsHttpService,
  output: PassThrough,
  initSegmentPromise: Promise<Buffer | null>,
  segmentUrls: string[],
  headers: Record<string, string>,
): Promise<void> {
  const initSegment = await initSegmentPromise;
  if (initSegment) {
    if (initSegment.includes(Buffer.from('enca'))) {
      throw new Error('Stream is CENC encrypted');
    }
    if (!output.writable) return;
    output.write(initSegment);
  }

  const inflight: Array<Promise<Buffer>> = [];
  let nextIndex = 0;

  const fillQueue = () => {
    while (nextIndex < segmentUrls.length && inflight.length < HLS_PREFETCH_SEGMENTS) {
      inflight.push(downloadSegment(httpService, segmentUrls[nextIndex], headers));
      nextIndex += 1;
    }
  };

  fillQueue();

  while (inflight.length > 0) {
    const chunk = await inflight.shift()!;
    if (!output.writable) break;
    output.write(chunk);
    fillQueue();
  }
  output.end();
}

export async function streamFromHls(
  httpService: HlsHttpService,
  m3u8Url: string,
  mimeType: string,
  headers: Record<string, string> = {},
): Promise<{ stream: Readable; headers: Record<string, string> }> {
  const { data: m3u8Content } = await proxyGetWithRetry<string>(
    httpService,
    m3u8Url,
    headers,
    { responseType: 'text' },
  );

  const { initUrl, segmentUrls } = parseM3u8(m3u8Content, m3u8Url);
  if (!segmentUrls.length) {
    throw new Error('No segments found in m3u8 playlist');
  }

  const initSegmentPromise = initUrl
    ? downloadSegment(httpService, initUrl, headers)
    : Promise.resolve<Buffer | null>(null);

  const passthrough = new PassThrough();
  pipeSegments(httpService, passthrough, initSegmentPromise, segmentUrls, headers).catch((error) => {
    passthrough.destroy(error);
  });

  return { stream: passthrough, headers: { 'content-type': getContentTypeForMime(mimeType) } };
}
