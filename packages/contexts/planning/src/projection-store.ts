// SPDX-License-Identifier: MIT
/**
 * The sole writer of `projection_runs` and `projection_percentiles`, and WP
 * 4.6's typed refusals (migration 0022).
 *
 * Raw parameterised SQL, for `src/store.ts`'s reason: every statement here
 * carries a rule the query builder cannot express — `ON CONFLICT (user_id,
 * cache_key) DO NOTHING` against the cache index, a `goals_evaluated_at IS
 * NULL` guard whose **row count is the check**, and `DISTINCT ON` over the
 * revision ladder of `net_worth_daily`.
 *
 * ## Two write paths, and only two
 *
 *   * `insertRun` — a run and its bands, in the caller's transaction. Loses a
 *     race gracefully: a concurrent identical request that committed first owns
 *     the cache key, and this call returns *that* row with `inserted: false`
 *     rather than a unique violation, so the caller serves the winner and emits
 *     nothing.
 *   * `claimGoalEvaluation` — the one-way stamp of `goals_evaluated_at`.
 *     `projection_runs_are_immutable` refuses every other UPDATE; this is the
 *     one the trigger lets through, once.
 *
 * There is no path that updates a run's numbers. A run whose assumptions
 * version no longer resolves is *read back* stale by `projection-service.ts`;
 * nothing here could recompute it in place even if something tried.
 */
