// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Repeat } from 'lucide-react';
import { useState } from 'react';

import {
  getRecurringUpcomingQueryKey,
  getSafeToSpendQueryKey,
  listRecurringSeriesQueryKey,
  mergeRecurringSeriesMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { RecurringSeries } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import {
  formatCadenceLabel,
  formatDuplicateGroupLabel,
  formatNextDue,
  formatStatusLabel,
  formatStreamTypeLabel,
  inferAmountModelLabel,
  isDormantStatus,
} from './cadence-format.ts';
import { MergeSeriesDialog } from './MergeSeriesDialog.tsx';

export interface SeriesListProps {
  series: readonly RecurringSeries[];
  nameOf: (merchantId: string) => string;
}

/** `AT_RISK`/`LIKELY_CANCELED`/`CANCELED` read as a quiet notice; everything else as neutral. */
function statusBadgeVariant(status: string): 'neutral' | 'warning' {
  return isDormantStatus(status) ? 'warning' : 'neutral';
}

export function SeriesList({ series, nameOf }: SeriesListProps) {
  const queryClient = useQueryClient();
  const [merging, setMerging] = useState<RecurringSeries | null>(null);

  const merge = useMutation({
    ...mergeRecurringSeriesMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listRecurringSeriesQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getRecurringUpcomingQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getSafeToSpendQueryKey() });
      setMerging(null);
    },
  });

  if (series.length === 0) {
    return (
      <EmptyState
        icon={Repeat}
        headline="No subscriptions detected yet"
        description="Once transactions are syncing, recurring charges show up here."
      />
    );
  }

  return (
    <>
      <ul aria-label="Confirmed and detected recurring series" className="flex flex-col gap-2">
        {series.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-body font-medium text-text-primary">
                {nameOf(row.merchantId)}
              </p>
              <p className="text-small text-text-muted">
                {formatStreamTypeLabel(row.type)} · {formatCadenceLabel(row.cadence)} ·{' '}
                {inferAmountModelLabel(row.observedMin.minor, row.observedMax.minor)}
              </p>
              <p className="text-small text-text-muted">{formatNextDue(row.nextDueDate)}</p>
              {/*
                `priceChangeEvents` is newest-first (`GET /recurring/series`,
                `wp3.14-carryovers.md` item 4), so `[0]` is the latest change.
                `?? []` even though the wire schema makes the field required:
                a fixture built against an older contract (an e2e mock this
                work package does not own, or a client not yet regenerated)
                should degrade to "no price-change line" rather than throw.
              */}
              {(row.priceChangeEvents ?? []).length > 0 && (
                <p className="text-caption text-text-muted">
                  Price{' '}
                  {row.priceChangeEvents[0]?.direction === 'INCREASE' ? 'increased' : 'decreased'}{' '}
                  to <Money value={row.priceChangeEvents[0]!.toAmount} colorBySign={false} /> on{' '}
                  {row.priceChangeEvents[0]?.effectiveDate}
                </p>
              )}
            </div>
            <Money value={row.typicalAmount} className="shrink-0" />
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {row.userConfirmed && <Badge variant="good">Confirmed</Badge>}
              <Badge variant={statusBadgeVariant(row.status)}>
                {formatStatusLabel(row.status)}
              </Badge>
              {row.duplicateNode !== null && (
                <Badge variant="accent">
                  Possible duplicate: {formatDuplicateGroupLabel(row.duplicateNode)}
                </Badge>
              )}
            </div>
            <Button variant="ghost" onClick={() => setMerging(row)}>
              Merge into…
            </Button>
          </li>
        ))}
      </ul>

      {merging !== null && (
        <MergeSeriesDialog
          open
          onOpenChange={(next) => !next && setMerging(null)}
          source={merging}
          sourceLabel={nameOf(merging.merchantId)}
          candidates={series}
          nameOf={nameOf}
          busy={merge.isPending}
          onMerge={(targetSeriesId, reason) =>
            merge.mutate({
              path: { seriesId: merging.id },
              body: { targetSeriesId, reason },
            })
          }
        />
      )}
    </>
  );
}
