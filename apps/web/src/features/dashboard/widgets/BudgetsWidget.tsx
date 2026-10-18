// SPDX-License-Identifier: MIT
import type { BudgetLine } from '../../../api/generated/types.gen.ts';
import { Money } from '../../../components/finance/Money.tsx';
import { StatTile } from '../../../components/finance/StatTile.tsx';
import { BudgetMeterRow } from '../../../components/finance/BudgetMeter.tsx';
import { paceOf } from '../../../components/finance/budget-meter.ts';
import { useCurrentBudgetPeriodQuery } from '../../budget/api.ts';
import { useCategories } from '../../categories/useCategories.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { closestToBudget } from './budget-meters.ts';

/**
 * Budgets (WP 10.9; Monarch's equivalent): the "Left to budget" figure and the three envelopes closest to
 * or over their budget, as small meters — since WP 10.11 the Budget screen's own `BudgetMeterRow`, with the pace
 * tick at the server's today.
 *
 * **Left to budget is the budget's own Ready to Assign** (`period.readyToAssign`): this is an envelope budget, and
 * Ready to Assign *is* income not yet given a job, after every assignment — which is what Monarch's "income −
 * budgeted expenses − planned savings" means once savings are envelopes too. Nothing is recomputed here.
 */
export function BudgetsWidget() {
  const query = useCurrentBudgetPeriodQuery();
  const { byId, isLoading: categoriesLoading } = useCategories();
  const period = query.data?.period;
  const categoryLines = period?.lines.filter((line) => line.kind === 'category') ?? [];

  const state: WidgetState =
    query.isLoading || categoriesLoading
      ? { kind: 'loading' }
      : query.isError || period === undefined
        ? { kind: 'error', message: "Your budget isn't available right now." }
        : categoryLines.length === 0
          ? {
              kind: 'empty',
              message: 'No budget yet: no category has an amount for this month.',
              fix: { to: '/budget', label: 'Set one' },
            }
          : { kind: 'ready' };

  const labelOf = (line: Pick<BudgetLine, 'categoryId'> & { name?: string | null }): string =>
    line.name ??
    (line.categoryId !== null ? (byId.get(line.categoryId)?.label ?? 'Category') : 'Category');
  const today = query.data?.today;
  const pace =
    period === undefined || today === undefined
      ? null
      : paceOf(period.startDate, period.endDate, today);
  const meters =
    period === undefined || pace === null
      ? []
      : closestToBudget(period.lines, (id) => id !== null && byId.get(id)?.kind === 'income', pace);

  return (
    <DashboardWidgetCard
      id="budgets"
      title="Budgets"
      subtitle={period === undefined ? undefined : `${period.startDate} – ${period.endDate}`}
      seeAll={{ to: '/budget', label: 'See all' }}
      state={state}
    >
      {period !== undefined && (
        <>
          <StatTile
            label="Left to budget"
            size="display"
            value={<Money value={period.readyToAssign} signDisplay="auto" colorBySign />}
            hint="Income not yet given to a category"
          />
          {meters.length === 0 ? (
            <p className="mt-3 text-small text-text-secondary">
              Nothing has been spent from a budgeted category yet this month.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3" aria-label="Closest to their budget">
              {meters.map((meter) => {
                const line = period.lines.find((candidate) => candidate.id === meter.lineId);
                const label = line === undefined ? 'Category' : labelOf(line);
                return (
                  <li key={meter.lineId}>
                    <BudgetMeterRow
                      title={<span className="block truncate">{label}</span>}
                      figures={meter.figures}
                      pace={pace ?? { kind: 'over' }}
                      label={label}
                      size="sm"
                      shape="rounded"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </DashboardWidgetCard>
  );
}
