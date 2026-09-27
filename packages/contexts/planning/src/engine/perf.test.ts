// SPDX-License-Identifier: MIT
/**
 * WP 4.5 — `'10,000 paths over 40 years complete within 800 ms p95 on one
 * core'` (08 §7.2; the §5 exit criterion).
 *
 * ## What is timed
 *
 * `runJobInWorker` from call to reply: the envelope, a **fresh**
 * `worker_thread` spawned with the production options (the resource limits,
 * `env: {}`, `execArgv: []`), the structured clone of the job in, the kernel
 * (shocks → 10,000 × 40 `stepYear`s, one pass serving both the plan and its
 * crypto-at-zero projection → percentiles for both, failure summary,
 * sequence deciles) and the clone of the bands out. That is exactly what one
 * interactive request costs; no HTTP (the whole-path budget is WP 4.13's
 * `apps/api/test/db/projection-perf.test.ts`).
 *
 * Two clocks per sample, both printed and both asserted: the **wall time**
 * spawn to reply (what "complete within" means — the latency a user waits),
 * and the **worker thread's own CPU time** (`process.threadCpuUsage()` at the
 * reply: module load, clone in, kernel), which confirms the work is one
 * core's. Warm-ups are printed and excluded; the host's CPU, Node version and
 * load average are printed.
 *
 * ## This file must run alone
 *
 * 08 §7.2's number is for a core the kernel has to itself. In the full
 * `planning` project this file shares a 4-core / 8-thread laptop with every
 * other planning test file (the invariants file alone is ~15 s of Monte
 * Carlo), and both clocks inflate: observed p95 1,416 ms wall / 1,121 ms
 * thread CPU under the suite against 671 / 664 ms alone — SMT siblings and the
 * all-core clock, not the kernel. A benchmark in a parallel unit run measures
 * the scheduler. The fix is configuration, not a looser number: the WP 4.5
 * evidence ("For the orchestrator") gives a `planning-perf` vitest project
 * (`fileParallelism: false`, a later `sequence.groupOrder`) that runs this
 * file after everything else, alone.
 *
 * ## On what
 *
 * Dispatch §5 says "measured on WP 4.13's scale plan (200 positions, five
 * years of daily rows)", and WP 4.13 has now landed: `@core/seed`'s
 * `generatePhase4Scale` builds exactly that (11 accounts across four tax
 * buckets, 200 distinct positions, a crypto sleeve, and five years of daily
 * `net_worth_daily`-shaped rows) and this file reads its **last** day's
 * per-account breakdown rather than building an equivalent shape by hand. The
 * engine does not see positions: WP 4.6 sums them into four tax buckets
 * (`projection-service.ts`, from `net_worth_daily`), so what 200 positions
 * change here is the buckets' sizes and the crypto sleeve — the cost is
 * paths × years × (the plan's features), and this plan turns every feature
 * on: four buckets each with its own glidepath, contributions into three,
 * Guyton-Klinger guardrails with a floor, Social Security, a pension with a
 * COLA, part-time income, and crypto (its own draws, and a second set of
 * bands). The return series is the synthetic fixture at the real Shiller
 * window's length (1,847 months), so the bootstrap indexes a table of the
 * real size.
 */
import { cpus, loadavg } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { generatePhase4Scale } from '@core/seed';
import { loadAssumptions } from '../assumptions.ts';
import { syntheticSeries, SYNTHETIC_MONTHS } from '../../test/engine/fixtures/synthetic-series.ts';
import type { ProjectionBucket, ProjectionPlan } from './boundary.ts';
import { DEFAULT_PATHS, yearsOf } from './montecarlo.ts';
import { runJobInWorker, toMonteCarloJob } from './worker-host.ts';

const WARM_UPS = 3;
const SAMPLES = 25;
const BUDGET_MS = 800;

/**
 * The scale seed's last day, summed by tax bucket the way WP 4.6 sums
 * `net_worth_daily`'s breakdown — every account but `crypto-wallet` into its
 * bucket, that one account into `cryptoHolding` — plus the counts a perf
 * number is asserted against before anything is timed.
 */
