// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';
import { AlertTriangle, CircleCheck, Gauge } from 'lucide-react';

import type { BudgetLine } from '../../../api/generated/types.gen.ts';
import { Money } from '../../../components/finance/Money.tsx';
import { StatTile } from '../../../components/finance/StatTile.tsx';
import { cn } from '../../../lib/cn.ts';
import { useCurrentBudgetPeriodQuery } from '../../budget/api.ts';
import { useCategories } from '../../categories/useCategories.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { closestToBudget, type BudgetMeter } from './budget-meters.ts';
import { wire } from './pace.ts';

/**
 * Budgets (WP 10.9; Monarch's equivalent): the "Left to budget" figure and the three envelopes closest to
 * or over their budget, as small meters.
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
  const meters =
    period === undefined
      ? []
      : closestToBudget(period.lines, (id) => id !== null && byId.get(id)?.kind === 'income');

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
                return (
                  <li key={meter.lineId}>
                    <BudgetMeterRow
                      meter={meter}
                      label={line === undefined ? 'Category' : labelOf(line)}
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

const STATE_COPY = {
  under: { Icon: CircleCheck, word: 'On budget' },
  near: { Icon: Gauge, word: 'Nearly spent' },
  over: { Icon: AlertTriangle, word: 'Over budget' },
} as const;

/** One meter: the label and its state in words (with an icon), the bar, then "$X of $Y" and what is left or over. */
export function BudgetMeterRow({
  meter,
  label,
}: {
  readonly meter: BudgetMeter;
  readonly label: string;
}) {
  const { Icon, word } = STATE_COPY[meter.state];
  const percent = meter.ratio === null ? 100 : Math.min(Math.max(meter.ratio, 0), 1) * 100;
  return (
    <div data-meter-state={meter.state}>
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span className="min-w-0 truncate font-medium text-text-primary">{label}</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-caption',
            meter.state === 'over'
              ? 'text-status-danger-text'
              : meter.state === 'near'
                ? 'text-status-warning-text'
                : 'text-text-secondary',
          )}
        >
          <Icon size={12} aria-hidden="true" />
          {word}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label}: spent of budget`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={`${String(Math.round((meter.ratio ?? 1) * 100))}% of the budget spent`}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
      >
        <div
          className={cn(
            'h-full rounded-full',
            meter.state === 'over'
              ? 'bg-status-danger-bold'
              : meter.state === 'near'
                ? 'bg-status-warning-bold'
                : 'bg-accent',
          )}
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <p className="mt-1 text-caption text-text-muted tabular-nums">
        <Money value={wire(meter.spent)} signDisplay="auto" colorBySign={false} /> of{' '}
        <Money value={wire(meter.funded)} signDisplay="auto" colorBySign={false} /> ·{' '}
        {meter.state === 'over' ? (
          <>
            <Money
              value={wire(MoneyKernel.negate(meter.available))}
              signDisplay="auto"
              colorBySign={false}
            />{' '}
            over
          </>
        ) : (
          <>
            <Money value={wire(meter.available)} signDisplay="auto" colorBySign={false} /> left
          </>
        )}
      </p>
    </div>
  );
}
