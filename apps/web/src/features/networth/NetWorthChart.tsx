// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';

import { NetWorthAreaChart } from '../../charts/NetWorthAreaChart.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../components/ui/dialog.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { useNetWorthSeriesQuery } from './api.ts';
import { NetWorthFullView } from './NetWorthFullView.tsx';
import { groupByCurrency } from './series.ts';
import { DEFAULT_NET_WORTH_RANGE, type NetWorthRange } from './search.ts';

/** The dashboard's fixed compact window — independent of the full view's range control. */
const COMPACT_RANGE: NetWorthRange = 'p90d';

export interface NetWorthDashboardSectionProps {
  className?: string;
  /** URL-synced range for the full view (`_app.index.tsx`'s `netWorthRange` search param). */
  range?: NetWorthRange;
  onRangeChange?: (range: NetWorthRange) => void;
}

/**
 * The compact chart on `_app.index.tsx` plus the "View full history" trigger
 * for `NetWorthFullView` — dispatch §3, WP 3.12: "the chart on `_app.index.tsx`
 * (compact) and a full view."
 *
 * Groups the real `GET /net-worth/series` response by currency
 * (`series.ts#groupByCurrency`) and renders one `NetWorthAreaChart` instance
 * per currency rather than one summed line — the one property this screen
 * must never violate.
 */
export function NetWorthDashboardSection({
  className,
  range,
  onRangeChange,
}: NetWorthDashboardSectionProps) {
  const seriesQuery = useNetWorthSeriesQuery(COMPACT_RANGE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const effectiveRange = range ?? DEFAULT_NET_WORTH_RANGE;

  const currencySeries = useMemo(
    () => groupByCurrency(seriesQuery.data?.points ?? []),
    [seriesQuery.data],
  );

  return (
    <div className={className}>
      {seriesQuery.isLoading && <Skeleton height={220} variant="block" />}

      {seriesQuery.isError && (
        <p className="text-small text-text-muted">Net worth history isn't available right now.</p>
      )}

      {seriesQuery.isSuccess && currencySeries.length === 0 && (
        <p className="text-small text-text-muted">No net worth history yet.</p>
      )}

      {seriesQuery.isSuccess &&
        currencySeries.map((series) => (
          <NetWorthAreaChart
            key={series.currency}
            data={series.points}
            color={series.color}
            seriesLabel={currencySeries.length > 1 ? series.currency : undefined}
            height={currencySeries.length > 1 ? 160 : 220}
          />
        ))}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger
          render={
            <Button variant="ghost" size="sm" className="mt-2">
              View full history
            </Button>
          }
        />
        {/* `DialogContent` is a `fixed`, vertically-centred popup with no
            built-in scroll container (05-frontend-architecture.md's dialog
            shape assumes content that fits one viewport — every other
            `DialogContent` caller in this codebase does). Two stacked
            280px charts plus the range/legend/table content in this view
            routinely exceed that, and with no `max-h`/`overflow-y-auto` a
            `top-1/2 -translate-y-1/2` popup taller than the viewport is
            pushed off-screen at the top with nothing to scroll it back —
            not merely visually clipped, but genuinely unreachable, which is
            what left "Refresh" and the range buttons un-clickable. */}
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>Net worth over time</DialogTitle>
          <NetWorthFullView range={effectiveRange} onRangeChange={onRangeChange} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
