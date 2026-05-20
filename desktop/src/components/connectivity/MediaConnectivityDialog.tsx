import * as Dialog from '@radix-ui/react-dialog';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { ProxySection } from '../settings/ProxySection';
import { checkSoundCloudCdnConnectivity } from '../../lib/media-connectivity';
import {
  AlertCircle,
  AudioLines,
  Download,
  ExternalLink,
  Globe,
  Headphones,
  Link,
  Loader2,
  Lock,
  RotateCcw,
  Sparkles,
  X,
} from '../../lib/icons';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';

type DialogView = 'intro' | 'vpn' | 'proxy-options' | 'manual-proxy' | 'continue-confirm';
type Tone = 'accent' | 'cyan' | 'amber' | 'violet' | 'neutral';
type IconType = ComponentType<{ size?: number; className?: string }>;

const ZAPRET_URL = 'https://github.com/Flowseal/zapret-discord-youtube';

const TONE_STYLES: Record<
  Tone,
  {
    glow: string;
    line: string;
    icon: string;
    dot: string;
  }
> = {
  accent: {
    glow: 'bg-accent/[0.18]',
    line: 'from-transparent via-accent/40 to-transparent',
    icon: 'bg-accent/16 text-accent shadow-[0_0_26px_var(--color-accent-glow)]',
    dot: 'bg-accent',
  },
  cyan: {
    glow: 'bg-cyan-400/[0.16]',
    line: 'from-transparent via-cyan-300/40 to-transparent',
    icon: 'bg-cyan-400/14 text-cyan-100 shadow-[0_0_26px_rgba(34,211,238,0.18)]',
    dot: 'bg-cyan-300',
  },
  amber: {
    glow: 'bg-amber-400/[0.16]',
    line: 'from-transparent via-amber-300/40 to-transparent',
    icon: 'bg-amber-400/14 text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.16)]',
    dot: 'bg-amber-300',
  },
  violet: {
    glow: 'bg-fuchsia-400/[0.14]',
    line: 'from-transparent via-fuchsia-300/34 to-transparent',
    icon: 'bg-fuchsia-400/14 text-fuchsia-100 shadow-[0_0_24px_rgba(232,121,249,0.16)]',
    dot: 'bg-fuchsia-300',
  },
  neutral: {
    glow: 'bg-white/[0.08]',
    line: 'from-transparent via-white/18 to-transparent',
    icon: 'bg-white/[0.08] text-white/86 shadow-[0_0_20px_rgba(255,255,255,0.06)]',
    dot: 'bg-white/40',
  },
};

async function openExternalUrl(url: string) {
  if (isTauri()) {
    try {
      await openUrl(url);
      return;
    } catch {
      // Fall through to the browser fallback.
    }
  }

  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function FrostCard({
  children,
  className = '',
  tone = 'neutral',
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
}) {
  const palette = TONE_STYLES[tone];

  return (
    <div className={`glass-featured relative overflow-hidden rounded-[30px] ${className}`.trim()}>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.09)_0%,rgba(255,255,255,0.03)_38%,rgba(255,255,255,0)_100%)]" />
      <div
        className={`pointer-events-none absolute -right-10 top-[-52px] h-40 w-40 rounded-full blur-[90px] ${palette.glow}`}
      />
      <div
        className={`pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r ${palette.line}`}
      />
      <div className="pointer-events-none absolute inset-px rounded-[29px] border border-white/[0.04]" />
      <div className="relative">{children}</div>
    </div>
  );
}

