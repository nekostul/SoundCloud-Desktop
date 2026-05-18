import interFontDataUrl from '../assets/fonts/inter.ttf?inline';

const EMBEDDED_FONT_STYLE_ID = 'app-embedded-inter-font';

export function installEmbeddedFont() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(EMBEDDED_FONT_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = EMBEDDED_FONT_STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: "Inter";
      src: url("${interFontDataUrl}") format("truetype");
      font-display: swap;
    }
  `;

  document.head.appendChild(style);
}
