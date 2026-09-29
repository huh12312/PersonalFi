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
 * This suite seeds both rows directly (never through the Monte Carlo engine
 * itself — that is WP 4.5/4.6's proof, not this one's) so the ordering is
 * exercised without depending on whether a return series happens to be bound
 * in this process.
 */
// eslint-disable-next-line no-restricted-imports -- a synthetic digest for a CHECK constraint, not cryptography
import { createHash } from 'node:crypto';
import { DateOnly, newId, systemClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createInsightsPlanningPort } from '../../src/domain.ts';
import { NO_DATABASE, createApiHarness, expectStatus } from '../helpers/api-harness.ts';

const ZONE = 'UTC';

function digest(seed: string): string {
  return `sha256:${createHash('sha256').update(seed).digest('hex')}`;
}

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
      const assumptionsVersion = digest('carry-c1-assumptions');
      const nowMs = Date.now();

      async function insertRun(input: {
        readonly id: string;
        readonly method: 'deterministic' | 'monte_carlo';
        readonly paths: number;
        readonly successProbability: string;
        readonly createdAtMs: number;
        readonly cacheKeySeed: string;
      }): Promise<void> {
        await h.database.db.execute(sql`
          INSERT INTO projection_runs (
            id, user_id, scenario_id, scenario_kind, method, cache_key, seed,
            engine_version, assumptions_version, assumptions_overrides,
            input_digest, input, paths, as_of_date, balances_sealed, currency,
            success_probability, duration_ms, created_at
          ) VALUES (
            ${input.id}::uuid, ${h.userId}::uuid, ${baselineId}::uuid, 'baseline',
            ${input.method}, ${digest(input.cacheKeySeed)}, 12345,
            'carry-c1-test/1', ${assumptionsVersion}, '{}'::jsonb,
            ${digest(`${input.cacheKeySeed}-input`)}, '{}'::jsonb, ${input.paths},
            '2026-01-01'::date, true, 'USD', ${input.successProbability}, 5,
            ${new Date(input.createdAtMs).toISOString()}::timestamptz
          )
        `);
        await h.database.db.execute(sql`
          INSERT INTO projection_percentiles (
            run_id, user_id, period_index, age, calendar_year, currency, p50_minor
          ) VALUES (
            ${input.id}::uuid, ${h.userId}::uuid, 0, 65, 2026, 'USD', 100000
          )
        `);
      }

      const monteCarloRunId = newId();
      const deterministicRunId = newId();
      // Older, Monte Carlo — the nightly refresh's shape.
      await insertRun({
        id: monteCarloRunId,
        method: 'monte_carlo',
        paths: 500,
        successProbability: '0.603500',
        createdAtMs: nowMs - 60_000,
        cacheKeySeed: 'carry-c1-mc',
      });
      // Newer, deterministic — an interactive reload after the nightly run.
      await insertRun({
        id: deterministicRunId,
        method: 'deterministic',
        paths: 1,
        successProbability: '1.000000',
        createdAtMs: nowMs,
        cacheKeySeed: 'carry-c1-det',
      });

      const port = createInsightsPlanningPort(h.database.db, systemClock, { timeZone: ZONE });
      const read = await port.projection({
        userId: h.userId,
        asOf: DateOnly.parse('2026-01-01'),
      });

      expect(read).not.toBeNull();
      // The Monte Carlo run's own numbers, not the newer deterministic run's.
      expect(read?.method).toBe('monte_carlo');
      expect(read?.successProbability).toBe('0.603500');
    },
  );
});
