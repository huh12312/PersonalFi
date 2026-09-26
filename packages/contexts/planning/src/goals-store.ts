// SPDX-License-Identifier: MIT
/**
 * The sole reader and writer of `goals`, `goal_contributions`, `risk_profile`
 * and `cash_earmarks` (WP 4.1, migration 0020).
 *
 * Raw parameterised SQL in the style of `src/store.ts`, for the same reason:
 * several statements carry a rule the query builder would obscure — a guarded
 * UPDATE whose *row count* is the check, and the `WHERE user_id = …` that
 * scopes every statement below.
 *
 * ## Every statement is scoped by one predicate, and that predicate is load-bearing
 *
 * WP 3.9's S1 finding: a sabotage that drops `holdings.user_id` stayed green
 * because a join on `securities` also scoped the query, so the test proved the
 * *other* predicate. Nothing here joins. Each statement reads or writes exactly
 * one table and carries exactly one `user_id = $caller` predicate, so dropping
 * it is observable on its own — `test/db/goals.test.ts` plants a second
 * holder's rows beside the first's and the phase-4 evidence records each
 * predicate dropped one at a time, then together. The write-side backstop is
 * in the schema, not here: the composite `(goal_id, user_id)` foreign keys
 * refuse a child row that names another holder's goal even if a service check
 * above this layer is removed.
 *
 * ## What is absent
 *
 * No UPDATE of `risk_profile` (append-only: re-answering is a new row) and no
 * DELETE of `cash_earmarks` (released, never deleted, so I3's past verdicts
 * stay checkable). The only way either leaves the table is the `users`
 * ON DELETE CASCADE.
 */
import { DateOnly, Money, isUuid } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type {
  ContributionCadence,
  ContributionSource,
  GoalKind,
  GoalStatus,
  LiquidityNeed,
  RiskTolerance,
} from '../schema/goals.ts';
import {
  parseEscalationPct,
  type ContributionPlan,
  type ValidContributionPlan,
} from './contributions.ts';
import type { PlanningExecutor } from './store.ts';
import type { RiskAnswers, RiskProfileRecord } from './risk-profile.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Goal {
  readonly id: string;
  readonly kind: GoalKind;
  readonly name: string;
  readonly target: Money;
  readonly targetDate: DateOnly;
  readonly priority: number;
  readonly fundedFromAccountIds: readonly string[];
  readonly status: GoalStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CashEarmark {
  readonly id: string;
  readonly goalId: string;
  readonly accountId: string;
  readonly name: string;
  readonly amount: Money;
  readonly releasedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredRiskProfile extends RiskProfileRecord {
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const instant = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const day = (value: string): DateOnly => DateOnly.parse(String(value).slice(0, 10));

/**
 * `UUID[]` arrives as a JS array when node-postgres knows the array type and as
 * the literal `{a,b}` when it does not. Accept both rather than depend on which.
 */
function uuidArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? '{}');
  const inner = text.replace(/^\{/, '').replace(/\}$/, '');
  return inner === '' ? [] : inner.split(',');
}

/**
 * A UUID array as a Postgres array literal.
 *
 * Drizzle's `sql` template expands a JS array into a parenthesised parameter
 * list, which is the wrong shape for `uuid[]`. Every element is checked to be a
 * UUID first, so the literal cannot carry anything but hex and hyphens.
 */
function uuidArrayLiteral(ids: readonly string[]): string {
  for (const id of ids) {
    if (!isUuid(id)) throw new Error(`not a UUID: ${JSON.stringify(id)}`);
  }
  return `{${ids.join(',')}}`;
}

