// SPDX-License-Identifier: MIT
import { useMemo } from 'react';

import { NetWorthAreaChart } from '../../charts/NetWorthAreaChart.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { useNetWorthSeriesQuery } from './api.ts';
import { groupByCurrency, interpolatedCount, type RawSeriesPoint } from './series.ts';
import {
  DEFAULT_NET_WORTH_RANGE,
  NET_WORTH_RANGES,
  NET_WORTH_RANGE_LABELS,
  type NetWorthRange,
} from './search.ts';

export interface NetWorthFullViewProps {
  range: NetWorthRange;
  onRangeChange?: (range: NetWorthRange) => void;
}

/**
 * The net worth "full view" (dispatch §3, WP 3.12: "the chart on
 * `_app.index.tsx` (compact) and a full view"). Rendered inside
 * `NetWorthChart.tsx`'s dialog. `range` is owned by the caller so it can
 * live in the URL (`_app.index.tsx`'s `netWorthRange` search param) —
 * "URL state (range) round-trips" is this prop, reloaded from the address
 * bar rather than component state.
 */
export function NetWorthFullView({ range, onRangeChange }: NetWorthFullViewProps) {
  const effectiveRange = range ?? DEFAULT_NET_WORTH_RANGE;
  const seriesQuery = useNetWorthSeriesQuery(effectiveRange);
  // Depends on `seriesQuery.data`, not the derived `points` below —
  // `?? []` mints a fresh array reference every render, which would defeat
  // this memo entirely (`react-hooks/exhaustive-deps` flags exactly that).
  const points = useMemo(() => seriesQuery.data?.points ?? [], [seriesQuery.data]);
  const currencySeries = useMemo(() => groupByCurrency(points), [points]);
  const interpolated = interpolatedCount(points);
  const hasMultipleCurrencies = currencySeries.length > 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Date range" className="flex gap-1">
          {NET_WORTH_RANGES.map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === effectiveRange ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={option === effectiveRange}
              onClick={() => onRangeChange?.(option)}
            >
              {NET_WORTH_RANGE_LABELS[option]}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={seriesQuery.isFetching}
          onClick={() => void seriesQuery.refetch()}
        >
          {seriesQuery.isFetching ? 'Checking…' : 'Refresh'}
        </Button>
      </div>

      {hasMultipleCurrencies && (
        <p className="text-caption text-text-muted">
          This window spans more than one currency. Each currency is drawn as its own line — never
          summed into one total, because no FX rate has been recorded to combine them.
        </p>
      )}

      {seriesQuery.isLoading && <Skeleton height={280} variant="block" />}

      {seriesQuery.isError && (
        <p className="text-small text-text-muted">Net worth history isn't available right now.</p>
      )}

      {seriesQuery.isSuccess && currencySeries.length === 0 && (
        <p className="text-small text-text-muted">No net worth history in this window yet.</p>
      )}

      {seriesQuery.isSuccess &&
        currencySeries.map((series) => (
          <NetWorthAreaChart
            key={series.currency}
            data={series.points}
            color={series.color}
            seriesLabel={hasMultipleCurrencies ? series.currency : undefined}
            height={280}
            showSealedLegend
          />
        ))}

      {seriesQuery.isSuccess && (
        <p className="text-caption text-text-muted">
          {interpolated > 0
            ? `${String(interpolated)} day${interpolated === 1 ? ' has' : 's have'} no observation in this window and ${interpolated === 1 ? 'is' : 'are'} interpolated from neighbouring days.`
            : 'Every day in this window has an observed or corrected value.'}
        </p>
      )}

      {seriesQuery.isSuccess && <RecentDayDetail points={points.slice(-5)} />}
    </div>
  );
}

function RecentDayDetail({ points }: { points: readonly RawSeriesPoint[] }) {
  if (points.length === 0) return null;
  return (
    <div className="rounded-md border border-border-hairline">
      <table className="w-full text-small">
        <caption className="sr-only">Recent days in this window, with their seal status</caption>
        <thead>
          <tr className="border-b border-border-hairline text-caption text-text-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Date
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Value
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Note
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr
              key={point.asOfDate}
              className="border-b border-border-hairline last:border-0"
              data-testid={`net-worth-day-${point.asOfDate}`}
            >
              <td className="px-3 py-2 text-text-primary">
                {formatDateOnly(point.asOfDate, 'MMM d')}
              </td>
              <td
                className="px-3 py-2 text-text-primary"
                data-testid={`net-worth-value-${point.asOfDate}`}
              >
                {point.netWorth !== null ? (
                  <Money
                    value={point.netWorth}
                    signDisplay="never"
                    colorBySign={false}
                    sensitive={false}
                  />
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-text-secondary">
                {point.sealed ? 'Sealed' : 'Live (unsealed)'}
                {point.source === 'interpolated' ? ' · interpolated' : ''}
                {point.source === 'corrected' ? ' · corrected' : ''}
              </td>
              <td className="px-3 py-2 text-text-muted">{point.correctionReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
