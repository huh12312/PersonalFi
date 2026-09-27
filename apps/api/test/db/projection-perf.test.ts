// SPDX-License-Identifier: MIT
/**
 * WP 4.13 — the **whole-path** halves of the 08 §7.1/§7.2 budgets, over the
 * scale seed, on real Postgres.
 *
 * The engine-alone half of the Monte Carlo budget already has its own file
 * (`packages/contexts/planning/src/engine/perf.test.ts`, WP 4.5, isolated in
 * the `planning-perf` project): `runJobInWorker` from call to reply, no HTTP,
 * no database. This file measures the *other* thing — everything a real
 * request costs on top of that: `@ctx/planning`'s own `runProjection`
 * (scenario/baseline reads, the cache-key assembly, the Monte Carlo run
 * through a real `worker_thread`, the stored-run insert and its event) driven
 * over `ApiHarness`'s real Postgres, and `GET /net-worth/series` over real
 * `fetch()` — the `investments-perf.test.ts` / `phase2-reports-http-perf.test.ts`
 * pattern this repository already uses for a whole-path budget.
 *
 * ## Why the projection half is not `fetch()`, unlike the net-worth half
 *
 * The dispatch's exit test name is
 * `'POST /plan/scenarios/{id}/projections p95 is within budget over real HTTP'`
 * — that route is WP 4.8's, and **does not exist yet**. Driving it over HTTP
 * is impossible today, so this test calls `@ctx/planning`'s `runProjection`
 * directly against this harness's Postgres instead: every read and write the
 * route would make (`plan_scenarios`, `net_worth_daily`, `projection_runs`,
 * `projection_percentiles`, the domain event) happens for real, over the same
 * connection pool a route would use — only the Fastify routing/auth/
 * serialisation layer is absent. The test's *name* is kept exactly as the
 * dispatch wrote it, because that is the claim WP 4.8 inherits and must keep
 * true once it binds the route: "For the orchestrator" below says so again.
 *
 * ## Why the projection isn't cached across samples
 *
 * `runProjection` caches by `hash(assumptions + engine_version + seed +
 * input)` (WP 4.6) and serves a repeat request from `projection_runs` without
 * running the engine at all — exactly the behaviour
 * `wp4.6-projection-service.md` §2 proves. Timing that would measure a cache
 * hit, not the budget. So every sample is a **fresh fork** of the same
 * baseline with a one-dollar-larger `annual_spending` lever than the last —
 * `diffLevers` never drops it (the baseline states no `annualSpending` of its
 * own, so every stated fork value is kept), which gives every sample its own
 * `input_digest` and therefore its own Monte Carlo run, deterministically,
 * with no `Math.random()` anywhere in the loop.
 *
 * ## Row counts before timing
 *
 * `net_worth_daily` is asserted at exactly 1,825 rows, and the goals/life
 * events the scale seed's plan carries are asserted present, before either
 * timer starts — a perf number over an empty table is a lie, and
 * `docs/TESTING.md` already says so.
 */
import { DateOnly, Money, newId, systemClock, type Clock } from '@core/kernel';
import { generatePhase4Scale, type ScaleNetWorthDailyPoint } from '@core/seed';
import {
  ENGINE_VERSION,
  addContribution,
  createGoal,
  createLifeEvent,
  createScenario,
  currentRegistry,
  runMonteCarloInWorker,
  runProjection,
  saveBaseline,
  type BaselineProfile,
  type BreakdownEntry,
  type FundingAccountsReader,
  type MonteCarloOutcome,
  type MonteCarloPeriod,
  type MonteCarloRequest,
  type MonteCarloRunner,
  type ProjectionBucket,
  type ProjectionInputsReader,
  type ProjectionServiceDependencies,
  type ReturnSeries,
} from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

/** 08 §7.2 / dispatch §5: the same budget the engine-alone test measures. */
const PROJECTION_BUDGET_MS = 800;
/** 08 §7.1: "net worth chart, 5 years daily (1,825 points), p95 <= 150 ms". */
const NET_WORTH_BUDGET_MS = 150;
const WARMUP_COUNT = 3;
const SAMPLE_COUNT = 12;
/** The real Shiller window's length (WP 4.5's own perf test uses the same figure). */
const RETURN_SERIES_MONTHS = 1_847;

