// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { PiggyBank } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { BudgetLine, BudgetPeriodSummary } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { BudgetMeterRow } from '../../components/finance/BudgetMeter.tsx';
import {
  meterFiguresOf,
  meterStateOf,
  METER_STATE_WORDS,
  paceOf,
  paceWordsOf,
  spentPercentOf,
  type MeterFigures,
  type PaceStatus,
} from '../../components/finance/budget-meter.ts';
import { Money } from '../../components/finance/Money.tsx';
import { cn } from '../../lib/cn.ts';
import { wireOf } from '../../lib/money.ts';
import { useCategories } from '../categories/useCategories.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { AddEnvelopeControl } from './AddEnvelopeControl.tsx';
import { useCurrentBudgetPeriodQuery, useVariabilitySuggestionsQuery } from './api.ts';
import { ClassifyControl } from './ClassifyControl.tsx';
import { LeftToBudgetCard } from './LeftToBudgetCard.tsx';
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
import {
  VARIABILITY_LABELS,
  VARIABILITY_MEANING,
  VARIABILITY_TOTAL_LABELS,
  variabilityViewOf,
} from './variability.ts';

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
export function BudgetScreen({
  view = 'group',
  onViewChange = () => undefined,
}: {
  readonly view?: BudgetView;
  readonly onViewChange?: (view: BudgetView) => void;
} = {}) {
  const currentQuery = useCurrentBudgetPeriodQuery();
  const suggestionsQuery = useVariabilitySuggestionsQuery(view === 'variability');
  const { byId: categoriesById, isLoading: categoriesLoading } = useCategories();
  const [historicalPeriod, setHistoricalPeriod] = useState<BudgetPeriodSummary | null>(null);
  // The row a keyboard user just classified moves section and remounts; its control takes focus back.
  const [refocusCategoryId, setRefocusCategoryId] = useState<string | null>(null);
  const clearRefocus = useCallback(() => setRefocusCategoryId(null), []);
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

  const { budgetId, currency, period, today } = currentQuery.data;
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
            <p role="alert" className="mt-2 text-small text-status-danger-text">
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
  const pace = paceOf(period.startDate, period.endDate, today);
  const suggestedIds = new Set(
    (suggestionsQuery.data?.suggestions ?? []).map((suggestion) => suggestion.categoryId),
  );
  const variabilityView = variabilityViewOf(period.lines, categoriesById, currency);
  // Income envelopes are not spent from and card payments are funded by rule: neither gets a meter.
  const metered = (line: BudgetLine): boolean =>
    line.kind === 'category' && categoryKind(line.categoryId) !== 'income';

  const tableRows: MeterTableRow[] =
    view === 'variability'
      ? variabilityView.sections.map((section) => ({
          label: VARIABILITY_LABELS[section.key],
          figures: section.figures,
        }))
      : GROUP_ORDER.filter(
          (key) => groups.has(key) && key !== 'income' && key !== 'credit_card_payment',
        ).map((key) => ({
          label: GROUP_LABELS[key],
          figures: meterFiguresOf(groups.get(key) ?? [], currency),
        }));

  return (
    <div className="flex flex-col gap-6">
      <PeriodHeader
        budgetId={budgetId}
        period={period}
        selectedPeriodId={period.id}
        onSelectPeriod={setHistoricalPeriod}
      />

      <LeftToBudgetCard period={period} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <AddEnvelopeControl periodId={period.id} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ViewToggle view={view} onViewChange={onViewChange} />
          <Link
            to="/reports"
            className="text-small text-accent-text underline-offset-4 hover:underline"
          >
            View reports →
          </Link>
        </div>
      </div>

      <p data-testid="budget-pace" className="text-caption text-text-secondary">
        {pace.kind === 'running'
          ? `Pace: ${paceWordsOf(pace)} — the mark on each bar is where spending would be if it kept an even pace.`
          : pace.kind === 'over'
            ? 'This period is over, so the bars have no pace mark.'
            : 'This period has not started yet, so the bars have no pace mark.'}
      </p>

      {view === 'variability' ? (
        <>
          {variabilityView.sections.map((section) => (
            <section
              key={section.key}
              aria-labelledby={`budget-variability-${section.key}`}
              data-variability-section={section.key}
            >
              <div className="mb-2 rounded-md border border-border-primary bg-bg-primary p-3">
                <BudgetMeterRow
                  title={
                    <h2
                      id={`budget-variability-${section.key}`}
                      className="text-small font-semibold"
                    >
                      {VARIABILITY_LABELS[section.key]}
                    </h2>
                  }
                  figures={section.figures}
                  pace={pace}
                  label={`${VARIABILITY_LABELS[section.key]} expenses`}
                  size="md"
                  shape="rounded"
                />
                <p className="mt-1 text-caption text-text-secondary">
                  {VARIABILITY_MEANING[section.key]}
                </p>
                {section.key !== 'unclassified' && (
                  <p
                    data-testid={`variability-total-${section.key}`}
                    className="mt-1 flex justify-between gap-2 text-small font-medium text-text-primary tabular-nums"
                  >
                    <span>{VARIABILITY_TOTAL_LABELS[section.key]}</span>
                    <Money
                      value={wireOf(section.figures.budgeted)}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </p>
                )}
              </div>
              {section.lines.length === 0 ? (
                <p className="text-small text-text-secondary">
                  {section.key === 'unclassified'
                    ? 'Every budgeted category is classified.'
                    : `No category is classified ${VARIABILITY_LABELS[section.key].toLowerCase()} yet.`}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {section.lines.map((line) => (
                    <EnvelopeLineRow
                      key={line.id}
                      line={line}
                      categoryLabel={categoryLabel(line)}
                      pace={pace}
                    >
                      {line.categoryId !== null && (
                        <ClassifyControl
                          categoryId={line.categoryId}
                          categoryLabel={categoryLabel(line)}
                          current={section.key}
                          suggested={suggestedIds.has(line.categoryId)}
                          onClassified={setRefocusCategoryId}
                          focusPressed={refocusCategoryId === line.categoryId}
                          onFocused={clearRefocus}
                        />
                      )}
                    </EnvelopeLineRow>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {variabilityView.other.length > 0 && (
            <section aria-labelledby="budget-variability-other">
              <h2
                id="budget-variability-other"
                className="mb-2 text-small font-semibold text-text-secondary"
              >
                Income and card payments
              </h2>
              <ul className="flex flex-col gap-2">
                {variabilityView.other.map((line) => (
                  <EnvelopeLineRow key={line.id} line={line} categoryLabel={categoryLabel(line)} />
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        GROUP_ORDER.filter((key) => groups.has(key)).map((key) => {
          const lines = groups.get(key) ?? [];
          const showMeter = key !== 'income' && key !== 'credit_card_payment';
          return (
            <section key={key} aria-labelledby={`budget-group-${key}`}>
              {showMeter ? (
                <div className="mb-2 rounded-md border border-border-primary bg-bg-primary p-3">
                  <BudgetMeterRow
                    title={
                      <h2 id={`budget-group-${key}`} className="text-small font-semibold">
                        {GROUP_LABELS[key]}
                      </h2>
                    }
                    figures={meterFiguresOf(lines, currency)}
                    pace={pace}
                    label={GROUP_LABELS[key]}
                    size="md"
                    shape="squared"
                  />
                </div>
              ) : (
                <h2
                  id={`budget-group-${key}`}
                  className="mb-2 text-small font-semibold text-text-secondary"
                >
                  {GROUP_LABELS[key]}
                </h2>
              )}
              <ul className="flex flex-col gap-2">
                {lines.map((line) => (
                  <EnvelopeLineRow
                    key={line.id}
                    line={line}
                    categoryLabel={categoryLabel(line)}
                    {...(metered(line) ? { pace } : {})}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}

      <MeterTable
        rows={tableRows}
        pace={pace}
        caption={view === 'variability' ? 'By variability' : 'By group'}
      />
    </div>
  );
}

export type BudgetView = 'group' | 'variability';

function ViewToggle({
  view,
  onViewChange,
}: {
  readonly view: BudgetView;
  readonly onViewChange: (view: BudgetView) => void;
}) {
  const options: readonly { value: BudgetView; label: string }[] = [
    { value: 'group', label: 'By group' },
    { value: 'variability', label: 'By variability' },
  ];
  return (
    <div
      role="group"
      aria-label="Budget view"
      className="inline-flex overflow-hidden rounded-md border border-border-primary"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => onViewChange(option.value)}
          className={cn(
            'min-h-8 px-3 text-small font-medium focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
            index > 0 && 'border-l border-border-primary',
            view === option.value
              ? 'bg-accent text-text-on-brand'
              : 'bg-bg-primary text-text-secondary hover:bg-bg-secondary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface MeterTableRow {
  readonly label: string;
  readonly figures: MeterFigures;
}

/** The meters as a table (the dataviz skill: every chart has a table view) — with the pace as its own column. */
function MeterTable({
  rows,
  pace,
  caption,
}: {
  readonly rows: readonly MeterTableRow[];
  readonly pace: PaceStatus;
  readonly caption: string;
}) {
  if (rows.length === 0) return null;
  const paceCell =
    pace.kind === 'running'
      ? `${String(Math.round(pace.fraction * 100))}% (${paceWordsOf(pace)})`
      : paceWordsOf(pace);
  return (
    <details className="rounded-md border border-border-primary bg-bg-primary p-3">
      <summary className="cursor-pointer text-small font-medium text-text-primary">
        Show the bars as a table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-small tabular-nums">
          <caption className="sr-only">Budget meters, {caption}</caption>
          <thead>
            <tr className="text-left text-caption text-text-secondary">
              <th scope="col" className="py-1 pr-3 font-medium">
                {caption === 'By variability' ? 'Section' : 'Group'}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Budgeted
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Spent
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Left
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Spent %
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Pace
              </th>
              <th scope="col" className="py-1 font-medium">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = meterStateOf(row.figures, pace);
              const percent = spentPercentOf(row.figures);
              return (
                <tr key={row.label} className="border-t border-border-divider text-text-primary">
                  <th scope="row" className="py-1 pr-3 text-left font-medium">
                    {row.label}
                  </th>
                  <td className="py-1 pr-3 text-right">
                    <Money
                      value={wireOf(row.figures.budgeted)}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Money
                      value={wireOf(row.figures.spent)}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Money
                      value={wireOf(row.figures.remaining)}
                      signDisplay="auto"
                      colorBySign={false}
                    />
                  </td>
                  <td className="py-1 pr-3 text-right">
                    {percent === null ? '—' : `${String(percent)}%`}
                  </td>
                  <td className="py-1 pr-3 text-right">{paceCell}</td>
                  <td className="py-1">{METER_STATE_WORDS[state]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
