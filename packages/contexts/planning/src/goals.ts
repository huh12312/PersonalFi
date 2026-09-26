// SPDX-License-Identifier: MIT
/**
 * Goals (WP 4.1): what the holder is saving towards, by when, from which
 * accounts — and the contribution plans that fund each one.
 *
 * ## Two refusals the dispatch names, and what "refusal" means here
 *
 *   * **A target date already in the past** is `planning.goal_target_date_in_past`
 *     (`domain`, 422). "The past" is computed in the holder's zone with
 *     `todayIn(clock, timeZone)` (docs/CONVENTIONS.md "Time"), never the
 *     container's. The date is **not clamped to today**: a goal the holder
 *     believes is due last March and the app silently re-dates to this morning
 *     is a goal whose required-savings answer is wrong by an amount nobody can
 *     see.
 *   * **A funding account that does not exist** is
 *     `planning.goal_funding_account_not_found` (`domain`, 422), naming the id.
 *     It is **not dropped from the list**: a goal funded "from checking and
 *     from an account that is not there" is not the same goal as one funded
 *     from checking. "Exists" means *the caller's* account — the roster comes
 *     through `FundingAccountsReader` scoped to the caller — so another
 *     holder's account id is indistinguishable from a made-up one.
 *
 * Both are checked in `validateNewGoal`, a pure function, so the rules can be
 * tested without a database and the service is only I/O around it.
 *
 * ## The port
 *
 * `accounts` is `@ctx/ledger`'s table and this context may not read it
 * (`lint:schema-ownership`). `FundingAccountsReader` is a `Pick` of the
 * snapshotter's `BalancesReader`, so the binding `apps/api/src/domain.ts`
 * already supplies for WP 3.8 satisfies it with no adapter.
 *
 * ## Money
 *
 * `target` is `Money` end to end — `BIGINT` + `CHAR(3)` in the row, `bigint`
 * in memory, `{ minor: "…", currency }` on the wire (WP 4.8). No function in
 * this module takes or returns a `number` amount.
 */
import { DateOnly, Money, newId, todayIn, type Clock } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { GOAL_KINDS, GOAL_STATUSES, type GoalKind, type GoalStatus } from '../schema/goals.ts';
import {
  validateContributionPlan,
  type ContributionPlan,
  type ContributionPlanInput,
} from './contributions.ts';
import { PlanningError } from './errors.ts';
import { GoalCreated } from './events.ts';
import {
  deleteContributionRow,
  deleteGoalRow,
  findGoal,
  hasLiveRetirementGoal,
  insertContribution,
  insertGoal,
  listContributionRows,
  listGoals as listGoalRows,
  updateGoalRow,
  type Goal,
} from './goals-store.ts';
import type { BalancesReader, PlanningAccount } from './ports.ts';
import { platformOf, type PlanningExecutor } from './store.ts';

export type { Goal } from './goals-store.ts';

/**
 * The narrow roster a goal (or an earmark) is validated against. A `Pick` of
 * `BalancesReader`, deliberately: the composition root already binds one.
 */
export type FundingAccountsReader = Pick<BalancesReader, 'accounts'>;

/** Everything a write path needs that is not data. */
export interface GoalsContext {
  readonly userId: string;
  readonly clock: Clock;
  /** The holder's IANA zone. "Today" and "the past" are computed in it. */
  readonly timeZone: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export const GOAL_NAME_MAX_LENGTH = 96;
export const MAX_FUNDING_ACCOUNTS = 32;

export interface NewGoalInput {
  readonly kind: GoalKind;
  readonly name: string;
  readonly target: Money;
  readonly targetDate: string;
  /** 1 (most important) to 5. Defaults to 3. */
  readonly priority?: number;
  readonly fundedFromAccountIds?: readonly string[];
}

export interface ValidGoal {
  readonly kind: GoalKind;
  readonly name: string;
  readonly target: Money;
  readonly targetDate: DateOnly;
  readonly priority: number;
  readonly fundedFromAccountIds: readonly string[];
}

function invalid(message: string): never {
  throw new PlanningError('planning.goal_invalid', message);
}

function validName(name: unknown): string {
  if (typeof name !== 'string') invalid('name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') invalid('name must not be blank');
  if (trimmed.length > GOAL_NAME_MAX_LENGTH) {
    invalid(`name is at most ${String(GOAL_NAME_MAX_LENGTH)} characters`);
  }
  return trimmed;
}

function validTarget(target: Money): Money {
  if (typeof target.minor !== 'bigint') invalid('target must be Money with bigint minor units');
  if (target.minor <= 0n) {
    throw new PlanningError(
      'planning.goal_target_not_positive',
      `a goal target must be positive, got ${Money.format(target)}`,
    );
  }
  return target;
}

function validPriority(priority: unknown): number {
  if (priority === undefined) return 3;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 5) {
    invalid('priority must be a whole number from 1 to 5');
  }
  return priority;
}

