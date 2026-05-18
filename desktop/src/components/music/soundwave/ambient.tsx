import React, { useMemo } from 'react';

interface Props {
  /** Number of drifting accent particles. Fewer on smaller blocks. */
  particleCount?: number;
  /** Max blur radius for aurora orbs. Lower = cheaper GPU paint. */
  blur?: number;
  /** Primary aurora opacity. */
  intensity?: number;
}

/**
 * Decorative aurora + particle layer for SoundWave blocks.
 * Pure CSS animations, `contain: strict` isolates repaints, no React updates
 * during animation.
 */
export const AmbientLayer = React.memo(function AmbientLayer({
  particleCount = 12,
  blur = 45,
  intensity = 0.55,
}: Props) {
  const particles = useMemo(
    () => Array.from({ length: particleCount }, (_, i) => i),
    [particleCount],
  );

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-hidden
      style={{ contain: 'strict', transform: 'translateZ(0)' }}
    >
      {/* Outer wrapper runs the CSS drift animation (`transform: translate`).
          Inner child applies the music-driven `scale(...)` — separating them
          prevents the inline transform from clobbering the keyframe.
          Position mirrors the right orb (-top-1/4, off-edge by 12%, 50/160
          %) so both glow blobs are equally visible — previously left orb
          was centered well off-canvas and showed only its right half. */}
      {/* Static aurora orbs without reactive pulse for better performance */}
      <div
        className="absolute -top-1/3 -left-1/4 w-[55%] h-[170%] rounded-full"
        style={{
          background: 'radial-gradient(closest-side, var(--color-accent-glow), transparent 70%)',
          filter: `blur(${blur}px)`,
          opacity: intensity,
          animation: 'sw-aurora 32s linear infinite',
          willChange: 'transform',
          contain: 'strict',
          transform: 'translateZ(0)',
        }}
      />
      <div
        className="absolute -bottom-1/2 right-[-12%] w-[50%] h-[160%] rounded-full"
        style={{
          background: 'radial-gradient(closest-side, rgba(255,255,255,0.04), transparent 70%)',
          filter: `blur(${blur + 3}px)`,
          opacity: intensity * 0.6,
          animation: 'sw-aurora 44s linear reverse infinite',
          willChange: 'transform',
          contain: 'strict',
          transform: 'translateZ(0)',
        }}
      />

      {particles.map((i) => {
        const size = 2 + (i % 3);
        const left = (i * 41) % 100;
        const top = 12 + ((i * 53) % 70);
        const duration = 5200 + ((i * 313) % 3200);
        const delay = (i * 277) % 3800;
        return (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              width: `${size}px`,
              height: `${size}px`,
              left: `${left}%`,
              top: `${top}%`,
              background: 'var(--color-accent)',
              boxShadow: '0 0 6px var(--color-accent-glow)',
              animation: `sw-drift ${duration}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        );
      })}
    </div>
  );
});
