// SPDX-License-Identifier: MIT
import { ArrowDownRight, ArrowUpRight, Equal } from 'lucide-react';

import type { SpendingPace } from '../../../api/generated/types.gen.ts';
import { Money } from '../../../components/finance/Money.tsx';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { useSpendingPaceQuery } from '../api.ts';
import { staleNote } from './freshness.ts';
import { monthName, paceState, wire, type PaceComparison } from './pace.ts';
import { SpendingPaceChart } from './SpendingPaceChart.tsx';

/**
 * The spending pace widget (WP 10.9) — the centrepiece of the dashboard: this month's running spend by day against
 * last month's and the three-month average, and the sentence that says it in words. The difference is money, in
 * the status role for its direction (under = success, over = danger), with an arrow and a word, never colour alone
 * and never a percentage without the two amounts.
 */
export function SpendingPaceWidget({ now }: { readonly now?: Date } = {}) {
  const query = useSpendingPaceQuery();
  const pace = query.data;
  const state = paceState(pace ?? emptyPace());

  let widgetState: WidgetState;
  if (query.isLoading) widgetState = { kind: 'loading' };
  else if (query.isError || pace === undefined)
    widgetState = { kind: 'error', message: "Spending isn't available right now." };
  else if (state.kind === 'no-data')
    widgetState = {
      kind: 'empty',
      message:
        'No transactions in the last four months, so there is no pace to draw yet. Connect an account or import a statement.',
      fix: { to: '/accounts/connections', label: 'Connect an account' },
    };
  else if (state.kind === 'future')
    widgetState = { kind: 'empty', message: `${monthName(pace.month)} has not started yet.` };
  else widgetState = { kind: 'ready' };

  return (
    <DashboardWidgetCard
      id="spending-pace"
      title="Spending pace"
      subtitle={pace === undefined ? undefined : `${monthName(pace.month)}, day by day`}
      seeAll={{ to: '/reports', label: 'See all' }}
      state={widgetState}
      asOf={pace === undefined ? undefined : staleNote(pace.lastSyncedAt, now)}
    >
      {pace !== undefined && state.kind === 'ready' && pace.currency !== null && (
        <>
          <PaceSentence comparison={state.comparison} pace={pace} />
          <SpendingPaceChart className="mt-3" pace={pace} currency={pace.currency} />
          <PaceNotes pace={pace} />
        </>
      )}
    </DashboardWidgetCard>
  );
}

function emptyPace(): SpendingPace {
  return {
    month: '1970-01',
    currency: null,
    otherCurrencies: [],
    daysInMonth: 31,
    today: null,
    days: [],
    lastMonthKey: '1969-12',
    lastMonth: [],
    trailingMonths: [],
    trailingAverage: [],
    includePending: false,
    pendingExcludedCount: 0,
    asOf: '',
    lastSyncedAt: null,
  };
}

/** "You've spent $X this month. By this day last month you had spent $Y." — then the difference, in words. */
export function PaceSentence({
  comparison,
  pace,
}: {
  readonly comparison: PaceComparison;
  readonly pace: SpendingPace;
}) {
  const current = pace.today !== null;
  const last = comparison.lastMonth;
  return (
    <div data-testid="pace-sentence">
      <p className="text-body text-text-primary">
        {current ? "You've spent " : `You spent `}
        <Money
          value={wire(comparison.spent)}
          signDisplay="auto"
          colorBySign={false}
          className="font-semibold"
        />
        {current ? ' this month.' : ` in ${monthName(pace.month)}.`}{' '}
        {last === null ? (
          <span className="text-text-secondary">
            No spending was recorded in {monthName(pace.lastMonthKey)} to compare with.
          </span>
        ) : (
          <>
            {current
              ? last.day === comparison.day
                ? 'By this day last month you had spent '
                : `By the end of last month (day ${String(last.day)}) you had spent `
              : `In ${monthName(pace.lastMonthKey)} you spent `}
            <Money
              value={wire(last.spent)}
              signDisplay="auto"
              colorBySign={false}
              className="font-semibold"
            />
            .
          </>
        )}
      </p>
      {last !== null && (
        <PaceDifference direction={last.direction} difference={wire(last.difference)} />
      )}
    </div>
  );
}

function PaceDifference({
  direction,
  difference,
}: {
  readonly direction: 'under' | 'over' | 'same';
  readonly difference: { minor: string; currency: string };
}) {
  if (direction === 'same') {
    return (
      <p className="mt-1 flex items-center gap-1 text-small text-text-secondary" data-pace="same">
        <Equal size={14} aria-hidden="true" />
        The same as last month.
      </p>
    );
  }
  const under = direction === 'under';
  const Icon = under ? ArrowDownRight : ArrowUpRight;
  return (
    <p
      className={
        under
          ? 'mt-1 flex items-center gap-1 text-small font-medium text-status-success-text'
          : 'mt-1 flex items-center gap-1 text-small font-medium text-status-danger-text'
      }
      data-pace={direction}
    >
      <Icon size={14} aria-hidden="true" />
      <Money value={difference} signDisplay="never" colorBySign={false} />
      {under ? ' less than last month' : ' more than last month'}
    </p>
  );
}

function PaceNotes({ pace }: { readonly pace: SpendingPace }) {
  const notes: string[] = [];
  if (pace.pendingExcludedCount > 0) {
    notes.push(
      `${String(pace.pendingExcludedCount)} pending charge${pace.pendingExcludedCount === 1 ? ' is' : 's are'} not counted until ${pace.pendingExcludedCount === 1 ? 'it posts' : 'they post'}.`,
    );
  }
  if (pace.trailingAverage.length > 0 && pace.trailingMonths.length < 3) {
    notes.push(
      `The average is over ${String(pace.trailingMonths.length)} month${pace.trailingMonths.length === 1 ? '' : 's'}: there is no earlier history.`,
    );
  }
  if (pace.otherCurrencies.length > 0) {
    notes.push(`Spending in ${pace.otherCurrencies.join(', ')} is not included (never converted).`);
  }
  notes.push('Transfers between your accounts and income are not spending.');
  return (
    <ul
      className="mt-2 flex flex-col gap-0.5 text-caption text-text-muted"
      data-testid="pace-notes"
    >
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
