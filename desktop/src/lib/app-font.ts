const TEXT_SIZE_BASE = 15;
export const FORCED_APP_TEXT_SIZE = 16;
export const FORCED_APP_UI_SCALE = 1;
const TEXT_SCALE_STYLE_ID = 'app-text-scale-style';

type CachedTextRule = { selector: string; px: number };

let textRulesCache: CachedTextRule[] | null = null;
let lateScanTimer: number | null = null;

function scanTextRules(): CachedTextRule[] {
  const out: CachedTextRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSStyleRule) {
        const fontSize = rule.style.getPropertyValue('font-size').trim();
        if (!fontSize) continue;
        const match = fontSize.match(/^(-?\d+(?:\.\d+)?)(px|rem)$/);
        if (!match) continue;
        const px = match[2] === 'rem' ? parseFloat(match[1]) * 16 : parseFloat(match[1]);
        out.push({ selector: rule.selectorText, px });
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* ignore cross-origin stylesheets */
    }
  }

  return out;
}

function applyTextScale(scale: number, textSizePx: number): void {
  let tag = document.getElementById(TEXT_SCALE_STYLE_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = TEXT_SCALE_STYLE_ID;
    document.head.appendChild(tag);
  }

  document.body.style.fontSize = `${textSizePx}px`;

  if (Math.abs(scale - 1) < 0.001) {
    tag.textContent = '';
    return;
  }

  if (!textRulesCache) textRulesCache = scanTextRules();

  if (lateScanTimer == null && textRulesCache.length < 50) {
    lateScanTimer = window.setTimeout(() => {
      textRulesCache = scanTextRules();
      const root = document.documentElement;
      const currentScale = parseFloat(root.dataset.appTextScale || '1');
      const currentPx = parseFloat(root.dataset.appTextSize || `${TEXT_SIZE_BASE}`);
      applyTextScale(currentScale, currentPx);
    }, 600);
  }

  const out: string[] = [];
  for (const rule of textRulesCache) {
    out.push(`${rule.selector}{font-size:${(rule.px * scale).toFixed(3)}px !important}`);
  }
  tag.textContent = out.join('\n');

  document.documentElement.dataset.appTextScale = String(scale);
  document.documentElement.dataset.appTextSize = String(textSizePx);
}

interface ApplyArgs {
  textSize: number;
  uiScale: number;
}

export async function applyAppFont(args: ApplyArgs): Promise<void> {
  document.documentElement.style.fontSize = `${16 * args.uiScale}px`;
  applyTextScale(args.textSize / TEXT_SIZE_BASE, args.textSize);
}