import { DateOnly, Money, type Clock, type DateOnly as DateOnlyType } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { BreakdownEntry } from './net-worth.ts';
import type { PlanningExecutor } from './store.ts';
import type { ProjectionMethod, ScenarioKind } from '../schema/projections.ts';

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * WP 4.6's codes, each with its HTTP status and family **beside it** — the
 * `errors.ts` pattern, so WP 4.8's problem mapping needs no judgement of its
 * own. `domain` 409 is a state refusal, 422 a content refusal; `user` 400/404
 * is malformed input or not-yours (the same 404, so a probe cannot learn that
 * another holder's scenario exists).
 */
export type ProjectionRefusalCodeWp46 =
  | 'planning.scenario_not_found'
  | 'planning.scenario_invalid'
  | 'planning.scenario_no_baseline'
  | 'planning.scenario_levers_empty'
  | 'planning.scenario_lever_invalid'
  | 'planning.scenario_fork_of_fork'
  | 'planning.scenario_baseline_not_deletable'
  | 'planning.scenario_income_unknown'
  | 'planning.life_event_not_found'
  | 'planning.life_event_invalid'
  | 'planning.life_event_sign_mismatch'
  | 'planning.projection_not_found'
  | 'planning.projection_no_balances'
  | 'planning.projection_balances_unsealed'
  | 'planning.projection_spending_unknown'
  | 'planning.projection_paths_invalid'
  | 'planning.projection_assumptions_stale'
  | 'planning.monte_carlo_unavailable'
  | 'planning.monte_carlo_outcome_mismatch'
  | 'planning.projection_run_incomplete';

export interface ProjectionRefusalStatus {
  readonly status: 400 | 404 | 409 | 422 | 500;
  readonly family: 'user' | 'domain' | 'internal';
}

export const PROJECTION_REFUSAL_STATUS: Readonly<
  Record<ProjectionRefusalCodeWp46, ProjectionRefusalStatus>
> = Object.freeze({
  'planning.scenario_not_found': { status: 404, family: 'user' },
  'planning.scenario_invalid': { status: 400, family: 'user' },
  'planning.scenario_no_baseline': { status: 409, family: 'domain' },
  'planning.scenario_levers_empty': { status: 422, family: 'domain' },
  'planning.scenario_lever_invalid': { status: 422, family: 'domain' },
  'planning.scenario_fork_of_fork': { status: 422, family: 'domain' },
  'planning.scenario_baseline_not_deletable': { status: 409, family: 'domain' },
  'planning.scenario_income_unknown': { status: 422, family: 'domain' },
  'planning.life_event_not_found': { status: 404, family: 'user' },
  'planning.life_event_invalid': { status: 400, family: 'user' },
  'planning.life_event_sign_mismatch': { status: 422, family: 'domain' },
  'planning.projection_not_found': { status: 404, family: 'user' },
  'planning.projection_no_balances': { status: 409, family: 'domain' },
  'planning.projection_balances_unsealed': { status: 409, family: 'domain' },
  'planning.projection_spending_unknown': { status: 422, family: 'domain' },
  'planning.projection_paths_invalid': { status: 422, family: 'domain' },
  // The holder's overrides name an assumptions version this build no longer
  // holds. 409: the request is fine, the *state* refuses it — and the answer
  // is to re-save the overrides against today's file, never to drop them.
  'planning.projection_assumptions_stale': { status: 409, family: 'domain' },
  // No Monte Carlo is bound (WP 4.5 not yet wired). A state of the install.
  'planning.monte_carlo_unavailable': { status: 409, family: 'domain' },
  // The runner answered a different seed, path count or engine than it was
  // asked. That is a bug on the other side of the port, and it is ours.
  'planning.monte_carlo_outcome_mismatch': { status: 500, family: 'internal' },
  'planning.projection_run_incomplete': { status: 500, family: 'internal' },
});

export class ProjectionRefused extends Error {
  override readonly name = 'ProjectionRefused';
  readonly code: ProjectionRefusalCodeWp46;
  readonly status: ProjectionRefusalStatus['status'];
  readonly family: ProjectionRefusalStatus['family'];

  constructor(code: ProjectionRefusalCodeWp46, message: string) {
    super(message);
    this.code = code;
    const { status, family } = PROJECTION_REFUSAL_STATUS[code];
    this.status = status;
    this.family = family;
  }
}

/** A predicate rather than `instanceof`, for the reason `isAssumptionsRefusal` gives. */
export function isProjectionRefused(error: unknown): error is ProjectionRefused {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && code in PROJECTION_REFUSAL_STATUS;
}

// ---------------------------------------------------------------------------
// projection_runs
// ---------------------------------------------------------------------------

/** One band row, Money in and out. The six outer bands are `null` on a deterministic run. */
export interface StoredPercentile {
  readonly index: number;
  readonly age: number;
  readonly calendarYear: number;
  readonly p5: Money | null;
  readonly p10: Money | null;
  readonly p25: Money | null;
  readonly p50: Money;
  readonly p75: Money | null;
  readonly p90: Money | null;
  readonly p95: Money | null;
}

/** Everything a run row says, in the shape this context reasons about. */
export interface StoredRun {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioKind: ScenarioKind;
  readonly method: ProjectionMethod;
  readonly cacheKey: string;
  readonly seed: bigint;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly assumptionsOverrides: Readonly<Record<string, string>>;
  readonly inputDigest: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly paths: number;
  readonly asOfDate: DateOnlyType;
  readonly balancesSealed: boolean;
  readonly currency: string;
  /** A decimal string with six places, exactly as NUMERIC(7,6) returns it. */
  readonly successProbability: string;
  readonly durationMs: number;
  readonly goalsEvaluatedAt: Date | null;
  readonly createdAt: Date;
}

/** What `insertRun` is handed. Every cache-key input is required by type *and* by NOT NULL. */
export interface NewRun {
  readonly id: string;
  readonly userId: string;
  readonly scenarioId: string;
  readonly scenarioKind: ScenarioKind;
  readonly method: ProjectionMethod;
  readonly cacheKey: string;
  readonly seed: bigint;
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly assumptionsOverrides: Readonly<Record<string, string>>;
  readonly inputDigest: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly paths: number;
  readonly asOfDate: DateOnlyType;
  readonly balancesSealed: boolean;
  readonly currency: string;
  readonly successProbability: string;
  readonly durationMs: number;
  readonly percentiles: readonly StoredPercentile[];
  readonly createdAt: Date;
}

interface RawRun extends Record<string, unknown> {
  id: string;
  scenario_id: string;
  scenario_kind: string;
  method: string;
  cache_key: string;
  seed: string | bigint;
  engine_version: string;
  assumptions_version: string;
  assumptions_overrides: unknown;
  input_digest: string;
  input: unknown;
  paths: number;
  as_of_date: string;
  balances_sealed: boolean;
  currency: string;
  success_probability: string;
  duration_ms: number;
  goals_evaluated_at: Date | string | null;
  created_at: Date | string;
}

const RUN_COLUMNS = sql`
  id, scenario_id, scenario_kind, method, cache_key, seed::text AS seed, engine_version,
  assumptions_version, assumptions_overrides, input_digest, input, paths, as_of_date,
  balances_sealed, currency, success_probability::text AS success_probability, duration_ms,
  goals_evaluated_at, created_at
`;

function runOf(raw: RawRun): StoredRun {
  return Object.freeze({
    id: raw.id,
    scenarioId: raw.scenario_id,
    scenarioKind: raw.scenario_kind as ScenarioKind,
    method: raw.method as ProjectionMethod,
    cacheKey: raw.cache_key,
    seed: BigInt(raw.seed),
    engineVersion: raw.engine_version,
    assumptionsVersion: raw.assumptions_version,
    assumptionsOverrides: Object.freeze({
      ...(raw.assumptions_overrides as Record<string, string>),
    }),
    inputDigest: raw.input_digest,
    input: raw.input as Record<string, unknown>,
    paths: Number(raw.paths),
    asOfDate: DateOnly.parse(String(raw.as_of_date).slice(0, 10)),
    balancesSealed: raw.balances_sealed,
    currency: raw.currency.trim(),
    successProbability: raw.success_probability,
    durationMs: Number(raw.duration_ms),
    goalsEvaluatedAt: raw.goals_evaluated_at === null ? null : new Date(raw.goals_evaluated_at),
    createdAt: new Date(raw.created_at),
  });
}

/**
 * Refuse a run that is missing a cache-key input *before* the database does.
 *
 * The NOT NULL and shape CHECKs in 0022 are the backstop and the test proves
 * them directly; this is the same rule one layer earlier so the refusal names
 * the field in words rather than as a 23502.
 */
function assertComplete(run: NewRun): void {
  const missing: string[] = [];
  if (typeof run.seed !== 'bigint' || run.seed < 0n || run.seed >= 1n << 64n) missing.push('seed');
  if (typeof run.engineVersion !== 'string' || run.engineVersion.trim() === '') {
    missing.push('engine_version');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(run.assumptionsVersion))) {
    missing.push('assumptions_version');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(run.inputDigest))) missing.push('input_digest');
  if (missing.length > 0) {
    throw new ProjectionRefused(
      'planning.projection_run_incomplete',
      `a projection run must record ${missing.join(', ')}; without it the run is not reproducible ` +
        'and "why did it say this?" has no answer (07 §7.3)',
    );
  }
}

