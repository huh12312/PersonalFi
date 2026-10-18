// SPDX-License-Identifier: MIT
import { Money } from '../../../components/finance/Money.tsx';
import { formatDateOnly } from '../../../lib/date.ts';
import { useAccountsQuery } from '../../accounts/useAccounts.ts';
import { useGoalsQuery } from '../../goals/api.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { goalProgress, type GoalProgress } from './goal-progress.ts';
import { wire } from './pace.ts';

const UNMEASURED_COPY = {
  no_funding_account: 'No account funds this goal yet, so its progress cannot be measured.',
  currency_mismatch: 'Its accounts are in another currency than its target (not converted).',
  no_balance: 'Its accounts have no balance recorded yet.',
} as const;

/** Goals (WP 10.9): progress per active goal, from the balances of the accounts that fund it. */
export function GoalsWidget() {
  const goalsQuery = useGoalsQuery();
  const accountsQuery = useAccountsQuery();
  const goals = goalsQuery.data?.goals ?? [];
  const progress = goalProgress(goals, accountsQuery.data?.accounts ?? []);
  const retirementOnly =
    progress.length === 0 &&
    goals.some((goal) => goal.status === 'active' && goal.kind === 'retirement');

  const state: WidgetState =
    goalsQuery.isLoading || accountsQuery.isLoading
      ? { kind: 'loading' }
      : goalsQuery.isError
        ? { kind: 'error', message: "Goals aren't available right now." }
        : retirementOnly
          ? {
              kind: 'empty',
              message: 'Your retirement goal is measured by your plan, not a balance.',
              fix: { to: '/goals', label: 'Open goals' },
            }
          : progress.length === 0
            ? {
                kind: 'empty',
                message: 'No active goals yet.',
                fix: { to: '/goals', label: 'Add a goal' },
              }
            : { kind: 'ready' };

  return (
    <DashboardWidgetCard
      id="goals"
      title="Goals"
      seeAll={{ to: '/goals', label: 'See all' }}
      state={state}
    >
      <ul className="flex flex-col gap-3">
        {progress.slice(0, 4).map((entry) => (
          <li key={entry.goal.id}>
            <GoalRow entry={entry} />
          </li>
        ))}
      </ul>
      {progress.length > 4 && (
        <p className="mt-2 text-caption text-text-muted">
          and {progress.length - 4} more on the Goals screen
        </p>
      )}
    </DashboardWidgetCard>
  );
}

function GoalRow({ entry }: { readonly entry: GoalProgress }) {
  const { goal } = entry;
  return (
    <div data-goal-progress={entry.kind}>
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span className="min-w-0 truncate font-medium text-text-primary">{goal.name}</span>
        <span className="shrink-0 text-caption text-text-muted">
          by {formatDateOnly(goal.targetDate, 'MMM yyyy')}
        </span>
      </div>
      {entry.kind === 'measured' ? (
        <>
          <div
            role="meter"
            aria-label={`${goal.name}: saved of target`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(entry.ratio * 100)}
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${String(entry.ratio * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-caption text-text-muted tabular-nums">
            <Money value={wire(entry.funded)} signDisplay="auto" colorBySign={false} /> of{' '}
            <Money value={goal.target} signDisplay="auto" colorBySign={false} />
            {entry.sharedAccounts > 0 &&
              ` · ${String(entry.sharedAccounts)} shared account${entry.sharedAccounts === 1 ? '' : 's'} not counted`}
          </p>
        </>
      ) : (
        <p className="mt-1 text-caption text-text-secondary">
          <Money value={goal.target} signDisplay="auto" colorBySign={false} /> target.{' '}
          {UNMEASURED_COPY[entry.reason]}
        </p>
      )}
    </div>
  );
}
