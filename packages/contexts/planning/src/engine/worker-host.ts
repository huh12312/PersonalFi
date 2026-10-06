// SPDX-License-Identifier: MIT
/**
 * The Monte Carlo's host side: the envelope, the worker's limits, the deadline,
 * and the Money-facing conversion on both sides of the thread.
 *
 * A `worker_thread` is in-process: an out-of-memory there takes the API or the
 * worker container with it, and both are capped at 1536 MB in `compose.yml`
 * (08 §7.4's original 512 / 640 MB were raised at the Phase 0 gate and again for
 * the worker; dispatch §5, "the Monte Carlo worker is an unbounded resource").
 * So, in this order, and every one of them sabotage-tested in `worker-limits.test.ts`:
 *
 * 1. **The envelope, before anything is spawned.** A path count, horizon,
 *    path × year product, seed, series length or ν outside `MONTE_CARLO_ENVELOPE`
 *    is a typed `MonteCarloRefused` thrown by `assertWithinEnvelope` — the
 *    spawn function is never called. This is the bound that matters for
 *    memory: **`resourceLimits` do not cover typed-array backing stores**
 *    (measured: a 512 MB `Float64Array` allocates happily under these very
 *    limits — 64 MB old generation — see the WP 4.5 evidence), and every large
 *    buffer here is one. The envelope caps them at ~49 MB.
 * 2. **Declared `resourceLimits`** — the JS heap, the young generation and the
 *    stack, each with its reason below.
 * 3. **An empty environment and no execArgv.** `env: {}` — an empty object,
 *    *not* `SHARE_ENV`, which would share the parent's `process.env` live —
 *    so no secret the API holds (database URL, provider keys) is readable from
 *    the thread. `execArgv: []` so no inspector flag, loader or
 *    `--max-old-space-size` of the parent's leaks in.
 * 4. **A hard deadline that terminates.** When it fires the worker is
 *    `terminate()`d — not awaited, not left to finish — and the caller gets a
 *    typed `MonteCarloTimeout`, never a hang.
 *
 * The worker receives a structured-cloneable `WorkerRequest` (engine units,
 * no `Money`, no functions) and replies with bands, never paths.
 *
 * ## Where the worker file comes from at runtime
 *
 * `new URL('./monte-carlo.worker.ts', import.meta.url)` — a sibling of this
 * file, resolved from this module's own URL. Node 26 strips types natively
 * (CONVENTIONS: "There is no build step"), in the worker as in the main thread,
 * and it resolves `@ctx/planning` through the workspace symlink to its real
 * path, so the URL never contains `node_modules` (where Node would refuse to
 * strip types). See the WP 4.5 evidence, "For the orchestrator", for dev, test
 * and the pruned image.
 */
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { Money } from '@core/kernel';
import {
  ProjectionInputRefused,
  fromEngineRatio,
  monteCarloMarketFrom,
  monthlyFromAnnual,
  annualFromMonthly,
  planCurrency,
  solverMoney,
  toEngineCeiling,
  toEngineCryptoHolding,
  toEnginePlan,
  toEngineRate,
  toEngineTarget,
  wholeYearsFrom,
  type AssumptionsLike,
  type ProjectionPlan,
} from './boundary.ts';
import { NO_EXTRA } from './deterministic.ts';
import type { ReturnSeries } from './bootstrap.ts';
import { canonicalSeed } from './prng.ts';
import {
  DEFAULT_PATHS,
  PERCENTILE_LEVELS,
  SEQUENCE_COLUMNS,
  SEQUENCE_DECILES,
  yearsOf,
  type EngineKind,
  type MonteCarloJob,
  type MonteCarloResult,
  type SuccessObjective,
  type SuccessSolveOutcome,
  type WorkerReply,
  type WorkerRequest,
} from './montecarlo.ts';
import type { RequiredSavingsObjective } from './solve.ts';

// ---------------------------------------------------------------------------
// The limits
// ---------------------------------------------------------------------------

