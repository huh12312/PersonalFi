// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { PiggyBank } from 'lucide-react';
import { useState } from 'react';

import type { BudgetLine, BudgetPeriodSummary } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { useCategories } from '../categories/useCategories.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { AddEnvelopeControl } from './AddEnvelopeControl.tsx';
import { useCurrentBudgetPeriodQuery } from './api.ts';
import { EnvelopeLineRow } from './EnvelopeLineRow.tsx';
import {
  GROUP_LABELS,
  GROUP_ORDER,
  groupKeyOf,
  type EnvelopeGroupKey,
} from './envelope-display.ts';
import { PeriodPicker } from './PeriodPicker.tsx';
import { PeriodHeader } from './PeriodHeader.tsx';
import { useSeedBudgetFromLastMonth } from './useSeedFromLastMonth.ts';

function groupLines(
  lines: readonly BudgetLine[],
  categoryKindOf: (categoryId: string | null) => string | undefined,
): Map<EnvelopeGroupKey, BudgetLine[]> {
  const groups = new Map<EnvelopeGroupKey, BudgetLine[]>();
  for (const line of lines) {
    const key = groupKeyOf(line, categoryKindOf(line.categoryId));
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [line]);
    else bucket.push(line);
  }
  return groups;
}

/** The one screen this work package's whole `apps/web/src/routes/_app.budget.tsx` renders. */
export function BudgetScreen() {
  const currentQuery = useCurrentBudgetPeriodQuery();
  const { byId: categoriesById, isLoading: categoriesLoading } = useCategories();
  const [historicalPeriod, setHistoricalPeriod] = useState<BudgetPeriodSummary | null>(null);
  const seedFromLastMonth = useSeedBudgetFromLastMonth();

  if (currentQuery.isLoading || categoriesLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton variant="block" height={140} />
        <Skeleton variant="block" height={72} />
        <Skeleton variant="block" height={72} />
        <Skeleton variant="block" height={72} />
      </div>
    );
  }

  if (currentQuery.isError || currentQuery.data === undefined) {
    return (
      <EmptyState
        icon={PiggyBank}
        headline="Couldn't load your budget"
        description="Something went wrong reaching the budgeting service. Try again in a moment."
      />
    );
  }

  const { budgetId, currency, period } = currentQuery.data;
  const categoryLabel = (line: BudgetLine): string =>
    line.name ??
    (line.categoryId !== null
      ? (categoriesById.get(line.categoryId)?.label ?? 'Category')
      : 'Category');
  const categoryKind = (categoryId: string | null): string | undefined =>
    categoryId !== null ? categoriesById.get(categoryId)?.kind : undefined;

  // A historical period (`GET /budgets/periods` has no `lines`, only
  // `GET /budgets/current` does — `PeriodPicker.tsx`'s module comment) gets a
  // summary view, not the full envelope editor.
  if (historicalPeriod !== null && historicalPeriod.id !== period.id) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 font-semibold text-text-primary">Budget</h2>
          <PeriodPicker
            budgetId={budgetId}
            currentPeriodId={period.id}
            selectedPeriodId={historicalPeriod.id}
            onSelect={setHistoricalPeriod}
          />
        </div>
        <div className="rounded-lg border border-border-hairline bg-bg-surface p-4">
          <p className="text-small text-text-muted">
            {formatDateOnly(historicalPeriod.startDate)} –{' '}
            {formatDateOnly(historicalPeriod.endDate)} · {historicalPeriod.status}
          </p>
          <p className="mt-2 text-h1 font-semibold text-text-primary">
            <Money value={historicalPeriod.readyToAssign} colorBySign />
          </p>
          <p className="text-small text-text-muted">Ready to Assign at the end of this period</p>
          <p className="mt-4 text-caption text-text-muted">
            Envelope-by-envelope detail is only available for the current period — there is no route
            yet to read another period's lines. See{' '}
            <code>docs/evidence/phase-2/wp2.9-budget-ui.md</code> for the gap.
          </p>
          <button
            type="button"
            className="mt-2 text-small text-accent-text underline-offset-4 hover:underline"
            onClick={() => setHistoricalPeriod(null)}
          >
            Back to the current period
          </button>
        </div>
      </div>
    );
  }

  if (period.lines.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PeriodHeader
          budgetId={budgetId}
          period={period}
          selectedPeriodId={period.id}
          onSelectPeriod={setHistoricalPeriod}
        />
        <EmptyState
          icon={PiggyBank}
          headline="No budget yet"
          description="Start with last month's spending, or build categories from scratch."
          action={{
            label: seedFromLastMonth.isSeeding ? 'Working…' : "Start from last month's spending",
            onClick: () => void seedFromLastMonth.seed(period.id, currency),
          }}
        >
          {seedFromLastMonth.error !== null && (
            <p role="alert" className="mt-2 text-small text-status-critical">
              {seedFromLastMonth.error}
            </p>
          )}
          <div className="mt-4">
            <AddEnvelopeControl periodId={period.id} />
          </div>
        </EmptyState>
      </div>
    );
  }

  const groups = groupLines(period.lines, categoryKind);

  return (
    <div className="flex flex-col gap-6">
      <PeriodHeader
        budgetId={budgetId}
        period={period}
        selectedPeriodId={period.id}
        onSelectPeriod={setHistoricalPeriod}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <AddEnvelopeControl periodId={period.id} />
        <Link
          to="/reports"
          className="text-small text-accent-text underline-offset-4 hover:underline"
        >
          View reports →
        </Link>
      </div>

      {GROUP_ORDER.filter((key) => groups.has(key)).map((key) => (
        <section key={key} aria-labelledby={`budget-group-${key}`}>
          <h2
            id={`budget-group-${key}`}
            className="mb-2 text-small font-semibold text-text-secondary"
          >
            {GROUP_LABELS[key]}
          </h2>
          <ul className="flex flex-col gap-2">
            {(groups.get(key) ?? []).map((line) => (
              <EnvelopeLineRow key={line.id} line={line} categoryLabel={categoryLabel(line)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
