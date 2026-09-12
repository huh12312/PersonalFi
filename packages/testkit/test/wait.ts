// SPDX-License-Identifier: MIT
import { systemClock } from '@core/kernel';

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly what?: string;
}

/**
 * Poll until `predicate` holds or the deadline passes. Beats an arbitrary sleep.
 *
 * Reads `systemClock.nowMs()` rather than `Date.now()` directly — this is
 * shipped `src/`, not a `*.test.ts` file, so the lint ban on wall-clock reads
 * outside `Clock` still applies to it, and the deadline genuinely does need a
 * real wall clock: a test polling a spawned process or a real database has
 * nothing else to measure against.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, intervalMs = 25, what = 'condition' }: WaitForOptions = {},
): Promise<void> {
  const deadline = systemClock.nowMs() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (systemClock.nowMs() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
