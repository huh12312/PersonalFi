// SPDX-License-Identifier: MIT
/**
 * Drizzle definitions for WP 4.1's four tables (migration 0020).
 *
 * As with `net_worth_daily`, these are the *type* and the claim that
 * `pnpm lint:schema-ownership` reads; `0020_planning_goals.sql` is the schema.
 * The constraints that carry the load have no Drizzle expression and are not
 * re-stated here:
 *
 *   * `goal_contributions_goal_is_the_same_users` and
 *     `cash_earmarks_goal_is_the_same_users` — composite foreign keys on
 *     `(goal_id, user_id)` against `goals_id_user_key`, so a child row can
 *     never be one holder's while pointing at another holder's goal;
 *   * `risk_profile_penalty_is_the_difference` and
 *     `risk_profile_answers_are_well_formed`;
 *   * `goals_one_live_retirement_idx`.
 *
 * Every amount is `amountMinorColumn` + `currencyColumn` (D3). The one rate,
 * `escalation_pct`, is `numeric(..., { mode: 'string' })`: a decimal string in
 * and out, never a JS `number`.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { jsonb, numeric, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';

export const GOAL_KINDS = [
  'retirement',
  'emergency_fund',
  'purchase',
  'sabbatical',
  'custom',
] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const CONTRIBUTION_CADENCES = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annually',
] as const;
export type ContributionCadence = (typeof CONTRIBUTION_CADENCES)[number];

/** 09 GOAL-4: derived from observed transfers, or typed by the holder. */
export const CONTRIBUTION_SOURCES = ['DERIVED', 'USER'] as const;
export type ContributionSource = (typeof CONTRIBUTION_SOURCES)[number];

export const RISK_TOLERANCES = [
  'conservative',
  'moderate_conservative',
  'moderate',
  'moderate_aggressive',
  'aggressive',
] as const;
export type RiskTolerance = (typeof RISK_TOLERANCES)[number];

export const LIQUIDITY_NEEDS = ['low', 'medium', 'high'] as const;
export type LiquidityNeed = (typeof LIQUIDITY_NEEDS)[number];

export const goals = pgTable('goals', {
  id: idColumn(),
  userId: userIdColumn(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  targetMinor: amountMinorColumn('target_minor').notNull(),
  currency: currencyColumn('currency').notNull(),
  targetDate: dateColumn('target_date').notNull(),
  priority: smallint('priority').notNull().default(3),
  fundedFromAccountIds: uuid('funded_from_account_ids').array().notNull().default([]),
  status: text('status').notNull().default('active'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const goalContributions = pgTable('goal_contributions', {
  id: idColumn(),
  userId: userIdColumn(),
  goalId: uuid('goal_id').notNull(),
  cadence: text('cadence').notNull(),
  amountMinor: amountMinorColumn('amount_minor').notNull(),
  currency: currencyColumn('currency').notNull(),
  escalationPct: numeric('escalation_pct', { precision: 7, scale: 4, mode: 'string' })
    .notNull()
    .default('0'),
  startsOn: dateColumn('starts_on').notNull(),
  endsOn: dateColumn('ends_on'),
  source: text('source').notNull(),
  derivedAsOf: dateColumn('derived_as_of'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const riskProfile = pgTable('risk_profile', {
  id: idColumn(),
  userId: userIdColumn(),
  tolerance: text('tolerance').notNull(),
  compositeScore: smallint('composite_score').notNull(),
  unpenalisedScore: smallint('unpenalised_score').notNull(),
  consistencyPenalty: smallint('consistency_penalty').notNull(),
  horizonYears: smallint('horizon_years').notNull(),
  taxBracketBand: text('tax_bracket_band'),
  liquidityNeed: text('liquidity_need').notNull(),
  answers: jsonb('answers').notNull(),
  answeredAt: instantColumn('answered_at').notNull(),
  createdAt: createdAtColumn(),
});

export const cashEarmarks = pgTable('cash_earmarks', {
  id: idColumn(),
  userId: userIdColumn(),
  goalId: uuid('goal_id').notNull(),
  accountId: uuid('account_id').notNull(),
  name: text('name').notNull(),
  amountMinor: amountMinorColumn('amount_minor').notNull(),
  currency: currencyColumn('currency').notNull(),
  releasedAt: instantColumn('released_at'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
