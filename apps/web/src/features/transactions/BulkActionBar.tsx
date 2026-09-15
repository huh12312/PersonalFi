// SPDX-License-Identifier: MIT
import { X } from 'lucide-react';

import { Button } from '../../components/ui/button.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';
import { useBulkUpdateMutation } from './useBulkUpdateMutation.ts';

export interface BulkActionBarProps {
  selectedIds: readonly string[];
  onClear: () => void;
}

/** Appears once at least one row is selected; applies one overlay patch to every selected transaction. */
export function BulkActionBar({ selectedIds, onClear }: BulkActionBarProps) {
  const bulkUpdate = useBulkUpdateMutation();

  if (selectedIds.length === 0) return null;

  function applyCategory(categoryId: string | null): void {
    bulkUpdate.mutate({ body: { transactionIds: [...selectedIds], patch: { categoryId } } });
  }

  function applyExcluded(excluded: boolean): void {
    bulkUpdate.mutate({ body: { transactionIds: [...selectedIds], patch: { excluded } } });
  }

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-bg-surface-raised px-3 py-2 shadow-[var(--shadow-elev-1)]"
    >
      <span className="text-small font-medium text-text-primary">
        {selectedIds.length} selected
      </span>
      <CategoryPicker value={null} onChange={applyCategory} disabled={bulkUpdate.isPending} />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => applyExcluded(true)}
        disabled={bulkUpdate.isPending}
      >
        Exclude from totals
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => applyExcluded(false)}
        disabled={bulkUpdate.isPending}
      >
        Include in totals
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear} className="ml-auto gap-1.5">
        <X size={14} aria-hidden="true" />
        Clear selection
      </Button>
    </div>
  );
}