/**
 * What an interactive run may ask for. 100,000-path "power-user" runs are a
 * queued job with a notification (08 §7.2), never this path.
 */
export const MONTE_CARLO_ENVELOPE = Object.freeze({
  /** 07 §5.3 defaults to 10,000; twice that is the most an interactive re-run needs. */
  maxPaths: 20_000,
  /** WP 4.4's `MAX_PLAN_AGE` is 120; a plan from age 20 is 100 years. */
  maxYears: 100,
  /**
   * paths × years. Bounds the buffers `resourceLimits` cannot: 4 shock arrays + 2
   * checkpoint arrays (the plan, and crypto at zero) × 8 bytes × 1,000,000 cells =
   * 48 MB, plus 5 × 8 × paths.
   */
  maxCells: 1_000_000,
  /**
   * A seed is a 64-bit pattern (`prng.ts`, `seedHalves`): WP 4.6 stores it unsigned in
   * `projection_runs.seed` (`numeric(20, 0)`), and a signed representation of the same pattern is
   * accepted too — −2^63 ..= 2^64 − 1 — then canonicalised to unsigned, which the result echoes.
   */
  minSeed: -(2n ** 63n),
  maxSeed: 2n ** 64n - 1n,
  /** 200 years of months: Shiller's series is ~1,850; a clone of more is not a return series. */
  maxSeriesMonths: 2_400,
  /** ν beyond 30 is a normal distribution with extra steps; below 3 the variance is infinite. */
  minDegreesOfFreedom: 3,
  maxDegreesOfFreedom: 30,
});

/**
 * The worker's V8 limits, each with its reason. These bound the **JS heap**
 * only; the typed arrays are bounded by the envelope above.
 */
export const WORKER_RESOURCE_LIMITS = Object.freeze({
  /**
   * 64 MB of old generation. The kernel's heap is small — the plan, a few
   * closures, the result's headers; every per-path and per-year number lives
   * in a typed array outside the heap — and the probe measures a few MB in use.
   * 64 MB is several times that and a small fraction of the 1536 MB container,
   * so a runaway (a leak, a pathological input past the envelope) dies here
   * with `ERR_WORKER_OUT_OF_MEMORY` instead of taking the API down.
   */
  maxOldGenerationSizeMb: 64,
  /**
   * 16 MB of young generation. The inner loop allocates nothing; what is
   * short-lived is per-job setup. A small nursery keeps scavenges short.
   */
  maxYoungGenerationSizeMb: 16,
  /**
   * 4 MB of stack — Node's default, declared rather than inherited. Nothing in
   * the kernel recurses: quickselect and the bisection are loops.
   */
  stackSizeMb: 4,
});

/** 08 §7.2's p95 is 800 ms for 10,000 × 40 on one core; five seconds is ~6× that plus the spawn. */
export const DEFAULT_DEADLINE_MS = 5_000;
/** The solver runs ~15–20 simulations over one shock matrix. */
export const DEFAULT_SOLVE_DEADLINE_MS = 20_000;

export const WORKER_URL = new URL('./monte-carlo.worker.ts', import.meta.url);

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

export type MonteCarloRefusalCode =
  | 'planning.montecarlo_paths_outside_envelope'
  | 'planning.montecarlo_horizon_outside_envelope'
  | 'planning.montecarlo_cells_outside_envelope'
  | 'planning.montecarlo_seed_outside_envelope'
  | 'planning.montecarlo_series_invalid'
  | 'planning.montecarlo_crypto_invalid'
  | 'planning.montecarlo_target_invalid';

/** A request outside the envelope. `domain` / 422, thrown **before** a worker exists. */
export class MonteCarloRefused extends Error {
  override readonly name = 'MonteCarloRefused';
  readonly code: MonteCarloRefusalCode;
  readonly field: string;

  constructor(code: MonteCarloRefusalCode, field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.code = code;
    this.field = field;
  }
}

