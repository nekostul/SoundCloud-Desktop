import type { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  rankTranscodings,
  streamFromHls,
  type ScTranscodingInfo,
} from '../soundcloud/sc-stream-utils.js';
import { SoundcloudService } from '../soundcloud/soundcloud.service.js';
import type {
  ScComment,
  ScPaginatedResponse,
  ScStreams,
  ScTrack,
  ScUser,
} from '../soundcloud/soundcloud.types.js';

@Injectable()
export class TracksService {
  private readonly logger = new Logger(TracksService.name);
  private hqOauthDisabledUntil = 0;
  private readonly qwenAsrUrl: string;
  private readonly qwenAsrKey: string;

  constructor(
    private readonly sc: SoundcloudService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.qwenAsrUrl = this.configService.get<string>('lyrics.qwenAsrUrl')?.trim() ?? '';
    this.qwenAsrKey = this.configService.get<string>('lyrics.qwenAsrKey')?.trim() ?? '';
  }

  search(token: string, params?: Record<string, unknown>): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet('/tracks', token, params);
  }

  getById(token: string, trackUrn: string, params?: Record<string, unknown>): Promise<ScTrack> {
    return this.sc.apiGet(`/tracks/${trackUrn}`, token, params);
  }

  update(token: string, trackUrn: string, body: unknown): Promise<ScTrack> {
    return this.sc.apiPut(`/tracks/${trackUrn}`, token, body);
  }

  delete(token: string, trackUrn: string): Promise<unknown> {
    return this.sc.apiDelete(`/tracks/${trackUrn}`, token);
  }

  getStreams(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScStreams> {
    return this.sc.apiGet(`/tracks/${trackUrn}/streams`, token, params);
  }

  proxyStream(
    token: string,
    url: string,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> }> {
    return this.sc.proxyStream(url, token, range);
  }

  async syncLyricsWithQwen(
    token: string,
    trackUrn: string,
    plainLyrics: string,
    artist?: string,
    title?: string,
    format = 'http_mp3_128',
  ): Promise<unknown> {
    if (!this.qwenAsrUrl) {
      throw new ServiceUnavailableException('Qwen aligner is not configured');
    }

    const streamData = await this.getStreamWithFallback(
      token,
      trackUrn,
      format,
      {},
      undefined,
      true,
    );
    if (!streamData) {
      throw new NotFoundException('Track not available for ASR sync');
    }

    const audioBuffer = await this.readStreamToBuffer(streamData.stream);
    const audioArrayBuffer = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength,
    ) as ArrayBuffer;
    const contentType = streamData.headers['content-type'] || 'audio/mpeg';
    const form = new FormData();
    const fileName = `${trackUrn.replace(/[^a-z0-9_-]+/gi, '_')}.${this.extensionFromMime(contentType)}`;

    form.append('audio', new Blob([audioArrayBuffer], { type: contentType }), fileName);
    form.append('lyrics', plainLyrics);
    form.append('plainLyrics', plainLyrics);
    form.append('trackUrn', trackUrn);
    if (artist) form.append('artist', artist);
    if (title) form.append('title', title);

    const headers: Record<string, string> = {};
    if (this.qwenAsrKey) {
      headers.authorization = `Bearer ${this.qwenAsrKey}`;
      headers['x-api-key'] = this.qwenAsrKey;
    }

    form.append('language', 'Russian');
    form.append('mode', 'forced_alignment');
    form.append('format', 'words');

    const response = await fetch(this.qwenAsrUrl, {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BadGatewayException(
        `Qwen aligner failed: ${response.status}${body ? ` ${body}` : ''}`,
      );
    }

    const responseType = response.headers.get('content-type') || '';
    if (responseType.includes('application/json')) {
      return await response.json();
    }

    return await response.text();
  }

  async getStreamWithFallback(
    token: string,
    trackUrn: string,
    format: string,
    params: Record<string, unknown>,
    range?: string,
    hq = false,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    try {
      const track = await this.sc.apiGet<ScTrack>(`/tracks/${trackUrn}`, token, params);
      if (track.access === 'blocked') {
        return null;
      }

      const mediaStream = await this.tryTrackMediaStream(token, track, format, range);
      if (mediaStream) {
        return mediaStream;
      }

      return await this.tryOfficialStreamsFallback(
        token,
        trackUrn,
        track,
        format,
        params,
        range,
        hq,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Official SoundCloud stream flow failed for ${trackUrn}: ${message}`);
      return null;
    }
  }

  async tryOAuthStream(
    token: string,
    trackUrn: string,
    format: string,
    params: Record<string, unknown>,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    try {
      const track = await this.sc.apiGet<ScTrack>(`/tracks/${trackUrn}`, token, params);
      if (track.access === 'blocked') {
        return null;
      }

      const mediaStream = await this.tryTrackMediaStream(token, track, format, range);
      if (mediaStream) {
        return mediaStream;
      }

      return await this.tryOfficialStreamsFallback(
        token,
        trackUrn,
        track,
        format,
        params,
        range,
        false,
      );
    } catch {
      return null;
    }
  }

  private async tryTrackMediaStream(
    token: string,
    track: ScTrack,
    format: string,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    const transcodings = rankTranscodings(track.media?.transcodings ?? [], format, {
      allowPreview: track.access === 'preview',
    });

    if (!transcodings.length) {
      return null;
    }

    for (const transcoding of transcodings) {
      const quality = this.qualityFromTranscoding(transcoding);
      if (quality === 'hq' && Date.now() < this.hqOauthDisabledUntil) {
        continue;
      }

      try {
        const streamUrl = await this.resolveTranscodingUrl(token, transcoding.url);
        const result = await this.loadResolvedTranscoding(token, streamUrl, transcoding, range);
        return this.withStreamQuality(result, quality);
      } catch (err: unknown) {
        this.handleHqFailure(transcoding.preset ?? transcoding.url, quality, err);
      }
    }

    return null;
  }

  private async tryOfficialStreamsFallback(
    token: string,
    trackUrn: string,
    track: ScTrack,
    format: string,
    params: Record<string, unknown>,
    range: string | undefined,
    hq: boolean,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    try {
      const streams = await this.getTrackStreams(token, trackUrn, track, params);
      const candidates = this.buildStreamCandidates(streams, format, hq, track.access === 'preview');

      for (const { key, url } of candidates) {
        const fmt = String(key).replace('_url', '');
        const quality = this.qualityFromStreamKey(key);

        if (quality === 'hq' && Date.now() < this.hqOauthDisabledUntil) {
          continue;
        }

        try {
          if (fmt.startsWith('hls_')) {
            const result = await streamFromHls(
              this.httpService,
              url,
              this.hlsMimeType(fmt),
              this.sc.buildAuthorizationHeaders(token),
            );
            return this.withStreamQuality(result, quality);
          }

          const result = await this.proxyStream(token, url, range);
          return this.withStreamQuality(result, quality);
        } catch (err: unknown) {
          this.handleHqFailure(fmt, quality, err);
        }
      }

      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Official streams fallback failed for ${trackUrn}: ${message}`);
      return null;
    }
  }

  private async getTrackStreams(
    token: string,
    trackUrn: string,
    track: ScTrack,
    params: Record<string, unknown>,
  ): Promise<ScStreams> {
    try {
      return await this.getStreams(token, trackUrn, params);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Official /tracks/${trackUrn}/streams lookup failed: ${message}`);
    }

    if (track.stream_url) {
      try {
        const previewUrl = await this.sc.resolveRedirectLocation(track.stream_url, token, params);
        if (previewUrl) {
          return { preview_mp3_128_url: previewUrl };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Track stream_url fallback failed for ${trackUrn}: ${message}`);
      }
    }

    throw new Error(`No stream URLs available for ${trackUrn}`);
  }

  private buildStreamCandidates(
    streams: ScStreams,
    format: string,
    hq: boolean,
    allowPreview: boolean,
  ): Array<{ key: keyof ScStreams; url: string }> {
    const requestedKey = `${format}_url` as keyof ScStreams;
    const fallbackOrder: (keyof ScStreams)[] = hq
      ? [
          'hls_aac_160_url',
          'hls_aac_96_url',
          'http_mp3_128_url',
          'hls_mp3_128_url',
          'hls_opus_64_url',
        ]
      : [
          'http_mp3_128_url',
          'hls_mp3_128_url',
          'hls_aac_160_url',
          'hls_aac_96_url',
          'hls_opus_64_url',
        ];

    if (allowPreview) {
      fallbackOrder.push('preview_mp3_128_url');
    }

    const orderedKeys: (keyof ScStreams)[] = [];
    for (const key of [requestedKey, ...fallbackOrder]) {
      if (!orderedKeys.includes(key)) {
        orderedKeys.push(key);
      }
    }

    return orderedKeys.flatMap((key) => {
      const url = streams[key];
      return url ? [{ key, url }] : [];
    });
  }

  private async resolveTranscodingUrl(token: string, transcodingUrl: string): Promise<string> {
    const payload = await this.sc.apiGetByUrl<{ url?: string }>(transcodingUrl, token);
    if (!payload.url) {
      throw new Error('Transcoding resolver returned no stream URL');
    }
    return payload.url;
  }

  private async loadResolvedTranscoding(
    token: string,
    streamUrl: string,
    transcoding: ScTranscodingInfo,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> }> {
    const protocol = transcoding.format?.protocol ?? '';
    const mimeType = transcoding.format?.mime_type ?? this.hlsMimeType(transcoding.preset ?? '');

    if (protocol === 'progressive') {
      return this.proxyStream(token, streamUrl, range);
    }

    return streamFromHls(
      this.httpService,
      streamUrl,
      mimeType,
      this.sc.buildAuthorizationHeaders(token),
    );
  }

  private qualityFromStreamKey(key: keyof ScStreams): 'hq' | 'lq' {
    return String(key).startsWith('hls_aac_') ? 'hq' : 'lq';
  }

  private qualityFromTranscoding(transcoding: ScTranscodingInfo): 'hq' | 'lq' {
    if (transcoding.quality === 'hq') return 'hq';
    if ((transcoding.preset ?? '').startsWith('aac_')) return 'hq';
    return 'lq';
  }

  private withStreamQuality(
    result: { stream: Readable; headers: Record<string, string> },
    quality: 'hq' | 'lq',
  ): { stream: Readable; headers: Record<string, string> } {
    return {
      ...result,
      headers: {
        ...result.headers,
        'x-stream-quality': quality,
      },
    };
  }

  private hlsMimeType(format: string): string {
    if (format.includes('aac')) return 'audio/mp4; codecs="mp4a.40.2"';
    if (format.includes('opus')) return 'audio/ogg; codecs="opus"';
    return 'audio/mpeg';
  }

  private handleHqFailure(label: string, quality: 'hq' | 'lq', err: unknown) {
    const status = this.extractHttpStatus(err);
    const message = err instanceof Error ? err.message : String(err);

    if (quality === 'hq' && status === 401) {
      this.hqOauthDisabledUntil = Date.now() + 10 * 60 * 1000;
      this.logger.warn(`Official HQ stream ${label} returned 401, temporarily disabling HQ`);
      return;
    }

    this.logger.warn(`Official stream candidate ${label} failed: ${message}`);
  }

  private extensionFromMime(mime: string): string {
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
    if (mime.includes('wav')) return 'wav';
    return 'mp3';
  }

private async readStreamToBuffer(
  stream: Readable,
  maxBytes = 40 * 1024 * 1024,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer =
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

    total += buffer.length;

    if (total > maxBytes) {
      throw new BadGatewayException(
        'Audio is too large for Qwen aligner upload',
      );
    }

    buffers.push(buffer);
  }

  return buffers.length === 1
    ? buffers[0]
    : Buffer.concat(buffers, total);
}

  private extractHttpStatus(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null;
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === 'number') return maybeStatus;

    const responseStatus = (err as { response?: { status?: unknown } }).response?.status;
    return typeof responseStatus === 'number' ? responseStatus : null;
  }

  getComments(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScComment>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/comments`, token, params);
  }

  createComment(
    token: string,
    trackUrn: string,
    body: { comment: { body: string; timestamp?: number } },
  ): Promise<ScComment> {
    return this.sc.apiPost(`/tracks/${trackUrn}/comments`, token, body);
  }

  getFavoriters(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/favoriters`, token, params);
  }

  getReposters(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/reposters`, token, params);
  }

  getRelated(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/related`, token, params);
  }
}
