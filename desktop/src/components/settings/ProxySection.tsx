import { listen } from '@tauri-apps/api/event';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  applyMediaProxySettings,
  getMediaProxyStatus,
  resolveMediaProxyStatusMessage,
  type MediaProxyStatus,
} from '../../lib/media-proxy';
import { isTauriRuntime } from '../../lib/runtime';
import { useSettingsStore, type MediaProxyMode } from '../../stores/settings';

interface ProxySectionProps {
  sectionId?: string;
  className?: string;
}

export const ProxySection = React.memo(function ProxySection({
  sectionId,
  className = '',
}: ProxySectionProps) {
  const { t } = useTranslation();
  const mediaProxyMode = useSettingsStore((s) => s.mediaProxyMode);
  const mediaProxyHost = useSettingsStore((s) => s.mediaProxyHost);
  const mediaProxyUsername = useSettingsStore((s) => s.mediaProxyUsername);
  const mediaProxyPassword = useSettingsStore((s) => s.mediaProxyPassword);
  const setMediaProxyMode = useSettingsStore((s) => s.setMediaProxyMode);
  const setMediaProxyHost = useSettingsStore((s) => s.setMediaProxyHost);
  const setMediaProxyUsername = useSettingsStore((s) => s.setMediaProxyUsername);
  const setMediaProxyPassword = useSettingsStore((s) => s.setMediaProxyPassword);
  const [status, setStatus] = useState<MediaProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSeqRef = useRef(0);

  const loadStatus = useCallback(async () => {
    const next = await getMediaProxyStatus();
    setStatus(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let active = true;
    let unlistenStatus: (() => void) | null = null;
    const syncStatus = (next: MediaProxyStatus) => {
      if (!active) return;
      setStatus(next);
      setLoading(false);
    };

    const bind = async () => {
      const statusCleanup = await listen<MediaProxyStatus>('media-proxy:status', (event) => {
        syncStatus(event.payload);
      });

      if (!active) {
        statusCleanup();
        return;
      }

      unlistenStatus = statusCleanup;
    };

    void bind();

    return () => {
      active = false;
      unlistenStatus?.();
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadStatus();
    }, 700);
    return () => window.clearTimeout(timeoutId);
  }, [loadStatus, mediaProxyMode, mediaProxyHost, mediaProxyUsername, mediaProxyPassword]);

  const applyMode = useCallback(
    async (mode: MediaProxyMode) => {
      const requestId = ++requestSeqRef.current;
      setMediaProxyMode(mode);
      try {
        const next = await applyMediaProxySettings();
        if (requestSeqRef.current !== requestId) return;
        if (next) setStatus(next);
      } catch (error) {
        if (requestSeqRef.current !== requestId) return;
        toast.error(t('settings.mediaProxyUnexpectedError', { error: String(error) }));
      }
    },
    [setMediaProxyMode, t],
  );

  const modeOptions: Array<{ value: MediaProxyMode; label: string }> = [
    { value: 'off', label: t('settings.mediaProxyOff') },
    { value: 'manual', label: t('settings.mediaProxyManual') },
  ];

  const stateLabelKey =
    status?.state === 'proxy-active'
      ? 'settings.mediaProxyStateActive'
      : status?.state === 'invalid'
        ? 'settings.mediaProxyStateInvalid'
        : status?.state === 'disabled'
          ? 'settings.mediaProxyStateDisabled'
          : 'settings.mediaProxyStateDirect';
  const routingLabelKey =
    status?.routing === 'proxy'
      ? 'settings.mediaProxyRoutingProxy'
      : 'settings.mediaProxyRoutingDirect';
  const proxyTypeLabel =
    status?.proxy_type === 'http'
      ? t('settings.mediaProxyTypeHttp')
      : status?.proxy_type === 'https'
        ? t('settings.mediaProxyTypeHttps')
        : status?.proxy_type === 'socks4'
          ? t('settings.mediaProxyTypeSocks4')
          : status?.proxy_type === 'socks5'
            ? t('settings.mediaProxyTypeSocks5')
            : '-';
  const resolvedMessage = resolveMediaProxyStatusMessage(status);
  const showProxyStatusCard = status?.state === 'proxy-active' || status?.state === 'invalid';

  const statusTone =
    status?.state === 'proxy-active'
      ? 'text-emerald-300 border-emerald-400/20 bg-emerald-500/10'
      : status?.state === 'invalid'
        ? 'text-red-200 border-red-400/20 bg-red-500/10'
        : 'text-white/70 border-white/[0.06] bg-white/[0.03]';

  return (
    <section
      id={sectionId}
      className={`bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-4 ${className}`.trim()}
    >
      <div>
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('settings.mediaProxyTitle')}
        </h3>
        <p className="mt-1 text-[12px] text-white/35">{t('settings.mediaProxyDesc')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {modeOptions.map((option) => {
          const active = mediaProxyMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => void applyMode(option.value)}
              className={
                active
                  ? 'rounded-2xl border px-4 py-3 text-[12px] font-semibold transition-all cursor-pointer border-white/[0.14] bg-white/[0.09] text-white/90'
                  : 'rounded-2xl border px-4 py-3 text-[12px] font-semibold transition-all cursor-pointer border-white/[0.05] bg-white/[0.03] text-white/45 hover:bg-white/[0.05] hover:text-white/70'
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {mediaProxyMode === 'manual' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={mediaProxyHost}
            onChange={(e) => setMediaProxyHost(e.target.value)}
            placeholder={t('settings.mediaProxyHost')}
            className="sm:col-span-2 px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/85 placeholder:text-white/25 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none"
          />
          <input
            type="text"
            value={mediaProxyUsername}
            onChange={(e) => setMediaProxyUsername(e.target.value)}
            placeholder={t('settings.mediaProxyUsername')}
            className="px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/85 placeholder:text-white/25 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none"
          />
          <input
            type="password"
            value={mediaProxyPassword}
            onChange={(e) => setMediaProxyPassword(e.target.value)}
            placeholder={t('settings.mediaProxyPassword')}
            className="px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/85 placeholder:text-white/25 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none"
          />
        </div>
      )}

      {showProxyStatusCard ? (
        <div className={`rounded-2xl border p-4 ${statusTone}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyStatus')}
              </p>
              <p className="mt-1 text-[13px] font-semibold text-inherit">
                {loading ? t('settings.loading') : t(stateLabelKey)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyRouting')}
              </p>
              <p className="mt-1 text-[13px] font-semibold text-inherit">{t(routingLabelKey)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyType')}
              </p>
              <p className="mt-1 text-[13px] font-semibold text-inherit">{proxyTypeLabel}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyLatency')}
              </p>
              <p className="mt-1 text-[13px] font-semibold text-inherit">
                {typeof status?.latency_ms === 'number' ? `${status.latency_ms} ms` : '-'}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyThroughput')}
              </p>
              <p className="mt-1 text-[13px] font-semibold text-inherit">
                {typeof status?.throughput_kbps === 'number'
                  ? `${status.throughput_kbps} kb/s`
                  : '-'}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-white/35">
                {t('settings.mediaProxyEndpoint')}
              </p>
              <p className="mt-1 break-all text-[13px] font-semibold text-inherit">
                {status?.endpoint || '-'}
              </p>
            </div>
          </div>
          {resolvedMessage ? (
            <p className="mt-3 text-[12px] leading-relaxed text-white/80">{resolvedMessage}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