/** The deadline fired and the worker was terminated. `infrastructure` / 503 — retryable. */
export class MonteCarloTimeout extends Error {
  override readonly name = 'MonteCarloTimeout';
  readonly code = 'planning.montecarlo_timeout';
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(
      `the Monte Carlo worker exceeded its ${String(deadlineMs)} ms deadline and was terminated`,
    );
    this.deadlineMs = deadlineMs;
  }
}

/** The worker died without a reply (an exception, or `ERR_WORKER_OUT_OF_MEMORY`). */
export class MonteCarloWorkerFailed extends Error {
  override readonly name = 'MonteCarloWorkerFailed';
  readonly code = 'planning.montecarlo_worker_failed';
  readonly workerCode: string | null;

  constructor(detail: string, workerCode: string | null) {
    super(`the Monte Carlo worker failed: ${detail}`);
    this.workerCode = workerCode;
  }
}

function refuse(code: MonteCarloRefusalCode, field: string, detail: string): never {
  throw new MonteCarloRefused(code, field, detail);
}

/** The envelope. Called before every spawn; a refusal here means no worker was created. */
export function assertWithinEnvelope(job: MonteCarloJob): void {
  const e = MONTE_CARLO_ENVELOPE;
  if (!Number.isInteger(job.paths) || job.paths < 1 || job.paths > e.maxPaths) {
    refuse(
      'planning.montecarlo_paths_outside_envelope',
      'paths',
      `must be a whole number within 1..${String(e.maxPaths)}, got ${String(job.paths)}`,
    );
  }
  const years = yearsOf(job.plan);
  if (!Number.isInteger(years) || years < 1 || years > e.maxYears) {
    refuse(
      'planning.montecarlo_horizon_outside_envelope',
      'planEndAge',
      `a Monte Carlo horizon is 1..${String(e.maxYears)} years, got ${String(years)}`,
    );
  }
  if (job.paths * years > e.maxCells) {
    refuse(
      'planning.montecarlo_cells_outside_envelope',
      'paths',
      `${String(job.paths)} paths × ${String(years)} years exceeds ${String(e.maxCells)} path-years`,
    );
  }
  if (typeof job.seed !== 'bigint' || job.seed < e.minSeed || job.seed > e.maxSeed) {
    refuse(
      'planning.montecarlo_seed_outside_envelope',
      'seed',
      'a 64-bit pattern, signed or unsigned: −2^63 ..= 2^64 − 1',
    );
  }
  if (job.engine === 'bootstrap') {
    const series = job.series;
    if (series === null) {
      refuse(
        'planning.montecarlo_series_invalid',
        'series',
        'the bootstrap engine needs a return series',
      );
    }
    const months = series.equityReal.length;
    if (
      months < 12 ||
      months > e.maxSeriesMonths ||
      series.bondReal.length !== months ||
      series.inflation.length !== months
    ) {
      refuse(
        'planning.montecarlo_series_invalid',
        'series',
        `three equal columns of 12..${String(e.maxSeriesMonths)} months`,
      );
    }
  } else if (job.engine !== 'lognormal') {
    refuse('planning.montecarlo_series_invalid', 'engine', 'is bootstrap or lognormal');
  }
  const crypto = job.crypto;
  if (
    !Number.isInteger(crypto.degreesOfFreedom) ||
    crypto.degreesOfFreedom < e.minDegreesOfFreedom ||
    crypto.degreesOfFreedom > e.maxDegreesOfFreedom ||
    !(crypto.holding >= 0) ||
    !(crypto.volatility >= 0)
  ) {
    refuse(
      'planning.montecarlo_crypto_invalid',
      'crypto',
      `ν within ${String(e.minDegreesOfFreedom)}..${String(e.maxDegreesOfFreedom)}, a holding and σ ≥ 0`,
    );
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export type SpawnWorker = (url: URL, options: WorkerOptions) => Worker;

export interface HostOptions {
  readonly deadlineMs?: number;
  /** Injected by the worker-limits test to observe (or count) spawns. Default: `new Worker`. */
  readonly spawn?: SpawnWorker;
}

/** The options every Monte Carlo worker is created with. Exported so the tests can assert them. */
export function workerOptions(request: WorkerRequest): WorkerOptions {
  return {
    workerData: request,
    env: {},
    execArgv: [],
    resourceLimits: { ...WORKER_RESOURCE_LIMITS },
    name: 'personalfi-montecarlo',
  };
}

const defaultSpawn: SpawnWorker = (url, options) => new Worker(url, options);

/**
 * Run one request in a fresh worker. Resolves with its single reply; rejects
 * with `MonteCarloTimeout` after `deadlineMs` — having called `terminate()` —
 * or `MonteCarloWorkerFailed` if the thread dies first.
 */
export function inWorker(request: WorkerRequest, options: HostOptions = {}): Promise<WorkerReply> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const spawn = options.spawn ?? defaultSpawn;
  return new Promise<WorkerReply>((resolve, reject) => {
    const worker = spawn(WORKER_URL, workerOptions(request));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => {
        // Terminate, do not await: the caller is answered now, and the thread is torn down.
        void worker.terminate();
        reject(new MonteCarloTimeout(deadlineMs));
      });
    }, deadlineMs);
    worker.once('message', (reply: WorkerReply) => {
      finish(() => {
        resolve(reply);
      });
    });
    worker.once('error', (error: Error & { code?: string }) => {
      finish(() => {
        reject(new MonteCarloWorkerFailed(error.message, error.code ?? null));
      });
    });
    worker.once('exit', (exitCode) => {
      finish(() => {
        reject(new MonteCarloWorkerFailed(`exited ${String(exitCode)} without a reply`, null));
      });
    });
  });
}

