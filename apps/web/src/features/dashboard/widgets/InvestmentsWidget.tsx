// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';

import { Money } from '../../../components/finance/Money.tsx';
import { StatTile } from '../../../components/finance/StatTile.tsx';
import { formatDateOnly } from '../../../lib/date.ts';
import { parseWireMoney } from '../../../lib/money.ts';
import { useHoldingsQuery, usePerformanceQuery } from '../../investments/api.ts';
import { DEFAULT_BASIS } from '../../investments/search.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';

/** Yesterday as `YYYY-MM-DD` in the browser's calendar (the performance window `(yesterday, today]`). */
export function yesterdayIso(now: Date = new Date()): string {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(local.getFullYear())}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/**
 * Investments (WP 10.9; Monarch's equivalent): the portfolio's value and its change since yesterday.
 *
 * Honest by construction: no holdings is "no investments yet" with the screen that connects one; holdings with no
 * price are "no price yet" (never a $0 total); the day change is the performance route's own period gain over
 * `(yesterday, today]` (closing − opening − contributions), shown only when yesterday had a priced value — a day
 * with no opening price has no change to show, and says so; a stale price shows its date.
 */
export function InvestmentsWidget({ now }: { readonly now?: Date } = {}) {
  const holdingsQuery = useHoldingsQuery(DEFAULT_BASIS);
  const performanceQuery = usePerformanceQuery(yesterdayIso(now));
  const holdings = holdingsQuery.data;

  const priced = holdings?.holdings.filter((holding) => holding.marketValue !== null) ?? [];
  const state: WidgetState = holdingsQuery.isLoading
    ? { kind: 'loading' }
    : holdingsQuery.isError || holdings === undefined
      ? { kind: 'error', message: "Investments aren't available right now." }
      : holdings.holdings.length === 0 && holdings.unresolved.length === 0
        ? {
            kind: 'empty',
            message: 'No investment holdings yet.',
            fix: { to: '/accounts/connections', label: 'Connect a brokerage' },
          }
        : priced.length === 0
          ? {
              kind: 'empty',
              message: `No price yet for ${String(holdings.holdings.length + holdings.unresolved.length)} holding${holdings.holdings.length + holdings.unresolved.length === 1 ? '' : 's'}: a value appears once a price is fetched.`,
              fix: { to: '/investments', label: 'Open investments' },
            }
          : { kind: 'ready' };

  const summary = performanceQuery.data?.summary;
  const opening = summary === undefined ? null : parseWireMoney(summary.openingValue);
  const dayChange =
    summary !== undefined && opening !== null && !MoneyKernel.isZero(opening)
      ? summary.periodGain
      : null;
  const stale = priced.filter((holding) => holding.stale);
  const oldest = stale
    .map((holding) => holding.price?.priceDate)
    .filter((date): date is string => date !== undefined)
    .sort()[0];
  const leftOut = holdings === undefined ? 0 : holdings.excluded.length;

  return (
    <DashboardWidgetCard
      id="investments"
      title="Investments"
      seeAll={{ to: '/investments', label: 'See all' }}
      state={state}
      asOf={
        oldest === undefined
          ? undefined
          : `Some prices are from ${formatDateOnly(oldest, 'MMM d')}: no newer price yet.`
      }
    >
      {holdings !== undefined && (
        <>
          <StatTile
            label="Total value"
            size="display"
            value={<Money value={holdings.total} signDisplay="auto" colorBySign={false} />}
            delta={
              dayChange === null ? (
                <span className="text-text-muted" data-testid="investments-day-change">
                  {performanceQuery.isLoading
                    ? 'Loading today’s change…'
                    : 'No change since yesterday to show: no price for yesterday yet'}
                </span>
              ) : (
                <span className="text-text-secondary" data-testid="investments-day-change">
                  <Money value={dayChange} colorBySign /> today
                </span>
              )
            }
          />
          {leftOut > 0 && (
            <p className="mt-2 text-caption text-text-muted">
              {leftOut} holding{leftOut === 1 ? '' : 's'} not in the total: no usable price.
            </p>
          )}
        </>
      )}
    </DashboardWidgetCard>
  );
}
