// SPDX-License-Identifier: MIT
import { Money } from '../../components/finance/Money.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { formatPercent } from '../../lib/money.ts';
import { netWorthDelta } from '../dashboard/widgets/net-worth-delta.ts';
import { wire } from '../dashboard/widgets/pace.ts';
import { useNetWorthSeriesPeriodQuery } from './api.ts';
import type { HeroSelection } from './NetWorthStackedCharts.tsx';
import {
  DASHBOARD_PERIOD_LABELS,
  DEFAULT_DASHBOARD_PERIOD,
  type DashboardPeriod,
} from './search.ts';
import { latestValued } from './series.ts';

/**
 * The hero net-worth figure, read from the same `GET /net-worth/series` response the chart below draws.
 *
 * Phase 3 gate finding G3-2 (docs/evidence/phase-3/gate-security-review.md): until this was fixed the hero
 * rendered two scaffold literals from WP 0.x — `$88,904.00` and "+$4,210.00 2.1% this month" — on every install,
 * above a chart drawn from real data. A net worth the app did not compute is the one number this screen must never
 * show, so there is deliberately no fallback here: no value yet reads as "—", and no change is shown at all until
 * one can be computed from two real points (`netWorthDelta`). Moved with the widget by WP 10.9 and here by WP 10.13
 * (the full view shows it too); `_app.index.tsx` still re-exports it.
 *
 * WP 10.13: **it follows the scrub.** While a bucket of the chart below is selected, the figure is that bucket's
 * net worth, the as-of line is its closing day, and the change line is since the first bucket in the period; when
 * the selection is released it returns to the latest point. "Live, may still change" stays on whichever day is the
 * open one.
 */
export function NetWorthHero({
  period = DEFAULT_DASHBOARD_PERIOD,
  selection = null,
}: {
  readonly period?: DashboardPeriod;
  readonly selection?: HeroSelection | null;
}) {
  const seriesQuery = useNetWorthSeriesPeriodQuery(period);
  const points = seriesQuery.data?.points ?? [];
  const latest = latestValued(points);
  const delta = netWorthDelta(points);

  if (selection !== null) {
    return (
      <StatTile
        label="Net worth"
        size="hero"
        value={<Money value={selection.netWorth} signDisplay="auto" colorBySign={false} />}
        delta={
          <span className="flex flex-col gap-0.5" data-testid="net-worth-hero-selection">
            {selection.sinceFirst !== null && (
              <span className="text-text-secondary" data-testid="net-worth-delta">
                {selection.sinceFirst}
              </span>
            )}
            <span className="text-text-muted">
              {`${selection.label} · as of ${selection.asOfDate}${selection.sealed ? '' : ' · live, may still change'}`}
            </span>
          </span>
        }
      />
    );
  }

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
