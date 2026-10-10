// SPDX-License-Identifier: MIT
/**
 * C-1 (G4-1) / `docs/evidence/phase-4/gate-security-review.md` §6 row **C-1**:
 * "`newestBaselineRunId` prefers a fresh Monte Carlo baseline run for R2 so
 * the api's interactive deterministic run no longer hides the nightly MC
 * run."
 *
 * §3.11 of the gate observed the real shape this guards against: the
 * scheduled `planning.projection_refresh` writes a `monte_carlo` baseline run
 * once a process has a return series bound, and the api's own interactive
 * `POST …/projections` (no explicit `method`, `projection-service.ts`'s own
 * default) writes a fresh `deterministic` run on every `/plan` reload after
 * it. Before this fix `newestBaselineRunId` ordered by `created_at` alone, so
 * the next reload's deterministic run — newer by definition, since a reload
 * can happen at any time after the nightly job — permanently outranked the
 * nightly Monte Carlo run. `createInsightsPlanningPort(...).projection()` is
 * the port R2 (`builtin.retirement.success_probability`,
 * `builtin.retirement.goal_pace`, and every other retirement-wave advisor)
 * reads through, so the one real bootstrap probability the install ever
 * computed was invisible to every advisor the moment a holder looked at the
 * plan screen again.
 *
 * Both runs are written by the production writer (G9-15, C9-9): the Monte
 * Carlo baseline by `@ctx/planning`'s `runProjection` — the function the
 * nightly `planning.projection_refresh` and `POST …/projections` both call —
 * with the engine port bound to a double that answers a fixed outcome (the
 * bootstrap engine is WP 4.5/4.6's proof, not this one's, and needs a fetched
 * return series), and the deterministic run by the route itself, after it, as
 * a `/plan` reload would. The rows are therefore real: a real cache key, input
 * document, digest and assumptions version, in the order the product writes
 * them (the deterministic run really is newer). The earlier fixture inserted
 * both by SQL with `input '{}'`, an invented engine and assumptions version and
 * a digest of nothing, and pinned "the newest baseline run is served" on them.
 */
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  computeNetWorth,
  createProjectionInputsReader,
  currentRegistry,
  runProjection,
  sealDay,
  upsertOpenDay,
  type MonteCarloRunner,
} from '@ctx/planning';
import { describe, expect, it } from 'vitest';
import {
  createInsightsPlanningPort,
  planningPortsFor,
  planningRevealedPortsFor,
} from '../../src/domain.ts';
import { NO_DATABASE, createApiHarness, expectStatus } from '../helpers/api-harness.ts';

const ZONE = 'UTC';

/** The engine port, answering what the nightly bootstrap run would: a 60.35 % success. */
const FIXED_MONTE_CARLO: MonteCarloRunner = {
  engineVersion: 'carry-c1-engine-double/1',
  run: async (request) => ({
    engineVersion: 'carry-c1-engine-double/1',
    seed: request.seed,
    paths: request.paths,
    successProbability: '0.603500',
    periods: [
      {
        index: 0,
        age: 65,
        calendarYear: 2026,
        p5: money(50_000n, 'USD'),
        p10: money(60_000n, 'USD'),
        p25: money(80_000n, 'USD'),
        p50: money(100_000n, 'USD'),
        p75: money(120_000n, 'USD'),
        p90: money(140_000n, 'USD'),
        p95: money(160_000n, 'USD'),
      },
    ],
  }),
};

describe.skipIf(NO_DATABASE)('C-1: newestBaselineRunId prefers Monte Carlo (carry-c1)', () => {
  it(
    'R2 reads the older Monte Carlo baseline run, not a newer deterministic one',
    { timeout: 30_000 },
    async () => {
      const h = await createApiHarness({ suite: 'carry-c1-newest-run' });

      const baseline = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body: {
          kind: 'baseline',
          name: 'carry-c1 baseline',
          profile: {
            birthDate: '1970-01-01',
            retirementAge: 65,
            planEndAge: 95,
            currency: 'USD',
            glidepath: { kind: 'age_based' },
            contributionGrowth: 'flat',
            annualSpending: { minor: '4000000', currency: 'USD' },
            withdrawalPolicy: 'guardrails',
            spendingFloor: 'none',
            taxDeferredRate: '0.15',
            socialSecurity: null,
            pensions: [],
            contributions: null,
          },
        },
      });
      expectStatus(baseline, 201);
      const baselineId = (baseline.json() as { id: string }).id;

      // A projection starts from a sealed net-worth day: written the way the
      // 04:00 snapshot job writes one (`computeNetWorth` -> `upsertOpenDay` -> `sealDay`).
      const sealedDay = new Date(systemClock.now().getTime() - 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const snapshot = await computeNetWorth(
        planningPortsFor(h.database.db, { userId: h.userId, timeZone: ZONE, clock: systemClock }),
        { userId: h.userId, asOfDate: sealedDay, baseCurrency: 'USD' },
      );
      await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });
      await sealDay(h.database.db, { userId: h.userId, asOfDate: sealedDay, clock: systemClock });

      // Older, Monte Carlo — the nightly refresh's shape: `runProjection`, the
      // function the job calls, with the engine port bound.
      const monteCarlo = await h.database.db.transaction((tx) =>
        runProjection(
          tx,
          {
            inputs: createProjectionInputsReader(
              tx,
              planningRevealedPortsFor(tx, {
                userId: h.userId,
                timeZone: ZONE,
                clock: systemClock,
              }),
            ),
            monteCarlo: FIXED_MONTE_CARLO,
            clock: systemClock,
            timeZone: ZONE,
            registry: currentRegistry(),
          },
          {
            userId: h.userId,
            scenarioId: baselineId,
            method: 'monte_carlo',
            paths: 500,
            asOf: null,
            allowOpenDay: true,
            correlationId: newId(),
          },
        ),
      );
      expect(monteCarlo.run?.method).toBe('monte_carlo');
      const monteCarloRunId = monteCarlo.run?.id as string;
      // A reload can happen at any moment after the nightly run; the clock only
      // has to have moved for "newer" to be true of `created_at`.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Newer, deterministic — an interactive reload after the nightly run, through
      // the route (no `method`, no Monte Carlo bound on the api in this harness).
      const reload = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${baselineId}/projections`,
        session: h.stale,
        body: { method: 'deterministic', allowOpenDay: true },
      });
      expectStatus(reload, 200);
      const deterministicRunId = (reload.json() as { run: { id: string } }).run.id;
      expect(deterministicRunId).not.toBe(monteCarloRunId);
      const newest = await h.database.pool.query<{ id: string; method: string }>(
        `SELECT id, method FROM projection_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [h.userId],
      );
      expect(newest.rows[0]).toEqual({ id: deterministicRunId, method: 'deterministic' });

      const port = createInsightsPlanningPort(h.database.db, systemClock, { timeZone: ZONE });
      const read = await port.projection({
        userId: h.userId,
        asOf: DateOnly.parse(systemClock.now().toISOString().slice(0, 10)),
      });

      expect(read).not.toBeNull();
      // The Monte Carlo run's own numbers, not the newer deterministic run's.
      expect(read?.method).toBe('monte_carlo');
      expect(read?.successProbability).toBe('0.603500');
    },
  );
});
