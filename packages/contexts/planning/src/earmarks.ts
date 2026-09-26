// SPDX-License-Identifier: MIT
/**
 * Cash earmarks (WP 4.1): a named reservation of cash in one account against
 * one goal.
 *
 * 07 I3 fires on brokerage cash "> max($1,000, 2% of account) for > 14 days
 * **and not earmarked**". Without this table the last clause has no source and
 * the rule can only ever say "invest it" — including about the house deposit
 * the holder is deliberately keeping in cash for next spring. An earmark is the
 * holder saying so, once, by name.
 *
 * ## Why here and not in `@ctx/investments`
 *
 * An earmark is a statement about a **goal** — the row carries `goal_id` by
 * composite foreign key — and goals are Planning's. 08 §1.6 draws
 * `planning → investments`, never the reverse, so Investments cannot own a row
 * that points at a goal, and Planning owning it costs nothing: WP 4.7's dwell
 * analytic stays Investments', the earmark stays Planning's, and the
 * composition root — which may read both, 08 §1.3 #9 — composes them for I3.
 * `liveEarmarksByAccount` is the read it composes with.
 *
 * ## The rules
 *
 *   * The goal must be the caller's (`planning.goal_not_found` otherwise, and
 *     `cash_earmarks_goal_is_the_same_users` refuses it in the database if this
 *     check is ever removed).
 *   * The account must be one of the caller's open **asset** accounts — a
 *     reservation of cash on a credit card is not a reservation of anything —
 *     and the amount must be in that account's own currency. No conversion:
 *     an earmark reserves the cash that is there, in the currency it is in.
 *   * Released, never deleted, so a past I3 verdict stays checkable against
 *     what was earmarked on the day.
 *
 * Deliberately **not** a rule: the earmark exceeding the account's balance.
 * Balances move daily and an earmark is an intention; WP 4.7's composition caps
 * the earmarked amount at the observed cash on the day it evaluates, which is
 * the only place both numbers are known at once.
 */
import { Money, newId, todayIn, type Clock } from '@core/kernel';
import { PlanningError } from './errors.ts';
import type { FundingAccountsReader } from './goals.ts';
import { getGoal } from './goals.ts';
import {
  insertEarmark,
  listEarmarkRows,
  releaseEarmarkRow,
  type CashEarmark,
} from './goals-store.ts';
import type { PlanningExecutor } from './store.ts';

export type { CashEarmark } from './goals-store.ts';

export const EARMARK_NAME_MAX_LENGTH = 96;

export interface NewEarmarkInput {
  readonly goalId: string;
  readonly accountId: string;
  readonly name: string;
  readonly amount: Money;
}

function invalid(message: string): never {
  throw new PlanningError('planning.earmark_invalid', message);
}

export async function createEarmark(
  executor: PlanningExecutor,
  ports: { readonly accounts: FundingAccountsReader },
  context: { readonly userId: string; readonly clock: Clock; readonly timeZone: string },
  input: NewEarmarkInput,
): Promise<CashEarmark> {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    invalid('an earmark has a name');
  }
  const name = input.name.trim();
  if (name.length > EARMARK_NAME_MAX_LENGTH) {
    invalid(`name is at most ${String(EARMARK_NAME_MAX_LENGTH)} characters`);
  }
  if (typeof input.amount.minor !== 'bigint' || input.amount.minor <= 0n) {
    invalid('an earmark amount is positive Money');
  }
  const goal = await getGoal(executor, context.userId, input.goalId);

  const today = todayIn(context.clock, context.timeZone);
  const roster = await ports.accounts.accounts(context.userId, today);
  const account = roster.find((candidate) => candidate.accountId === input.accountId);
  if (account === undefined || account.closedAt !== null) {
    throw new PlanningError(
      'planning.earmark_account_not_found',
      `account ${input.accountId} is not one of your open accounts`,
    );
  }
  if (account.side !== 'asset') {
    throw new PlanningError(
      'planning.earmark_account_not_an_asset',
      `account ${input.accountId} is a liability; only cash that exists can be earmarked`,
    );
  }
  if (account.currency !== input.amount.currency) {
    throw new PlanningError(
      'planning.earmark_currency_mismatch',
      `the account holds ${account.currency}; the earmark is in ${input.amount.currency}`,
    );
  }

  return insertEarmark(executor, {
    id: newId(),
    userId: context.userId,
    goalId: goal.id,
    accountId: account.accountId,
    name,
    amount: input.amount,
    now: context.clock.now(),
  });
}

export async function releaseEarmark(
  executor: PlanningExecutor,
  context: { readonly userId: string; readonly clock: Clock },
  earmarkId: string,
): Promise<CashEarmark> {
  const released = await releaseEarmarkRow(executor, {
    userId: context.userId,
    earmarkId,
    now: context.clock.now(),
  });
  if (released === null) {
    throw new PlanningError(
      'planning.earmark_not_found',
      `no live earmark ${earmarkId}; it does not exist or was already released`,
    );
  }
  return released;
}

export function listEarmarks(
  executor: PlanningExecutor,
  userId: string,
  options: { readonly includeReleased?: boolean } = {},
): Promise<readonly CashEarmark[]> {
  return listEarmarkRows(executor, userId, { includeReleased: options.includeReleased ?? false });
}

/**
 * Live earmarked cash per account, summed — the input WP 4.7's I3 composition
 * subtracts from an account's idle cash. One currency per account by
 * construction (`createEarmark` refuses any other), so each total is one
 * `Money`; `Money.add` would throw rather than coerce if that ever stopped
 * being true.
 */
export async function liveEarmarksByAccount(
  executor: PlanningExecutor,
  userId: string,
): Promise<ReadonlyMap<string, Money>> {
  const totals = new Map<string, Money>();
  for (const earmark of await listEarmarkRows(executor, userId, { includeReleased: false })) {
    const running = totals.get(earmark.accountId);
    totals.set(
      earmark.accountId,
      running === undefined ? earmark.amount : Money.add(running, earmark.amount),
    );
  }
  return totals;
}
