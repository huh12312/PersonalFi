// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { CategoryPicker } from '../transactions/CategoryPicker.tsx';
import { useCreateBudgetLineMutation } from './api.ts';

export interface AddEnvelopeControlProps {
  periodId: string;
}

/**
 * "Add a category to this period's budget" — `POST /budgets/lines` upserts
 * on `(periodId, categoryId)` (`wp2.r-routes.md` §4), so re-picking a
 * category that already has a line is harmless (it re-opens it rather than
 * duplicating). Reuses the transactions feature's `CategoryPicker` as-is
 * (a combobox over the same `GET /categories` every screen shares) rather
 * than building a second category control.
 */
export function AddEnvelopeControl({ periodId }: AddEnvelopeControlProps) {
  const create = useCreateBudgetLineMutation();
  // Remounting the picker after a successful create is the simplest way to
  // reset a `CategoryPicker` back to its blank/clear state — it has no
  // imperative reset method of its own.
  const [resetKey, setResetKey] = useState(0);

  return (
    <div className="flex items-center gap-2">
      <span className="text-small text-text-secondary">Add a category</span>
      <CategoryPicker
        key={resetKey}
        value={null}
        onChange={(categoryId) => {
          if (categoryId === null) return;
          create.mutate(
            { body: { periodId, categoryId } },
            { onSuccess: () => setResetKey((k) => k + 1) },
          );
        }}
        disabled={create.isPending}
        className="w-56"
      />
      {create.isError && (
        <span role="alert" className="text-caption text-status-danger-text">
          Could not add that category.
        </span>
      )}
    </div>
  );
}