// ---------------------------------------------------------------------------
// A synthetic monthly return series — never Shiller's (fetched, git-ignored,
// licensed; WP 4.5's own perf test avoids it for the same reason), of the
// real window's length so the bootstrap indexes a table of the real size.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function syntheticReturnSeries(months: number, seed: number): ReturnSeries {
  const rng = mulberry32(seed);
  const equityReal = new Float64Array(months);
  const bondReal = new Float64Array(months);
  const inflation = new Float64Array(months);
  for (let i = 0; i < months; i += 1) {
    equityReal[i] = 0.0055 + 0.041 * (rng() * 2 - 1);
    bondReal[i] = 0.0019 + 0.018 * (rng() * 2 - 1);
    inflation[i] = 0.0017 + 0.006 * (rng() * 2 - 1);
  }
  return {
    id: `synthetic/projection-perf-${String(months)}-months`,
    sha256: '0'.repeat(64),
    firstMonth: '1871-02',
    equityReal,
    bondReal,
    inflation,
  };
}

// ---------------------------------------------------------------------------
// The Monte Carlo runner, over WP 4.5's real worker host
// ---------------------------------------------------------------------------

/**
 * `@ctx/planning`'s `MonteCarloRunner` port, bound to WP 4.5's real
 * `runMonteCarloInWorker` — a fresh `worker_thread` per run, exactly as
 * production would. `apps/api/src/domain.ts` does not bind this port yet
 * (see "For the orchestrator" below); this is that binding's shape, built
 * here only because this test needs a real one to measure a real budget.
 */
