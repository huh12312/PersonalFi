// SPDX-License-Identifier: MIT

/**
 * A sleep that `stop()` can cut short.
 *
 * Every loop in this package spends almost all of its life asleep: the reaper
 * waits half a reclaim window (22.5 s at the defaults), the scheduler waits a
 * tick (30 s), a consumer that lost the race for its advisory lock waits
 * `leaseRetryMs` (15 s). A plain `setTimeout` makes each of those a *floor* on
 * shutdown, because `stop()` flips `running` to false and then waits for the
 * loop promise — which is parked in the middle of a timer that does not care.
 *
 * That is not a cosmetic delay. Docker's default `docker stop` grace is ten
 * seconds; systemd's `TimeoutStopSec` is ninety but the compose file is what
 * runs here. A worker that needs twenty-two seconds to answer SIGTERM gets
 * SIGKILLed instead, and the clean shutdown path — drain in-flight jobs, release
 * the leases, close the pool — never executes. The drill in
 * `test/worker-restart.test.ts` then describes every deploy, not just a crash.
 *
 * So sleeps are registered, and `wake()` resolves all of them at once. Each
 * loop's next statement is its `while (running)` check, which is already false.
 */
export interface Sleeper {
  /** Sleep, unless and until `wake()` is called. Never rejects. */
  sleep(ms: number): Promise<void>;
  /** Resolve every pending sleep immediately. Idempotent. */
  wake(): void;
}

export function createSleeper(): Sleeper {
  const pending = new Set<() => void>();

  return {
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          if (!pending.delete(finish)) return;
          clearTimeout(timer);
          resolve();
        };
        // Unref'd: a parked loop must never be the reason the process stays up.
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        pending.add(finish);
      });
    },

    wake() {
      for (const finish of [...pending]) finish();
    },
  };
}
