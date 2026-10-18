// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, type Money } from '@core/kernel';

import type { Account, Goal } from '../../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../../lib/money.ts';

export type GoalProgress =
  | {
      readonly kind: 'measured';
      readonly goal: Goal;
      readonly funded: Money;
      /** funded ÷ target, for the bar (a float from exact minor units), clamped to [0, 1]. */
      readonly ratio: number;
      /** Funding accounts left out because another active goal names them too. */
      readonly sharedAccounts: number;
    }
  | {
      readonly kind: 'unmeasured';
      readonly goal: Goal;
      readonly reason: 'no_funding_account' | 'currency_mismatch' | 'no_balance';
    };

/**
 * How far each active goal is (WP 10.9): the positive balances of the asset accounts it is funded from, against its
 * target. This is `@ctx/planning`'s own "funded" rule for a goal with no earmarks (`evaluateGoalPace`,
 * `projection-service.ts`): an account two active goals both name is counted for neither, a liability or a negative
 * balance adds nothing, and a goal in another currency than its accounts is not measured (never converted).
 * Earmarks have no route, so a goal funded only by earmarks reads as "no funding account" here — said, not guessed.
 * Retirement goals are measured by the plan's success probability, not a balance, and are left out (the planning
 * rule again).
 */
export function goalProgress(goals: readonly Goal[], accounts: readonly Account[]): GoalProgress[] {
  const active = goals.filter((goal) => goal.status === 'active' && goal.kind !== 'retirement');
  const namedBy = new Map<string, number>();
  for (const goal of active) {
    for (const id of new Set(goal.fundedFromAccountIds))
      namedBy.set(id, (namedBy.get(id) ?? 0) + 1);
  }
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  return [...active]
    .sort((a, b) => a.priority - b.priority || a.targetDate.localeCompare(b.targetDate))
    .map((goal): GoalProgress => {
      const ids = [...new Set(goal.fundedFromAccountIds)];
      if (ids.length === 0) return { kind: 'unmeasured', goal, reason: 'no_funding_account' };
      const target = parseWireMoney(goal.target);
      let funded = MoneyKernel.zero(target.currency);
      let shared = 0;
      let seenBalance = false;
      for (const id of ids) {
        if ((namedBy.get(id) ?? 0) > 1) {
          shared += 1;
          continue;
        }
        const account = byId.get(id);
        if (account === undefined || account.classification !== 'asset' || account.balance === null)
          continue;
        const balance = parseWireMoney(account.balance.current);
        if (balance.currency !== target.currency) {
          return { kind: 'unmeasured', goal, reason: 'currency_mismatch' };
        }
        seenBalance = true;
        if (MoneyKernel.isPositive(balance)) funded = MoneyKernel.add(funded, balance);
      }
      if (!seenBalance && shared === 0) return { kind: 'unmeasured', goal, reason: 'no_balance' };
      // Presentation only: the bar's length.
      const ratio = MoneyKernel.isPositive(target)
        ? Math.min(Math.max(Number(funded.minor) / Number(target.minor), 0), 1)
        : 1;
      return { kind: 'measured', goal, funded, ratio, sharedAccounts: shared };
    });
}
