// SPDX-License-Identifier: MIT
/**
 * The one decision the budget tests share, tested on its own (WP 9.9 item (j)):
 * what an over-budget reading means on a loaded host.
 *
 * `assertWithinBudget` is the only thing standing between "the host was busy"
 * and a gate that cries wolf, and also the only thing that could turn a real
 * regression into a skip. So it is checked from both sides, with the load
 * average under the test's control: in budget passes at any load; over budget on
 * a quiet host FAILS (it must never skip); over budget at or above the ceiling
 * is the named skip, with the reading and the load in its note; and a mixed set
 * is judged as a whole.
 *
 * Named for the rule rather than for `perf`, so `scripts/check-perf-skips.ts` does
 * not list its calls to `assertWithinBudget` (a fake context, not a skip) as skip
 * sites. It needs no database and never skips for the lack of one.
 */
import type * as NodeOs from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => ({ one: 0 }));
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>();
  return { ...original, loadavg: () => [load.one, load.one, load.one] };
});

import {
  BURST_OTHER_CORES,
  BURST_WINDOW_MS,
  HOST_LOAD_CEILING,
  assertWithinBudget,
  currentLoad,
  describeLoad,
  percentile,
  recentBurst,
  recordBusySlot,
  resetBusySlots,
  summarise,
} from './perf-support.ts';

interface FakeContext {
  readonly skip: ReturnType<typeof vi.fn>;
}

function context(): FakeContext {
  return { skip: vi.fn() };
}

const asContext = (fake: FakeContext): Parameters<typeof assertWithinBudget>[0] =>
  fake as unknown as Parameters<typeof assertWithinBudget>[0];

describe('assertWithinBudget', () => {
  beforeEach(() => {
    load.one = 0;
    resetBusySlots();
  });

  it('an in-budget reading passes at any load and never skips', () => {
    for (const host of [0.2, HOST_LOAD_CEILING, 40]) {
      load.one = host;
      const fake = context();
      expect(() =>
        assertWithinBudget(asContext(fake), { label: 'x', p95: 120, budgetMs: 200 }),
      ).not.toThrow();
      expect(fake.skip).not.toHaveBeenCalled();
    }
  });

  it('an over-budget reading on a quiet host FAILS: it is believed, never skipped', () => {
    load.one = HOST_LOAD_CEILING - 0.01;
    const fake = context();
    expect(() =>
      assertWithinBudget(asContext(fake), { label: 'GET /x', p95: 354.6, budgetMs: 200 }),
    ).toThrow(/GET \/x over its budget/);
    expect(fake.skip).not.toHaveBeenCalled();
  });

  it('an over-budget reading at the ceiling or above is the named skip, with the reading and the load', () => {
    for (const host of [HOST_LOAD_CEILING, 7.99]) {
      load.one = host;
      const fake = context();
      assertWithinBudget(asContext(fake), { label: 'GET /reports', p95: 1399, budgetMs: 200 });
      expect(fake.skip).toHaveBeenCalledTimes(1);
      const note = String(fake.skip.mock.calls[0]?.[0]);
      expect(note).toMatch(/^HOST_LOADED:/);
      expect(note).toContain('GET /reports p95 1399.0 ms > 200 ms');
      expect(note).toContain(`load ${host.toFixed(2)}`);
    }
  });

  it('a set of readings is judged together: one over budget on a quiet host fails even if another passes', () => {
    load.one = 0.5;
    const fake = context();
    expect(() =>
      assertWithinBudget(asContext(fake), [
        { label: 'a', p95: 10, budgetMs: 200 },
        { label: 'b', p95: 250, budgetMs: 200 },
      ]),
    ).toThrow(/b over its budget/);
    expect(fake.skip).not.toHaveBeenCalled();
  });

  it('a set with one over-budget reading on a loaded host skips once, naming only the offender', () => {
    load.one = 6;
    const fake = context();
    assertWithinBudget(asContext(fake), [
      { label: 'ok', p95: 10, budgetMs: 200 },
      { label: 'slow', p95: 900, budgetMs: 200 },
    ]);
    expect(fake.skip).toHaveBeenCalledTimes(1);
    const note = String(fake.skip.mock.calls[0]?.[0]);
    expect(note).toContain('slow p95 900.0 ms');
    expect(note).not.toContain('ok p95');
  });

  it('a reading exactly on the budget is over it: the budget is strict, as the tests have always been', () => {
    load.one = 0.1;
    const fake = context();
    expect(() =>
      assertWithinBudget(asContext(fake), { label: 'edge', p95: 200, budgetMs: 200 }),
    ).toThrow();
  });
});

/**
 * The gate lagged the contention it detects (WP 9.14): the Wave D verify read p95 248 ms at a 1-minute load
 * of 1.29 because sibling test workers burst for a few seconds, and the 1-minute average cannot see that.
 */
describe('a CPU burst the 1-minute load cannot see', () => {
  beforeEach(() => {
    load.one = 1.29;
    resetBusySlots();
  });

  it('an over-budget reading beside a burst is the named skip, and says why', () => {
    recordBusySlot({ atMs: Date.now() - 2_000, otherCores: BURST_OTHER_CORES + 1 });
    const fake = context();
    assertWithinBudget(asContext(fake), { label: 'list first page', p95: 248, budgetMs: 200 });
    expect(fake.skip).toHaveBeenCalledTimes(1);
    const note = String(fake.skip.mock.calls[0]?.[0]);
    expect(note).toMatch(/^HOST_LOADED:/);
    expect(note).toContain('list first page p95 248.0 ms');
    expect(note).toContain('a burst the 1-minute load cannot see');
    expect(note).toContain('load 1.29');
  });

  it('the same reading with no burst in the window still FAILS (a quiet host is believed)', () => {
    recordBusySlot({ atMs: Date.now() - 2_000, otherCores: BURST_OTHER_CORES - 0.5 });
    // A burst that ended before the window opened does not taint it either.
    recordBusySlot({ atMs: Date.now() - BURST_WINDOW_MS - 1_000, otherCores: 8 });
    const fake = context();
    expect(() =>
      assertWithinBudget(asContext(fake), { label: 'list first page', p95: 248, budgetMs: 200 }),
    ).toThrow(/list first page over its budget/);
    expect(fake.skip).not.toHaveBeenCalled();
    expect(recentBurst()).toBeNull();
  });

  it('an in-budget reading beside a burst passes: a burst can only turn a failure into a skip', () => {
    recordBusySlot({ atMs: Date.now(), otherCores: 8 });
    const fake = context();
    expect(() =>
      assertWithinBudget(asContext(fake), { label: 'x', p95: 120, budgetMs: 200 }),
    ).not.toThrow();
    expect(fake.skip).not.toHaveBeenCalled();
  });

  it('reports the worst slot inside the window', () => {
    recordBusySlot({ atMs: Date.now() - 5_000, otherCores: 3.2 });
    recordBusySlot({ atMs: Date.now() - 1_000, otherCores: 6.1 });
    expect(recentBurst()?.otherCores).toBe(6.1);
  });
});

describe('the printing helpers', () => {
  it('prints the load with its core count, and percentiles the way the budget tests always have', () => {
    load.one = 1.234;
    expect(describeLoad(currentLoad())).toMatch(/^load 1\.23 1\.23 1\.23 \(\d+ cores\)$/);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(6);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    const measured = summarise('unit', [30, 10, 20]);
    expect(measured.samples).toEqual([10, 20, 30]);
    expect(measured.p50).toBe(20);
  });
});