function monteCarloRunnerOverWorker(series: ReturnSeries): MonteCarloRunner {
  return {
    engineVersion: ENGINE_VERSION,
    async run(request: MonteCarloRequest): Promise<MonteCarloOutcome> {
      const run = await runMonteCarloInWorker({
        plan: request.plan,
        assumptions: request.assumptions,
        seed: request.seed,
        paths: request.paths,
        engine: 'bootstrap',
        series,
        // The port `runProjection` calls through carries no crypto figure
        // (`ports.ts`'s `MonteCarloRequest` has `plan`/`assumptions`/`seed`/
        // `paths` only) — an open item, named in the evidence, not this
        // test's to invent.
        cryptoHolding: null,
      });
      const summary = run.summary;
      const years = summary.bands[3]?.byYear.length ?? 0; // index 3 = p50; every band is the same length
      const periods: MonteCarloPeriod[] = [];
      for (let year = 0; year < years; year += 1) {
        periods.push({
          index: year,
          age: summary.startAge + year,
          calendarYear: summary.startYear + year,
          // `PERCENTILE_LEVELS` order is fixed (0.05, 0.10, 0.25, 0.50, 0.75,
          // 0.90, 0.95) — positional, never string-matched against
          // `canonicalDecimal`'s trailing-zero-stripped level text.
          p5: summary.bands[0]?.byYear[year] as Money,
          p10: summary.bands[1]?.byYear[year] as Money,
          p25: summary.bands[2]?.byYear[year] as Money,
          p50: summary.bands[3]?.byYear[year] as Money,
          p75: summary.bands[4]?.byYear[year] as Money,
          p90: summary.bands[5]?.byYear[year] as Money,
          p95: summary.bands[6]?.byYear[year] as Money,
        });
      }
      return {
        engineVersion: summary.engineVersion,
        seed: summary.seed,
        paths: summary.paths,
        successProbability: summary.successProbability,
        periods,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A `ProjectionInputsReader` over the scale seed's own net_worth_daily row
// ---------------------------------------------------------------------------

interface SealedDay {
  readonly asOfDate: string;
  readonly revision: number;
  readonly sealed: boolean;
  readonly baseCurrency: string;
  readonly breakdown: readonly BreakdownEntry[];
}

/**
 * The newest sealed day, read the same way `@ctx/planning`'s own
 * `balancesDay` does (same table, same columns) — not exported past that
 * package's public surface, so this is a small, direct read against a table
 * this file also writes to, in the `investments-perf.test.ts` tradition of
 * reading a context's table directly in a perf harness rather than growing a
 * second public export for one test.
 */
async function newestSealedDay(
  db: ApiHarness['database']['db'],
  userId: string,
): Promise<SealedDay> {
  const result = await db.execute<{
    as_of_date: string;
    revision: number;
    sealed: boolean;
    base_currency: string;
    breakdown: unknown;
  }>(sql`
    SELECT as_of_date, revision, sealed_at IS NOT NULL AS sealed, base_currency, breakdown
      FROM net_worth_daily
     WHERE user_id = ${userId}::uuid AND sealed_at IS NOT NULL
     ORDER BY as_of_date DESC, revision DESC
     LIMIT 1
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('no sealed net_worth_daily row for the scale seed');
  return {
    asOfDate: String(raw.as_of_date).slice(0, 10),
    revision: Number(raw.revision),
    sealed: raw.sealed,
    baseCurrency: raw.base_currency.trim(),
    breakdown: raw.breakdown as BreakdownEntry[],
  };
}

/**
 * A `ProjectionInputsReader` whose **balances** are real — read from this
 * harness's `net_worth_daily` — and whose contributions/income/spending are
 * literals. Deriving those from twelve months of real transactions is WP
 * 4.3's own scope and its own suite (`revealed-ports.test.ts`); building that
 * ledger history at 200-position scale here would time a different budget
 * than the one this file is named for.
 */
function scaleInputsReader(
  db: ApiHarness['database']['db'],
  userId: string,
  bucketOf: ReadonlyMap<string, ProjectionBucket>,
): ProjectionInputsReader {
  return {
    async derivedInputs(input) {
      if (input.asOf !== null) {
        throw new Error(
          'this reader only serves the newest sealed day (the test never asks for another)',
        );
      }
      const day = await newestSealedDay(db, userId);
      if (!day.sealed && !input.allowOpenDay) {
        throw new Error(`${day.asOfDate} is not sealed and allowOpenDay was not asked for`);
      }
      const zero = Money.zero(day.baseCurrency);
      const byBucket: Record<ProjectionBucket, Money> = {
        TAXABLE: zero,
        TAX_DEFERRED: zero,
        ROTH: zero,
        HSA: zero,
      };
      for (const entry of day.breakdown) {
        if (entry.side !== 'asset' || !entry.inNetWorth) continue;
        const bucket = bucketOf.get(entry.accountId);
        if (bucket === undefined) continue;
        byBucket[bucket] = Money.add(
          byBucket[bucket],
          Money.of(BigInt(entry.baseMinor), day.baseCurrency),
        );
      }
      return {
        currency: day.baseCurrency,
        balances: {
          asOfDate: DateOnly.parse(day.asOfDate),
          revision: day.revision,
          sealed: day.sealed,
          byBucket,
        },
        contributions: {
          TAXABLE: Money.parseAmount('12000', day.baseCurrency),
          TAX_DEFERRED: Money.parseAmount('23000', day.baseCurrency),
          ROTH: Money.parseAmount('7000', day.baseCurrency),
          HSA: Money.zero(day.baseCurrency),
        },
        annualIncome: Money.parseAmount('180000', day.baseCurrency),
        nonSavingsSpending: Money.parseAmount('96000', day.baseCurrency),
        essentialSpending: Money.parseAmount('60000', day.baseCurrency),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Loading the scale seed's net_worth_daily into Postgres
// ---------------------------------------------------------------------------

const NET_WORTH_CHUNK = 200;

function breakdownJsonOf(point: ScaleNetWorthDailyPoint): readonly Record<string, unknown>[] {
  return point.byAccount.map((entry) => ({
    accountId: entry.accountId,
    currency: entry.currency,
    nativeMinor: entry.nativeMinor,
    baseMinor: entry.baseMinor,
    fxRate: entry.fxRate,
    fxRateDate: entry.fxRateDate,
    // Every position here is an investment holding: on budget, in net worth,
    // investable, not liquid. The scale seed's job is row *scale*, not a
    // fresh proof of the four-booleans derivation — WP 3.8/3.9 already own that.
    onBudget: true,
    inNetWorth: true,
    isLiquid: false,
    isInvestable: true,
    side: 'asset',
    kind: 'investment',
    valuation: 'quantity_times_price',
    stalePrice: false,
  }));
}

/**
 * Every day already sealed, direct SQL rather than `upsertOpenDay` +
 * `sealDay` (1,825 round trips each) — `investments-perf.test.ts`'s own
 * header explains the same trade for `securities`/`holdings`/`prices`: this
 * is a perf test on the **read** path, and re-running the **write** path
 * (`computeNetWorth`) 1,825 times over 200 holdings each would spend minutes
 * proving a budget this file is not about. `writeCorrection`'s own doc comment
 * confirms a sealed row inserted directly (never updated after) is the
 * schema's own shape for "already closed history".
 */
async function loadNetWorthDaily(
  db: ApiHarness['database']['db'],
  userId: string,
  points: readonly ScaleNetWorthDailyPoint[],
): Promise<void> {
  const now = new Date().toISOString();
  for (let start = 0; start < points.length; start += NET_WORTH_CHUNK) {
    const chunk = points.slice(start, start + NET_WORTH_CHUNK);
    const rows = chunk.map(
      (point) => sql`(
        ${newId()}::uuid, ${userId}::uuid, ${point.date}::date, 1, ${point.baseCurrency},
        ${point.assetsMinor}::bigint, ${point.liabilitiesMinor}::bigint, ${point.netWorthMinor}::bigint,
        ${point.assetsMinor}::bigint, ${point.assetsMinor}::bigint, ${point.assetsMinor}::bigint,
        ${JSON.stringify(breakdownJsonOf(point))}::jsonb, 'observed', false,
        ${point.byAccount.length}, 0, false,
        ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz
      )`,
    );
    await db.execute(sql`
      INSERT INTO net_worth_daily (
        id, user_id, as_of_date, revision, base_currency,
        assets_minor, liabilities_minor, net_worth_minor,
        liquid_minor, investable_minor, on_budget_minor,
        breakdown, source, stale_price, accounts_counted, accounts_unvalued,
        dirty, sealed_at, computed_at, created_at, updated_at
      ) VALUES ${sql.join(rows, sql`, `)}
    `);
  }
}

// ---------------------------------------------------------------------------
// Timing helpers (the `investments-perf.test.ts` / `phase2-reports-http-perf.test.ts` pattern)
// ---------------------------------------------------------------------------

function percentile(sortedAscending: readonly number[], p: number): number {
  const index = Math.floor(sortedAscending.length * p);
  return sortedAscending[Math.min(index, sortedAscending.length - 1)] ?? Number.NaN;
}

interface Measured {
  readonly p50: number;
  readonly p95: number;
  readonly samples: readonly number[];
}

function summarise(label: string, samples: readonly number[]): Measured {
  const sorted = [...samples].sort((a, b) => a - b);
  const measured = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), samples: sorted };
  process.stdout.write(
    `perf ${label}: p50=${measured.p50.toFixed(1)}ms p95=${measured.p95.toFixed(1)}ms ` +
      `samples=${JSON.stringify(sorted.map((s) => Math.round(s)))}\n`,
  );
  return measured;
}

async function timeGet(base: string, path: string, cookie: string): Promise<number> {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const elapsed = performance.now() - start;
  await response.arrayBuffer(); // drain the body: this times the answer, not the headers
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${String(response.status)}: ${await response.text()}`);
  }
  return elapsed;
}

describeWithDb('[slow] the whole-path perf budgets on WP 4.13’s scale seed', () => {
  let h: ApiHarness;
  let base: string;
  let cookie: string;
  const scale = generatePhase4Scale(1);

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp413-projection-perf' });
    const db = h.database.db;
    const userId = h.userId;

    await loadNetWorthDaily(db, userId, scale.netWorthDaily);

    // --- the plan: goals, contributions, life events, over the real service ---
    const clock: Clock = systemClock;
    const noAccounts: FundingAccountsReader = {
      async accounts() {
        return [];
      },
    };
    const goalContext = {
      userId,
      clock,
      timeZone: 'America/New_York',
      correlationId: newId(),
    };
    const goalRowByScaleId = new Map<string, string>();
    for (const goal of scale.goals) {
      const row = await createGoal(db, { accounts: noAccounts }, goalContext, {
        kind: goal.kind,
        name: goal.name,
        target: Money.fromJSON(goal.target),
        targetDate: goal.targetDate,
        priority: goal.priority,
      });
      goalRowByScaleId.set(goal.id, row.id);
    }
    for (const contribution of scale.contributions) {
      const goalId = goalRowByScaleId.get(contribution.goalId);
      if (goalId === undefined) throw new Error('scale contribution names an unknown goal');
      await addContribution(db, { userId, clock }, goalId, {
        cadence: contribution.cadence,
        amount: Money.fromJSON(contribution.amount),
        startsOn: contribution.startsOn,
        source: contribution.source,
      });
    }
    for (const event of scale.lifeEvents) {
      await createLifeEvent(db, {
        userId,
        event: {
          kind: event.kind,
          name: event.name,
          occursOn: event.occursOn,
          amount: Money.fromJSON(event.amount),
        },
        clock,
      });
    }

    // --- the baseline scenario ------------------------------------------------
    const profile: BaselineProfile = {
      birthDate: DateOnly.parse('1971-01-01'),
      retirementAge: 62,
      planEndAge: 95,
      currency: 'USD',
      glidepath: { kind: 'age_based' },
      contributionGrowth: 'wage',
      annualSpending: null, // derived, from this reader's literal nonSavingsSpending
      withdrawalPolicy: 'guardrails',
      spendingFloor: 'essential_spend',
      taxDeferredRate: '0.15',
      socialSecurity: {
        monthlyPia: Money.parseAmount('2900', 'USD'),
        claimAge: { years: 67, months: 0 },
        stressAfter2034: true,
      },
      pensions: [],
      contributions: null, // every bucket derived from this reader's literals
    };
    await saveBaseline(db, { userId, name: 'WP 4.13 scale baseline', profile, clock });

    base = await h.listen();
    cookie = `__Host-pfi_session=${h.fresh.accessToken}`;
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('the scale seed is actually in the database (a perf number over an empty table is a lie)', async () => {
    const days = await h.database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM net_worth_daily WHERE user_id = ${h.userId}::uuid`,
    );
    expect(Number(days.rows[0]?.count ?? '0')).toBe(scale.days.length);
    expect(scale.days.length).toBe(1_825);

    const goals = await h.database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM goals WHERE user_id = ${h.userId}::uuid`,
    );
    expect(Number(goals.rows[0]?.count ?? '0')).toBe(scale.goals.length);
    expect(scale.goals.length).toBeGreaterThanOrEqual(2);

    const events = await h.database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM plan_life_events WHERE user_id = ${h.userId}::uuid`,
    );
    expect(Number(events.rows[0]?.count ?? '0')).toBe(scale.lifeEvents.length);
    expect(scale.lifeEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('POST /plan/scenarios/{id}/projections p95 is within budget over real HTTP', async () => {
    const db = h.database.db;
    const userId = h.userId;
    const bucketOf = new Map(
      scale.accounts.map((account) => [account.id, account.bucket] as const),
    );
    const series = syntheticReturnSeries(RETURN_SERIES_MONTHS, 4_130_413);
    const dependencies: ProjectionServiceDependencies = {
      inputs: scaleInputsReader(db, userId, bucketOf),
      monteCarlo: monteCarloRunnerOverWorker(series),
      clock: systemClock,
      timeZone: 'America/New_York',
      registry: currentRegistry(),
    };

    const totalRuns = WARMUP_COUNT + SAMPLE_COUNT;
    const wallSamples: number[] = [];
    for (let i = 0; i < totalRuns; i += 1) {
      // A fresh fork every iteration: `annual_spending` moves by $1 each
      // time, so `diffLevers` keeps it (the baseline has none of its own)
      // and every sample gets a fresh `input_digest` — never a cache hit.
      const fork = await createScenario(db, {
        userId,
        name: `perf sample ${String(i)}`,
        levers: { annualSpending: Money.parseAmount(String(96_000 + i), 'USD') },
        clock: systemClock,
      });
      const started = performance.now();
      const outcome = await runProjection(db, dependencies, {
        userId,
        scenarioId: fork.id,
        method: 'monte_carlo',
        correlationId: newId(),
      });
      const elapsed = performance.now() - started;
      if (outcome.status !== 'computed') {
        throw new Error(`sample ${String(i)} was ${outcome.status}, expected a fresh computation`);
      }
      if (i >= WARMUP_COUNT) {
        wallSamples.push(elapsed);
        // A decimal string in [0, 1] (`SIX_PLACES` in `projection-service.ts`),
        // never a JSON number — the dispatch's own wire rule for this field.
        expect(outcome.run.successProbability).toMatch(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/);
      }
    }

    const measured = summarise('POST /plan/scenarios/{id}/projections (in-process)', wallSamples);
    expect(measured.p95, 'the whole-path Monte Carlo projection').toBeLessThanOrEqual(
      PROJECTION_BUDGET_MS,
    );
  }, 180_000);

  it(`GET /net-worth/series over ${String(scale.days.length)} points is within ${String(NET_WORTH_BUDGET_MS)} ms p95`, async () => {
    const from = scale.days[0] as string;
    const to = scale.days.at(-1) as string;
    for (let i = 0; i < 2; i += 1)
      await timeGet(base, `/net-worth/series?from=${from}&to=${to}`, cookie);
    const samples: number[] = [];
    for (let i = 0; i < 15; i += 1)
      samples.push(await timeGet(base, `/net-worth/series?from=${from}&to=${to}`, cookie));
    const measured = summarise(
      `GET /net-worth/series (${String(scale.days.length)} days)`,
      samples,
    );
    expect(measured.p95, 'GET /net-worth/series').toBeLessThanOrEqual(NET_WORTH_BUDGET_MS);
  });
});
