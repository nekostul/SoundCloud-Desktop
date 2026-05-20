import {
  fetchMediaJson,
  fetchMediaText,
  probeMediaStreamUrl,
  probeRememberedMediaStream,
} from './media-proxy';

export type CdnProbeStatus = 'healthy' | 'degraded';

export interface SoundCloudCdnProbeDetail {
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export interface SoundCloudCdnProbeResult {
  status: CdnProbeStatus;
  healthy: boolean;
  successfulProbes: number;
  totalProbes: number;
  details: SoundCloudCdnProbeDetail[];
}

interface CheckSoundCloudCdnConnectivityOptions {
  useRememberedStream?: boolean;
}

interface SoundCloudMobileNextData {
  runtimeConfig?: {
    clientId?: string | null;
  } | null;
  props?: {
    pageProps?: {
      pageInfo?: {
        pageUrn?: string | null;
      } | null;
      initialStoreState?: {
        entities?: {
          tracks?: Record<
            string,
            | {
                data?: SoundCloudMobileTrack | null;
              }
            | undefined
          > | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface SoundCloudMobileTrack {
  title?: string | null;
  track_authorization?: string | null;
  media?: {
    transcodings?: Array<{
      url?: string | null;
      format?: {
        protocol?: string | null;
      } | null;
    }> | null;
  } | null;
}

const STREAM_PROBE_TIMEOUT_MS = 6500;
const STREAM_PROBE_MIN_BYTES = 48 * 1024;
const PUBLIC_TRACK_PAGE_TIMEOUT_MS = 6500;
const PUBLIC_TRACK_RESOLVE_TIMEOUT_MS = 6500;
const PUBLIC_TRACK_PROBE_PAGES = [
  'https://m.soundcloud.com/preview-s/tksn',
  'https://m.soundcloud.com/digimentrecords/dmr059-mekane-dirty-2',
  'https://m.soundcloud.com/alexsenna/alex-senna-fantasy-world',
] as const;
const INCONCLUSIVE_STREAM_STATUSES = new Set([400, 401, 403, 404, 410, 416]);
const NEXT_DATA_PATTERN =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

function isReachableStatus(status: number): boolean {
  return status >= 200 && status < 500;
}

function extractHttpStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\bHTTP (\d{3})\b/);
  return statusMatch ? Number(statusMatch[1]) : null;
}

async function probeRememberedStream(): Promise<SoundCloudCdnProbeDetail | null> {
  const startedAt = performance.now();

  try {
    const response = await probeRememberedMediaStream({ timeoutMs: STREAM_PROBE_TIMEOUT_MS });
    if (INCONCLUSIVE_STREAM_STATUSES.has(response.status)) {
      return null;
    }

    const enoughBytes = response.bytes_read >= STREAM_PROBE_MIN_BYTES;
    const reachable = isReachableStatus(response.status);

    return {
      url: response.url,
      ok: reachable && enoughBytes,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      error:
        reachable && !enoughBytes
          ? `cache did not progress enough: ${response.bytes_read} bytes`
          : reachable
            ? null
            : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no remembered media URL available')) {
      return null;
    }

    return {
      url: 'remembered-media-stream',
      ok: false,
      status: extractHttpStatus(error),
      latencyMs: Math.round(performance.now() - startedAt),
      error: message,
    };
  }
}

async function resolvePublicTrackStream(pageUrl: string): Promise<{ streamUrl: string }> {
  const html = await fetchMediaText(pageUrl, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
    timeoutMs: PUBLIC_TRACK_PAGE_TIMEOUT_MS,
  });

  const nextDataMatch = html.match(NEXT_DATA_PATTERN);
  if (!nextDataMatch) {
    throw new Error('public track page is missing __NEXT_DATA__');
  }

  const nextData = JSON.parse(nextDataMatch[1]) as SoundCloudMobileNextData;
  const clientId = nextData.runtimeConfig?.clientId?.trim();
  if (!clientId) {
    throw new Error('public track page is missing mobile client_id');
  }

  const pageUrn = nextData.props?.pageProps?.pageInfo?.pageUrn?.trim();
  if (!pageUrn) {
    throw new Error('public track page is missing page URN');
  }

  const track = nextData.props?.pageProps?.initialStoreState?.entities?.tracks?.[pageUrn]?.data;
  if (!track) {
    throw new Error('public track payload is missing');
  }

  const progressiveTranscoding = track.media?.transcodings?.find(
    (transcoding) =>
      transcoding?.format?.protocol === 'progressive' &&
      typeof transcoding.url === 'string' &&
      transcoding.url.trim().length > 0,
  );

  if (!progressiveTranscoding?.url) {
    throw new Error('public track has no progressive transcoding');
  }

  const resolveUrl = new URL(progressiveTranscoding.url);
  resolveUrl.searchParams.set('client_id', clientId);

  const trackAuthorization = track.track_authorization?.trim();
  if (trackAuthorization) {
    resolveUrl.searchParams.set('track_authorization', trackAuthorization);
  }

  const payload = await fetchMediaJson<{ url?: string | null }>(resolveUrl.toString(), {
    accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
    timeoutMs: PUBLIC_TRACK_RESOLVE_TIMEOUT_MS,
  });

  const streamUrl = payload.url?.trim();
  if (!streamUrl) {
    throw new Error('public track resolve payload is missing stream URL');
  }

  return { streamUrl };
}

async function probePublicTrackStream(pageUrl: string): Promise<SoundCloudCdnProbeDetail> {
  const startedAt = performance.now();
  let detailUrl = pageUrl;

  try {
    const resolvedStream = await resolvePublicTrackStream(pageUrl);
    detailUrl = resolvedStream.streamUrl;

    const response = await probeMediaStreamUrl(resolvedStream.streamUrl, {
      timeoutMs: STREAM_PROBE_TIMEOUT_MS,
    });
    const enoughBytes = response.bytes_read >= STREAM_PROBE_MIN_BYTES;
    const reachable = isReachableStatus(response.status);

    return {
      url: response.url || detailUrl,
      ok: reachable && enoughBytes,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      error:
        reachable && !enoughBytes
          ? `cache did not progress enough: ${response.bytes_read} bytes`
          : reachable
            ? null
            : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      url: detailUrl,
      ok: false,
      status: extractHttpStatus(error),
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkSoundCloudCdnConnectivity(
  options: CheckSoundCloudCdnConnectivityOptions = {},
): Promise<SoundCloudCdnProbeResult> {
  const useRememberedStream = options.useRememberedStream ?? true;
  const rememberedStream = useRememberedStream ? await probeRememberedStream() : null;
  if (rememberedStream?.ok) {
    return {
      status: 'healthy',
      healthy: true,
      successfulProbes: 1,
      totalProbes: 1,
      details: [rememberedStream],
    };
  }

  const publicTrackDetails = await Promise.all(
    PUBLIC_TRACK_PROBE_PAGES.map((pageUrl) => probePublicTrackStream(pageUrl)),
  );
  const details = rememberedStream ? [rememberedStream, ...publicTrackDetails] : publicTrackDetails;
  const successfulProbes = details.filter((detail) => detail.ok).length;
  const healthy = publicTrackDetails.some((detail) => detail.ok);

  return {
    status: healthy ? 'healthy' : 'degraded',
    healthy,
    successfulProbes,
    totalProbes: details.length,
    details,
  };
}