/** The run a cache key already names, or `null`. Scoped by `user_id`. */
export async function findRunByCacheKey(
  executor: PlanningExecutor,
  userId: string,
  cacheKey: string,
): Promise<StoredRun | null> {
  const result = await executor.execute<RawRun>(sql`
    SELECT ${RUN_COLUMNS} FROM projection_runs
     WHERE user_id = ${userId}::uuid AND cache_key = ${cacheKey}
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : runOf(raw);
}

/** One run by id, or `null` — "not yours" and "does not exist" are the same answer. */
export async function findRun(
  executor: PlanningExecutor,
  userId: string,
  runId: string,
): Promise<StoredRun | null> {
  const result = await executor.execute<RawRun>(sql`
    SELECT ${RUN_COLUMNS} FROM projection_runs
     WHERE user_id = ${userId}::uuid AND id = ${runId}::uuid
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : runOf(raw);
}

/** The newest run of a scenario (optionally of one method), or `null`. */
export async function latestRunForScenario(
  executor: PlanningExecutor,
  userId: string,
  scenarioId: string,
  method?: ProjectionMethod,
): Promise<StoredRun | null> {
  const result = await executor.execute<RawRun>(sql`
    SELECT ${RUN_COLUMNS} FROM projection_runs
     WHERE user_id = ${userId}::uuid AND scenario_id = ${scenarioId}::uuid
       AND (${method ?? null}::text IS NULL OR method = ${method ?? null}::text)
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : runOf(raw);
}

interface RawPercentile extends Record<string, unknown> {
  period_index: number;
  age: number;
  calendar_year: number;
  currency: string;
  p5_minor: string | bigint | null;
  p10_minor: string | bigint | null;
  p25_minor: string | bigint | null;
  p50_minor: string | bigint;
  p75_minor: string | bigint | null;
  p90_minor: string | bigint | null;
  p95_minor: string | bigint | null;
}

/** A run's bands, in period order. */
export async function percentilesOf(
  executor: PlanningExecutor,
  userId: string,
  runId: string,
): Promise<readonly StoredPercentile[]> {
  const result = await executor.execute<RawPercentile>(sql`
    SELECT period_index, age, calendar_year, currency,
           p5_minor, p10_minor, p25_minor, p50_minor, p75_minor, p90_minor, p95_minor
      FROM projection_percentiles
     WHERE user_id = ${userId}::uuid AND run_id = ${runId}::uuid
     ORDER BY period_index
  `);
  return result.rows.map((raw) => {
    const code = raw.currency.trim();
    const band = (minor: string | bigint | null): Money | null =>
      minor === null ? null : Money.of(BigInt(minor), code);
    return Object.freeze({
      index: Number(raw.period_index),
      age: Number(raw.age),
      calendarYear: Number(raw.calendar_year),
      p5: band(raw.p5_minor),
      p10: band(raw.p10_minor),
      p25: band(raw.p25_minor),
      p50: Money.of(BigInt(raw.p50_minor), code),
      p75: band(raw.p75_minor),
      p90: band(raw.p90_minor),
      p95: band(raw.p95_minor),
    });
  });
}

/**
 * Store a run and its bands. Idempotent on `(user_id, cache_key)`.
 *
 * `inserted: false` means a concurrent identical request committed first; the
 * returned run is **that** row, and the caller must serve it and emit nothing.
 */
export async function insertRun(
  executor: PlanningExecutor,
  run: NewRun,
): Promise<{ readonly inserted: boolean; readonly run: StoredRun }> {
  assertComplete(run);
  const result = await executor.execute<RawRun>(sql`
    INSERT INTO projection_runs (
      id, user_id, scenario_id, scenario_kind, method, cache_key, seed, engine_version,
      assumptions_version, assumptions_overrides, input_digest, input, paths, as_of_date,
      balances_sealed, currency, success_probability, duration_ms, created_at
    ) VALUES (
      ${run.id}::uuid, ${run.userId}::uuid, ${run.scenarioId}::uuid, ${run.scenarioKind},
      ${run.method}, ${run.cacheKey}, ${run.seed.toString()}::numeric, ${run.engineVersion},
      ${run.assumptionsVersion}, ${JSON.stringify(run.assumptionsOverrides)}::jsonb,
      ${run.inputDigest}, ${JSON.stringify(run.input)}::jsonb, ${run.paths},
      ${run.asOfDate}::date, ${run.balancesSealed}, ${run.currency},
      ${run.successProbability}::numeric, ${run.durationMs},
      ${run.createdAt.toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, cache_key) DO NOTHING
    RETURNING ${RUN_COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) {
    const winner = await findRunByCacheKey(executor, run.userId, run.cacheKey);
    if (winner === null) {
      throw new Error(`projection_runs: cache key ${run.cacheKey} conflicted and then vanished`);
    }
    return { inserted: false, run: winner };
  }
  for (const band of run.percentiles) {
    const minor = (money: Money | null): string | null =>
      money === null ? null : money.minor.toString();
    await executor.execute(sql`
      INSERT INTO projection_percentiles (
        run_id, user_id, period_index, age, calendar_year, currency,
        p5_minor, p10_minor, p25_minor, p50_minor, p75_minor, p90_minor, p95_minor
      ) VALUES (
        ${run.id}::uuid, ${run.userId}::uuid, ${band.index}, ${band.age}, ${band.calendarYear},
        ${run.currency},
        ${minor(band.p5)}::bigint, ${minor(band.p10)}::bigint, ${minor(band.p25)}::bigint,
        ${band.p50.minor.toString()}::bigint, ${minor(band.p75)}::bigint,
        ${minor(band.p90)}::bigint, ${minor(band.p95)}::bigint
      )
    `);
  }
  return { inserted: true, run: runOf(raw) };
}

/**
 * Claim a run's R6 evaluation. `true` exactly once per run, ever.
 *
 * The `goals_evaluated_at IS NULL` guard is the whole control: two deliveries
 * of the same `ProjectionCompleted` — a redelivery after a failed offset
 * commit, a replay from 0 after a consumer version bump — race for one row, the
 * row lock serialises them, and the loser's UPDATE matches nothing. Scoped by
 * `user_id` so an event naming another holder's run claims nothing.
 */
export async function claimGoalEvaluation(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly runId: string; readonly clock: Clock },
): Promise<boolean> {
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE projection_runs
       SET goals_evaluated_at = ${input.clock.now().toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid
       AND id = ${input.runId}::uuid
       AND goals_evaluated_at IS NULL
    RETURNING id
  `);
  return result.rows.length === 1;
}

// ---------------------------------------------------------------------------
// net_worth_daily, as the projection reads it (this context's own table)
// ---------------------------------------------------------------------------

/** One day's current revision, with the per-account breakdown the projection needs. */
export interface BalancesDay {
  readonly asOfDate: DateOnlyType;
  readonly revision: number;
  readonly sealed: boolean;
  readonly baseCurrency: string;
  readonly breakdown: readonly BreakdownEntry[];
}

interface RawDay extends Record<string, unknown> {
  as_of_date: string;
  revision: number;
  sealed: boolean;
  base_currency: string;
  breakdown: unknown;
}

function dayOf(raw: RawDay): BalancesDay {
  return Object.freeze({
    asOfDate: DateOnly.parse(String(raw.as_of_date).slice(0, 10)),
    revision: Number(raw.revision),
    sealed: raw.sealed,
    baseCurrency: raw.base_currency.trim(),
    breakdown: raw.breakdown as BreakdownEntry[],
  });
}

/**
 * The current revision of `asOf`, or — with no date — the newest **sealed** day.
 *
 * The dispatch's §5 risk row: a projection's starting balances come from the
 * sealed row for its date, never the live open day, so a saved projection
 * stays reproducible after a re-sync moves today. The open day is returned only
 * when it is asked for by date; the caller decides whether that is allowed.
 */
export async function balancesDay(
  executor: PlanningExecutor,
  userId: string,
  asOf: DateOnlyType | null,
): Promise<BalancesDay | null> {
  const result =
    asOf === null
      ? await executor.execute<RawDay>(sql`
          SELECT as_of_date, revision, sealed_at IS NOT NULL AS sealed, base_currency, breakdown
            FROM net_worth_daily
           WHERE user_id = ${userId}::uuid AND sealed_at IS NOT NULL
           ORDER BY as_of_date DESC, revision DESC
           LIMIT 1
        `)
      : await executor.execute<RawDay>(sql`
          SELECT as_of_date, revision, sealed_at IS NOT NULL AS sealed, base_currency, breakdown
            FROM net_worth_daily
           WHERE user_id = ${userId}::uuid AND as_of_date = ${asOf}::date
           ORDER BY revision DESC
           LIMIT 1
        `);
  const raw = result.rows[0];
  return raw === undefined ? null : dayOf(raw);
}
