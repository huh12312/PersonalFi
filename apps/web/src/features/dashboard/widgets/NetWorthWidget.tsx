// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Money } from '../../../components/finance/Money.tsx';
import { StatTile } from '../../../components/finance/StatTile.tsx';
import { formatPercent } from '../../../lib/money.ts';
import { cn } from '../../../lib/cn.ts';
import { useNetWorthSeriesPeriodQuery } from '../../networth/api.ts';
import { NetWorthDashboardSection } from '../../networth/NetWorthChart.tsx';
import {
  DASHBOARD_PERIOD_LABELS,
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
  type DashboardPeriod,
  type NetWorthRange,
} from '../../networth/search.ts';
import { latestValued } from '../../networth/series.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { netWorthDelta } from './net-worth-delta.ts';
import { wire } from './pace.ts';

/**
 * The hero net-worth figure, read from the same `GET /net-worth/series` response the chart below draws.
 *
 * Phase 3 gate finding G3-2 (docs/evidence/phase-3/gate-security-review.md): until this was fixed the hero
 * rendered two scaffold literals from WP 0.x — `$88,904.00` and "+$4,210.00 2.1% this month" — on every install,
 * above a chart drawn from real data. A net worth the app did not compute is the one number this screen must never
 * show, so there is deliberately no fallback here: no value yet reads as "—", and no change is shown at all until
 * one can be computed from two real points (`netWorthDelta`). Moved here from `_app.index.tsx` by WP 10.9, which
 * re-exports it; the default period (3M) is the 90-day window it always read.
 */
export function NetWorthHero({
  period = DEFAULT_DASHBOARD_PERIOD,
}: {
  readonly period?: DashboardPeriod;
}) {
  const seriesQuery = useNetWorthSeriesPeriodQuery(period);
  const points = seriesQuery.data?.points ?? [];
  const latest = latestValued(points);
  const delta = netWorthDelta(points);

  return (
    <StatTile
      label="Net worth"
      size="hero"
      value={
        latest?.netWorth != null ? (
          <Money value={latest.netWorth} signDisplay="auto" colorBySign={false} />
        ) : (
          <span aria-label="No net worth recorded yet">—</span>
        )
      }
      delta={
        <span className="flex flex-col gap-0.5">
          {delta !== null && (
            <span className="text-text-secondary" data-testid="net-worth-delta">
              <Money value={wire(delta.change)} colorBySign />
              {delta.ratio !== null && (
                <span className="tabular-nums">
                  {' '}
                  ({formatPercent(delta.ratio, { signDisplay: 'exceptZero' })})
                </span>
              )}{' '}
              over {DASHBOARD_PERIOD_LABELS[period].long}
            </span>
          )}
          <span className="text-text-muted">
            {latest === undefined
              ? seriesQuery.isLoading
                ? 'Loading…'
                : 'No net worth recorded yet'
              : `As of ${latest.asOfDate}${latest.sealed ? '' : ' · live, may still change'}`}
          </span>
        </span>
      }
    />
  );
}

export interface NetWorthWidgetProps {
  /** URL-synced range for the full-history dialog (`_app.index.tsx`'s `netWorthRange`). */
  readonly range?: NetWorthRange;
  readonly onRangeChange?: (range: NetWorthRange) => void;
}

/** Net worth (WP 10.9): the hero figure with its change over the chosen period, the chips, the chart. */
export function NetWorthWidget({ range, onRangeChange }: NetWorthWidgetProps) {
  const [period, setPeriod] = useState<DashboardPeriod>(DEFAULT_DASHBOARD_PERIOD);
  const query = useNetWorthSeriesPeriodQuery(period);
  // The body renders once there is an answer (the hero says "—" and the chart says why when there is nothing). A
  // failed read is the error state, *not* the body: the body's hero and chart are observers of the same query, and
  // mounting them over an errored query refetches it (TanStack's retry-on-mount), which flipped this card to
  // loading, unmounted them, failed again and remounted them — a render loop found by DashboardScreen.test.tsx.
  const state: WidgetState = query.isError
    ? { kind: 'error', message: "Net worth history isn't available right now." }
    : query.data === undefined
      ? { kind: 'loading' }
      : { kind: 'ready' };

  return (
    <DashboardWidgetCard
      id="net-worth"
      title="Net worth"
      seeAll={{ to: '/accounts', label: 'Accounts' }}
      state={state}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <NetWorthHero period={period} />
        <div role="group" aria-label="Net worth period" className="flex flex-wrap gap-1">
          {DASHBOARD_PERIODS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === period}
              onClick={() => setPeriod(option)}
              className={cn(
                'inline-flex h-8 min-w-10 items-center justify-center rounded-md px-2 text-xs font-medium',
                option === period
                  ? 'bg-bg-secondary text-text-primary ring-1 ring-border-primary'
                  : 'text-text-secondary hover:bg-bg-subtle',
              )}
            >
              {DASHBOARD_PERIOD_LABELS[option].short}
              {/* The name keeps the visible text first (2.5.3 Label in Name) and says what it means. */}
              <span className="sr-only">: {DASHBOARD_PERIOD_LABELS[option].long}</span>
            </button>
          ))}
        </div>
      </div>
      <NetWorthDashboardSection
        className="mt-4"
        period={period}
        {...(range === undefined ? {} : { range })}
        {...(onRangeChange === undefined ? {} : { onRangeChange })}
      />
    </DashboardWidgetCard>
  );
}