/**
 * The target date must not be before `today`. Today itself is allowed: a goal
 * due today is a goal whose horizon is zero, which the `goals.list` scope
 * already represents (`horizon_months: 0`).
 */
export function assertTargetDateNotPast(targetDate: unknown, today: DateOnly): DateOnly {
  if (typeof targetDate !== 'string' || !DateOnly.is(targetDate)) {
    invalid('targetDate must be a YYYY-MM-DD date');
  }
  if (DateOnly.isBefore(targetDate, today)) {
    throw new PlanningError(
      'planning.goal_target_date_in_past',
      `target date ${targetDate} is before today (${today}) in the holder's time zone; ` +
        'it is refused rather than moved',
    );
  }
  return targetDate;
}

/**
 * Every id must be one of the caller's open accounts. Duplicates are collapsed
 * (the set is what matters) and the order is kept as given.
 */
export function assertFundingAccountsExist(
  ids: readonly string[],
  roster: readonly Pick<PlanningAccount, 'accountId' | 'closedAt'>[],
): readonly string[] {
  if (!Array.isArray(ids)) invalid('fundedFromAccountIds must be an array');
  const unique = [...new Set(ids)];
  if (unique.length > MAX_FUNDING_ACCOUNTS) {
    invalid(`a goal names at most ${String(MAX_FUNDING_ACCOUNTS)} funding accounts`);
  }
  const byId = new Map(roster.map((account) => [account.accountId, account]));
  for (const id of unique) {
    const account = typeof id === 'string' ? byId.get(id) : undefined;
    if (account === undefined) {
      throw new PlanningError(
        'planning.goal_funding_account_not_found',
        `funding account ${String(id)} does not exist`,
      );
    }
    if (account.closedAt !== null) {
      throw new PlanningError(
        'planning.goal_funding_account_closed',
        `funding account ${id} was closed on ${account.closedAt.toISOString().slice(0, 10)}`,
      );
    }
  }
  return Object.freeze(unique);
}

/** Pure. Every rule a new goal must satisfy, against a known today and roster. */
export function validateNewGoal(
  input: NewGoalInput,
  known: {
    readonly today: DateOnly;
    readonly accounts: readonly Pick<PlanningAccount, 'accountId' | 'closedAt'>[];
  },
): ValidGoal {
  if (!GOAL_KINDS.includes(input.kind)) invalid(`kind must be one of ${GOAL_KINDS.join(', ')}`);
  return Object.freeze({
    kind: input.kind,
    name: validName(input.name),
    target: validTarget(input.target),
    targetDate: assertTargetDateNotPast(input.targetDate, known.today),
    priority: validPriority(input.priority),
    fundedFromAccountIds: assertFundingAccountsExist(
      input.fundedFromAccountIds ?? [],
      known.accounts,
    ),
  });
}

/**
 * Create a goal and append `planning.GoalCreated`, on one executor.
 *
 * Pass a transaction: the goal and its event are one fact or none. A second
 * live retirement goal is refused here by a read, and by
 * `goals_one_live_retirement_idx` if two requests race past the read.
 */