export interface WorkerRun {
  readonly result: MonteCarloResult;
  /** Wall time, spawn to reply. Not part of the result's bytes: a duration is not a result. */
  readonly durationMs: number;
  /** The worker thread's own CPU time, start to reply (08 §7.2's "single core" measure). */
  readonly threadCpuMs: number;
}

/** Envelope, spawn, run. The engine-unit entry point (the perf and reproducibility tests use it). */
export async function runJobInWorker(
  job: MonteCarloJob,
  options: HostOptions = {},
): Promise<WorkerRun> {
  assertWithinEnvelope(job);
  const started = performance.now();
  const reply = await inWorker(
    { kind: 'run', job: { ...job, seed: canonicalSeed(job.seed) } },
    options,
  );
  if (reply.kind !== 'run')
    throw new MonteCarloWorkerFailed(`unexpected ${reply.kind} reply`, null);
  return {
    result: reply.result,
    durationMs: performance.now() - started,
    threadCpuMs: reply.threadCpuMs,
  };
}

/** Ask a worker what it was given (environment keys, execArgv, resource limits). */
export async function probeWorker(
  options: HostOptions = {},
): Promise<Extract<WorkerReply, { kind: 'probe' }>> {
  const reply = await inWorker({ kind: 'probe' }, options);
  if (reply.kind !== 'probe')
    throw new MonteCarloWorkerFailed(`unexpected ${reply.kind} reply`, null);
  return reply;
}

// ---------------------------------------------------------------------------
// The Money-facing side
// ---------------------------------------------------------------------------

export interface MonteCarloRequest {
  readonly plan: ProjectionPlan;
  readonly assumptions: AssumptionsLike;
  /** Stored on the run (WP 4.6) unsigned; a 64-bit pattern, signed or unsigned representation. */
  readonly seed: bigint;
  /** Default 10,000 (07 §5.3). */
  readonly paths?: number;
  /** Default `bootstrap` (07 §5.3, dispatch §6 Q2); `lognormal` for sensitivity. */
  readonly engine?: EngineKind;
  /** The vendored/fetched real monthly series (`data/returns/series.ts`); required for `bootstrap`. */
  readonly series?: ReturnSeries | null;
  /** Crypto held today, its own class (07 §6.4). Absent or zero: no crypto. */
  readonly cryptoHolding?: Money | null;
}

