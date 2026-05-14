import React, { useMemo, useRef } from 'react';

interface Props {
  /** Number of drifting accent particles. Fewer on smaller blocks. */
  particleCount?: number;
  /** Max blur radius for aurora orbs. Lower = cheaper GPU paint. */
  blur?: number;
  /** Primary aurora opacity. */
  intensity?: number;
  /** When true, the two aurora orbs pulse with the audio level — bass-heavy
   *  bins drive scale + opacity through CSS variables (no React re-renders).
   *  Falls back to the static `intensity` when no audio is playing. */
  reactive?: boolean;
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

  // Refs to the two aurora orbs — we mutate inline opacity/transform every
  // animation frame from a smoothed audio level, bypassing React re-renders.
  const auroraARef = useRef<HTMLDivElement>(null);
  const auroraBRef = useRef<HTMLDivElement>(null);

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
      <div
        className="absolute top-0 -left-[25%] w-[60%] h-full"
        style={{
          animation: 'sw-aurora 32s linear infinite',
          willChange: 'transform',
        }}
      >
        <div
          ref={auroraARef}
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, var(--color-accent-glow), transparent 70%)',
            filter: `blur(${blur}px)`,
            opacity: intensity,
            transform: 'scale(var(--sw-pulse-scale, 1))',
            transformOrigin: 'center',
            transition: 'transform 60ms linear',
            willChange: 'transform, opacity',
          }}
        />
      </div>
      {/* Right orb: previously bottom-right and white-7% — invisible at the
          top of the block where the user looks. Moved to top-right and
          re-tinted with the accent glow so the music-reactive pulse is
          visible across the full width of the block, not just the left. */}
      <div
        className="absolute top-0 -right-[25%] w-[60%] h-full"
        style={{
          animation: 'sw-aurora 44s linear reverse infinite',
          willChange: 'transform',
        }}
      >
        <div
          ref={auroraBRef}
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, var(--color-accent-glow), transparent 70%)',
            filter: `blur(${blur + 5}px)`,
            opacity: intensity * 0.7,
            transform: 'scale(var(--sw-pulse-scale, 1))',
            transformOrigin: 'center',
            transition: 'transform 60ms linear',
            willChange: 'transform, opacity',
          }}
        />
      </div>

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
