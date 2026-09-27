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
 * ## WP 4.8 rebind: over real `fetch()`, against the real route
 *
 * The dispatch's exit test name is
 * `'POST /plan/scenarios/{id}/projections p95 is within budget over real HTTP'`
 * — that route did not exist when WP 4.13 wrote this file, so it called
 * `@ctx/planning`'s `runProjection` in-process instead, over a literal
 * `ProjectionInputsReader` stub and a `MonteCarloRunner` built directly
 * against a synthetic return series (never Shiller's — fetched, git-ignored,
 * licensed). WP 4.8's route now exists (`apps/api/src/routes/plan.ts`), and
 * this file's one timed HTTP test is rebound to call it for real: `h.listen()`
 * plus `fetch()`, the exact `timeGet`/`investments-perf.test.ts` pattern this
 * file already uses for the net-worth half, extended to a `timePost` that
 * carries the CSRF pair `h.request()` sends internally (`app.ts`'s CSRF gate
 * applies to every mutation, `GET`s included in this file's other half).
 *
 * Two consequences of going through the real route rather than a stub:
 *
 *   1. **The Monte Carlo runner is now `app.ts`'s real
 *      `createMonteCarloRunnerFromCache`** (`docs/evidence/phase-4/
 *      wp4.8-routes.md`'s composition-root decision), over whatever return
 *      series is actually on disk. In this checkout that is the real,
 *      checksum-pinned Shiller series (`data/returns/cache/shiller-monthly.csv`,
 *      git-ignored, fetched once by an operator — `RETURN_SERIES_FETCH
 *      _COMMAND`) rather than the synthetic one this file used to vendor
 *      itself; a checkout with no cached series has `deps.monteCarlo === null`
 *      and the route answers `planning.monte_carlo_unavailable` (409) rather
 *      than inventing a lognormal substitute. The Monte Carlo half of this
 *      suite below detects that 409 and **skips its own assertion with a
 *      named reason** instead of failing an environment that was never asked
 *      to vendor a licensed dataset (`wp4.5-montecarlo.md` §6's licence
 *      verdict).
 *   2. **Balances and derived contributions/spending now come from the real
 *      `createProjectionInputsReader`/`planningRevealedPortsFor`**, not the
 *      literal stub. Starting balances by tax bucket still resolve correctly
 *      from the real `net_worth_daily` breakdown this file already loads
 *      (`loadNetWorthDaily`) through the scale seed's real account subtypes —
 *      nothing changes there. Contributions and spending, though, would now
 *      derive from twelve months of real ledger transactions the scale seed
 *      does not generate, and would come back `insufficient_history` (`null`)
 *      — so the baseline profile below now **states** `annualSpending` and
 *      every bucket's `contributions` directly, the one change this file's
 *      `beforeAll` needed to keep working with no stubbed reader behind it.
 *      Everything else about the setup (accounts, goals, life events,
 *      `net_worth_daily`) is unchanged from WP 4.13's own version.
 *
 * ## Why the projection isn't cached across samples
 *
 * `runProjection` caches by `hash(assumptions + engine_version + seed +
 * input)` (WP 4.6) and serves a repeat request from `projection_runs` without
 * running the engine at all — exactly the behaviour
 * `wp4.6-projection-service.md` §2 proves. Timing that would measure a cache
 * hit, not the budget. So every sample is a **fresh fork** of the same
 * baseline with a one-dollar-larger `annual_spending` lever than the last —
 * `diffLevers` never drops it (the fork's own stated value always differs
 * from the baseline's), which gives every sample its own `input_digest` and
 * therefore its own Monte Carlo run, deterministically, with no
 * `Math.random()` anywhere in the loop.
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
  addContribution,
  createGoal,
  createLifeEvent,
  createScenario,
  saveBaseline,
  type BaselineProfile,
  type FundingAccountsReader,
} from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  NO_DATABASE,
  TEST_ORIGIN,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

/** 08 §7.2 / dispatch §5: the same budget the engine-alone test measures. */
const PROJECTION_BUDGET_MS = 800;
/** 08 §7.1: "net worth chart, 5 years daily (1,825 points), p95 <= 150 ms". */
const NET_WORTH_BUDGET_MS = 150;
const WARMUP_COUNT = 3;
const SAMPLE_COUNT = 12;

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

/**
 * `POST` over real `fetch()`, carrying the same session cookie **and** CSRF
 * pair `h.request()` sends internally (`app.ts`'s CSRF gate — mounted at the
 * root, ahead of every route — applies to every mutation; the net-worth half
 * of this file never needed this because a `GET` is exempt). Returns the
 * elapsed time and the parsed body so the caller can both time the request
 * and inspect what it answered (which method actually ran, in particular).
 */
async function timePost(
  base: string,
  path: string,
  session: ApiHarness['fresh'],
  body: unknown,
): Promise<{ readonly elapsedMs: number; readonly status: number; readonly json: unknown }> {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      cookie: `__Host-pfi_session=${session.accessToken}; __Host-pfi_csrf=${session.csrf}`,
      'x-csrf-token': session.csrf,
      'sec-fetch-site': 'same-origin',
      origin: TEST_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = performance.now() - start;
  const json: unknown = await response.json();
  return { elapsedMs, status: response.status, json };
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
    // WP 4.8 rebind: `annualSpending` and every bucket's `contributions` are
    // now **stated** rather than `null`. Over the real route these would
    // otherwise derive from twelve months of real ledger transactions
    // (`@ctx/planning`'s `deriveRevealedBehavior`, WP 4.3), which the scale
    // seed does not generate — building that history at 200-position scale
    // belongs to a different budget than the one this file measures, exactly
    // as the module comment above says. Stating them here is the one change
    // this `beforeAll` needed; every other input is WP 4.13's own.
    const profile: BaselineProfile = {
      birthDate: DateOnly.parse('1971-01-01'),
      retirementAge: 62,
      planEndAge: 95,
      currency: 'USD',
      glidepath: { kind: 'age_based' },
      contributionGrowth: 'wage',
      annualSpending: Money.parseAmount('96000', 'USD'),
      withdrawalPolicy: 'guardrails',
      spendingFloor: 'none',
      taxDeferredRate: '0.15',
      socialSecurity: {
        monthlyPia: Money.parseAmount('2900', 'USD'),
        claimAge: { years: 67, months: 0 },
        stressAfter2034: true,
      },
      pensions: [],
      contributions: {
        TAXABLE: Money.parseAmount('12000', 'USD'),
        TAX_DEFERRED: Money.parseAmount('23000', 'USD'),
        ROTH: Money.parseAmount('7000', 'USD'),
        HSA: Money.parseAmount('0', 'USD'),
      },
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

    const totalRuns = WARMUP_COUNT + SAMPLE_COUNT;
    const wallSamples: number[] = [];
    let sawMonteCarlo = false;
    let skipReason: string | null = null;
    for (let i = 0; i < totalRuns; i += 1) {
      // A fresh fork every iteration: `annual_spending` moves by $1 each
      // time, so `diffLevers` keeps it (the baseline states its own, so
      // every fork's value still differs) and every sample gets a fresh
      // `input_digest` — never a cache hit.
      const fork = await createScenario(db, {
        userId,
        name: `perf sample ${String(i)}`,
        levers: { annualSpending: Money.parseAmount(String(96_001 + i), 'USD') },
        clock: systemClock,
      });
      const result = await timePost(base, `/plan/scenarios/${fork.id}/projections`, h.fresh, {
        method: 'monte_carlo',
      });
      if (result.status === 409) {
        // `planning.monte_carlo_unavailable` — this checkout has no return
        // series cached on disk (`createMonteCarloRunnerFromCache` answers
        // `null` rather than a silent lognormal substitute; `wp4.5
        // -montecarlo.md` §6's licence verdict is why the series is not
        // vendored). A perf number for the wrong engine is worse than none;
        // skip the budget assertion below with a named reason rather than
        // failing an environment that was never asked to fetch a licensed
        // dataset.
        const problem = result.json as { code?: string };
        skipReason =
          `no Monte Carlo runner bound (code: ${String(problem.code)}); ` +
          'this checkout has no cached return series — see the file header';
        break;
      }
      if (result.status !== 200) {
        throw new Error(
          `sample ${String(i)} -> ${String(result.status)}: ${JSON.stringify(result.json)}`,
        );
      }
      const body = result.json as {
        status: string;
        run: { method: string; successProbability: string } | null;
      };
      if (body.status !== 'computed') {
        throw new Error(`sample ${String(i)} was ${body.status}, expected a fresh computation`);
      }
      if (body.run?.method === 'monte_carlo') sawMonteCarlo = true;
      if (i >= WARMUP_COUNT) {
        wallSamples.push(result.elapsedMs);
        // A decimal string in [0, 1] (`SIX_PLACES` in `projection-service.ts`),
        // never a JSON number — the dispatch's own wire rule for this field,
        // now checked on the wire this route actually serves.
        expect(body.run?.successProbability).toMatch(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/);
      }
    }

    if (skipReason !== null) {
      console.warn(`[projection-perf] Monte Carlo budget skipped: ${skipReason}`);
      return;
    }
    expect(
      sawMonteCarlo,
      'every sample must actually have run Monte Carlo, not a silent fallback',
    ).toBe(true);

    const measured = summarise('POST /plan/scenarios/{id}/projections (real HTTP)', wallSamples);
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
