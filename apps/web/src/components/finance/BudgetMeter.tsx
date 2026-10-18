// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { AlertOctagon, CircleCheck, Gauge, Repeat, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';
import { wireOf } from '../../lib/money.ts';
import { Money } from './Money.tsx';
import {
  fillFractionOf,
  meterStateOf,
  METER_STATE_STATUS,
  METER_STATE_WORDS,
  paceWordsOf,
  spentPercentOf,
  type MeterFigures,
  type MeterState,
  type PaceStatus,
} from './budget-meter.ts';

export type BudgetMeterSize = 'xs' | 'sm' | 'md';
export type BudgetMeterShape = 'squared' | 'rounded';

/**
 * Track = the state's wash (`--status-*-bg`), edged by its border; fill = its bold step. The dataviz skill's meter:
 * "the fill carries severity; the unfilled track is a lighter step of the same ramp", so the state reads across the
 * whole bar. Literal class strings, so Tailwind sees every one.
 */
const TRACK: Record<keyof typeof STATUS_TEXT, string> = {
  success: 'bg-status-success-bg border-status-success-border',
  info: 'bg-status-info-bg border-status-info-border',
  warning: 'bg-status-warning-bg border-status-warning-border',
  danger: 'bg-status-danger-bg border-status-danger-border',
};
const FILL: Record<keyof typeof STATUS_TEXT, string> = {
  success: 'bg-status-success-bold',
  info: 'bg-status-info-bold',
  warning: 'bg-status-warning-bold',
  danger: 'bg-status-danger-bold',
};
const STATUS_TEXT = {
  success: 'text-status-success-text',
  info: 'text-status-info-text',
  warning: 'text-status-warning-text',
  danger: 'text-status-danger-text',
} as const;

const HEIGHT: Record<BudgetMeterSize, string> = { xs: 'h-1', sm: 'h-1.5', md: 'h-2.5' };
const RADIUS: Record<BudgetMeterShape, string> = {
  squared: 'rounded-[2px]',
  rounded: 'rounded-full',
};

const STATE_ICON: Record<Exclude<MeterState, 'no_budget'>, typeof Gauge> = {
  under: CircleCheck,
  within: CircleCheck,
  on_pace: Gauge,
  ahead: TrendingUp,
  over: AlertOctagon,
};

export interface BudgetMeterProps {
  readonly figures: MeterFigures;
  readonly pace: PaceStatus;
  /** What the meter measures, for its accessible name ("Groceries", "Fixed expenses"). */
  readonly label: string;
  readonly size?: BudgetMeterSize;
  readonly shape?: BudgetMeterShape;
  readonly className?: string;
}

/**
 * The bar alone (the meter bar with `tickPercent` and `showRolloverIcon`): spent ÷ budgeted, a pace tick at the
 * fraction of the period elapsed, the rollover glyph when the budget carries one. **Withheld** (renders nothing) at
 * a budget of zero — `BudgetMeterRow` says "no amount set" instead of drawing an empty bar. The fill never animates
 * under reduced motion. The hover readout says what the bar and the tick are, in words.
 */
