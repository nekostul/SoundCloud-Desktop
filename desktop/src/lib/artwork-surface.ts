import type { ArtworkGradientPalette } from './artwork-palette';

export function hexToRgba(hex?: string | null, alpha = 1) {
  if (!hex || typeof hex !== 'string') {
    return `rgba(0, 0, 0, ${alpha})`;
  }

  const normalized = hex.trim().replace('#', '');

  if (!/^[0-9A-Fa-f]{6}$/.test(normalized)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }

  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface ArtworkSurfaceVisual {
  background: string;
  borderColor: string;
  boxShadow: string;
}

export const ARTWORK_SURFACE_BACKGROUND_SIZE = '100% 100%, 100% 100%, 100% 100%';
export const ARTWORK_SURFACE_BACKGROUND_POSITION = '0% 0%, 0% 0%, 0% 0%';
export const ARTWORK_SURFACE_BACKGROUND_REPEAT = 'no-repeat';

export function buildArtworkSurfaceVisual(
  palette: Pick<ArtworkGradientPalette, 'gradientA' | 'gradientB' | 'gradientC'>,
): ArtworkSurfaceVisual {
  return {
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.042), rgba(255,255,255,0.06)),
      radial-gradient(circle at 16% 18%, ${hexToRgba(palette.gradientA, 0.12)} 0%, ${hexToRgba(palette.gradientB, 0.07)} 34%, rgba(0,0,0,0) 62%),
      linear-gradient(135deg, ${hexToRgba(palette.gradientB, 0.06)} 0%, ${hexToRgba(palette.gradientC, 0.04)} 52%, rgba(8,8,10,0.78) 100%)
    `,
    borderColor: hexToRgba(palette.gradientA, 0.1),
    boxShadow: `0 12px 34px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.04), 0 0 20px ${hexToRgba(palette.gradientA, 0.05)}`,
  };
}