export async function createGoal(
  executor: PlanningExecutor,
  ports: { readonly accounts: FundingAccountsReader },
  context: GoalsContext,
  input: NewGoalInput,
): Promise<Goal> {
  const today = todayIn(context.clock, context.timeZone);
  const accounts = await ports.accounts.accounts(context.userId, today);
  const valid = validateNewGoal(input, { today, accounts });
  if (
    valid.kind === 'retirement' &&
    (await hasLiveRetirementGoal(executor, context.userId, null))
  ) {
    throw new PlanningError(
      'planning.goal_retirement_already_live',
      'there is already an active or paused retirement goal; finish or abandon it first',
    );
  }
  const goal = await insertGoal(executor, {
    id: newId(),
    userId: context.userId,
    ...valid,
    now: context.clock.now(),
  });
  await appendEvent(
    platformOf(executor),
    GoalCreated.create(
      {
        goalId: goal.id,
        kind: goal.kind,
        targetDate: goal.targetDate,
        priority: goal.priority,
        fundingAccountCount: goal.fundedFromAccountIds.length,
      },
      {
        userId: context.userId,
        aggregateId: goal.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return goal;
}

export async function getGoal(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<Goal> {
  const goal = await findGoal(executor, userId, goalId);
  if (goal === null) {
    throw new PlanningError('planning.goal_not_found', `no goal ${goalId}`);
  }
  return goal;
}

export function listGoals(executor: PlanningExecutor, userId: string): Promise<readonly Goal[]> {
  return listGoalRows(executor, userId);
}

export interface GoalPatch {
  readonly name?: string;
  readonly target?: Money;
  readonly targetDate?: string;
  readonly priority?: number;
  readonly fundedFromAccountIds?: readonly string[];
  readonly status?: GoalStatus;
}

/**
 * Edit a goal. Each field that is present is re-validated by the same rule
 * creation uses — so moving a target date into the past is refused exactly as
 * creating one there is — and a field that is absent is left alone. An
 * unchanged past target date on an old goal is *not* re-checked: the goal
 * became due, it did not become invalid.
 */
export async function updateGoal(
  executor: PlanningExecutor,
  ports: { readonly accounts: FundingAccountsReader },
  context: GoalsContext,
  goalId: string,
  patch: GoalPatch,
): Promise<Goal> {
  const current = await getGoal(executor, context.userId, goalId);
  const today = todayIn(context.clock, context.timeZone);
  const status = patch.status ?? current.status;
  if (!GOAL_STATUSES.includes(status)) invalid(`status must be one of ${GOAL_STATUSES.join(', ')}`);
  const target = patch.target === undefined ? current.target : validTarget(patch.target);
  if (
    patch.target !== undefined &&
    patch.target.currency !== current.target.currency &&
    (await listContributionRows(executor, context.userId, goalId)).length > 0
  ) {
    throw new PlanningError(
      'planning.contribution_currency_mismatch',
      `the goal has contribution plans in ${current.target.currency}; remove them before ` +
        `changing its currency to ${patch.target.currency}`,
    );
  }
  const fundedFromAccountIds =
    patch.fundedFromAccountIds === undefined
      ? current.fundedFromAccountIds
      : assertFundingAccountsExist(
          patch.fundedFromAccountIds,
          await ports.accounts.accounts(context.userId, today),
        );
  const revived =
    current.kind === 'retirement' &&
    (status === 'active' || status === 'paused') &&
    !(current.status === 'active' || current.status === 'paused');
  if (revived && (await hasLiveRetirementGoal(executor, context.userId, current.id))) {
    throw new PlanningError(
      'planning.goal_retirement_already_live',
      'another retirement goal is already active or paused',
    );
  }
  const updated = await updateGoalRow(executor, {
    userId: context.userId,
    goal: {
      id: current.id,
      name: patch.name === undefined ? current.name : validName(patch.name),
      target,
      targetDate:
        patch.targetDate === undefined
          ? current.targetDate
          : assertTargetDateNotPast(patch.targetDate, today),
      priority: patch.priority === undefined ? current.priority : validPriority(patch.priority),
      fundedFromAccountIds,
      status,
    },
    now: context.clock.now(),
  });
  if (updated === null) throw new PlanningError('planning.goal_not_found', `no goal ${goalId}`);
  return updated;
}

/** Deletes the goal and, by cascade, its contribution plans and earmarks. */
export async function deleteGoal(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<void> {
  if (!(await deleteGoalRow(executor, userId, goalId))) {
    throw new PlanningError('planning.goal_not_found', `no goal ${goalId}`);
  }
}

// ---------------------------------------------------------------------------
// Contribution plans, which only ever exist under a goal
// ---------------------------------------------------------------------------

/**
 * Add a contribution plan to one of the caller's goals.
 *
 * The goal is read through the caller's scope first, so another holder's goal
 * id is `planning.goal_not_found` — the same 404 as an id that never existed.
 * `goal_contributions_goal_is_the_same_users` is the database's answer to the
 * same question if this read is ever removed.
 */
export async function addContribution(
  executor: PlanningExecutor,
  context: Pick<GoalsContext, 'userId' | 'clock'>,
  goalId: string,
  input: ContributionPlanInput,
): Promise<ContributionPlan> {
  const goal = await getGoal(executor, context.userId, goalId);
  const plan = validateContributionPlan(input, goal);
  return insertContribution(executor, {
    id: newId(),
    userId: context.userId,
    goalId: goal.id,
    plan,
    now: context.clock.now(),
  });
}

export async function listContributions(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<readonly ContributionPlan[]> {
  await getGoal(executor, userId, goalId);
  return listContributionRows(executor, userId, goalId);
}

export async function removeContribution(
  executor: PlanningExecutor,
  userId: string,
  contributionId: string,
): Promise<void> {
  if (!(await deleteContributionRow(executor, userId, contributionId))) {
    throw new PlanningError(
      'planning.contribution_not_found',
      `no contribution plan ${contributionId}`,
    );
  }
}