/**
 * Convert once: the plan through `toEnginePlan`, the market parameters through
 * `boundary.ts#monteCarloMarketFrom`, the crypto holding through the boundary's
 * own crossing (currency-checked, non-negative, exact to 2^53).
 */
export function toMonteCarloJob(request: MonteCarloRequest): MonteCarloJob {
  const plan = toEnginePlan(request.plan, request.assumptions);
  const code = planCurrency(request.plan);
  const market = monteCarloMarketFrom(request.assumptions);
  return {
    plan,
    engine: request.engine ?? 'bootstrap',
    series: request.series ?? null,
    volatility: market.volatility,
    correlation: market.correlation,
    crypto: { holding: toEngineCryptoHolding(request.cryptoHolding, code), ...market.crypto },
    // Canonical (unsigned) when it is a 64-bit pattern; anything else is left for the envelope to refuse.
    seed:
      request.seed >= -(2n ** 63n) && request.seed < 2n ** 64n
        ? canonicalSeed(request.seed)
        : request.seed,
    paths: request.paths ?? DEFAULT_PATHS,
    extra: NO_EXTRA,
  };
}

export interface MoneyBand {
  /** `'0.05'` … `'0.95'`. */
  readonly level: string;
  /** Real (today's) year-end wealth, one per projected year. */
  readonly byYear: readonly Money[];
}

export interface SequenceDecile {
  /** 1 = the worst first-five-retirement-year returns. */
  readonly decile: number;
  /** Annualised real portfolio return, decimal strings. */
  readonly lowestReturn: string;
  readonly highestReturn: string;
  readonly paths: number;
  readonly successProbability: string;
}

/** The result WP 4.6 stores and WP 4.8 serves: Money and decimal strings, never a float. */
export interface MonteCarloSummary {
  readonly monteCarloVersion: string;
  readonly engineVersion: string;
  readonly engine: EngineKind;
  readonly seriesId: string | null;
  readonly seed: bigint;
  readonly paths: number;
  readonly startAge: number;
  readonly startYear: number;
  readonly successCount: number;
  readonly successProbability: string;
  readonly bands: readonly MoneyBand[];
  readonly failure: {
    readonly paths: number;
    readonly medianDepletionAge: number | null;
    readonly medianShortfallYears: number | null;
    readonly medianShortfallTotal: Money | null;
  };
  /** 07 §5.6: "worst-case spending cut in the 5th-percentile path", as the 95th percentile of per-path cuts. */
  readonly worstSpendingCutP95: string;
  readonly sequence: {
    readonly startAge: number;
    readonly years: number;
    readonly deciles: readonly SequenceDecile[];
  } | null;
  /** 07 §6.4 treatment 2, and treatment 1's disclaimer, whenever crypto is held. */
  readonly crypto: {
    readonly withoutCryptoSuccessProbability: string;
    readonly withoutCryptoMedianTerminal: Money;
    readonly disclaimer: string;
  } | null;
}

function probability(count: number, paths: number): string {
  return fromEngineRatio(count / paths, 6);
}