function IconBadge({
  icon: Icon,
  tone = 'neutral',
  size = 18,
  className = '',
}: {
  icon: IconType;
  tone?: Tone;
  size?: number;
  className?: string;
}) {
  const palette = TONE_STYLES[tone];

  return (
    <div
      className={`relative flex h-12 w-12 items-center justify-center rounded-[20px] border border-white/[0.08] backdrop-blur-xl ${palette.icon} ${className}`.trim()}
    >
      <div className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <Icon size={size} />
    </div>
  );
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
  tone = 'neutral',
  disabled = false,
  trailing,
}: {
  icon: IconType;
  title: string;
  description: string;
  onClick: () => void;
  tone?: Tone;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  const palette = TONE_STYLES[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0.025)_100%)] px-4 py-4 text-left shadow-[0_18px_56px_rgba(0,0,0,0.34)] backdrop-blur-[24px] transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
        disabled
          ? 'cursor-default opacity-60'
          : 'cursor-pointer hover:-translate-y-1 hover:border-white/[0.13] hover:shadow-[0_30px_92px_rgba(0,0,0,0.42)]'
      }`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0)_36%,rgba(255,255,255,0.015)_100%)]" />
      <div
        className={`pointer-events-none absolute -right-8 top-[-42px] h-32 w-32 rounded-full blur-[88px] transition-opacity duration-300 group-hover:opacity-100 ${palette.glow}`}
      />
      <div
        className={`pointer-events-none absolute inset-x-7 top-0 h-px bg-gradient-to-r ${palette.line}`}
      />
      <div className="pointer-events-none absolute inset-px rounded-[27px] border border-white/[0.04]" />

      <div className="relative flex items-start justify-between gap-4">
        <IconBadge icon={icon} tone={tone} />
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>

      <div className="relative mt-4 space-y-1.5">
        <div className="text-[16px] font-semibold tracking-tight text-white/92">{title}</div>
        <p className="text-[12px] leading-relaxed text-white/55">{description}</p>
      </div>
    </button>
  );
}

function InlineNotice({ message }: { message: string }) {
  return (
    <FrostCard tone="amber" className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <IconBadge icon={AlertCircle} tone="amber" size={15} className="h-10 w-10 rounded-2xl" />
        <p className="pt-0.5 text-[13px] leading-relaxed text-amber-50/88">{message}</p>
      </div>
    </FrostCard>
  );
}

function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/18 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/42 backdrop-blur-md">
        <span className="h-1.5 w-1.5 rounded-full bg-accent/90 shadow-[0_0_14px_var(--color-accent-glow)]" />
        <span>{eyebrow}</span>
      </div>
      <h3 className="mt-3.5 text-[24px] font-semibold tracking-[-0.03em] text-white/96 sm:text-[26px]">
        {title}
      </h3>
      <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed text-white/56">{description}</p>
    </div>
  );
}

export function MediaConnectivityDialog() {
  const { t } = useTranslation();
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const open = useSettingsStore((s) => s.mediaConnectivityDialogOpen);
  const setOpen = useSettingsStore((s) => s.setMediaConnectivityDialogOpen);
  const setDismissed = useSettingsStore((s) => s.setMediaConnectivityDialogDismissed);
  const setProbeState = useSettingsStore((s) => s.setMediaConnectivityProbeState);
  const setMediaProxyMode = useSettingsStore((s) => s.setMediaProxyMode);
  const [view, setView] = useState<DialogView>('intro');
  const [rechecking, setRechecking] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<string | null>(null);
  const skipDismissRef = useRef(false);
  const closeReturnViewRef = useRef<Exclude<DialogView, 'continue-confirm'>>('intro');

  const closeWithoutDismiss = useCallback(() => {
    skipDismissRef.current = true;
    setOpen(false);
  }, [setOpen]);

  const dismissDialog = useCallback(() => {
    setDismissed(true);
    setOpen(false);
  }, [setDismissed, setOpen]);

  const requestDismissConfirmation = useCallback(() => {
    closeReturnViewRef.current = view === 'continue-confirm' ? 'intro' : view;
    setView('continue-confirm');
  }, [view]);

  const syncProbeResult = useCallback(
    async (successToastKey?: string) => {
      const result = await checkSoundCloudCdnConnectivity({
        useRememberedStream: isAuthenticated,
      });
      setProbeState(result.status);

      if (result.healthy) {
        closeWithoutDismiss();
        toast.success(t(successToastKey ?? 'connectivity.checkSuccessToast'));
        return true;
      }

      return false;
    },
    [closeWithoutDismiss, isAuthenticated, setProbeState, t],
  );

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setOpen(true);
        return;
      }

      if (skipDismissRef.current) {
        skipDismissRef.current = false;
        setOpen(false);
      }
    },
    [setOpen],
  );

  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    setInlineMessage(null);

    try {
      const healthy = await syncProbeResult();
      if (!healthy) {
        setInlineMessage(t('connectivity.stillUnavailable'));
      }
    } catch (error) {
      setInlineMessage(
        t('settings.mediaProxyUnexpectedError', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setRechecking(false);
    }
  }, [syncProbeResult, t]);

  const handleManualProxy = useCallback(() => {
    setMediaProxyMode('manual');

    if (location.pathname === '/settings') {
      closeWithoutDismiss();
      window.requestAnimationFrame(() => {
        document.getElementById('settings-proxy-section')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
      return;
    }

    setView('manual-proxy');
  }, [closeWithoutDismiss, location.pathname, setMediaProxyMode]);

  useEffect(() => {
    if (!open) return;

    setView('intro');
    closeReturnViewRef.current = 'intro';
    setInlineMessage(null);
    setRechecking(false);
  }, [open]);

  const confirmOpen = view === 'continue-confirm';
  const contentView = confirmOpen ? closeReturnViewRef.current : view;
  const showStatusInline = contentView === 'intro';

  const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isTauri()) return;
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(() => {});
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={handleDialogOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-[140] bg-black/72 backdrop-blur-[18px]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="dialog-content fixed left-1/2 top-1/2 z-[141] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[34px] border border-white/[0.08] bg-[rgba(12,12,16,0.78)] shadow-[0_42px_160px_rgba(0,0,0,0.64)] backdrop-blur-[30px] outline-none animate-fade-in-up select-none [&_input]:select-text [&_textarea]:select-text"
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -left-24 top-[-96px] h-80 w-80 rounded-full bg-accent/[0.18] blur-[132px]" />
            <div className="absolute right-[-58px] top-[84px] h-64 w-64 rounded-full bg-cyan-400/[0.12] blur-[128px]" />
            <div className="absolute bottom-[-130px] left-[34%] h-80 w-80 rounded-full bg-fuchsia-400/[0.09] blur-[150px]" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0.02)_26%,rgba(255,255,255,0)_56%,rgba(0,0,0,0.16)_100%)]" />
            <div className="absolute inset-px rounded-[35px] border border-white/[0.04]" />
          </div>
          <div
            data-tauri-drag-region
            onPointerDown={handleDragPointerDown}
            className="absolute inset-x-0 top-0 z-10 h-24 cursor-grab active:cursor-grabbing"
          />

          <div
            className={`relative z-20 max-h-[86vh] overflow-y-auto px-5 pb-6 pt-5 transition-[filter,transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:px-6 sm:pb-6 sm:pt-5 ${
              confirmOpen
                ? 'pointer-events-none select-none blur-[16px] saturate-[0.72] scale-[0.985] opacity-70'
                : ''
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div
                data-tauri-drag-region
                className="min-w-0 flex-1 cursor-grab active:cursor-grabbing"
                onPointerDown={handleDragPointerDown}
              >
                <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/18 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/42 backdrop-blur-md">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent/90 shadow-[0_0_14px_var(--color-accent-glow)]" />
                  <span>{t('connectivity.helperLabel')}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={requestDismissConfirmation}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.05] text-white/42 shadow-[0_14px_34px_rgba(0,0,0,0.24)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.09] hover:text-white/82 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mx-auto mt-4 max-w-[560px] space-y-4">
              <FrostCard tone="accent" className="px-5 py-5 sm:px-5 sm:py-5">
                <div className="absolute inset-0 opacity-70">
                  <div className="absolute left-6 top-6 h-24 w-24 rounded-full bg-white/[0.04] blur-3xl" />
                  <div className="absolute right-12 top-10 h-28 w-28 rounded-full bg-accent/[0.08] blur-[86px]" />
                </div>

                <div
                  data-tauri-drag-region
                  className="relative flex items-start gap-4 cursor-grab active:cursor-grabbing"
                  onPointerDown={handleDragPointerDown}
                >
                  <div className="relative">
                    <div className="absolute inset-0 rounded-[28px] bg-accent/20 blur-2xl" />
                    <div className="relative flex h-16 w-16 items-center justify-center rounded-[26px] border border-white/[0.1] bg-white/[0.08] text-accent shadow-[0_18px_48px_rgba(0,0,0,0.28),0_0_30px_var(--color-accent-glow)] backdrop-blur-xl">
                      <AudioLines size={24} />
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <Dialog.Title className="text-[24px] font-semibold leading-[1.02] tracking-[-0.04em] text-white/96 sm:text-[28px]">
                      {t('connectivity.title')}
                    </Dialog.Title>
                    <Dialog.Description className="mt-2.5 max-w-[520px] text-[13px] leading-relaxed text-white/58 sm:text-[14px]">
                      {t('connectivity.subtitle')}
                    </Dialog.Description>
                  </div>
                </div>

                {showStatusInline ? (
                  <div className="mt-5 rounded-[24px] border border-white/[0.07] bg-black/[0.16] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-white/78 backdrop-blur-md">
                        <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_16px_rgba(251,191,36,0.9)]" />
                        <span>{t('connectivity.statusTitle')}</span>
                      </div>
                      <span className="rounded-full border border-white/[0.08] bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-white/42 backdrop-blur-md">
                        sndcdn.com
                      </span>
                    </div>

                    <p className="mt-3 text-[13px] leading-relaxed text-white/78">
                      {t('connectivity.description', { host: 'sndcdn.com' })}
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-white/46">
                      {t('connectivity.statusHint')}
                    </p>

                    <div className="mt-4 grid gap-2">
                      {[
                        { icon: Headphones, label: t('connectivity.impactTracks'), tone: 'accent' as const },
                        { icon: AudioLines, label: t('connectivity.impactPreviews'), tone: 'cyan' as const },
                        { icon: Sparkles, label: t('connectivity.impactAssets'), tone: 'violet' as const },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center gap-3 rounded-[18px] border border-white/[0.05] bg-white/[0.03] px-3 py-2.5 backdrop-blur-md"
                        >
                          <IconBadge icon={item.icon} tone={item.tone} size={14} className="h-9 w-9 rounded-[18px]" />
                          <div className="text-[12px] leading-relaxed text-white/68">{item.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {contentView === 'intro' ? (
                  <div className="relative mt-6">
                    <SectionIntro
                      eyebrow={t('connectivity.questionLabel')}
                      title={t('connectivity.question')}
                      description={t('connectivity.questionHint')}
                    />

                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                      <ActionCard
                        icon={Lock}
                        title={t('connectivity.yes')}
                        description={t('connectivity.yesHint')}
                        tone="accent"
                        onClick={() => setView('vpn')}
                      />
                      <ActionCard
                        icon={Globe}
                        title={t('connectivity.no')}
                        description={t('connectivity.noHint')}
                        tone="cyan"
                        onClick={() => setView('proxy-options')}
                      />
                    </div>
                  </div>
                ) : null}

                {contentView === 'vpn' ? (
                  <div className="relative mt-8 space-y-4">
                    <SectionIntro
                      eyebrow={t('connectivity.helperLabel')}
                      title={t('connectivity.yes')}
                      description={t('connectivity.yesHint')}
                    />

                    <div className="grid gap-3">
                      <FrostCard tone="accent" className="px-5 py-5">
                        <div className="flex items-start gap-4">
                          <IconBadge icon={Sparkles} tone="accent" />
                          <div className="min-w-0">
                            <p className="text-[15px] font-semibold tracking-tight text-white/92">
                              {t('connectivity.zapretTitle')}
                            </p>
                            <p className="mt-2 text-[13px] leading-relaxed text-white/56">
                              {t('connectivity.zapretDescription')}
                            </p>
                            <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px] text-white/74">
                              <code className="rounded-full border border-white/[0.08] bg-black/22 px-3 py-1.5 backdrop-blur-md">
                                sndcdn.com
                              </code>
                              <span className="text-white/38">{t('connectivity.zapretInto')}</span>
                              <code className="rounded-full border border-white/[0.08] bg-black/22 px-3 py-1.5 backdrop-blur-md">
                                list-general.txt
                              </code>
                            </div>
                          </div>
                        </div>
                      </FrostCard>

                      <FrostCard tone="cyan" className="px-5 py-5">
                        <div className="flex items-start gap-4">
                          <IconBadge icon={Lock} tone="cyan" />
                          <div className="min-w-0">
                            <p className="text-[15px] font-semibold tracking-tight text-white/92">
                              {t('connectivity.vpnTitle')}
                            </p>
                            <p className="mt-2 text-[13px] leading-relaxed text-white/56">
                              {t('connectivity.vpnDescription')}
                            </p>
                          </div>
                        </div>
                      </FrostCard>
                    </div>

                    {inlineMessage ? <InlineNotice message={inlineMessage} /> : null}

                    <div className="flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => setView('intro')}
                        className="rounded-full border border-white/[0.08] bg-white/[0.04] px-5 py-3 text-[13px] font-medium text-white/68 shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md transition-all hover:bg-white/[0.07] hover:text-white/88 cursor-pointer"
                      >
                        {t('connectivity.back')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRecheck()}
                        disabled={rechecking}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-5 py-3 text-[13px] font-semibold text-accent-contrast shadow-[0_0_40px_var(--color-accent-glow),0_18px_36px_rgba(0,0,0,0.24)] transition-all hover:bg-accent-hover disabled:opacity-60 cursor-pointer"
                      >
                        {rechecking ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            {t('connectivity.rechecking')}
                          </>
                        ) : (
                          t('connectivity.checkAgain')
                        )}
                      </button>
                    </div>
                  </div>
                ) : null}

                {contentView === 'proxy-options' ? (
                  <div className="relative mt-8 space-y-4">
                    <SectionIntro
                      eyebrow={t('connectivity.helperLabel')}
                      title={t('connectivity.no')}
                      description={t('connectivity.noHint')}
                    />

                    <div className="grid gap-3 sm:grid-cols-3">
                      <ActionCard
                        icon={Link}
                        title={t('connectivity.manualProxy')}
                        description={t('connectivity.manualProxyHint')}
                        tone="cyan"
                        onClick={handleManualProxy}
                      />
                      <ActionCard
                        icon={Download}
                        title={t('connectivity.downloadZapret')}
                        description={t('connectivity.downloadZapretHint')}
                        tone="violet"
                        onClick={() => void openExternalUrl(ZAPRET_URL)}
                        trailing={
                          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.05] text-white/52 backdrop-blur-md">
                            <ExternalLink size={14} />
                          </div>
                        }
                      />
                      <ActionCard
                        icon={AlertCircle}
                        title={t('connectivity.continueWithoutProxy')}
                        description={t('connectivity.continueWithoutProxyHint')}
                        tone="amber"
                        trailing={
                          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.05] text-white/52 backdrop-blur-md">
                            <AlertCircle size={14} />
                          </div>
                        }
                        onClick={() => {
                          closeReturnViewRef.current = 'proxy-options';
                          setView('continue-confirm');
                        }}
                      />
                    </div>

                    {inlineMessage ? <InlineNotice message={inlineMessage} /> : null}

                    <button
                      type="button"
                      onClick={() => setView('intro')}
                      className="rounded-full border border-white/[0.08] bg-white/[0.04] px-5 py-3 text-[13px] font-medium text-white/68 shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md transition-all hover:bg-white/[0.07] hover:text-white/88 cursor-pointer"
                    >
                      {t('connectivity.back')}
                    </button>
                  </div>
                ) : null}

                {contentView === 'manual-proxy' ? (
                  <div className="relative mt-8 space-y-4">
                    <SectionIntro
                      eyebrow={t('connectivity.helperLabel')}
                      title={t('connectivity.manualProxy')}
                      description={t('connectivity.manualProxyDescription')}
                    />

                    <div className="rounded-[32px] border border-white/[0.06] bg-black/[0.12] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md">
                      <ProxySection className="!border-white/[0.08] !bg-white/[0.03] !backdrop-blur-[46px] shadow-[0_24px_72px_rgba(0,0,0,0.36)]" />
                    </div>

                    <button
                      type="button"
                      onClick={() => setView('proxy-options')}
                      className="rounded-full border border-white/[0.08] bg-white/[0.04] px-5 py-3 text-[13px] font-medium text-white/68 shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md transition-all hover:bg-white/[0.07] hover:text-white/88 cursor-pointer"
                    >
                      {t('connectivity.back')}
                    </button>
                  </div>
                ) : null}

              </FrostCard>
            </div>

            {rechecking && (
              <div className="pointer-events-none absolute bottom-6 right-6 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.06] px-3 py-1.5 text-[11px] text-white/60 shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur-md">
                <RotateCcw size={12} className="animate-spin" />
                <span>{t('connectivity.rechecking')}</span>
              </div>
            )}
          </div>

          {confirmOpen ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_52%),linear-gradient(180deg,rgba(5,5,8,0.18)_0%,rgba(5,5,8,0.44)_100%)] backdrop-blur-[18px] px-5">
              <div className="relative w-full max-w-[460px] overflow-hidden rounded-[30px] border border-white/[0.10] bg-[rgba(18,18,24,0.58)] shadow-[0_30px_110px_rgba(0,0,0,0.48)] backdrop-blur-[34px] animate-fade-in-up">
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_36%,rgba(255,255,255,0)_100%)]" />
                <div className="pointer-events-none absolute -left-8 top-[-28px] h-28 w-28 rounded-full bg-amber-400/[0.14] blur-[84px]" />
                <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/36 to-transparent" />
                <div className="pointer-events-none absolute inset-px rounded-[29px] border border-white/[0.04]" />

                <div className="relative px-6 py-6 sm:px-7 sm:py-7">
                  <div className="flex items-start gap-4">
                    <IconBadge icon={AlertCircle} tone="amber" className="h-12 w-12 rounded-[22px]" />
                    <div className="min-w-0">
                      <p className="text-[18px] font-semibold tracking-[-0.03em] text-white/94">
                        {t('connectivity.continueWarningTitle')}
                      </p>
                      <p className="mt-2 text-[14px] leading-relaxed text-white/60">
                        {t('connectivity.continueWarning')}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={dismissDialog}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white/[0.11] px-5 py-3 text-[13px] font-semibold text-white/94 shadow-[0_16px_40px_rgba(0,0,0,0.24)] backdrop-blur-md transition-all hover:bg-white/[0.15] cursor-pointer"
                    >
                      {t('connectivity.continueAnyway')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setView(closeReturnViewRef.current)}
                      className="rounded-full border border-white/[0.08] bg-transparent px-5 py-3 text-[13px] font-medium text-white/68 transition-all hover:bg-white/[0.05] hover:text-white/88 cursor-pointer"
                    >
                      {t('connectivity.back')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
