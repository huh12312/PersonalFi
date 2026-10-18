// SPDX-License-Identifier: MIT
import { useEffect, useRef } from 'react';

import { cn } from '../../lib/cn.ts';
import {
  angleFor,
  arcLength,
  arcPath,
  clampScore,
  gapDegrees,
  gaugeGeometry,
  GAUGE_END_DEG,
  GAUGE_START_DEG,
  GAUGE_SWEEP_DEG,
  polar,
  tierSegments,
} from './gauge.ts';
import { healthVar, statusVar } from './health-chart-tokens.ts';
import { tierOf } from './tiers.ts';

export type ScoreGaugeSize = 'sm' | 'md';

const SIZE: Record<
  ScoreGaugeSize,
  { px: number; stroke: number; figure: string; caption: string }
> = {
  sm: { px: 112, stroke: 9, figure: 'text-[28px] leading-none', caption: 'text-caption' },
  md: { px: 232, stroke: 16, figure: 'text-[56px] leading-none', caption: 'text-small' },
};

/** The sweep's length. Short: it says "this is a level", it is not a show. */
export const SWEEP_MS = 700;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scoreText(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export interface ScoreGaugeProps {
  readonly score: number | null;
  readonly size?: ScoreGaugeSize;
  readonly className?: string;
}

/**
 * The health score as a 270° arc (WP 10.12; Monarch's equivalent), by the dataviz skill's meter:
 * the three tiers are the track, each in its own status wash with a surface gap between them; the fill runs to
 * the score in the current tier's bold step with round caps and ends in a dot ringed in the surface. The score is
 * the large figure inside (proportional figures — tabular digits look loose at display size), the tier word sits
 * beside it in words, so the state is never colour alone.
 *
 * **The sweep.** The fill sweeps from empty to the score once, when the gauge first mounts — through the Web
 * Animations API, so it is a real, observable animation — and never under `prefers-reduced-motion`. A later score
 * (a refetch) is drawn where it lands with no sweep. `data-gauge-swept` says whether this gauge swept.
 *
 * **No score** (every pillar withheld) draws the bare track and says "Not enough data yet" — never a 0.
 */
export function ScoreGauge({ score, size = 'md', className }: ScoreGaugeProps) {
  const spec = SIZE[size];
  const geometry = gaugeGeometry(spec.px, spec.stroke);
  const { cx, cy, r, stroke } = geometry;
  const fillRef = useRef<SVGPathElement>(null);
  const endRef = useRef<SVGCircleElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const fullLength = arcLength(r, GAUGE_SWEEP_DEG);
  const value = score === null ? null : clampScore(score);
  const targetOffset = value === null ? fullLength : fullLength * (1 - value / 100);

  // Once, on mount: sweep from empty to the first score we have. Not on a later score, and never under reduced
  // motion. The dependency list is deliberately only `value === null` — a changed score must not sweep again.
  const hasScore = value !== null;
  const sweptOnce = useRef(false);
  useEffect(() => {
    if (!hasScore || sweptOnce.current) return;
    sweptOnce.current = true;
    const path = fillRef.current;
    if (path === null || prefersReducedMotion() || typeof path.animate !== 'function') return;
    path.animate(
      [{ strokeDashoffset: String(fullLength) }, { strokeDashoffset: String(targetOffset) }],
      {
        duration: SWEEP_MS,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    );
    // The end dot arrives with the fill rather than waiting at the score while the arc grows towards it.
    endRef.current?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.85 }, { opacity: 1 }], {
      duration: SWEEP_MS,
    });
    // Set on the node, not in state: the sweep is a fact about this mount, not something to re-render for.
    if (rootRef.current !== null) rootRef.current.dataset['gaugeSwept'] = 'true';
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: a later score is drawn, not swept
  }, [hasScore]);

  const tier = value === null ? null : tierOf(value);
  const gap = gapDegrees(3, r);
  const label =
    value === null
      ? 'Financial health score: not enough data yet'
      : `Financial health score ${scoreText(value)} out of 100, ${tier!.word}`;
  const end = value === null ? null : polar(cx, cy, r, angleFor(value));

  return (
    <div
      role="img"
      aria-label={label}
      data-score-gauge={size}
      ref={rootRef}
      data-gauge-swept="false"
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: geometry.width, height: geometry.height }}
    >
      <svg
        width={geometry.width}
        height={geometry.height}
        viewBox={`0 0 ${String(geometry.width)} ${String(geometry.height)}`}
        aria-hidden="true"
        focusable="false"
      >
        {tierSegments().map((segment, index, all) => (
          <path
            key={segment.tier.id}
            data-gauge-segment={segment.tier.id}
            d={arcPath(
              cx,
              cy,
              r,
              segment.startDeg + (index === 0 ? 0 : gap / 2),
              segment.endDeg - (index === all.length - 1 ? 0 : gap / 2),
            )}
            fill="none"
            stroke={statusVar(segment.tier.status, 'bg')}
            strokeWidth={stroke}
            strokeLinecap={index === 0 || index === all.length - 1 ? 'round' : 'butt'}
          />
        ))}
        {value !== null && value > 0 && tier !== null && (
          <path
            ref={fillRef}
            data-gauge-fill=""
            d={arcPath(cx, cy, r, GAUGE_START_DEG, GAUGE_END_DEG)}
            fill="none"
            stroke={statusVar(tier.status, 'bold')}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${String(fullLength)} ${String(fullLength)}`}
            strokeDashoffset={targetOffset}
          />
        )}
        {/* The surface gap between tiers, drawn over the fill too, so the tier edges read along the whole arc. */}
        {value !== null &&
          tierSegments()
            .slice(1)
            .map((segment) => {
              const inner = polar(cx, cy, r - stroke / 2 - 1, segment.startDeg);
              const outer = polar(cx, cy, r + stroke / 2 + 1, segment.startDeg);
              return (
                <line
                  key={segment.tier.id}
                  data-gauge-gap=""
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={healthVar('ring')}
                  strokeWidth={3}
                />
              );
            })}
        {end !== null && tier !== null && (
          <circle
            ref={endRef}
            data-gauge-end=""
            cx={end.x}
            cy={end.y}
            r={Math.max(4, stroke / 2)}
            fill={statusVar(tier.status, 'bold')}
            stroke={healthVar('ring')}
            strokeWidth={2}
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 flex flex-col items-center"
        style={{ top: cy - (size === 'md' ? 34 : 17) }}
      >
        {value === null ? (
          <span className={cn('max-w-[70%] text-center text-text-secondary', spec.caption)}>
            Not enough data yet
          </span>
        ) : (
          <>
            <span
              className={cn('font-semibold text-text-primary', spec.figure)}
              data-gauge-score=""
            >
              {scoreText(value)}
            </span>
            <span className={cn('mt-1 text-text-muted', spec.caption)}>of 100</span>
          </>
        )}
      </div>
    </div>
  );
}
