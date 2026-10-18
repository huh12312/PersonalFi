// SPDX-License-Identifier: MIT
import { Repeat, TrendingDown } from 'lucide-react';

import type { BudgetPeriod } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { readyToAssignToneOf } from './envelope-display.ts';

/**
 * "Left to budget" (WP 10.11; Monarch's equivalent header card, "Left to budget" with rows Income / Expenses /
 * rollover). The hero is the period's **Ready to Assign, as the server computed it** — this card renders
 * `period.readyToAssign` and never derives it: in this envelope budget it comes from the balance-sheet identity
 * (`@ctx/budgeting` `src/rta.ts`), not from income minus assignments, and the three figures beneath it are context
 * for it, not its terms. All four, and the rollover line, are fields of `GET /budgets/current`
 * (`readyToAssign`, `income`, `budgetedExpenses`, `plannedSavings`, `rolledOver`).
 *
 * Sign-coloured; a negative figure keeps WP 2.9's "fix this first" alert in words and an icon.
 */
export function LeftToBudgetCard({
  period,
}: {
  readonly period: Pick<
    BudgetPeriod,
    'readyToAssign' | 'income' | 'budgetedExpenses' | 'plannedSavings' | 'rolledOver'
  >;
}) {
  const tone = readyToAssignToneOf(period);
  const rolled = BigInt(period.rolledOver.minor);
  return (
    <section
      aria-label="Left to budget"
      className="flex flex-col gap-4 rounded-lg border border-border-primary bg-bg-primary p-4"
    >
      <StatTile
        size="hero"
        label="Left to budget"
        value={
          <span data-testid="ready-to-assign-amount">
            <Money value={period.readyToAssign} colorBySign />
          </span>
        }
        hint={
          tone === 'alert' ? (
            <span className="flex items-center gap-1 text-status-danger-text">
              <TrendingDown size={14} aria-hidden="true" />
              Assigned more than you have — fix this first
            </span>
          ) : (
            'Income not yet given to a category'
          )
        }
      />
      <dl className="grid grid-cols-1 gap-3 border-t border-border-divider pt-3 sm:grid-cols-3">
        <Figure label="Income this period" testId="ltb-income" value={period.income} />
        <Figure
          label="Budgeted expenses"
          testId="ltb-budgeted-expenses"
          value={period.budgetedExpenses}
        />
        <Figure
          label="Planned savings & goals"
          testId="ltb-planned-savings"
          value={period.plannedSavings}
        />
      </dl>
      <p
        data-testid="ltb-rollover"
        className="flex items-center gap-1.5 text-small text-text-secondary"
      >
        <Repeat size={14} aria-hidden="true" />
        {rolled === 0n ? (
          'Nothing rolled over from last period'
        ) : rolled > 0n ? (
          <span>
            <Money value={period.rolledOver} signDisplay="exceptZero" colorBySign={false} /> rolled
            over from last period
          </span>
        ) : (
          <span>
            <Money value={period.rolledOver} signDisplay="exceptZero" colorBySign={false} /> carried
            in from last period's overspending
          </span>
        )}
      </p>
    </section>
  );
}

function Figure({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: BudgetPeriod['income'];
  readonly testId: string;
}) {
  return (
    <div>
      <dt className="text-caption text-text-secondary">{label}</dt>
      <dd data-testid={testId} className="text-body font-medium text-text-primary tabular-nums">
        <Money value={value} signDisplay="auto" colorBySign={false} />
      </dd>
    </div>
  );
}
