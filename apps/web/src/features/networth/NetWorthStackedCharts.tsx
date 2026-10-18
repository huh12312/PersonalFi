// SPDX-License-Identifier: MIT
import { useMemo } from 'react';

import type { GetNetWorthSeriesResponse } from '../../api/generated/types.gen.ts';
import {
  bucketLabel,
  changeText,
  NetWorthStackedChart,
  sinceLabel,
} from './NetWorthStackedChart.tsx';
import type { DashboardPeriod } from './search.ts';
import {
  BUCKETING_FOR_PERIOD,
  fromWire,
  groupBucketsByCurrency,
  readoutAt,
  trimLeadingGaps,
} from './stacked.ts';

/** The selected bucket of one currency's chart. */
export interface NetWorthSelection {
  readonly currency: string;
  readonly index: number;
}

/** What the hero shows while a bucket is selected (WP 10.13: the hero follows the scrub). */
export interface HeroSelection {
  readonly netWorth: { readonly minor: string; readonly currency: string };
  readonly asOfDate: string;
  readonly sealed: boolean;
  readonly label: string;
  /** The change since the first bucket in the period, in words; `null` on the first. */
  readonly sinceFirst: string | null;
}

const BUCKET_NOUN = { day: 'day', week: 'week', month: 'month' } as const;

/** The hero's view of a selection, or `null` when nothing (or a gap) is selected. */
export function heroSelectionOf(
  data: GetNetWorthSeriesResponse | undefined,
  period: DashboardPeriod,
  selection: NetWorthSelection | null,
): HeroSelection | null {
  if (data === undefined || selection === null) return null;
  const bucketing = BUCKETING_FOR_PERIOD[period];
  const all = fromWire(data.buckets);
  const group = groupBucketsByCurrency(period === 'ALL' ? trimLeadingGaps(all) : all).find(
    (g) => g.currency === selection.currency,
  );
  if (group === undefined) return null;
  const readout = readoutAt(group.buckets, selection.index);
  if (readout === null || readout.bucket.asOfDate === null || readout.bucket.netMinor === null) {
    return null;
  }
  return {
    netWorth: { minor: readout.bucket.netMinor.toString(), currency: group.currency },
    asOfDate: readout.bucket.asOfDate,
    sealed: readout.bucket.sealed,
    label: bucketLabel(readout.bucket, bucketing),
    sinceFirst:
      readout.vsFirst === null
        ? null
        : `${changeText(readout.vsFirst, group.currency)} since ${sinceLabel(readout.vsFirst.against)}`,
  };
}

/**
 * The stacked charts for one response (WP 10.13): one per currency — D4: never summed, never converted
 * without a rate — with the notes that say what is drawn apart and what is left out.
 */
export function NetWorthStackedCharts({
  data,
  period,
  selection,
  onSelectionChange,
  height,
}: {
  readonly data: GetNetWorthSeriesResponse;
  readonly period: DashboardPeriod;
  readonly selection: NetWorthSelection | null;
  readonly onSelectionChange: (selection: NetWorthSelection | null) => void;
  readonly height: number;
}) {
  const bucketing = BUCKETING_FOR_PERIOD[period];
  const groups = useMemo(() => {
    const all = fromWire(data.buckets);
    return groupBucketsByCurrency(period === 'ALL' ? trimLeadingGaps(all) : all);
  }, [data.buckets, period]);
  const pointCurrencies = useMemo(
    () =>
      [
        ...new Set(
          data.points.flatMap((point) =>
            point.netWorth === null ? [] : [point.netWorth.currency],
          ),
        ),
      ].sort(),
    [data.points],
  );
  const drawn = new Set(groups.map((group) => group.currency));
  const leftOut = pointCurrencies.filter((currency) => !drawn.has(currency));
  const many = groups.length > 1;

  return (
    <div className="flex flex-col gap-4">
      {(many || leftOut.length > 0) && (
        <p className="text-caption text-text-muted" data-testid="net-worth-currency-note">
          This period spans more than one currency. Each currency is drawn as its own chart — never
          summed into one total, because no FX rate has been recorded to combine them.
          {leftOut.length > 0 &&
            ` Not drawn at this scale: ${leftOut.join(', ')} — no ${BUCKET_NOUN[bucketing]} in this period closes on a day in ${leftOut.length === 1 ? 'that currency' : 'those currencies'}; choose 1M to see every day.`}
        </p>
      )}
      {groups.length === 0 && (
        <p className="text-small text-text-muted">No net worth history in this period yet.</p>
      )}
      {groups.map((group) => (
        <NetWorthStackedChart
          key={group.currency}
          buckets={group.buckets}
          bucketing={bucketing}
          currency={group.currency}
          title={`Net worth by account type${many ? `, ${group.currency}` : ''}`}
          {...(many ? { seriesLabel: group.currency } : {})}
          selected={selection?.currency === group.currency ? selection.index : null}
          onSelect={(index) =>
            onSelectionChange(index === null ? null : { currency: group.currency, index })
          }
          height={many ? Math.round(height * 0.8) : height}
        />
      ))}
    </div>
  );
}
