// SPDX-License-Identifier: MIT
import { useState } from 'react';

import type { RecurringSeries } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPortal,
} from '../../components/ui/combobox.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { formatCadenceLabel } from './cadence-format.ts';

export interface MergeSeriesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The series being merged away — archived on success. */
  source: RecurringSeries;
  sourceLabel: string;
  /** Every other confirmed series this one could merge into. */
  candidates: readonly RecurringSeries[];
  nameOf: (merchantId: string) => string;
  busy?: boolean;
  onMerge: (targetSeriesId: string, reason: string | null) => void;
}

/**
 * The duplicate-service / card-migration merge picker
 * (docs/evidence/phase-2/wp2.3-recurring.md §1, `POST /recurring/series/{id}/
 * merge`): the source series is archived and every future detection folds
 * into the surviving target. A human confirms the pairing — the route never
 * guesses which of two similar-looking streams is the "real" one.
 */
export function MergeSeriesDialog({
  open,
  onOpenChange,
  source,
  sourceLabel,
  candidates,
  nameOf,
  busy = false,
  onMerge,
}: MergeSeriesDialogProps) {
  const [target, setTarget] = useState<RecurringSeries | null>(null);
  const [reason, setReason] = useState('');

  const options = candidates.filter((series) => series.id !== source.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false}>
        <DialogTitle>Merge {sourceLabel} into another series</DialogTitle>
        <DialogDescription>
          {sourceLabel} will be archived. Its history and future charges are folded into the series
          you pick below, which is the one that survives.
        </DialogDescription>

        <div className="mt-4">
          <Combobox<RecurringSeries>
            items={options}
            value={target ?? undefined}
            onValueChange={(next) => setTarget(next ?? null)}
            itemToStringLabel={(series) =>
              `${nameOf(series.merchantId)} · ${formatCadenceLabel(series.cadence)}`
            }
            itemToStringValue={(series) => series.id}
            isItemEqualToValue={(series, selected) => series.id === selected.id}
          >
            <ComboboxInput aria-label="Merge into" placeholder="Search confirmed series…" />
            <ComboboxPortal>
              <ComboboxEmpty>No other confirmed series.</ComboboxEmpty>
              <ComboboxList>
                <ComboboxCollection>
                  {(series: RecurringSeries) => (
                    <ComboboxItem key={series.id} value={series}>
                      {nameOf(series.merchantId)} · {formatCadenceLabel(series.cadence)}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxList>
            </ComboboxPortal>
          </Combobox>
        </div>

        <div className="mt-4">
          <label htmlFor="merge-reason" className="text-small text-text-secondary">
            Why? (optional)
          </label>
          <textarea
            id="merge-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-border-hairline bg-bg-surface p-2 text-small text-text-primary"
            placeholder="New card, same service…"
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || target === null}
            onClick={() => target !== null && onMerge(target.id, reason.trim() || null)}
          >
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
