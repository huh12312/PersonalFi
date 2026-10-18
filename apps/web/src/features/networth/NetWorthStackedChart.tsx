// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { useCallback, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';
import type { AccountKind } from '../../components/finance/chart-hue.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { formatMoney, formatPercent, parseWireMoney } from '../../lib/money.ts';
import { netWorthVar } from './net-worth-chart-tokens.ts';
import {
  BUCKETING_RULE,
  KIND_LABEL,
  LEGEND_ORDER,
  extentOf,
  hasData,
  kindFillVar,
  latestIndex,
  legendAt,
  moveSelection,
  readoutAt,
  stackOf,
  type Bucketing,
  type Change,
  type StackedBucket,
} from './stacked.ts';

/**
 * Net worth stacked by account type, with the net line over the bars (WP 10.13, V6), drawn by the dataviz method.
 *
 * The question is "what is my net worth made of, and how has it moved?" — part-to-whole over time, with one
 * headline series — so: one column per bucket on **one** money axis, a segment per account type in its fixed
 * hue (`accountTypeHue`), assets stacked up from zero and liabilities down from it, and the net as a 2 px line
 * with ringed dots on the same axis (it is money too: never a second scale). Below zero the plot carries the
 * negative-area wash.
 *
 *  - Columns ≤ 24 px; a 2 px surface gap between segments (each segment is inset 1 px at every shared edge —
 *    never a stroke); the 4 px rounded data-end only on the topmost positive and the bottommost negative
 *    segment, square everywhere else.
 *  - Scrub: the pointer over the plot, or ← → Home End on the focused chart (a slider: its value is the
 *    selected bucket and is announced), selects a bucket; buckets older than the selection are drawn at
 *    reduced opacity; leaving the plot, Escape or moving focus away releases it and everything returns to the
 *    latest bucket. `onSelect` lets the hero above follow.
 *  - The readout above the plot: the date, the net, the change since the previous bucket and since the first
 *    in the period, in money and percent (the percent withheld, with the reason, when the base is zero or
 *    negative). The legend names every account type present with its total at the selected (else latest)
 *    bucket. **View as table** carries every bucket's segments and net, and states the bucketing rule.
 *  - A bucket with no snapshot draws nothing and breaks the line — a gap, never a zero.
 *  - Nothing animates (so nothing has to stop under reduced motion).
 */

const MAX_COLUMN = 24;
const RADIUS = 4;
const X_LABEL_BAND = 22;
const TICK_CHAR_PX = 7;
const DIMMED = 0.4;

function moneyText(minor: bigint | number, currency: string, compact = false): string {
  return formatMoney(parseWireMoney({ minor: String(Math.round(Number(minor))), currency }), {
    signDisplay: 'auto',
    compact,
  });
}

function exactMoney(minor: bigint, currency: string, signDisplay: 'auto' | 'exceptZero' = 'auto') {
  return formatMoney(parseWireMoney({ minor: minor.toString(), currency }), { signDisplay });
}

/** The bucket's name in words: a day, the week it spans, or the month. */
export function bucketLabel(bucket: StackedBucket, bucketing: Bucketing): string {
  switch (bucketing) {
    case 'day':
      return formatDateOnly(bucket.start, 'MMM d, yyyy');
    case 'week':
      return bucket.start === bucket.end
        ? formatDateOnly(bucket.start, 'MMM d, yyyy')
        : `${formatDateOnly(bucket.start, 'MMM d')} – ${formatDateOnly(bucket.end, 'MMM d, yyyy')}`;
    case 'month':
      return formatDateOnly(bucket.start, 'MMMM yyyy');
  }
}

/** The day a change is measured from: the compared bucket's closing day ("since Jul 26, 2026"). */
export function sinceLabel(bucket: StackedBucket): string {
  return formatDateOnly(bucket.asOfDate ?? bucket.end, 'MMM d, yyyy');
}

function tickLabel(bucket: StackedBucket, bucketing: Bucketing): string {
  return bucketing === 'month'
    ? formatDateOnly(bucket.start, 'MMM yy')
    : formatDateOnly(bucket.start, 'MMM d');
}

