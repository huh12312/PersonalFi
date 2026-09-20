// SPDX-License-Identifier: MIT
import type { BudgetPeriodSummary } from '../../api/generated/types.gen.ts';
import { formatDateOnlyShort } from '../../lib/date.ts';
import { useBudgetPeriodsQuery } from './api.ts';

export interface PeriodPickerProps {
  budgetId: string;
  currentPeriodId: string;
  selectedPeriodId: string;
  onSelect: (period: BudgetPeriodSummary) => void;
}

function periodLabel(period: BudgetPeriodSummary): string {
  return `${formatDateOnlyShort(period.startDate)} – ${formatDateOnlyShort(period.endDate)}`;
}

/**
 * The period picker (`02-phase-2-dispatch.md` §3 WP 2.9's DELIVER item, "over
 * `GET /budgets/periods`"). A native `<select>` — this app's own convention
 * for a single-choice enum control (`NotificationSettingsScreen.tsx`,
 * `CreateCategoryDialog.tsx`), and the roving/typeahead keyboard behaviour a
 * period picker needs comes for free from the platform.
 *
 * **Only the current period can show its envelope lines.** `GET
 * /budgets/current` is the only route that returns a period *with* its
 * `lines` array (`wp2.r-routes.md` §1's route table: `GET /budgets/periods`
 * returns `BudgetPeriodSummary[]`, no `lines`, and there is no `GET
 * /budgets/periods/{id}`). Picking a past period here does not — cannot —
 * open a full envelope editor for it; `BudgetScreen.tsx` renders the
 * selected summary's own totals (`readyToAssign`, `dirty`, date range) and a
 * note that per-line history needs a route this API doesn't have yet. This
 * is a real API gap, recorded in `docs/evidence/phase-2/wp2.9-budget-ui.md`
 * rather than worked around by guessing at envelope numbers the server never
 * sent.
 */
export function PeriodPicker({
  budgetId,
  currentPeriodId,
  selectedPeriodId,
  onSelect,
}: PeriodPickerProps) {
  const periodsQuery = useBudgetPeriodsQuery(budgetId);
  const periods = periodsQuery.data?.periods ?? [];

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="budget-period-picker" className="sr-only">
        Budget period
      </label>
      <select
        id="budget-period-picker"
        className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary"
        value={selectedPeriodId}
        onChange={(event) => {
          const period = periods.find((p) => p.id === event.target.value);
          if (period !== undefined) onSelect(period);
        }}
        disabled={periods.length === 0}
      >
        {periods.length === 0 && <option value={selectedPeriodId}>Loading periods…</option>}
        {periods.map((period) => (
          <option key={period.id} value={period.id}>
            {periodLabel(period)}
            {period.id === currentPeriodId ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
