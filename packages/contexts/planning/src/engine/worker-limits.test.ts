// SPDX-License-Identifier: MIT
/**
 * WP 4.5 — the Monte Carlo worker is a bounded resource (dispatch §5, "the
 * Monte Carlo worker is an unbounded resource"; 08 §7.2, §7.4).
 *
 *   * `'a request for 10,000,000 paths is refused before a worker is spawned'`
 *     — the envelope runs first, on every entry point, and the spawn function is
 *     never called: a counting `spawn` is injected and must read zero.
 *   * `'a worker that exceeds its deadline is terminated and the caller receives
 *     a typed timeout, not a hang'` — twice: the real engine given a deadline it
 *     cannot meet, and a worker that **never** finishes (`for (;;) {}`), which
 *     only `terminate()` can stop. The caller's promise must reject with
 *     `MonteCarloTimeout` within the deadline plus a small margin, and the
 *     thread's `exit` must be observed — a rejected promise over a still-running
 *     thread would be a leak dressed as a timeout.
 *   * `'the worker inherits no environment and no execArgv'` — proven in a child
 *     process that *has* both (a secret in its environment, flags in its
 *     execArgv), so an empty answer cannot be an accident of the test runner's
 *     own empty environment.
 *
 * Plus the limits' own proof: a heap-hungry thread under the same options dies
 * with `ERR_WORKER_OUT_OF_MEMORY` and the caller gets a typed failure, not a
 * dead process.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAssumptions } from '../assumptions.ts';
import { referencePlan, usd } from '../../test/engine/support.ts';
import type { ProjectionPlan } from './boundary.ts';
import {
  MONTE_CARLO_ENVELOPE,
  MonteCarloRefused,
  MonteCarloTimeout,
  MonteCarloWorkerFailed,
  WORKER_RESOURCE_LIMITS,
  inWorker,
  probeWorker,
  runJobInWorker,
  runMonteCarloInWorker,
  solveProbabilityInWorker,
  toMonteCarloJob,
  type SpawnWorker,
} from './worker-host.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const assumptions = loadAssumptions();

/** Every worker a test spawns, so none outlives it even when an assertion fails first. */
const live: Worker[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((worker) => worker.terminate()));
});

interface Observed {
  readonly spawn: SpawnWorker;
  readonly spawned: () => number;
  /** Resolves with the exit code of the n-th spawned worker. */
  readonly exited: (n: number) => Promise<number>;
}

/** A spawn that records every call; `make` decides what is actually started. */
function observe(
  make: (url: URL, options: WorkerOptions) => Worker = (url, options) => new Worker(url, options),
): Observed {
  const exits: Promise<number>[] = [];
  return {
    spawn: (url, options) => {
      const worker = make(url, options);
      live.push(worker);
      exits.push(new Promise((resolveExit) => worker.once('exit', resolveExit)));
      return worker;
    },
    spawned: () => exits.length,
    exited: (n) => exits[n] ?? Promise.reject(new Error(`worker ${String(n)} was never spawned`)),
  };
}

