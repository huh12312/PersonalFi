// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../components/ui/dialog.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { useNetWorthSeriesPeriodQuery } from './api.ts';
import { NetWorthFullView } from './NetWorthFullView.tsx';
import { NetWorthStackedCharts, type NetWorthSelection } from './NetWorthStackedCharts.tsx';
import {
  DEFAULT_DASHBOARD_PERIOD,
  DEFAULT_NET_WORTH_RANGE,
  type DashboardPeriod,
  type NetWorthRange,
} from './search.ts';

export interface NetWorthDashboardSectionProps {
  className?: string;
  /** The chart's window (WP 10.9: the dashboard widget's period chips). Default 3M. */
  period?: DashboardPeriod;
  /** WP 10.13: the scrubbed bucket, owned by the widget so its hero follows. */
  selection?: NetWorthSelection | null;
  onSelectionChange?: (selection: NetWorthSelection | null) => void;
  /** URL-synced range for the full view (`_app.index.tsx`'s `netWorthRange` search param). */
  range?: NetWorthRange;
  onRangeChange?: (range: NetWorthRange) => void;
}

/**
 * The dashboard widget's chart plus the "View full history" trigger for `NetWorthFullView` — dispatch §3,
 * WP 3.12: "the chart on `_app.index.tsx` (compact) and a full view." Since WP 10.13 the chart is net worth
 * stacked by account type with the net line over it, one chart per currency.
 */
export function NetWorthDashboardSection({
  className,
  period = DEFAULT_DASHBOARD_PERIOD,
  selection = null,
  onSelectionChange,
  range,
  onRangeChange,
}: NetWorthDashboardSectionProps) {
  const seriesQuery = useNetWorthSeriesPeriodQuery(period);
  const [dialogOpen, setDialogOpen] = useState(false);
  const effectiveRange = range ?? DEFAULT_NET_WORTH_RANGE;

  return (
    <div className={className}>
      {seriesQuery.isLoading && <Skeleton height={220} variant="block" />}

      {seriesQuery.isError && (
        <p className="text-small text-text-muted">Net worth history isn't available right now.</p>
      )}

      {seriesQuery.isSuccess && (
        <NetWorthStackedCharts
          data={seriesQuery.data}
          period={period}
          selection={selection}
          onSelectionChange={(next) => onSelectionChange?.(next)}
          height={220}
        />
      )}

      {seriesQuery.isSuccess && seriesQuery.data.lastSnapshotFailure !== null && (
        // O-7 (i): the figure above reads as complete, and a currency with no exchange rate is not in it. The
        // banner explaining this lived only in the full view, one click away from where the number is read.
        <p className="mt-2 text-small text-text-secondary" data-testid="net-worth-snapshot-failure">
          A currency may be left out of the latest figure: no exchange rate was available to convert
          it. Open the full history to enter one.
        </p>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger
          render={
            <Button variant="ghost" size="sm" className="mt-2">
              View full history
            </Button>
          }
        />
        {/* `DialogContent` is a `fixed`, vertically-centred popup with no built-in scroll container; the
            stacked charts plus the range/legend/table content in this view routinely exceed one viewport, so
            it scrolls itself (see WP 3.12's note: without it "Refresh" was unreachable). */}
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>Net worth over time</DialogTitle>
          <NetWorthFullView range={effectiveRange} onRangeChange={onRangeChange} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