interface GoalRaw extends Record<string, unknown> {
  id: string;
  kind: string;
  name: string;
  target_minor: bigint | string;
  currency: string;
  target_date: string;
  priority: number | string;
  funded_from_account_ids: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function goalOf(raw: GoalRaw): Goal {
  return Object.freeze({
    id: raw.id,
    kind: raw.kind as GoalKind,
    name: raw.name,
    target: Money.of(BigInt(raw.target_minor), raw.currency.trim()),
    targetDate: day(raw.target_date),
    priority: Number(raw.priority),
    fundedFromAccountIds: Object.freeze(uuidArray(raw.funded_from_account_ids)),
    status: raw.status as GoalStatus,
    createdAt: instant(raw.created_at),
    updatedAt: instant(raw.updated_at),
  });
}

const GOAL_COLUMNS = sql`
  id, kind, name, target_minor, currency, target_date, priority,
  funded_from_account_ids, status, created_at, updated_at
`;

interface ContributionRaw extends Record<string, unknown> {
  id: string;
  goal_id: string;
  cadence: string;
  amount_minor: bigint | string;
  currency: string;
  escalation_pct: string;
  starts_on: string;
  ends_on: string | null;
  source: string;
  derived_as_of: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function contributionOf(raw: ContributionRaw): ContributionPlan {
  return Object.freeze({
    id: raw.id,
    goalId: raw.goal_id,
    cadence: raw.cadence as ContributionCadence,
    amount: Money.of(BigInt(raw.amount_minor), raw.currency.trim()),
    // NUMERIC(7,4) reads back as '3.2500'; canonicalised, never Number()ed.
    escalationPct: parseEscalationPct(String(raw.escalation_pct)),
    startsOn: day(raw.starts_on),
    endsOn: raw.ends_on === null ? null : day(raw.ends_on),
    source: raw.source as ContributionSource,
    derivedAsOf: raw.derived_as_of === null ? null : day(raw.derived_as_of),
    createdAt: instant(raw.created_at),
    updatedAt: instant(raw.updated_at),
  });
}

const CONTRIBUTION_COLUMNS = sql`
  id, goal_id, cadence, amount_minor, currency, escalation_pct,
  starts_on, ends_on, source, derived_as_of, created_at, updated_at
`;

interface EarmarkRaw extends Record<string, unknown> {
  id: string;
  goal_id: string;
  account_id: string;
  name: string;
  amount_minor: bigint | string;
  currency: string;
  released_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function earmarkOf(raw: EarmarkRaw): CashEarmark {
  return Object.freeze({
    id: raw.id,
    goalId: raw.goal_id,
    accountId: raw.account_id,
    name: raw.name,
    amount: Money.of(BigInt(raw.amount_minor), raw.currency.trim()),
    releasedAt: raw.released_at === null ? null : instant(raw.released_at),
    createdAt: instant(raw.created_at),
    updatedAt: instant(raw.updated_at),
  });
}

const EARMARK_COLUMNS = sql`
  id, goal_id, account_id, name, amount_minor, currency, released_at, created_at, updated_at
`;

interface RiskRaw extends Record<string, unknown> {
  id: string;
  tolerance: string;
  composite_score: number | string;
  unpenalised_score: number | string;
  consistency_penalty: number | string;
  horizon_years: number | string;
  tax_bracket_band: string | null;
  liquidity_need: string;
  answers: unknown;
  answered_at: Date | string;
  created_at: Date | string;
}

function riskOf(raw: RiskRaw): StoredRiskProfile {
  const answers = (
    typeof raw.answers === 'string' ? JSON.parse(raw.answers) : raw.answers
  ) as RiskAnswers;
  return Object.freeze({
    id: raw.id,
    tolerance: raw.tolerance as RiskTolerance,
    compositeScore: Number(raw.composite_score),
    unpenalisedScore: Number(raw.unpenalised_score),
    consistencyPenalty: Number(raw.consistency_penalty),
    horizonYears: Number(raw.horizon_years),
    taxBracketBand: raw.tax_bracket_band,
    liquidityNeed: raw.liquidity_need as LiquidityNeed,
    answers,
    answeredAt: instant(raw.answered_at),
    createdAt: instant(raw.created_at),
  });
}

const RISK_COLUMNS = sql`
  id, tolerance, composite_score, unpenalised_score, consistency_penalty, horizon_years,
  tax_bracket_band, liquidity_need, answers, answered_at, created_at
`;

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

export async function insertGoal(
  executor: PlanningExecutor,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly kind: GoalKind;
    readonly name: string;
    readonly target: Money;
    readonly targetDate: DateOnly;
    readonly priority: number;
    readonly fundedFromAccountIds: readonly string[];
    readonly now: Date;
  },
): Promise<Goal> {
  const now = input.now.toISOString();
  const result = await executor.execute<GoalRaw>(sql`
    INSERT INTO goals (
      id, user_id, kind, name, target_minor, currency, target_date, priority,
      funded_from_account_ids, status, created_at, updated_at
    ) VALUES (
      ${input.id}::uuid, ${input.userId}::uuid, ${input.kind}, ${input.name},
      ${input.target.minor}, ${input.target.currency}, ${input.targetDate}::date, ${input.priority},
      ${uuidArrayLiteral(input.fundedFromAccountIds)}::uuid[], 'active',
      ${now}::timestamptz, ${now}::timestamptz
    )
    RETURNING ${GOAL_COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('goals insert returned no row');
  return goalOf(raw);
}

export async function findGoal(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<Goal | null> {
  if (!isUuid(goalId)) return null;
  const result = await executor.execute<GoalRaw>(sql`
    SELECT ${GOAL_COLUMNS} FROM goals
     WHERE id = ${goalId}::uuid AND user_id = ${userId}::uuid
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : goalOf(raw);
}

export async function listGoals(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly Goal[]> {
  const result = await executor.execute<GoalRaw>(sql`
    SELECT ${GOAL_COLUMNS} FROM goals
     WHERE user_id = ${userId}::uuid
     ORDER BY priority, target_date, id
  `);
  return result.rows.map(goalOf);
}

/** Whether the holder already has a live (active or paused) retirement goal, other than `exceptId`. */
export async function hasLiveRetirementGoal(
  executor: PlanningExecutor,
  userId: string,
  exceptId: string | null,
): Promise<boolean> {
  const result = await executor.execute<{ id: string }>(sql`
    SELECT id FROM goals
     WHERE user_id = ${userId}::uuid
       AND kind = 'retirement'
       AND status IN ('active', 'paused')
       AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
     LIMIT 1
  `);
  return result.rows.length > 0;
}

/** Guarded on `user_id`; `null` when the goal is not the caller's (or does not exist). */
export async function updateGoalRow(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly goal: Omit<Goal, 'createdAt' | 'updatedAt' | 'kind'>;
    readonly now: Date;
  },
): Promise<Goal | null> {
  const { goal } = input;
  const result = await executor.execute<GoalRaw>(sql`
    UPDATE goals
       SET name                    = ${goal.name},
           target_minor            = ${goal.target.minor},
           currency                = ${goal.target.currency},
           target_date             = ${goal.targetDate}::date,
           priority                = ${goal.priority},
           funded_from_account_ids = ${uuidArrayLiteral(goal.fundedFromAccountIds)}::uuid[],
           status                  = ${goal.status},
           updated_at              = ${input.now.toISOString()}::timestamptz
     WHERE id = ${goal.id}::uuid AND user_id = ${input.userId}::uuid
    RETURNING ${GOAL_COLUMNS}
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : goalOf(raw);
}

/** Cascades to the goal's contributions and earmarks. Returns whether a row went. */
export async function deleteGoalRow(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<boolean> {
  if (!isUuid(goalId)) return false;
  const result = await executor.execute<{ id: string }>(sql`
    DELETE FROM goals WHERE id = ${goalId}::uuid AND user_id = ${userId}::uuid RETURNING id
  `);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// goal_contributions
// ---------------------------------------------------------------------------

export async function insertContribution(
  executor: PlanningExecutor,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly goalId: string;
    readonly plan: ValidContributionPlan;
    readonly now: Date;
  },
): Promise<ContributionPlan> {
  const { plan } = input;
  const now = input.now.toISOString();
  const result = await executor.execute<ContributionRaw>(sql`
    INSERT INTO goal_contributions (
      id, user_id, goal_id, cadence, amount_minor, currency, escalation_pct,
      starts_on, ends_on, source, derived_as_of, created_at, updated_at
    ) VALUES (
      ${input.id}::uuid, ${input.userId}::uuid, ${input.goalId}::uuid, ${plan.cadence},
      ${plan.amount.minor}, ${plan.amount.currency}, ${plan.escalationPct}::numeric,
      ${plan.startsOn}::date, ${plan.endsOn}::date, ${plan.source}, ${plan.derivedAsOf}::date,
      ${now}::timestamptz, ${now}::timestamptz
    )
    RETURNING ${CONTRIBUTION_COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('goal_contributions insert returned no row');
  return contributionOf(raw);
}

export async function listContributionRows(
  executor: PlanningExecutor,
  userId: string,
  goalId: string,
): Promise<readonly ContributionPlan[]> {
  if (!isUuid(goalId)) return [];
  const result = await executor.execute<ContributionRaw>(sql`
    SELECT ${CONTRIBUTION_COLUMNS} FROM goal_contributions
     WHERE goal_id = ${goalId}::uuid AND user_id = ${userId}::uuid
     ORDER BY starts_on, id
  `);
  return result.rows.map(contributionOf);
}

export async function deleteContributionRow(
  executor: PlanningExecutor,
  userId: string,
  contributionId: string,
): Promise<boolean> {
  if (!isUuid(contributionId)) return false;
  const result = await executor.execute<{ id: string }>(sql`
    DELETE FROM goal_contributions
     WHERE id = ${contributionId}::uuid AND user_id = ${userId}::uuid
    RETURNING id
  `);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// risk_profile
// ---------------------------------------------------------------------------

/** Writes each field of the record and nothing else. There is no update path. */
export async function insertRiskProfile(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly record: RiskProfileRecord },
): Promise<StoredRiskProfile> {
  const { record } = input;
  const result = await executor.execute<RiskRaw>(sql`
    INSERT INTO risk_profile (
      id, user_id, tolerance, composite_score, unpenalised_score, consistency_penalty,
      horizon_years, tax_bracket_band, liquidity_need, answers, answered_at, created_at
    ) VALUES (
      ${record.id}::uuid, ${input.userId}::uuid, ${record.tolerance}, ${record.compositeScore},
      ${record.unpenalisedScore}, ${record.consistencyPenalty}, ${record.horizonYears},
      ${record.taxBracketBand}, ${record.liquidityNeed}, ${JSON.stringify(record.answers)}::jsonb,
      ${record.answeredAt.toISOString()}::timestamptz, ${record.answeredAt.toISOString()}::timestamptz
    )
    RETURNING ${RISK_COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('risk_profile insert returned no row');
  return riskOf(raw);
}

/** The current profile: the newest answering. `null` if the holder never answered. */
export async function latestRiskProfile(
  executor: PlanningExecutor,
  userId: string,
): Promise<StoredRiskProfile | null> {
  const result = await executor.execute<RiskRaw>(sql`
    SELECT ${RISK_COLUMNS} FROM risk_profile
     WHERE user_id = ${userId}::uuid
     ORDER BY answered_at DESC, id DESC
     LIMIT 1
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : riskOf(raw);
}

export async function riskProfileHistory(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly StoredRiskProfile[]> {
  const result = await executor.execute<RiskRaw>(sql`
    SELECT ${RISK_COLUMNS} FROM risk_profile
     WHERE user_id = ${userId}::uuid
     ORDER BY answered_at DESC, id DESC
  `);
  return result.rows.map(riskOf);
}

// ---------------------------------------------------------------------------
// cash_earmarks
// ---------------------------------------------------------------------------

export async function insertEarmark(
  executor: PlanningExecutor,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly goalId: string;
    readonly accountId: string;
    readonly name: string;
    readonly amount: Money;
    readonly now: Date;
  },
): Promise<CashEarmark> {
  const now = input.now.toISOString();
  const result = await executor.execute<EarmarkRaw>(sql`
    INSERT INTO cash_earmarks (
      id, user_id, goal_id, account_id, name, amount_minor, currency,
      released_at, created_at, updated_at
    ) VALUES (
      ${input.id}::uuid, ${input.userId}::uuid, ${input.goalId}::uuid, ${input.accountId}::uuid,
      ${input.name}, ${input.amount.minor}, ${input.amount.currency},
      NULL, ${now}::timestamptz, ${now}::timestamptz
    )
    RETURNING ${EARMARK_COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('cash_earmarks insert returned no row');
  return earmarkOf(raw);
}

export async function listEarmarkRows(
  executor: PlanningExecutor,
  userId: string,
  options: { readonly includeReleased: boolean },
): Promise<readonly CashEarmark[]> {
  const result = await executor.execute<EarmarkRaw>(sql`
    SELECT ${EARMARK_COLUMNS} FROM cash_earmarks
     WHERE user_id = ${userId}::uuid
       AND (${options.includeReleased} OR released_at IS NULL)
     ORDER BY created_at, id
  `);
  return result.rows.map(earmarkOf);
}

/**
 * Release a live earmark. Guarded on `released_at IS NULL` as well as on the
 * caller, so a second release is a zero-row UPDATE — `null` — and not a second
 * timestamp overwriting the first.
 */
export async function releaseEarmarkRow(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly earmarkId: string; readonly now: Date },
): Promise<CashEarmark | null> {
  if (!isUuid(input.earmarkId)) return null;
  const now = input.now.toISOString();
  const result = await executor.execute<EarmarkRaw>(sql`
    UPDATE cash_earmarks
       SET released_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     WHERE id = ${input.earmarkId}::uuid
       AND user_id = ${input.userId}::uuid
       AND released_at IS NULL
    RETURNING ${EARMARK_COLUMNS}
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : earmarkOf(raw);
}
