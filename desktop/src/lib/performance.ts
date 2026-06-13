import { useSettingsStore } from '../stores/settings';

/** Single source of truth for "should we cut motion / heavy effects right now".
 *  Driven by the in-app "Low-end PC mode" toggle — NOT the OS
 *  `prefers-reduced-motion`, so animations behave identically on Windows and
 *  macOS (macOS very often ships with Reduce Motion enabled, which used to
 *  silently strip every decorative animation on Mac only). */
export function isLowPerformanceMode(): boolean {
  return useSettingsStore.getState().lowPerformanceMode;
}

/** Whether non-essential motion (parallax, ambient canvas, view transitions,
 *  looping decorative keyframes) should be suppressed. */
export function shouldReduceMotion(): boolean {
  return isLowPerformanceMode();
}

const PERF_LOW_CLASS = 'perf-low';
const MACOS_CLASS = 'is-macos';

function detectMacOs(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable signal inside
  // a WKWebView; userAgent is the fallback.
  return (
    navigator.platform?.toUpperCase().startsWith('MAC') ||
    navigator.userAgent.includes('Mac OS X') ||
    navigator.userAgent.includes('Macintosh')
  );
}

/** Toggles `html.perf-low` so the stylesheet can disable blur / animations.
 *  Call on hydration and whenever the setting changes. */
export function applyLowPerformanceClass(enabled = isLowPerformanceMode()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(PERF_LOW_CLASS, enabled);
}

/** Marks the document as running on macOS so the stylesheet can apply
 *  platform-specific text-rendering fixes (crisp glyphs on WKWebView). */
export function applyPlatformClass(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(MACOS_CLASS, detectMacOs());
}