/** Every engine float → Money (rounded once, by the boundary) or a decimal string. */
export function toMonteCarloSummary(
  result: MonteCarloResult,
  request: MonteCarloRequest,
): MonteCarloSummary {
  const code = planCurrency(request.plan);
  const years = result.years;
  const money = (dollars: number, field: string) => solverMoney(dollars, code, field);
  const bands = result.levels.map((level, l) => ({
    level: fromEngineRatio(level, 2),
    byYear: Array.from({ length: years }, (_, t) =>
      money(result.bands[l * years + t] ?? Number.NaN, `bands.${String(level)}.${String(t)}`),
    ),
  }));
  const failed = result.failure.count;
  const sequence =
    result.sequence === null
      ? null
      : {
          startAge: result.sequence.startAge,
          years: result.sequence.years,
          deciles: Array.from({ length: SEQUENCE_DECILES }, (_, d) => {
            const row = result.sequence?.deciles.subarray(
              d * SEQUENCE_COLUMNS,
              (d + 1) * SEQUENCE_COLUMNS,
            );
            const paths = row?.[2] ?? 0;
            return {
              decile: d + 1,
              lowestReturn: fromEngineRatio(row?.[0] ?? Number.NaN, 6),
              highestReturn: fromEngineRatio(row?.[1] ?? Number.NaN, 6),
              paths,
              successProbability: probability(row?.[3] ?? 0, paths),
            };
          }),
        };
  const median = PERCENTILE_LEVELS.indexOf(0.5);
  const crypto =
    result.withoutCrypto === null
      ? null
      : {
          withoutCryptoSuccessProbability: probability(
            result.withoutCrypto.successCount,
            result.paths,
          ),
          withoutCryptoMedianTerminal: money(
            result.withoutCrypto.bands[median * years + years - 1] ?? Number.NaN,
            'withoutCrypto.medianTerminal',
          ),
          disclaimer: monteCarloMarketFrom(request.assumptions).cryptoDisclaimer,
        };
  return {
    monteCarloVersion: result.monteCarloVersion,
    engineVersion: result.engineVersion,
    engine: result.engine,
    seriesId: result.seriesId,
    seed: result.seed,
    paths: result.paths,
    startAge: result.startAge,
    startYear: result.startYear,
    successCount: result.successCount,
    successProbability: probability(result.successCount, result.paths),
    bands,
    failure: {
      paths: failed,
      medianDepletionAge: failed === 0 ? null : result.failure.medianDepletionAge,
      medianShortfallYears: failed === 0 ? null : result.failure.medianShortfallYears,
      medianShortfallTotal:
        failed === 0
          ? null
          : money(result.failure.medianShortfallTotal, 'failure.medianShortfallTotal'),
    },
    worstSpendingCutP95: fromEngineRatio(result.worstCutP95, 6),
    sequence,
    crypto,
  };
}

export interface MonteCarloRun extends WorkerRun {
  readonly summary: MonteCarloSummary;
}

/** The Money-facing entry point: convert, check the envelope, run in a worker, convert back. */
export async function runMonteCarloInWorker(
  request: MonteCarloRequest,
  options: HostOptions = {},
): Promise<MonteCarloRun> {
  const run = await runJobInWorker(toMonteCarloJob(request), options);
  return { ...run, summary: toMonteCarloSummary(run.result, request) };
}

// ---------------------------------------------------------------------------
// The probability-targeted solver (09 GOAL-7)
// ---------------------------------------------------------------------------

/** 09 GOAL-7's stated default and 07 R2's threshold (dispatch §6 Q5). */
export const DEFAULT_SUCCESS_TARGET = '0.80';

export interface ProbabilitySavingsRequest {
  readonly objective: RequiredSavingsObjective;
  /** A decimal string in (0, 1]. Default `'0.80'`. */
  readonly target?: string;
  /** The most the household can add per month. */
  readonly maxMonthly: Money;
}

export type ProbabilitySavingsResult =
  | { readonly kind: 'already_met'; readonly monthly: Money; readonly successProbability: string }
  | {
      readonly kind: 'required';
      readonly monthly: Money;
      readonly successProbability: string;
      readonly iterations: number;
      /** Always true: this exact Money was simulated over the same shocks and met the target. */
      readonly verified: true;
    }
  | {
      readonly kind: 'unreachable';
      readonly constraint:
        | {
            readonly name: 'no_contribution_window';
            readonly detail: string;
            readonly contributionsEndAge: number;
          }
        | {
            readonly name: 'monthly_ceiling';
            readonly detail: string;
            readonly ceiling: Money;
            readonly successProbabilityAtCeiling: string;
          };
    };