export function BudgetMeter({
  figures,
  pace,
  label,
  size = 'sm',
  shape = 'squared',
  className,
}: BudgetMeterProps) {
  const state = meterStateOf(figures, pace);
  if (state === 'no_budget') return null;
  const status = METER_STATE_STATUS[state];
  const fill = fillFractionOf(figures);
  const percent = spentPercentOf(figures) ?? 0;
  const tick = pace.kind === 'running' ? pace.fraction : null;
  const tickText =
    pace.kind === 'running'
      ? `pace ${String(Math.round(pace.fraction * 100))}% (${paceWordsOf(pace)})`
      : paceWordsOf(pace);
  const rolled = figures.rolledOver.minor !== 0n;
  return (
    <div className={cn('group/meter relative flex items-center gap-1.5', className)}>
      <div
        role="meter"
        aria-label={`${label}: spent of budget`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.max(0, percent))}
        aria-valuetext={`${String(percent)}% of the budget spent, ${METER_STATE_WORDS[state].toLowerCase()}; ${tickText}`}
        data-meter-state={state}
        data-meter-size={size}
        className={cn('relative w-full border', HEIGHT[size], RADIUS[shape], TRACK[status])}
      >
        <div
          data-meter-fill=""
          className={cn(
            'h-full transition-[width] duration-300 motion-reduce:transition-none',
            RADIUS[shape],
            FILL[status],
          )}
          style={{ width: `${String(fill * 100)}%` }}
        />
        {tick !== null && (
          <span
            data-meter-tick={tick.toFixed(4)}
            aria-hidden="true"
            className="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-text-primary ring-1 ring-bg-primary"
            style={{ left: `${String(tick * 100)}%` }}
          />
        )}
      </div>
      {rolled && (
        <span className="shrink-0 text-text-secondary" title="Includes money rolled over">
          <Repeat size={size === 'md' ? 14 : 12} aria-hidden="true" />
          <span className="sr-only">Includes money rolled over from last period</span>
        </span>
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-max max-w-64 rounded-md border border-border-primary bg-bg-overlay px-2 py-1 text-caption text-text-primary shadow-md group-hover/meter:block"
      >
        {String(percent)}% spent · {tickText}
      </span>
    </div>
  );
}

export interface BudgetMeterRowProps extends BudgetMeterProps {
  /** The visible label. Defaults to `label`. */
  readonly title?: ReactNode;
  /** Heading level semantics are the caller's; this is the line of text above the bar. */
  readonly titleClassName?: string;
}

/**
 * One labelled meter: the title and the state in words with its icon, the bar, then "$spent of $budgeted ·
 * $remaining left" (or "· $over over"), right-aligned and tabular. At a budget of zero: "$spent spent · no amount
 * set", and no bar.
 */
export function BudgetMeterRow({
  title,
  titleClassName,
  figures,
  pace,
  label,
  size = 'sm',
  shape = 'squared',
  className,
}: BudgetMeterRowProps) {
  const state = meterStateOf(figures, pace);
  const spent = <Money value={wireOf(figures.spent)} signDisplay="auto" colorBySign={false} />;
  if (state === 'no_budget') {
    return (
      <div className={className} data-meter-state="no_budget">
        {title !== undefined && (
          <div className={cn('text-small font-medium text-text-primary', titleClassName)}>
            {title}
          </div>
        )}
        <p className="text-caption text-text-secondary tabular-nums">
          {figures.spent.minor !== 0n && <>{spent} spent · </>}no amount set
        </p>
      </div>
    );
  }
  const status = METER_STATE_STATUS[state];
  const Icon = STATE_ICON[state];
  const over = figures.remaining.minor < 0n;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        {title !== undefined && (
          <div className={cn('min-w-0 text-small font-medium text-text-primary', titleClassName)}>
            {title}
          </div>
        )}
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 text-caption font-medium',
            STATUS_TEXT[status],
          )}
        >
          <Icon size={12} aria-hidden="true" />
          {METER_STATE_WORDS[state]}
        </span>
      </div>
      <BudgetMeter
        figures={figures}
        pace={pace}
        label={label}
        size={size}
        shape={shape}
        className="mt-1"
      />
      <p className="mt-1 text-right text-caption text-text-secondary tabular-nums">
        {spent} of <Money value={wireOf(figures.budgeted)} signDisplay="auto" colorBySign={false} />{' '}
        ·{' '}
        {over ? (
          <>
            <Money
              value={wireOf(MoneyKernel.negate(figures.remaining))}
              signDisplay="auto"
              colorBySign={false}
            />{' '}
            over
          </>
        ) : (
          <>
            <Money value={wireOf(figures.remaining)} signDisplay="auto" colorBySign={false} /> left
          </>
        )}
      </p>
    </div>
  );
}