/** Reject if `promise` has not settled within `ms` — so a hang is a red test, not a stuck suite. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const sentinel = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: still pending after ${String(ms)} ms — a hang`));
    }, ms);
  });
  return Promise.race([promise, sentinel]).finally(() => {
    clearTimeout(timer);
  });
}

describe('the envelope', () => {
  it('a request for 10,000,000 paths is refused before a worker is spawned', async () => {
    const plan = referencePlan('B');
    const job = toMonteCarloJob({
      plan,
      assumptions,
      seed: 1n,
      engine: 'lognormal',
      paths: 10_000_000,
    });
    // A spy that would start a thread which exits at once — so if the envelope is ever bypassed the
    // test fails on the count and on the error type, without allocating 10,000,000 × 60 cells.
    const spy = observe((_url, options) => new Worker('', { ...options, eval: true }));
    const started = performance.now();
    await expect(runJobInWorker(job, { spawn: spy.spawn })).rejects.toMatchObject({
      name: 'MonteCarloRefused',
      code: 'planning.montecarlo_paths_outside_envelope',
      field: 'paths',
    });
    const refusedInMs = performance.now() - started;
    expect(spy.spawned()).toBe(0);

    // The Money-facing entry points refuse the same way, before spawning.
    const request = {
      plan,
      assumptions,
      seed: 1n,
      engine: 'lognormal' as const,
      paths: 10_000_000,
    };
    await expect(runMonteCarloInWorker(request, { spawn: spy.spawn })).rejects.toBeInstanceOf(
      MonteCarloRefused,
    );
    await expect(
      solveProbabilityInWorker(
        request,
        { objective: { kind: 'sustain_to_plan_end' }, maxMonthly: usd('5000') },
        { spawn: spy.spawn },
      ),
    ).rejects.toBeInstanceOf(MonteCarloRefused);
    expect(spy.spawned()).toBe(0);

    // The rest of the envelope, each named: horizon, path × year product, seed, series.
    const long: ProjectionPlan = { ...plan, birthDate: plan.asOf, planEndAge: 101 };
    const refusals: readonly (readonly [string, Parameters<typeof runJobInWorker>[0]])[] = [
      [
        'planning.montecarlo_horizon_outside_envelope',
        toMonteCarloJob({ plan: long, assumptions, seed: 1n, engine: 'lognormal', paths: 10 }),
      ],
      [
        'planning.montecarlo_cells_outside_envelope',
        { ...job, paths: MONTE_CARLO_ENVELOPE.maxPaths },
      ], // 20,000 × 60
      ['planning.montecarlo_paths_outside_envelope', { ...job, paths: 0 }],
      ['planning.montecarlo_paths_outside_envelope', { ...job, paths: 10.5 }],
      ['planning.montecarlo_seed_outside_envelope', { ...job, paths: 100, seed: 2n ** 64n }],
      [
        'planning.montecarlo_seed_outside_envelope',
        { ...job, paths: 100, seed: -(2n ** 63n) - 1n },
      ],
      [
        'planning.montecarlo_series_invalid',
        { ...job, paths: 100, engine: 'bootstrap', series: null },
      ],
    ];
    for (const [code, refused] of refusals) {
      await expect(runJobInWorker(refused, { spawn: spy.spawn }), code).rejects.toMatchObject({
        code,
      });
    }
    expect(spy.spawned()).toBe(0);
    console.log(
      `[worker-limits] 10,000,000 paths refused in ${refusedInMs.toFixed(2)} ms; ` +
        `${String(refusals.length + 3)} refusals, 0 spawns; envelope ${JSON.stringify(MONTE_CARLO_ENVELOPE, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  });
});

describe('the deadline', () => {
  it('a worker that exceeds its deadline is terminated and the caller receives a typed timeout, not a hang', async () => {
    // 1. The real engine, 20,000 × 50 (inside the envelope), given 100 ms.
    const plan: ProjectionPlan = { ...referencePlan('B'), planEndAge: 85 };
    const job = toMonteCarloJob({
      plan,
      assumptions,
      seed: 2n,
      engine: 'lognormal',
      paths: 20_000,
    });
    const real = observe();
    let started = performance.now();
    const slow = runJobInWorker(job, { deadlineMs: 100, spawn: real.spawn });
    await expect(within(slow, 2_000, 'the real engine past its deadline')).rejects.toBeInstanceOf(
      MonteCarloTimeout,
    );
    await slow.catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'planning.montecarlo_timeout', deadlineMs: 100 });
    });
    const answeredA = performance.now() - started;
    const exitA = await within(real.exited(0), 2_000, 'the terminated engine thread');
    const goneA = performance.now() - started;

    // 2. A thread that never finishes on its own: only terminate() can stop it.
    const forever = observe(
      (_url, options) => new Worker('for (;;) {}', { ...options, eval: true }),
    );
    started = performance.now();
    const spin = inWorker({ kind: 'probe' }, { deadlineMs: 200, spawn: forever.spawn });
    await expect(within(spin, 2_000, 'a non-terminating worker')).rejects.toBeInstanceOf(
      MonteCarloTimeout,
    );
    const answeredB = performance.now() - started;
    const exitB = await within(forever.exited(0), 2_000, 'the spinning thread');
    const goneB = performance.now() - started;

    // terminate() ends a thread with exit code 1.
    expect(exitA).toBe(1);
    expect(exitB).toBe(1);
    expect(answeredA).toBeLessThan(100 + 1_000);
    expect(answeredB).toBeLessThan(200 + 1_000);
    console.log(
      `[worker-limits] engine 20,000×50 at a 100 ms deadline: MonteCarloTimeout after ${answeredA.toFixed(0)} ms, ` +
        `thread exit ${String(exitA)} after ${goneA.toFixed(0)} ms | for(;;) at 200 ms: timeout after ` +
        `${answeredB.toFixed(0)} ms, exit ${String(exitB)} after ${goneB.toFixed(0)} ms`,
    );
  }, 15_000);

  it('a heap-hungry worker dies at its declared limit and the caller receives a typed failure', async () => {
    // The same options every Monte Carlo worker gets (workerOptions), around a thread that leaks
    // JS objects — the heap the limits bound (typed arrays are the envelope's job).
    const hungry = observe(
      (_url, options) =>
        new Worker('const keep = []; for (;;) keep.push({ a: [1, 2, 3, 4, 5, 6, 7, 8] });', {
          ...options,
          eval: true,
        }),
    );
    const failed = inWorker({ kind: 'probe' }, { deadlineMs: 30_000, spawn: hungry.spawn });
    await expect(within(failed, 30_000, 'the OOM worker')).rejects.toBeInstanceOf(
      MonteCarloWorkerFailed,
    );
    await failed.catch((error: unknown) => {
      expect(error).toMatchObject({ workerCode: 'ERR_WORKER_OUT_OF_MEMORY' });
    });
    // This process is still here to assert it.
    expect(process.memoryUsage().rss).toBeGreaterThan(0);
  }, 40_000);
});

describe('what the thread is given', () => {
  it('the worker inherits no environment and no execArgv', async () => {
    // In this process, through the real spawn.
    const here = await probeWorker({ deadlineMs: 20_000 });
    expect(here.envKeys).toEqual([]);
    expect(here.execArgv).toEqual([]);
    expect(here.resourceLimits).toMatchObject(WORKER_RESOURCE_LIMITS);

    // In a child that has a secret in its environment and flags in its execArgv.
    const script = `
      import { probeWorker } from './packages/contexts/planning/src/engine/worker-host.ts';
      const probe = await probeWorker({ deadlineMs: 20000 });
      process.stdout.write(JSON.stringify({
        parentExecArgv: process.execArgv,
        parentHasSecret: process.env.PERSONALFI_PROBE_SECRET === 'do-not-leak',
        parentEnvKeys: Object.keys(process.env).length,
        probe,
      }));
    `;
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        ['--max-old-space-size=300', '--stack-trace-limit=40', '--input-type=module', '-e', script],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PERSONALFI_PROBE_SECRET: 'do-not-leak',
            DATABASE_URL: 'postgres://secret',
          },
        },
      ),
    ) as {
      readonly parentExecArgv: readonly string[];
      readonly parentHasSecret: boolean;
      readonly parentEnvKeys: number;
      readonly probe: Awaited<ReturnType<typeof probeWorker>>;
    };
    // The control: the parent really had both.
    expect(out.parentHasSecret).toBe(true);
    expect(out.parentExecArgv).toEqual(
      expect.arrayContaining(['--max-old-space-size=300', '--stack-trace-limit=40']),
    );
    // The thread had neither.
    expect(out.probe.envKeys).toEqual([]);
    expect(out.probe.execArgv).toEqual([]);
    expect(out.probe.resourceLimits).toMatchObject(WORKER_RESOURCE_LIMITS);
    console.log(
      `[worker-limits] parent: ${String(out.parentEnvKeys)} env keys (secret present), execArgv ` +
        `${JSON.stringify(out.parentExecArgv.slice(0, 3))}… → worker: env ${JSON.stringify(out.probe.envKeys)}, execArgv ` +
        `${JSON.stringify(out.probe.execArgv)}, resourceLimits ${JSON.stringify(out.probe.resourceLimits)}, ` +
        `heap used ${out.probe.heapUsedMb.toFixed(1)} MB`,
    );
  }, 30_000);
});
