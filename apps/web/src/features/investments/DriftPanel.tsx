// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { Target } from 'lucide-react';
import { useId } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import type { GetDriftResponse } from '../../api/generated/types.gen.ts';
import { assetClassLabel, pointsToNumber, ratioToNumber } from './labels.ts';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';

const ROW_HEIGHT = 30;
const BAR_HEIGHT = 14;
const CHART_WIDTH = 520;
const LABEL_WIDTH = 190;
const MARGIN = { top: 22, right: 12, bottom: 8 };

export interface DriftPanelProps {
  readonly data: GetDriftResponse | undefined;
  readonly isLoading: boolean;
  /** Opens the drift tab with a demonstration target set (the URL is where targets live today). */
  readonly onUseExampleTargets: () => void;
  readonly hasTargets: boolean;
}

/**
 * Drift against a target allocation.
 *
 * **Suppress, never invent** (07 §8 Q9, and `wp3.9-routes.md` §8 item 1):
 * with no target the route answers `targetsSet: false` with `rows: []`, and
 * this panel renders exactly one thing — a "set a target" empty state. It
 * does not fall back to an equal-weight target, a "typical" 60/40, or the
 * current allocation-as-target, all of which would draw a plausible chart
 * about a decision the user never made. The exit test
 * `'drift renders nothing when no target is set'` pins that.
 *
 * With targets, the **±`bandPoints` band is drawn**, not merely described:
 * a shaded, dashed rectangle centred on zero that every bar is measured
 * against, so "inside the band" is something you see rather than something
 * you compute. Inside/outside is encoded three ways — the CVD-safe
 * teal/vermilion pair, a hatch texture on the outside bars, and a text label
 * in the row — because hue alone is not a signal (D20).
 */