function scaleBalances(): {
  readonly byBucket: Readonly<Record<ProjectionBucket, Money>>;
  readonly cryptoHolding: Money;
  readonly positionCount: number;
  readonly securityCount: number;
} {
  const scale = generatePhase4Scale(20_260_926);
  // Counts before timing: 200 positions, every one a distinct security.
  if (scale.holdings.length !== 200) {
    throw new Error(
      `expected 200 positions from the scale seed, got ${String(scale.holdings.length)}`,
    );
  }
  const distinctSecurities = new Set(scale.holdings.map((holding) => holding.securityId));
  if (distinctSecurities.size !== 200) {
    throw new Error('the scale seed did not give every position its own security');
  }
  const lastDay = scale.netWorthDaily.at(-1);
  if (lastDay === undefined) throw new Error('the scale seed has no net_worth_daily rows');
  const cryptoAccount = scale.accounts.find((account) => account.name === 'crypto-wallet');
  if (cryptoAccount === undefined) throw new Error('the scale seed has no crypto-wallet account');
  const bucketOf = new Map(scale.accounts.map((account) => [account.id, account.bucket] as const));

  const zero = Money.zero('USD');
  const byBucket: Record<ProjectionBucket, Money> = {
    TAXABLE: zero,
    TAX_DEFERRED: zero,
    ROTH: zero,
    HSA: zero,
  };
  let cryptoHolding = zero;
  for (const entry of lastDay.byAccount) {
    const money = Money.of(BigInt(entry.baseMinor), lastDay.baseCurrency);
    if (entry.accountId === cryptoAccount.id) {
      cryptoHolding = Money.add(cryptoHolding, money);
      continue;
    }
    const bucket = bucketOf.get(entry.accountId);
    if (bucket === undefined) continue;
    byBucket[bucket] = Money.add(byBucket[bucket], money);
  }
  return {
    byBucket,
    cryptoHolding,
    positionCount: scale.holdings.length,
    securityCount: distinctSecurities.size,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const k = Math.floor(h);
  const below = sorted[k] ?? Number.NaN;
  const above = sorted[Math.min(k + 1, sorted.length - 1)] ?? Number.NaN;
  return below + (h - k) * (above - below);
}

describe('the 08 §7.2 budget', () => {
  it('10,000 paths over 40 years complete within 800 ms p95 on one core', async () => {
    const { byBucket, cryptoHolding, positionCount, securityCount } = scaleBalances();
    // Counts before timing: 200 positions, every one a distinct security.
    expect(positionCount).toBe(200);
    expect(securityCount).toBe(200);
    expect(cryptoHolding.minor).toBeGreaterThan(0n);

    const plan: ProjectionPlan = {
      currency: 'USD',
      asOf: DateOnly.parse('2026-01-01'),
      birthDate: DateOnly.parse('1971-01-01'),
      retirementAge: 62,
      planEndAge: 95,
      buckets: [
        {
          bucket: 'TAXABLE',
          startingBalance: byBucket.TAXABLE,
          annualContribution: Money.parseAmount('12000', 'USD'),
        },
        {
          bucket: 'TAX_DEFERRED',
          startingBalance: byBucket.TAX_DEFERRED,
          annualContribution: Money.parseAmount('23000', 'USD'),
          glidepath: { kind: 'target_date' },
        },
        {
          bucket: 'ROTH',
          startingBalance: byBucket.ROTH,
          annualContribution: Money.parseAmount('7000', 'USD'),
          glidepath: { kind: 'rising_equity' },
        },
        {
          bucket: 'HSA',
          startingBalance: byBucket.HSA,
          annualContribution: Money.zero('USD'),
          glidepath: { kind: 'static', equityShare: '0.9' },
        },
      ],
      contributionGrowth: 'wage',
      glidepath: { kind: 'age_based' },
      annualSpending: Money.parseAmount('118000', 'USD'),
      withdrawalPolicy: { kind: 'guardrails', spendingFloor: Money.parseAmount('80000', 'USD') },
      taxDeferredRate: '0.15',
      socialSecurity: {
        kind: 'statement',
        monthlyPia: Money.parseAmount('2900', 'USD'),
        claimAge: { years: 67, months: 0 },
        stressAfter2034: true,
      },
      pensions: [
        {
          name: 'DB',
          startAge: 65,
          annualBenefit: Money.parseAmount('14000', 'USD'),
          cola: { kind: 'cpi' },
        },
      ],
      otherIncome: [
        { name: 'part-time', startAge: 62, endAge: 66, annual: Money.parseAmount('20000', 'USD') },
      ],
    };
    const series = syntheticSeries();
    const job = toMonteCarloJob({
      plan,
      assumptions: loadAssumptions(),
      seed: 20_260_926n,
      engine: 'bootstrap',
      series,
      cryptoHolding,
    });
    expect(job.paths).toBe(DEFAULT_PATHS);
    expect(job.paths).toBe(10_000);
    expect(yearsOf(job.plan)).toBe(40);
    expect(series.equityReal.length).toBe(SYNTHETIC_MONTHS);
    expect(job.crypto.holding).toBeGreaterThan(0);

    const cpu = cpus()[0]?.model ?? 'unknown';
    console.log(
      `[perf] ${cpu} × ${String(cpus().length)} logical, Node ${process.version}, load ${loadavg()
        .map((x) => x.toFixed(2))
        .join(' ')}; WP 4.13 scale seed, 200 positions → buckets ${Object.entries(byBucket)
        .map(([bucket, total]) => `${bucket} ${Money.formatAmount(total)}`)
        .join(', ')}, crypto ${Money.formatAmount(cryptoHolding)}; ${String(job.paths)} paths × ` +
        `${String(yearsOf(job.plan))} years, bootstrap over ${String(series.equityReal.length)} months`,
    );

    const warm: string[] = [];
    for (let i = 0; i < WARM_UPS; i += 1) {
      const run = await runJobInWorker(job, { deadlineMs: 20_000 });
      warm.push(`${run.threadCpuMs.toFixed(1)}/${run.durationMs.toFixed(1)}`);
    }
    const cpuSamples: number[] = [];
    const wallSamples: number[] = [];
    let successCount = -1;
    for (let i = 0; i < SAMPLES; i += 1) {
      const run = await runJobInWorker(job, { deadlineMs: 20_000 });
      cpuSamples.push(run.threadCpuMs);
      wallSamples.push(run.durationMs);
      // Same seed, same job: every sample computed the same thing.
      if (successCount < 0) successCount = run.result.successCount;
      expect(run.result.successCount).toBe(successCount);
    }
    const summarise = (samples: readonly number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        min: sorted[0] ?? Number.NaN,
        max: sorted[sorted.length - 1] ?? Number.NaN,
      };
    };
    const cpuStats = summarise(cpuSamples);
    const wallStats = summarise(wallSamples);
    const line = (stats: ReturnType<typeof summarise>) =>
      `p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, p99 ${stats.p99.toFixed(1)} ms ` +
      `(min ${stats.min.toFixed(1)}, max ${stats.max.toFixed(1)})`;
    console.log(`[perf] warm-ups (excluded), thread cpu/wall: ${warm.join(', ')} ms`);
    console.log(
      `[perf] thread cpu samples: ${cpuSamples.map((ms) => ms.toFixed(1)).join(', ')} ms`,
    );
    console.log(
      `[perf] wall samples (spawn to reply): ${wallSamples.map((ms) => ms.toFixed(1)).join(', ')} ms`,
    );
    console.log(
      `[perf] n=${String(SAMPLES)} thread cpu: ${line(cpuStats)}; budget ${String(BUDGET_MS)} ms`,
    );
    console.log(
      `[perf] n=${String(SAMPLES)} wall: ${line(wallStats)}; success ${String(successCount)}/${String(job.paths)}; ` +
        `load average after ${loadavg()
          .map((x) => x.toFixed(2))
          .join(' ')}`,
    );
    expect(wallStats.p95).toBeLessThanOrEqual(BUDGET_MS);
    expect(cpuStats.p95).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);
});
