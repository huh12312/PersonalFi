// SPDX-License-Identifier: MIT
/**
 * Shared plumbing for the budget tests under `apps/api/test/db/` (WP 9.9).
 *
 * Not a test file (`api-db` collects `test/db/*.test.ts`), so nothing here is
 * run on its own. It exists so that every timing test prints its number the same
 * way — with the host's load average beside it (09 §3 rule 4) — and so that the
 * one decision about what a loaded host means lives in one place.
 *
 * ## The decision (09 §3 WP 9.9 item (j))
 *
 * Two budget tests read red under host load in the week this was written:
 * `GET /holdings` p95 354.6 ms at load ~7, and the reports route p95 1,399 ms at
 * load 7.99 against 37.8 ms alone. Neither was a regression. The options were to
 * leave them (a red that trains everyone to re-run until green), to skip above a
 * load threshold before measuring (a green that measured nothing, and a load
 * average that the test's own corpus load has already inflated), or this:
 *
 *   * a reading that is **inside** the budget passes, at any load;
 *   * a reading that is **over** the budget on a host whose 1-minute load
 *     average is **below** `HOST_LOAD_CEILING` fails: the machine was quiet, so
 *     the number is believed;
 *   * a reading that is over the budget on a host **at or above** the ceiling is
 *     reported as a skip named `HOST_LOADED`, with the load and the reading in
 *     the skip note. Rule 4: no performance number is believed on a loaded host,
 *     and a red that cannot be believed is not allowed to look like a regression.
 *
 * The skip is visible (vitest prints it; `scripts/check-perf-skips.ts` lists
 * every file that can take it, by name, and CI writes the list into the step
 * summary). It can never hide a row-count sanity check, which is a separate `it`
 * with no skip of its own. It cannot fire on a passing reading, so a regression
 * is hidden only while the host is loaded — which is exactly when no one can
 * tell a regression from the host.
 *
 * The ceiling is 3, the same figure rule 4 gives for taking evidence numbers.
 */
import { appendFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { expect, type TestContext } from 'vitest';

/** 09 §3 rule 4's figure: a number taken at or above this 1-minute load is informational. */
export const HOST_LOAD_CEILING = 3;

export function percentile(samplesAscending: readonly number[], p: number): number {
  const index = Math.floor(samplesAscending.length * p);
  return samplesAscending[Math.min(index, samplesAscending.length - 1)] ?? 0;
}

export interface Load {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

export function currentLoad(): Load {
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { one, five, fifteen };
}

/** `load 1.23 0.88 0.50 (8 cores)` — printed beside every number. */
export function describeLoad(load: Load = currentLoad()): string {
  return (
    `load ${load.one.toFixed(2)} ${load.five.toFixed(2)} ${load.fifteen.toFixed(2)} ` +
    `(${String(cpus().length)} cores)`
  );
}

export interface Measured {
  readonly label: string;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly samples: readonly number[];
  /** The 1-minute load average when the last sample finished. */
  readonly load: Load;
}

/** One timed `GET`, body drained: otherwise it times the headers, not the answer. */
export async function timeGet(base: string, path: string, cookie: string): Promise<number> {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  await response.arrayBuffer();
  const elapsed = performance.now() - start;
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${String(response.status)}`);
  }
  return elapsed;
}

export interface MeasureOptions {
  readonly warmups?: number;
  readonly samples?: number;
}

/** Warm-ups excluded; every sample kept and printed, because p50 against p95 is evidence. */
export async function measureGet(
  label: string,
  base: string,
  path: string,
  cookie: string,
  options: MeasureOptions = {},
): Promise<Measured> {
  const warmups = options.warmups ?? 3;
  const count = options.samples ?? 40;
  for (let i = 0; i < warmups; i += 1) await timeGet(base, path, cookie);
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) samples.push(await timeGet(base, path, cookie));
  return summarise(label, samples);
}

export function summarise(label: string, rawSamples: readonly number[]): Measured {
  const samples = [...rawSamples].sort((a, b) => a - b);
  const measured: Measured = {
    label,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.at(-1) ?? 0,
    samples,
    load: currentLoad(),
  };
  report(measured);
  return measured;
}

/** The printed line, and — when `PERF_RESULTS_FILE` is set — one JSON line for the evidence table. */
export function report(measured: Measured, extra: Record<string, unknown> = {}): void {
  process.stdout.write(
    `perf ${measured.label}: p50=${measured.p50.toFixed(1)}ms p95=${measured.p95.toFixed(1)}ms ` +
      `max=${measured.max.toFixed(1)}ms n=${String(measured.samples.length)} ` +
      `${describeLoad(measured.load)} ` +
      `samples=${JSON.stringify(measured.samples.map((s) => Math.round(s)))}\n`,
  );
  const file = process.env['PERF_RESULTS_FILE'];
  if (file !== undefined && file !== '') {
    appendFileSync(
      file,
      `${JSON.stringify({
        label: measured.label,
        p50: Number(measured.p50.toFixed(2)),
        p95: Number(measured.p95.toFixed(2)),
        max: Number(measured.max.toFixed(2)),
        n: measured.samples.length,
        load: measured.load,
        cores: cpus().length,
        at: new Date().toISOString(),
        ...extra,
      })}\n`,
    );
  }
}

/** Record a non-sampled figure (a duration, a count) the same way. */
export function recordFigure(label: string, figure: Record<string, unknown>): void {
  process.stdout.write(`perf ${label}: ${JSON.stringify(figure)} ${describeLoad()}\n`);
  const file = process.env['PERF_RESULTS_FILE'];
  if (file !== undefined && file !== '') {
    appendFileSync(
      file,
      `${JSON.stringify({ label, ...figure, load: currentLoad(), cores: cpus().length, at: new Date().toISOString() })}\n`,
    );
  }
}

export interface BudgetCheck {
  readonly label: string;
  readonly p95: number;
  readonly budgetMs: number;
}

/**
 * Assert every reading is inside its budget, or skip as `HOST_LOADED` (see the
 * file comment). Call it from the test body, after the samples are taken, so the
 * load it reads is the load the samples were taken under. Several checks are
 * judged together: any over-budget reading on a quiet host fails the test, and
 * otherwise any over-budget reading on a loaded host skips it, so one reading's
 * skip never hides another's pass-or-fail.
 */
export function assertWithinBudget(
  ctx: TestContext,
  checks: BudgetCheck | readonly BudgetCheck[],
): void {
  const list: readonly BudgetCheck[] = Array.isArray(checks)
    ? (checks as readonly BudgetCheck[])
    : [checks as BudgetCheck];
  const over = list.filter((check) => !(check.p95 < check.budgetMs));
  if (over.length === 0) {
    for (const check of list) expect(check.p95, check.label).toBeLessThan(check.budgetMs);
    return;
  }
  const load = currentLoad();
  if (load.one >= HOST_LOAD_CEILING) {
    ctx.skip(
      `HOST_LOADED: ${over
        .map(
          (check) => `${check.label} p95 ${check.p95.toFixed(1)} ms > ${String(check.budgetMs)} ms`,
        )
        .join('; ')} at ${describeLoad(load)}; the 1-minute load is at or above ` +
        `${String(HOST_LOAD_CEILING)}, so the reading is not believed (09 §3 rule 4). Re-run alone.`,
    );
    return;
  }
  for (const check of over) {
    expect(
      check.p95,
      `${check.label} over its budget at ${describeLoad(load)} (a quiet host: believed)`,
    ).toBeLessThan(check.budgetMs);
  }
}

/**
 * Skip from inside a test body, by name. For the cases only the body can know
 * (a 409 that says the Monte Carlo runner is not bound). `name` must be declared
 * by a `// perf-skip: NAME — reason` comment in the calling file, and
 * `scripts/check-perf-skips.ts` lists the call site by that name.
 */
export function skipNamed(ctx: TestContext, name: string, detail: string): void {
  ctx.skip(`${name}: ${detail} (${describeLoad()})`);
}

/**
 * Wait for the 1-minute load average to fall below the ceiling, up to
 * `maxWaitMs`, then carry on either way and say what happened. A corpus load
 * (50k rows through the write path, or eight Plaid backfills) lifts the load
 * average for a minute or two on its own, and a number taken straight after it
 * would be measuring the load it just made. Waiting changes nothing about the
 * budget: if the host is still loaded when the wait runs out, the reading is
 * taken, printed with its load, and `assertWithinBudget` treats it as it treats
 * any reading at that load.
 */
export async function settleLoad(maxWaitMs = 240_000): Promise<{ waitedMs: number; load: Load }> {
  const started = Date.now();
  let load = currentLoad();
  // On a shared CI runner the timing assertions are skipped by name
  // (ON_SHARED_RUNNER), so there is nothing worth waiting for.
  if (process.env['CI'] !== undefined) return { waitedMs: 0, load };
  while (load.one >= HOST_LOAD_CEILING && Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    load = currentLoad();
  }
  const waitedMs = Date.now() - started;
  process.stdout.write(
    `perf settle: waited ${(waitedMs / 1_000).toFixed(1)} s for the load to fall below ` +
      `${String(HOST_LOAD_CEILING)}; now ${describeLoad(load)}` +
      `${load.one >= HOST_LOAD_CEILING ? ' (STILL LOADED: informational)' : ''}\n`,
  );
  return { waitedMs, load };
}
