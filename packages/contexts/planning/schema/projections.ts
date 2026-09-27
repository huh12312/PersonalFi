// SPDX-License-Identifier: MIT
/**
 * Drizzle definitions for WP 4.6's four tables (migration 0022).
 *
 * The *type* and the claim `pnpm lint:schema-ownership` reads;
 * `0022_plan_projections.sql` is the schema. The constraints that carry the
 * load have no Drizzle expression and are not restated here:
 *
 *   * `plan_scenarios_shape` and `plan_scenarios_levers_are_deltas` — a fork
 *     holds 07 §5.10 lever deltas and nothing else, never a copy of the plan;
 *   * `plan_scenarios_seed_is_the_baselines` — common random numbers by
 *     construction: a fork has no seed of its own;
 *   * `projection_runs_cache_key_idx` and the NOT NULL + shape CHECK on each of
 *     `seed`, `engine_version`, `assumptions_version`, `input_digest`;
 *   * `projection_runs_are_immutable` / `projection_percentiles_are_immutable`
 *     — a stored run never changes (D20);
 *   * the composite `(…, user_id)` foreign keys, 0020's rule.
 *
 * Every amount is `amountMinorColumn` + a currency (D3). `seed` is
 * `numeric(20, 0)` in string mode — an unsigned 64-bit seed does not fit a
 * signed BIGINT — and `success_probability` is `numeric(7, 6)` in string mode:
 * a decimal string in and out, never a JS `number`.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const SCENARIO_KINDS = ['baseline', 'fork'] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const PROJECTION_METHODS = ['deterministic', 'monte_carlo'] as const;
export type ProjectionMethod = (typeof PROJECTION_METHODS)[number];

export const LIFE_EVENT_KINDS = [
  'inheritance',
  'home_purchase',
  'college',
  'sabbatical',
  'windfall',
  'other',
] as const;
export type LifeEventKind = (typeof LIFE_EVENT_KINDS)[number];

export const planScenarios = pgTable('plan_scenarios', {
  id: idColumn(),
  userId: userIdColumn(),
  kind: text('kind').notNull(),
  baselineId: uuid('baseline_id'),
  name: text('name').notNull(),
  profile: jsonb('profile'),
  levers: jsonb('levers'),
  seed: numeric('seed', { precision: 20, scale: 0, mode: 'string' }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const planLifeEvents = pgTable('plan_life_events', {
  id: idColumn(),
  userId: userIdColumn(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  occursOn: dateColumn('occurs_on').notNull(),
  amountMinor: amountMinorColumn('amount_minor').notNull(),
  currency: currencyColumn('currency').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const projectionRuns = pgTable('projection_runs', {
  id: idColumn(),
  userId: userIdColumn(),
  scenarioId: uuid('scenario_id').notNull(),
  scenarioKind: text('scenario_kind').notNull(),
  method: text('method').notNull(),
  cacheKey: text('cache_key').notNull(),
  seed: numeric('seed', { precision: 20, scale: 0, mode: 'string' }).notNull(),
  engineVersion: text('engine_version').notNull(),
  assumptionsVersion: text('assumptions_version').notNull(),
  assumptionsOverrides: jsonb('assumptions_overrides').notNull().default({}),
  inputDigest: text('input_digest').notNull(),
  input: jsonb('input').notNull(),
  paths: integer('paths').notNull(),
  asOfDate: dateColumn('as_of_date').notNull(),
  balancesSealed: flagColumn('balances_sealed').notNull(),
  currency: currencyColumn('currency').notNull(),
  successProbability: numeric('success_probability', {
    precision: 7,
    scale: 6,
    mode: 'string',
  }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  goalsEvaluatedAt: instantColumn('goals_evaluated_at'),
  createdAt: createdAtColumn(),
});

export const projectionPercentiles = pgTable('projection_percentiles', {
  runId: uuid('run_id').notNull(),
  userId: userIdColumn(),
  periodIndex: integer('period_index').notNull(),
  age: integer('age').notNull(),
  calendarYear: integer('calendar_year').notNull(),
  currency: currencyColumn('currency').notNull(),
  p5Minor: amountMinorColumn('p5_minor'),
  p10Minor: amountMinorColumn('p10_minor'),
  p25Minor: amountMinorColumn('p25_minor'),
  p50Minor: amountMinorColumn('p50_minor').notNull(),
  p75Minor: amountMinorColumn('p75_minor'),
  p90Minor: amountMinorColumn('p90_minor'),
  p95Minor: amountMinorColumn('p95_minor'),
});
