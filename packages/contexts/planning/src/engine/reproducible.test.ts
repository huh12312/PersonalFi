// SPDX-License-Identifier: MIT
/**
 * WP 4.5 — "identical seed ⇒ identical bytes" (the §5 exit criterion and the
 * v0.6 rung), proven the way dispatch §5 says it must be: **serialised bytes,
 * compared across two separate node processes**, never objects in one. An
 * in-process re-run would share every module-level cache, every JIT decision
 * and every accidental global, and would pass against a `Math.random()` seeded
 * once per process just as happily.
 *
 * Each child process imports the engine cold, runs the job **through the
 * worker thread** (`runJobInWorker` — the production path, envelope and all),
 * serialises the result with `serialiseResult` and prints its pid, its SHA-256
 * and the bytes. The parent compares the bytes with `Buffer.equals`. Both
 * engines, with crypto held, so the dual projection's bands are in the bytes.
 *
 * The control: a different seed must produce different bytes — without it,
 * the first test would pass against an engine that ignored the seed entirely
 * (which is the first sabotage in the evidence).
 *
 * Lives in `src/engine/` because the `planning` project's include is `src/**`
 * + `test/*.test.ts` (the WP 4.4 precedent; see its evidence).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newXoshiro, nextDouble, nextWord, seedHalves, seedStream, splitMix64Word } from './prng.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const FIXTURES = resolve(import.meta.dirname, '../../test/engine/fixtures');

interface ChildRun {
  readonly engine: string;
  readonly sha256: string;
  readonly bytes: string;
  readonly successCount: number;
}
interface ChildOutput {
  readonly pid: number;
  readonly runs: readonly ChildRun[];
}

/** One cold process: both engines through the worker, serialised. */
function runInChild(seed: bigint): ChildOutput {
  const script = `
    import { createHash } from 'node:crypto';
    import { loadAssumptions } from './packages/contexts/planning/src/assumptions.ts';
    import { runJobInWorker, toMonteCarloJob } from './packages/contexts/planning/src/engine/worker-host.ts';
    import { serialiseResult } from './packages/contexts/planning/src/engine/montecarlo.ts';
    import { syntheticSeries } from './packages/contexts/planning/test/engine/fixtures/synthetic-series.ts';
    import { referencePlan, usd } from './packages/contexts/planning/test/engine/support.ts';
    const seed = BigInt(process.argv[1]);
    const runs = [];
    for (const engine of ['bootstrap', 'lognormal']) {
      const job = toMonteCarloJob({
        plan: referencePlan('B'),
        assumptions: loadAssumptions(),
        seed,
        paths: 2000,
        engine,
        series: syntheticSeries(),
        cryptoHolding: usd('25000'),
      });
      const { result } = await runJobInWorker(job, { deadlineMs: 20000 });
      const bytes = serialiseResult(result);
      runs.push({
        engine,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: Buffer.from(bytes).toString('base64'),
        successCount: result.successCount,
      });
    }
    process.stdout.write(JSON.stringify({ pid: process.pid, runs }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script, seed.toString()], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as ChildOutput;
}

describe('reproducibility', () => {
  it('an identical seed produces byte-identical output across two processes', () => {
    const first = runInChild(20_260_910n);
    const second = runInChild(20_260_910n);
    expect(first.pid).not.toBe(second.pid);
    expect(first.runs.map((run) => run.engine)).toEqual(['bootstrap', 'lognormal']);
    first.runs.forEach((run, i) => {
      const other = second.runs[i];
      if (other === undefined) throw new Error('the second process reported fewer runs');
      const a = Buffer.from(run.bytes, 'base64');
      const b = Buffer.from(other.bytes, 'base64');
      // Bytes, not objects: a 7-band × 60-year Float64 payload plus the header, compared whole.
      expect(a.length).toBeGreaterThan(7 * 60 * 8);
      expect(a.equals(b), `${run.engine}: the two processes' bytes differ`).toBe(true);
      expect(run.sha256).toBe(other.sha256);
      console.log(
        `[reproducible] ${run.engine}: pid ${String(first.pid)} sha256 ${run.sha256} | ` +
          `pid ${String(second.pid)} sha256 ${other.sha256} | ${String(a.length)} bytes`,
      );
    });
    // Two cold processes, each importing the assumptions file and spawning two workers.
  }, 30_000);

  it('a different seed produces different output', () => {
    const base = runInChild(20_260_910n);
    const other = runInChild(20_260_911n);
    base.runs.forEach((run, i) => {
      const next = other.runs[i];
      if (next === undefined) throw new Error('the second process reported fewer runs');
      expect(run.sha256, `${run.engine}: seed ignored`).not.toBe(next.sha256);
      // Not just a header difference: the bands themselves moved.
      const a = Buffer.from(run.bytes, 'base64');
      const b = Buffer.from(next.bytes, 'base64');
      const headerEnd = a.indexOf(10, a.indexOf(10) + 1) + 1;
      expect(a.subarray(headerEnd).equals(b.subarray(headerEnd)), `${run.engine}: bands identical`).toBe(
        false,
      );
      console.log(
        `[reproducible] ${run.engine}: seed 20260910 → ${run.sha256}, seed 20260911 → ${next.sha256}`,
      );
    });
  }, 30_000);

  it('xoshiro256++ and SplitMix64 reproduce the reference C, word for word and double for double', () => {
    // test/engine/fixtures/xoshiro-vectors.json, produced by compiling xoshiro-reference.c beside it.
    const vectors = JSON.parse(readFileSync(resolve(FIXTURES, 'xoshiro-vectors.json'), 'utf8')) as {
      readonly cases: readonly {
        readonly seed: string;
        readonly splitmix64: readonly string[];
        readonly path0MarketOutputs: readonly string[];
        readonly path1MarketOutputs: readonly string[];
        readonly path0MarketDoubles: readonly string[];
      }[];
    };
    const hex = (out: Uint32Array) =>
      (out[0] ?? 0).toString(16).padStart(8, '0') + (out[1] ?? 0).toString(16).padStart(8, '0');
    expect(vectors.cases.length).toBe(6);
    for (const c of vectors.cases) {
      const seed = BigInt.asIntN(64, BigInt(`0x${c.seed}`));
      const [hi, lo] = seedHalves(seed);
      const out = new Uint32Array(2);
      c.splitmix64.forEach((word, k) => {
        splitMix64Word(hi, lo, k, out);
        expect(hex(out), `splitmix64 word ${String(k)} of seed ${c.seed}`).toBe(word);
      });
      const g = newXoshiro();
      for (const [path, words] of [
        [0, c.path0MarketOutputs],
        [1, c.path1MarketOutputs],
      ] as const) {
        seedStream(g, hi, lo, path, 0);
        for (const word of words) {
          nextWord(g, out);
          expect(hex(out)).toBe(word);
        }
      }
      // The pooled path (64 doubles per refill), across a refill boundary.
      seedStream(g, hi, lo, 0, 0);
      for (const text of c.path0MarketDoubles) expect(nextDouble(g)).toBe(Number(text));
    }
  });
});
