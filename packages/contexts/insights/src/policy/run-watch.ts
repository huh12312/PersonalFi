// SPDX-License-Identifier: MIT
/**
 * The run watcher: while the untrusted call is in flight, re-read every kill
 * switch and this run's own cancel flag, and abort the call on any "no".
 *
 * Before WP 5.1 the switches were read once, in transaction 1, and a switch
 * flipped mid-run changed the *next* run. For a built-in that finishes in
 * milliseconds that is the same thing; for a local model that takes minutes it
 * means "kill it" does nothing until it is finished.
 *
 * ## Why one second
 *
 * 05 §3 asks that each level, flipped in flight, ends the run within two
 * seconds. The worst case is one full poll interval plus one probe plus the
 * abort's own propagation, so the interval has to sit comfortably under two
 * seconds; one second leaves the other second for the probe (three short
 * indexed reads and two flag reads — single-digit milliseconds on this host)
 * and for the advisor to unwind. Shorter buys little: the probe is the only
 * database traffic a run makes while the model is thinking, and at 1 Hz it is
 * one small query burst a second for at most one run at a time (the local
 * lane's concurrency is 1). Longer breaks the two-second claim.
 *
 * ## What the watcher does not hold
 *
 * Each probe borrows a pooled connection for its own reads and returns it; the
 * watcher never opens a transaction and never keeps a client between ticks,
 * so the run as a whole holds **no database connection** across the model
 * call — `test/db/local-lane.test.ts` asserts it against `pg_stat_activity`.
 *
 * ## A probe that fails does not abort
 *
 * A probe that throws (a pool timeout, a restarting database) is retried on
 * the next tick rather than treated as "no". Safety does not depend on the
 * watcher: the write barrier re-reads every switch under a row lock before any
 * insert, so a run the watcher failed to stop still lands nothing. The watcher
 * is what makes a kill *prompt*; the barrier is what makes it *true*.
 *
 * ## Real timers, not the injected clock
 *
 * The poll is wall time on purpose. `Clock` is the source of every timestamp a
 * run *records*; a test's `fixedClock` never advances, and a watcher driven by
 * it would never tick.
 */
import type { CancelReason } from './kill-switches.ts';

/** At most once a second. See this file's header for the reason. */
export const RUN_WATCH_POLL_MS = 1_000;

export interface RunWatchOptions {
  /** Reads every switch and the cancel flag. `null` means "keep going". */
  readonly probe: () => Promise<CancelReason | null>;
  /** Aborted — with a `RunCancelled` reason — the first time the probe says no. */
  readonly controller: AbortController;
  readonly pollMs?: number;
  /** Told about a probe that threw. The watcher keeps polling. */
  readonly onProbeError?: (error: unknown) => void;
}

export interface RunWatch {
  /** The level that stopped the run, once one has. */
  readonly reason: () => CancelReason | null;
  /** Stop polling. Idempotent; waits for an in-flight probe to settle. */
  readonly stop: () => Promise<void>;
}

/** The abort reason the watcher uses, so the run can tell a kill from a deadline. */
export class RunCancelled extends Error {
  readonly reason: CancelReason;
  constructor(reason: CancelReason) {
    super(`advisor_run_cancelled:${reason}`);
    this.name = 'RunCancelled';
    this.reason = reason;
  }
}

export function watchRun(options: RunWatchOptions): RunWatch {
  const pollMs = options.pollMs ?? RUN_WATCH_POLL_MS;
  let stopped = false;
  let found: CancelReason | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        const reason = await options.probe();
        if (reason !== null && !stopped && found === null) {
          found = reason;
          options.controller.abort(new RunCancelled(reason));
          return;
        }
      } catch (error) {
        options.onProbeError?.(error);
      }
      if (!stopped && found === null) timer = setTimeout(tick, pollMs);
    })();
  };

  timer = setTimeout(tick, pollMs);

  return {
    reason: () => found,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