/** A segment from `near` (the zero side) to `far`; rounded (4 px) at the far end only when `rounded`. */
export function segmentPath(
  x: number,
  width: number,
  near: number,
  far: number,
  rounded: boolean,
): string {
  const height = Math.abs(near - far);
  if (height < 0.5 || width <= 0) return '';
  const top = Math.min(near, far);
  if (!rounded) return `M${x},${top}H${x + width}V${top + height}H${x}Z`;
  const r = Math.min(RADIUS, width / 2, height);
  if (far < near) {
    // Grows up: rounded top.
    return `M${x},${near}V${far + r}Q${x},${far} ${x + r},${far}H${x + width - r}Q${x + width},${far} ${x + width},${far + r}V${near}Z`;
  }
  // Grows down: rounded bottom.
  return `M${x},${near}V${far - r}Q${x},${far} ${x + r},${far}H${x + width - r}Q${x + width},${far} ${x + width},${far - r}V${near}Z`;
}

/** "+$1,200.00 (+0.8%)" or "+$1,200.00 — no percent: the starting figure is zero". */
export function changeText(change: Change, currency: string): string {
  const money = exactMoney(change.changeMinor, currency, 'exceptZero');
  if (change.ratio !== null)
    return `${money} (${formatPercent(change.ratio, { signDisplay: 'exceptZero' })})`;
  return `${money} — ${change.withheld ?? 'no percent'}`;
}

/** The readout as one sentence: the slider's value text and the keyboard announcement. */
export function readoutSentence(
  buckets: readonly StackedBucket[],
  index: number,
  bucketing: Bucketing,
  currency: string,
): string {
  const readout = readoutAt(buckets, index);
  const bucket = buckets[index];
  if (bucket === undefined) return '';
  if (readout === null) return `${bucketLabel(bucket, bucketing)}: no value recorded.`;
  const parts = [
    `${bucketLabel(bucket, bucketing)}: net worth ${exactMoney(bucket.netMinor ?? 0n, currency)}`,
  ];
  if (bucketing !== 'day' && bucket.asOfDate !== null) {
    parts[0] += ` (as of ${formatDateOnly(bucket.asOfDate, 'MMM d')})`;
  }
  if (!bucket.sealed) parts.push('live, may still change');
  if (readout.vsPrevious !== null)
    parts.push(`${changeText(readout.vsPrevious, currency)} vs the previous ${bucketing}`);
  if (readout.vsFirst !== null) {
    parts.push(
      `${changeText(readout.vsFirst, currency)} since ${sinceLabel(readout.vsFirst.against)}`,
    );
  }
  return `${parts.join('; ')}.`;
}

export interface NetWorthStackedInnerProps {
  readonly width: number;
  readonly height: number;
  readonly buckets: readonly StackedBucket[];
  readonly bucketing: Bucketing;
  readonly currency: string;
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
  /** The pointer is over the plot (cancels a pending release). */
  readonly onPointerKeep?: () => void;
  /** The pointer left the plot: release, after the readout's grace period (1.4.13). Default: release now. */
  readonly onPointerLeave?: () => void;
}

