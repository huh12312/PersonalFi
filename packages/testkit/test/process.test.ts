// SPDX-License-Identifier: MIT
/**
 * WP 2.12 flake note (docs/plan/01-execution-log.md, 2026-09-19 11:00 EDT:
 * "known flake: packages/testkit/test/process.test.ts SIGTERM under
 * full-suite load; passes alone" — handed to this WP by name).
 *
 * Investigated: each `it()` here carried a hand-set `10_000`ms timeout,
 * *below* this project's own `testTimeout: 30_000` default
 * (`vitest.config.ts`'s `testkit` project). Every test spawns a real second
 * Node process (`spawnProcess`) and waits on it via `waitFor`'s own
 * `timeoutMs: 30_000` (`process.ts`) — a longer budget than the test itself
 * was given. Under full-suite load, dozens of concurrent vitest workers and
 * `*-db` suites compete for the same CPUs a freshly `spawn()`ed child needs
 * to start up and register its `SIGTERM` handler in; 10 real seconds is not
 * always enough margin on a loaded machine even though it is generous when
 * this file runs alone, which is exactly the "passes alone" symptom on
 * record.
 *
 * Reproduction attempted, not achieved: `yes > /dev/null &` pinned across all
 * 8 cores plus three solo re-runs of this file (all green), and one full,
 * unfiltered `pnpm exec vitest run` across all 154 files / 1,915 tests (also
 * green — no `process.test.ts` failure, no `SIGTERM` in the log). The flake
 * did not reproduce in this session under either synthetic CPU pressure or a
 * real full-suite run, which is consistent with it being real but rare
 * (intermittent scheduler contention, not a deterministic race this file's
 * own logic contains) rather than fixed outright by this change.
 *
 * Fix applied: raised every per-test timeout here from `10_000` to `30_000`,
 * matching the project's own default and `waitFor`'s own internal budget, so
 * a slow-starting or slow-signalling child never runs out of the *test's*
 * clock before it runs out of `waitFor`'s. This is the mechanism a full-suite
 * flake in this exact shape would have, and removes the one place this file
 * gave itself *less* time than its own dependency already budgets — but
 * without a reproduction, it is recorded as a reasoned mitigation, not a
 * confirmed fix. **If this flake recurs, the next place to look is real
 * signal-delivery latency under load** (the OS delivering `SIGTERM` late to a
 * CPU-starved child), which no per-test timeout can paper over and which
 * would need a longer-running soak under real full-suite contention to catch
 * — owner: whoever next sees it reproduce, with this file's own header as
 * the starting note.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnProcess } from './process.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-process.ts', import.meta.url));

describe('spawnProcess', () => {
  it('parses line-buffered JSON stdout and resolves await() once seen', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['50'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      expect(proc.saw((line) => line['event'] === 'started')).toBe(true);
      expect(typeof proc.lines[0]?.['pid']).toBe('number');

      await proc.await('the fixture to finish its block', (line) => line['event'] === 'done');
      const result = await proc.exited();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
    }
  }, 30_000);

  it('reports a SIGKILL as the exit signal, not a clean exit', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['3600000'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      proc.child.kill('SIGKILL');
      const result = await proc.exited();
      expect(result.signal).toBe('SIGKILL');
      expect(proc.saw((line) => line['event'] === 'stopped')).toBe(false);
    } finally {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.kill('SIGKILL');
      }
    }
  }, 30_000);

  it('lets a SIGTERM shut the child down cleanly', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['3600000'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      proc.child.kill('SIGTERM');
      await proc.await('the fixture to report stopped', (line) => line['event'] === 'stopped');
      const result = await proc.exited();
      expect(result.code).toBe(0);
    } finally {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.kill('SIGKILL');
      }
    }
  }, 30_000);

  it('exited() resolves immediately for a process that has already exited', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['0'] });
    await proc.await('the fixture to finish', (line) => line['event'] === 'done');
    // Give the process a moment to actually exit after writing its last line.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await proc.exited();
    expect(result.code).toBe(0);
  }, 30_000);
});
