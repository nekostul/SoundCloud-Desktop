import { PassThrough, Readable } from 'node:stream';
import { Agent as HttpsAgent } from 'node:https';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { ScTokenResponse } from './soundcloud.types.js';

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const API_BASE = 'https://api.soundcloud.com';
const AUTH_BASE = 'https://secure.soundcloud.com';
const CONNECT_BASE = 'https://soundcloud.com';
const STREAM_PROXY_MAX_RETRIES = 3;
const STREAM_PROXY_RETRY_DELAYS_MS = [300, 800, 2000];
const PROGRESSIVE_PROXY_CHUNK_SIZE = 1024 * 1024;
const PROGRESSIVE_PROXY_HTTPS_AGENT = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 32,
  maxFreeSockets: 8,
});

function isRetryableStreamStatus(status: number | null | undefined): boolean {
  return typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedByteRange {
  start: number;
  end: number | null;
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number | null;
}

function parseByteRange(range?: string): ParsedByteRange | null {
  if (!range) return null;
  const match = range.trim().match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return null;
  return {
    start: Number.parseInt(match[1], 10),
    end: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}

function parseContentRange(value?: string): ParsedContentRange | null {
  if (!value) return null;
  const match = value.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number.parseInt(match[1], 10),
    end: Number.parseInt(match[2], 10),
    total: match[3] === '*' ? null : Number.parseInt(match[3], 10),
  };
}

@Injectable()
export class SoundcloudService {
  private readonly defaultAccessToken: string;
  private readonly defaultClientId: string;
  private readonly defaultRedirectUri: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.defaultAccessToken = this.configService.get<string>('soundcloud.accessToken')?.trim() ?? '';
    this.defaultClientId = this.configService.get<string>('soundcloud.clientId')!;
    this.defaultRedirectUri = this.configService.get<string>('soundcloud.redirectUri')!;
  }

  get scAuthBaseUrl() {
    return AUTH_BASE;
  }

  get scConnectBaseUrl() {
    return CONNECT_BASE;
  }

  get scDefaultClientId() {
    return this.defaultClientId;
  }

  get scDefaultAccessToken() {
    return this.defaultAccessToken;
  }

  get scDefaultRedirectUri() {
    return this.defaultRedirectUri;
  }

  resolveAccessToken(accessToken?: string | null): string {
    const resolved = accessToken?.trim() || this.defaultAccessToken;
    if (!resolved) {
      throw new Error('SoundCloud OAuth access token is not configured');
    }
    return resolved;
  }

  buildAuthorizationHeaders(
    accessToken?: string | null,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      ...extra,
      Authorization: `OAuth ${this.resolveAccessToken(accessToken)}`,
    };
  }

  // ─── Auth ──────────────────────────────────────────────────

  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    creds: OAuthCredentials,
  ): Promise<ScTokenResponse> {
    const { data } = await firstValueFrom(
      this.httpService.post<ScTokenResponse>(
        `${AUTH_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          redirect_uri: creds.redirectUri,
          code_verifier: codeVerifier,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json; charset=utf-8',
          },
        },
      ),
    );
    return data;
  }

  async refreshAccessToken(
    refreshToken: string,
    creds: OAuthCredentials,
  ): Promise<ScTokenResponse> {
    const { data } = await firstValueFrom(
      this.httpService.post<ScTokenResponse>(
        `${AUTH_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: refreshToken,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json; charset=utf-8',
          },
        },
      ),
    );
    return data;
  }

  async signOut(accessToken: string): Promise<void> {
    await firstValueFrom(
      this.httpService.post(`${AUTH_BASE}/sign-out`, JSON.stringify({ access_token: accessToken }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json; charset=utf-8',
        },
      }),
    ).catch(() => {});
  }

  // ─── API ───────────────────────────────────────────────────

  async apiGet<T>(
    path: string,
    accessToken?: string | null,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
      : undefined;
    const target = new URL(`${API_BASE}${path}`);
    if (cleanParams) {
      for (const [k, v] of Object.entries(cleanParams)) {
        target.searchParams.set(k, String(v));
      }
    }

    const { data } = await firstValueFrom(
      this.httpService.get<T>(target.toString(), {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
        }),
      }),
    );
    return data;
  }

  async apiGetByUrl<T>(
    targetUrl: string,
    accessToken?: string | null,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
      : undefined;
    const target = new URL(targetUrl);
    if (cleanParams) {
      for (const [key, value] of Object.entries(cleanParams)) {
        target.searchParams.set(key, String(value));
      }
    }

    const { data } = await firstValueFrom(
      this.httpService.get<T>(target.toString(), {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
        }),
      }),
    );
    return data;
  }

  async resolveRedirectLocation(
    targetUrl: string,
    accessToken?: string | null,
    params?: Record<string, unknown>,
  ): Promise<string | null> {
    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
      : undefined;
    const target = new URL(targetUrl);
    if (cleanParams) {
      for (const [key, value] of Object.entries(cleanParams)) {
        target.searchParams.set(key, String(value));
      }
    }

    const response = await firstValueFrom(
      this.httpService.get(target.toString(), {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
        }),
        maxRedirects: 0,
        validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
      }),
    );

    const locationHeader =
      (response.headers.location as string | undefined) ??
      (response.headers.Location as string | undefined);
    if (locationHeader?.trim()) {
      return locationHeader.trim();
    }

    const data = response.data as { location?: unknown; url?: unknown } | string | null | undefined;
    if (data && typeof data === 'object') {
      if (typeof data.location === 'string' && data.location.trim()) {
        return data.location.trim();
      }
      if (typeof data.url === 'string' && data.url.trim()) {
        return data.url.trim();
      }
    }

    return null;
  }

  async apiPost<T>(
    path: string,
    accessToken?: string | null,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const { data } = await firstValueFrom(
      this.httpService.post<T>(`${API_BASE}${path}`, body, {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
          'Content-Type': 'application/json; charset=utf-8',
          ...((config?.headers as Record<string, string> | undefined) ?? {}),
        }),
      }),
    );
    return data;
  }

  async apiPut<T>(
    path: string,
    accessToken?: string | null,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const { data } = await firstValueFrom(
      this.httpService.put<T>(`${API_BASE}${path}`, body, {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
          'Content-Type': 'application/json; charset=utf-8',
          ...((config?.headers as Record<string, string> | undefined) ?? {}),
        }),
      }),
    );
    return data;
  }

  async apiDelete<T>(path: string, accessToken?: string | null): Promise<T> {
    const { data, status } = await firstValueFrom(
      this.httpService.delete<T>(`${API_BASE}${path}`, {
        headers: this.buildAuthorizationHeaders(accessToken, {
          Accept: 'application/json; charset=utf-8',
        }),
        validateStatus: (s) => s >= 200 && s < 300,
      }),
    );
    return status === 204 || data == null || data === '' ? (null as T) : data;
  }

  // ─── Stream ────────────────────────────────────────────────

  async proxyStream(
    streamUrl: string,
    accessToken?: string | null,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> }> {
    const requestedRange = parseByteRange(range);
    const startOffset = requestedRange?.start ?? 0;
    const firstChunkEnd =
      requestedRange?.end != null
        ? Math.min(startOffset + PROGRESSIVE_PROXY_CHUNK_SIZE - 1, requestedRange.end)
        : startOffset + PROGRESSIVE_PROXY_CHUNK_SIZE - 1;

    const firstChunk = await this.fetchProgressiveChunk(
      streamUrl,
      accessToken,
      startOffset,
      firstChunkEnd,
    );

    const firstRange = parseContentRange(firstChunk.headers['content-range']);
    const totalSize =
      firstRange?.total ??
      (firstChunk.headers['content-length']
        ? Number.parseInt(firstChunk.headers['content-length'], 10)
        : null);
    const contentType = firstChunk.headers['content-type'] ?? 'application/octet-stream';
    const actualStart = firstRange?.start ?? startOffset;
    const actualEnd = firstRange?.end ?? actualStart + firstChunk.chunk.length - 1;
    const finalEnd =
      requestedRange?.end ??
      (totalSize != null ? Math.max(actualEnd, totalSize - 1) : actualEnd);

    const passthrough = new PassThrough();
    const responseHeaders: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
    };

    if (requestedRange) {
      const total = totalSize ?? actualEnd + 1;
      responseHeaders['content-range'] = `bytes ${actualStart}-${finalEnd}/${total}`;
      responseHeaders['content-length'] = String(finalEnd - actualStart + 1);
    } else if (totalSize != null) {
      responseHeaders['content-length'] = String(totalSize - actualStart);
    }

    void (async () => {
      try {
        if (!passthrough.writable) return;
        passthrough.write(firstChunk.chunk);

        let nextStart = actualEnd + 1;
        while (passthrough.writable && nextStart <= finalEnd) {
          const nextEnd = Math.min(nextStart + PROGRESSIVE_PROXY_CHUNK_SIZE - 1, finalEnd);
          const nextChunk = await this.fetchProgressiveChunk(
            streamUrl,
            accessToken,
            nextStart,
            nextEnd,
          );
          if (!nextChunk.chunk.length) {
            break;
          }

          passthrough.write(nextChunk.chunk);

          const nextRangeInfo = parseContentRange(nextChunk.headers['content-range']);
          const nextActualEnd =
            nextRangeInfo?.end ?? nextStart + nextChunk.chunk.length - 1;
          nextStart = nextActualEnd + 1;

          if (totalSize != null && nextActualEnd >= totalSize - 1) {
            break;
          }
        }

        passthrough.end();
      } catch (error: unknown) {
        passthrough.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return { stream: passthrough, headers: responseHeaders };
  }

  private async fetchProgressiveChunk(
    streamUrl: string,
    accessToken: string | null | undefined,
    start: number,
    end: number,
  ): Promise<{ chunk: Buffer; headers: Record<string, string> }> {
    const extra = this.buildAuthorizationHeaders(accessToken, {
      Range: `bytes=${start}-${end}`,
      Connection: 'close',
    });

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= STREAM_PROXY_MAX_RETRIES; attempt++) {
      try {
        const response = await this.httpService.axiosRef.get<ArrayBuffer>(streamUrl, {
          headers: extra,
          responseType: 'arraybuffer',
          httpsAgent: PROGRESSIVE_PROXY_HTTPS_AGENT,
          maxRedirects: 5,
          validateStatus: (status) => status === 200 || status === 206,
        });

        const responseHeaders: Record<string, string> = {};
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = response.headers[key];
          if (value) responseHeaders[key] = String(value);
        }

        return { chunk: Buffer.from(response.data), headers: responseHeaders };
      } catch (error: unknown) {
        lastError = error;
        const status =
          (error as { response?: { status?: unknown }; status?: unknown })?.response?.status ??
          (error as { response?: { status?: unknown }; status?: unknown })?.status;

        if (!isRetryableStreamStatus(typeof status === 'number' ? status : null)) {
          throw error;
        }

        if (attempt < STREAM_PROXY_MAX_RETRIES) {
          await sleep(STREAM_PROXY_RETRY_DELAYS_MS[attempt] ?? 2000);
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch progressive chunk ${start}-${end}`);
  }
}