/** The plot. Exported so a unit test can drive it with an explicit size: `ParentSize` never measures in happy-dom. */
export function NetWorthStackedInner({
  width,
  height,
  buckets,
  bucketing,
  currency,
  selected,
  onSelect,
  onPointerKeep,
  onPointerLeave,
}: NetWorthStackedInnerProps) {
  const [rawLo, rawHi] = extentOf(buckets);
  const domain = scaleLinear<number>({
    domain: [rawLo, rawHi === rawLo ? rawLo + 10_000 : rawHi],
    nice: 4,
  }).domain() as [number, number];
  const yTicks = scaleLinear<number>({ domain }).ticks(4);
  const yLabelWidth =
    Math.max(...yTicks.map((tick) => moneyText(tick, currency, true).length)) * TICK_CHAR_PX;
  const margin = { top: 10, right: 8, bottom: X_LABEL_BAND, left: yLabelWidth + 10 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);
  const keys = buckets.map((bucket) => bucket.start);
  const xScale = scaleBand<string>({
    domain: keys,
    range: [0, innerWidth],
    paddingInner: 0.3,
    paddingOuter: 0.15,
  });
  const yScale = scaleLinear<number>({ domain, range: [innerHeight, 0] });
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const band = xScale.bandwidth();
  const step = xScale.step();
  const column = Math.max(Math.min(MAX_COLUMN, band), 1);
  const baseline = yScale(0);
  const center = (index: number) => (xScale(keys[index]!) ?? 0) + band / 2;
  const latest = latestIndex(buckets);
  const active = selected ?? latest;
  const labelEvery = Math.max(1, Math.ceil(52 / step));
  const dotsEverywhere = step >= 12;

  function indexAt(event: ReactPointerEvent<SVGRectElement>): number | null {
    const local = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const [index, bucket] of buckets.entries()) {
      if (!hasData(bucket)) continue;
      const distance = Math.abs(center(index) - local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  return (
    <svg width={width} height={height} aria-hidden="true" data-testid="net-worth-stacked-plot">
      <Group left={margin.left} top={margin.top}>
        {domain[0] < 0 && (
          <rect
            x={0}
            y={baseline}
            width={innerWidth}
            height={Math.max(innerHeight - baseline, 0)}
            fill={netWorthVar('negativeArea')}
          />
        )}
        {yTicks.map((tick) => (
          <line
            key={`grid-${tick}`}
            x1={0}
            x2={innerWidth}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke={netWorthVar(tick === 0 ? 'axis' : 'gridline')}
            strokeWidth={1}
          />
        ))}
        {selected !== null && buckets[selected] !== undefined && (
          // The crosshair finds the X: a 1 px hairline through the selected bucket, behind its bar.
          <line
            x1={center(selected)}
            x2={center(selected)}
            y1={0}
            y2={innerHeight}
            stroke={netWorthVar('crosshair')}
            strokeWidth={1}
            data-testid="net-worth-crosshair"
          />
        )}
        {yTicks.map((tick) => (
          <g key={tick}>
            <text
              data-axis="y"
              x={-8}
              y={yScale(tick)}
              dy="0.32em"
              fontSize={11}
              fill={netWorthVar('axisInk')}
              textAnchor="end"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {moneyText(tick, currency, true)}
            </text>
          </g>
        ))}

        {buckets.map((bucket, index) => {
          const left = (xScale(bucket.start) ?? 0) + (band - column) / 2;
          const dimmed = selected !== null && index < selected;
          return (
            <g
              key={bucket.start}
              data-bucket={bucket.start}
              opacity={dimmed ? DIMMED : 1}
              data-dimmed={dimmed ? 'true' : undefined}
            >
              {hasData(bucket) &&
                stackOf(bucket).map((piece) => {
                  // 1 px inset at every shared edge: a 2 px surface gap between neighbours and across zero.
                  const sign = piece.side === 'up' ? -1 : 1;
                  const near = yScale(piece.from) + sign * 1;
                  const far = yScale(piece.to) - (piece.rounded ? 0 : sign * 1);
                  return (
                    <path
                      key={piece.kind}
                      d={segmentPath(left, column, near, far, piece.rounded)}
                      fill={kindFillVar(piece.kind)}
                      data-kind={piece.kind}
                      data-side={piece.side}
                      data-rounded={piece.rounded ? 'true' : 'false'}
                    />
                  );
                })}
            </g>
          );
        })}

        {/* Tick labels outside the dimmed groups: text keeps its full contrast whatever is selected. */}
        {buckets.map((bucket, index) =>
          index === active ||
          (index % labelEvery === (buckets.length - 1) % labelEvery &&
            Math.abs(index - active) * step >= 48) ? (
            <text
              key={`tick-${bucket.start}`}
              data-axis="x"
              x={center(index)}
              y={innerHeight + 16}
              fontSize={11}
              fontWeight={index === active && selected !== null ? 600 : 400}
              fill={netWorthVar(
                index === active && selected !== null ? 'axisInkStrong' : 'axisInk',
              )}
              textAnchor="middle"
            >
              {tickLabel(bucket, bucketing)}
            </text>
          ) : null,
        )}

        <LinePath<StackedBucket>
          data={buckets as StackedBucket[]}
          defined={(bucket) => hasData(bucket)}
          x={(_, index) => center(index)}
          y={(bucket) => yScale(Number(bucket.netMinor ?? 0n))}
          stroke={netWorthVar('net')}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          data-series="net"
        />
        {buckets.map((bucket, index) =>
          hasData(bucket) && (dotsEverywhere || index === active || index === latest) ? (
            <circle
              key={`net-${bucket.start}`}
              cx={center(index)}
              cy={yScale(Number(bucket.netMinor))}
              r={index === active && selected !== null ? 5 : 4}
              fill={netWorthVar('net')}
              stroke={netWorthVar('ring')}
              strokeWidth={2}
              paintOrder="stroke"
              pointerEvents="none"
              data-net-dot={bucket.start}
            />
          ) : null,
        )}

        <rect
          x={0}
          y={0}
          width={innerWidth}
          height={innerHeight + X_LABEL_BAND}
          fill="transparent"
          style={{ touchAction: 'pan-y' }}
          data-testid="net-worth-scrub-surface"
          onPointerMove={(event) => {
            onPointerKeep?.();
            const index = indexAt(event);
            if (index !== null && index !== selected) onSelect(index);
          }}
          onPointerDown={(event) => {
            onPointerKeep?.();
            const index = indexAt(event);
            if (index !== null) onSelect(index);
          }}
          onPointerLeave={() => (onPointerLeave === undefined ? onSelect(null) : onPointerLeave())}
        />
      </Group>
    </svg>
  );
}

function SwatchKey({ kind }: { readonly kind: AccountKind }) {
  return (
    <svg width={10} height={10} aria-hidden="true" className="shrink-0">
      <rect width={10} height={10} rx={2} fill={kindFillVar(kind)} />
    </svg>
  );
}

function NetKey() {
  return (
    <svg width={18} height={10} aria-hidden="true" className="shrink-0">
      <line
        x1={2}
        x2={16}
        y1={5}
        y2={5}
        stroke={netWorthVar('net')}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={9} cy={5} r={3} fill={netWorthVar('net')} />
    </svg>
  );
}

export interface NetWorthStackedChartProps {
  /** One currency's buckets, every position of the window (gaps included). */
  readonly buckets: readonly StackedBucket[];
  readonly bucketing: Bucketing;
  readonly currency: string;
  /** "Net worth by account type" (+ the currency when there is more than one). */
  readonly title: string;
  /** The selected bucket, owned by the caller so the hero above can follow it; `null` = the latest. */
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
  readonly height?: number;
  readonly className?: string;
  /** A small label pinned above the chart (the currency code when the window spans more than one). */
  readonly seriesLabel?: string;
}

export function NetWorthStackedChart({
  buckets,
  bucketing,
  currency,
  title,
  selected,
  onSelect,
  height = 240,
  className,
  seriesLabel,
}: NetWorthStackedChartProps) {
  const [announcement, setAnnouncement] = useState('');
  // 1.4.13 for the scrub: leaving the plot releases after a grace period, the readout can be hovered and keeps the
  // selection while it is, and Escape releases without the pointer moving (`useChartTooltipRules`).
  const release = useCallback(() => onSelect(null), [onSelect]);
  const rules = useChartTooltipRules(release, selected !== null);
  const latest = latestIndex(buckets);
  const active = selected ?? latest;
  const readout = active >= 0 ? readoutAt(buckets, active) : null;
  const activeBucket = active >= 0 ? buckets[active] : undefined;
  const legend = legendAt(activeBucket);
  const valued = buckets.filter(hasData);
  const position = active >= 0 ? valued.indexOf(buckets[active]!) + 1 : 0;
  const sentence =
    active >= 0
      ? readoutSentence(buckets, active, bucketing, currency)
      : 'No net worth recorded in this period.';

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      if (selected !== null) {
        // Escape releases the selection first; only a second Escape reaches an enclosing dialog.
        event.preventDefault();
        event.stopPropagation();
        onSelect(null);
        setAnnouncement('Back to the latest figure.');
      }
      return;
    }
    const next = moveSelection(buckets, selected, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    setAnnouncement(readoutSentence(buckets, next, bucketing, currency));
  }

  const kindsPresent = LEGEND_ORDER.filter((kind) =>
    buckets.some((bucket) => bucket.segments.some((segment) => segment.kind === kind)),
  );

  return (
    <div className={className} data-testid="net-worth-stacked" data-currency={currency}>
      {seriesLabel !== undefined && (
        <p
          className="mb-1 text-caption font-medium text-text-secondary"
          data-testid={`net-worth-series-label-${seriesLabel}`}
        >
          {seriesLabel}
        </p>
      )}

      {readout !== null && activeBucket !== undefined && (
        <div
          className="flex flex-col gap-0.5 text-small"
          data-testid="net-worth-readout"
          // While a bucket is selected this is the chart's readout (1.4.13: hoverable, persistent, dismissible).
          {...(selected === null ? {} : { 'data-chart-readout': '', ...rules.readoutProps })}
        >
          <p className="text-text-secondary">
            <span data-testid="net-worth-readout-date">{bucketLabel(activeBucket, bucketing)}</span>
            {bucketing !== 'day' && activeBucket.asOfDate !== null && (
              <span className="text-text-muted">
                {' '}
                · as of {formatDateOnly(activeBucket.asOfDate, 'MMM d')}
              </span>
            )}
            {!activeBucket.sealed && (
              <span className="text-text-muted"> · live, may still change</span>
            )}
            {selected === null && <span className="text-text-muted"> · latest</span>}
          </p>
          <p className="font-semibold text-text-primary" data-testid="net-worth-readout-net">
            {exactMoney(activeBucket.netMinor ?? 0n, currency)}
          </p>
          {readout.vsPrevious !== null && (
            <p className="text-text-secondary" data-testid="net-worth-readout-previous">
              {changeText(readout.vsPrevious, currency)} vs the previous {bucketing}
            </p>
          )}
          {readout.vsFirst !== null && (
            <p className="text-text-secondary" data-testid="net-worth-readout-first">
              {changeText(readout.vsFirst, currency)} since {sinceLabel(readout.vsFirst.against)}
            </p>
          )}
        </div>
      )}

      {legend.length > 0 && (
        <ul
          aria-label={`Account types${activeBucket === undefined ? '' : `, ${bucketLabel(activeBucket, bucketing)}`}`}
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary"
          data-testid="net-worth-legend"
        >
          {legend.map((entry) => (
            <li
              key={entry.kind}
              className="flex items-center gap-1.5"
              data-legend-kind={entry.kind}
            >
              <SwatchKey kind={entry.kind} />
              {KIND_LABEL[entry.kind]}
              <span className="tabular-nums text-text-primary">
                {exactMoney(entry.minor, currency)}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <NetKey />
            Net worth
          </li>
        </ul>
      )}

      <div
        role="slider"
        tabIndex={valued.length > 0 ? 0 : -1}
        aria-label={`${title}: choose a ${bucketing}`}
        aria-valuemin={valued.length > 0 ? 1 : 0}
        aria-valuemax={valued.length}
        aria-valuenow={position}
        aria-valuetext={sentence}
        onKeyDown={onKeyDown}
        onBlur={() => onSelect(null)}
        className="mt-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        style={{ height }}
        data-testid="net-worth-slider"
      >
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <NetWorthStackedInner
              width={width}
              height={parentHeight}
              buckets={buckets}
              bucketing={bucketing}
              currency={currency}
              selected={selected}
              onSelect={onSelect}
              onPointerKeep={rules.keep}
              onPointerLeave={rules.onChartLeave}
            />
          )}
        </ParentSize>
      </div>
      <p className="sr-only" aria-live="polite" data-testid="net-worth-announcement">
        {announcement}
      </p>

      {/* 09 §5.6: every bucket's segments and net, for the reader the plot and the readout cannot reach. */}
      <ChartDataTable
        className="mt-1"
        caption={`${title}. ${BUCKETING_RULE[bucketing]}`}
        columns={['Period', ...kindsPresent.map((kind) => KIND_LABEL[kind]), 'Net worth']}
        rows={buckets.map((bucket) => {
          const label = `${bucketLabel(bucket, bucketing)}${
            bucketing !== 'day' && bucket.asOfDate !== null
              ? ` (as of ${formatDateOnly(bucket.asOfDate, 'MMM d')})`
              : ''
          }${hasData(bucket) && !bucket.sealed ? ' (live)' : ''}`;
          if (!hasData(bucket)) {
            return [label, ...kindsPresent.map(() => '—'), 'No value recorded'];
          }
          const byKind = new Map(bucket.segments.map((segment) => [segment.kind, segment.minor]));
          return [
            label,
            ...kindsPresent.map((kind) => {
              const minor = byKind.get(kind);
              return minor === undefined ? '—' : exactMoney(minor, currency);
            }),
            exactMoney(bucket.netMinor ?? 0n, currency),
          ];
        })}
      />
    </div>
  );
}