/**
 * The additional monthly saving that lifts the plan's success probability to
 * the target, bisected over the Monte Carlo under common random numbers — so
 * the answer is the same on every re-run by construction (09 GOAL-7).
 */
export async function solveProbabilityInWorker(
  request: MonteCarloRequest,
  savings: ProbabilitySavingsRequest,
  options: HostOptions = {},
): Promise<ProbabilitySavingsResult> {
  const job = toMonteCarloJob(request);
  const code = planCurrency(request.plan);
  const ratio = toEngineRate(savings.target ?? DEFAULT_SUCCESS_TARGET, 'target');
  if (!(ratio > 0 && ratio <= 1)) {
    refuse('planning.montecarlo_target_invalid', 'target', 'a success probability within (0, 1]');
  }
  let objective: SuccessObjective = { kind: 'sustain' };
  if (savings.objective.kind === 'wealth_at') {
    const years = wholeYearsFrom(request.plan.asOf, savings.objective.targetDate);
    if (years < 1 || years > yearsOf(job.plan)) {
      throw new ProjectionInputRefused(
        'planning.projection_target_outside_plan',
        'objective.targetDate',
        `is ${String(years)} years out; the plan runs ${String(yearsOf(job.plan))}`,
      );
    }
    objective = {
      kind: 'wealth_at',
      yearIndex: years - 1,
      target: toEngineTarget(
        savings.objective.target,
        code,
        savings.objective.basis,
        years,
        job.plan.inflation,
      ),
    };
  }
  assertWithinEnvelope(job);
  // ⌈ratio × paths⌉; the epsilon keeps 0.8 × 10,000 at 8,000 rather than 8,001.
  const requiredCount = Math.ceil(ratio * job.paths - 1e-9);
  const ceilingAnnual = toEngineCeiling(savings.maxMonthly, code);
  const reply = await inWorker(
    { kind: 'solve', job, target: { objective, requiredCount, ceilingAnnual } },
    { deadlineMs: DEFAULT_SOLVE_DEADLINE_MS, ...options },
  );
  if (reply.kind !== 'solve')
    throw new MonteCarloWorkerFailed(`unexpected ${reply.kind} reply`, null);
  return toProbabilitySavings(reply.outcome, job, code, savings);
}

function toProbabilitySavings(
  outcome: SuccessSolveOutcome,
  job: MonteCarloJob,
  code: ReturnType<typeof planCurrency>,
  savings: ProbabilitySavingsRequest,
): ProbabilitySavingsResult {
  switch (outcome.kind) {
    case 'already_met':
      return {
        kind: 'already_met',
        monthly: solverMoney(0, code, 'requiredMonthly'),
        successProbability: probability(outcome.metCount, job.paths),
      };
    case 'required': {
      const monthly = monthlyFromAnnual(outcome.annual, code);
      // The Money handed back must be the exact amount the worker verified.
      if (annualFromMonthly(monthly, code) !== outcome.annual) {
        throw new Error(
          'solveProbabilityInWorker: the verified cents did not survive the boundary',
        );
      }
      return {
        kind: 'required',
        monthly,
        successProbability: probability(outcome.metCount, job.paths),
        iterations: outcome.iterations,
        verified: true,
      };
    }
    case 'unreachable':
      if (outcome.constraint === 'no_contribution_window') {
        return {
          kind: 'unreachable',
          constraint: {
            name: 'no_contribution_window',
            detail:
              `contributions stop at age ${String(outcome.untilAge)}, which is not after today's age: ` +
              'no additional saving can lift the probability — only spending, the retirement age or ' +
              'the target date can',
            contributionsEndAge: outcome.untilAge,
          },
        };
      }
      return {
        kind: 'unreachable',
        constraint: {
          name: 'monthly_ceiling',
          detail:
            'even the most this household can add each month leaves the success probability below ' +
            'the target; the probability at that ceiling is shown',
          ceiling: savings.maxMonthly,
          successProbabilityAtCeiling: probability(outcome.metCountAtCeiling, job.paths),
        },
      };
  }
}