export function DriftPanel({ data, isLoading, onUseExampleTargets, hasTargets }: DriftPanelProps) {
  const hatchId = `drift-hatch-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;

  if (isLoading) return <Skeleton variant="block" height={240} />;
  if (data === undefined) return null;

  if (!data.targetsSet) {
    return (
      <section aria-labelledby="drift-heading" className="flex flex-col gap-4">
        <h2 id="drift-heading" className="text-h3 text-text-primary">
          Drift
        </h2>
        <EmptyState
          icon={Target}
          headline="Set a target allocation"
          description="Drift compares what you hold against a target you choose. Until you set one, there is nothing to compare — so this screen stays empty rather than guessing a target for you."
          {...(hasTargets
            ? {}
            : { action: { label: 'Use an example target', onClick: onUseExampleTargets } })}
        />
      </section>
    );
  }

  const band = pointsToNumber(data.bandPoints);
  const maxGap = Math.max(
    band * 1.6,
    ...data.rows.map((row) => Math.abs(pointsToNumber(row.gapPoints))),
  );
  const domain = Math.max(maxGap * 1.15, band * 1.6);
  const innerHeight = data.rows.length * ROW_HEIGHT;
  const scale = scaleLinear<number>({ domain: [-domain, domain], range: [0, CHART_WIDTH] });
  const zero = scale(0);
  const bandLeft = scale(-band);
  const bandRight = scale(band);

  return (
    <section aria-labelledby="drift-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="drift-heading" className="text-h3 text-text-primary">
          Drift
        </h2>
        <p className="text-small text-text-secondary">
          Rebalancing band: ±{data.bandPoints} percentage points
        </p>
      </div>

      {data.noisy && (
        <p role="status" className="text-small text-status-warning" data-testid="drift-noisy">
          {ratioToNumber(data.unclassifiedPct) > 0 ? (
            <>
              <Percent value={ratioToNumber(data.unclassifiedPct)} /> of this portfolio is
              unclassified.{' '}
            </>
          ) : null}
          {data.proposalsWithheld ?? 'Rebalancing proposals are withheld.'}
        </p>
      )}

      <div className="overflow-x-auto">
        <svg
          width={LABEL_WIDTH + CHART_WIDTH + MARGIN.right}
          height={innerHeight + MARGIN.top + MARGIN.bottom}
          aria-hidden="true"
          focusable="false"
          data-testid="drift-band-chart"
        >
          <defs>
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse">
              <rect width={6} height={6} fill="var(--money-neg)" />
              <path
                d="M0,6 l6,-6 M-1.5,1.5 l3,-3 M4.5,7.5 l3,-3"
                stroke="var(--bg-surface)"
                strokeWidth={1.2}
                fill="none"
                opacity={0.8}
              />
            </pattern>
          </defs>
          <Group left={LABEL_WIDTH} top={MARGIN.top}>
            {/* The band itself — drawn, not described. */}
            <rect
              x={bandLeft}
              y={-14}
              width={bandRight - bandLeft}
              height={innerHeight + 14}
              fill="var(--bg-subtle)"
              stroke="var(--border-strong)"
              strokeDasharray="4,3"
              data-testid="drift-band"
            />
            <text
              x={(bandLeft + bandRight) / 2}
              y={-18}
              textAnchor="middle"
              fontSize={10}
              fill="var(--chart-axis-ink)"
            >
              ±{data.bandPoints} pts
            </text>
            <line x1={zero} x2={zero} y1={-14} y2={innerHeight} stroke="var(--chart-gridline)" />
            {data.rows.map((row, index) => {
              const gap = pointsToNumber(row.gapPoints);
              const x = scale(Math.min(0, gap));
              const width = Math.max(Math.abs(scale(gap) - zero), 1);
              const y = index * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
              return (
                <Group key={row.assetClass}>
                  <text
                    x={-10}
                    y={y + BAR_HEIGHT - 2}
                    textAnchor="end"
                    fontSize={11}
                    fill="var(--chart-axis-ink)"
                  >
                    {assetClassLabel(row.assetClass)}
                  </text>
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={BAR_HEIGHT}
                    rx={2}
                    fill={row.insideBand ? 'var(--money-pos)' : `url(#${hatchId})`}
                  />
                </Group>
              );
            })}
          </Group>
        </svg>
      </div>

      <ScrollRegion label="Target versus actual allocation">
        <table className="w-full text-small" data-testid="drift-table">
          <caption className="sr-only">
            Target versus actual allocation, with the gap in percentage points and whether it sits
            inside the ±{data.bandPoints}-point rebalancing band.
          </caption>
          <thead>
            <tr className="border-b border-border-hairline text-left text-text-secondary">
              <th scope="col" className="py-2 font-medium">
                Asset class
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Target
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Actual
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Gap
              </th>
              <th scope="col" className="py-2 font-medium">
                Band
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Suggested move
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr
                key={row.assetClass}
                className="border-b border-border-hairline last:border-0"
                data-testid={`drift-row-${row.assetClass}`}
              >
                <th scope="row" className="py-2 text-left font-normal text-text-primary">
                  {assetClassLabel(row.assetClass)}
                </th>
                <td className="py-2 text-right tabular-nums">
                  <Percent value={ratioToNumber(row.targetWeight)} />
                </td>
                <td className="py-2 text-right tabular-nums">
                  <Percent value={ratioToNumber(row.actualWeight)} />
                </td>
                <td className="py-2 text-right tabular-nums">{row.gapPoints} pts</td>
                <td className="py-2">
                  <span className={row.insideBand ? 'text-money-pos-text' : 'text-money-neg-text'}>
                    {row.insideBand ? 'inside band' : 'outside band'}
                  </span>
                </td>
                <td className="py-2 text-right">
                  {row.proposal === null ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <>
                      {row.proposal.direction === 'increase' ? 'Add ' : 'Reduce by '}
                      <Money value={row.proposal.amount} signDisplay="auto" colorBySign={false} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </section>
  );
}
