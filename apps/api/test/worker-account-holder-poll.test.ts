// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-1 (G3-1, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §3.1, §6): the worker's no-holder branch used to touch an `unref()`'d
 * heartbeat once and let `main()` return — which let the process exit 0 once
 * the connection pool's idle timeout closed the last client, thirty seconds
 * after boot. Compose's restart policy then started it again, and the cold
 * install "worked" only by an accidental exit-and-restart loop, never by
 * idling. This file is the behavioural half of C-1's close: `awaitAccountHolder`
 * is exercised directly with a fake `findPrimary` that answers `null` twice
 * and then a user, and it resolves to that user from **one call**, in **one
 * process**, with no restart anywhere. `main()`'s own wiring of this function
 * — polling in place and never returning while idle — is asserted at the
 * source in the same describe block, the same way `regate-worker-boot.test.ts`
 * asserts the pool-sizing arithmetic: the behaviour needs a database, a KEK
 * and an account holder to reproduce end to end, but the composition root's
 * shape does not.
 *
 * No database is needed for the poll itself: `awaitAccountHolder` takes a
 * `findPrimary` function, not a `UserService`, so this is `test/*.test.ts`
 * (the `api` project).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { awaitAccountHolder } from '../src/worker.ts';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

const USER = { id: 'user-1', displayTimezone: 'America/New_York' } as never;

describe('awaitAccountHolder (Phase 3 gate C-1)', () => {
  it('a fake findPrimary that answers null then a user resolves to that user, from one call', async () => {
    const findPrimary = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(USER);
    const onIdle = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await awaitAccountHolder({
      findPrimary,
      intervalMs: 5_000,
      isStopping: () => false,
      onIdle,
      sleep,
    });

    expect(result).toBe(USER);
    // Three attempts (null, null, user): main() never restarted to get there —
    // this is the same await, in the same call, all the way through.
    expect(findPrimary).toHaveBeenCalledTimes(3);
    // The idle heartbeat touches once per empty attempt, so a healthcheck
    // reading its freshness never lapses however long the wait is.
    expect(onIdle).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('never calls findPrimary again, and resolves null, once isStopping() is already true', async () => {
    const findPrimary = vi.fn().mockResolvedValue(USER);
    const result = await awaitAccountHolder({
      findPrimary,
      intervalMs: 1_000,
      isStopping: () => true,
    });
    expect(result).toBeNull();
    expect(findPrimary).not.toHaveBeenCalled();
  });

  it('stops between an empty attempt and the wait, without sleeping, once a shutdown signal lands', async () => {
    let stopped = false;
    const findPrimary = vi.fn().mockResolvedValue(null);
    const sleep = vi.fn().mockImplementation(async () => {
      throw new Error('must not sleep once isStopping() is true');
    });

    const result = await awaitAccountHolder({
      findPrimary,
      intervalMs: 1_000,
      isStopping: () => stopped,
      onIdle: () => {
        stopped = true; // simulates a SIGTERM handler flipping the flag mid-poll
      },
      sleep,
    });

    expect(result).toBeNull();
    expect(findPrimary).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("main()'s no-holder branch polls in place and never returns while idle — no early return before awaitAccountHolder", () => {
    const worker = repoFile('apps/api/src/worker.ts');
    const start = worker.indexOf('async function main(): Promise<void> {');
    const end = worker.indexOf("if (process.env['VITEST']");
    expect(start, 'apps/api/src/worker.ts has no main() to inspect').toBeGreaterThan(-1);
    expect(
      end,
      "apps/api/src/worker.ts has no VITEST guard to bound main()'s body",
    ).toBeGreaterThan(start);
    const body = worker.slice(start, end);

    // The old defect, restated as a test: a `return` inside the `user === null`
    // branch, before the poll, would restore "idle once, then let main() end".
    const noHolderBranch =
      /if \(user === null\) \{([\s\S]*?)\n {2}\}\n\n {2}if \(user === null\)/u.exec(body)?.[1];
    expect(noHolderBranch, 'the no-holder branch could not be found').toBeDefined();
    // Strip comment-only lines first: the branch's own prose and log message
    // legitimately say "return" several times (describing the defect this
    // closes). An actual early exit is a `return;` *statement*, not the word.
    const codeOnly = (noHolderBranch ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(
      /\breturn\s*;/.test(codeOnly),
      'the no-holder branch returns before polling — that is the G3-1 defect: `main()` must ' +
        'poll for the holder in place and only return afterwards (checked by the second ' +
        '`if (user === null)`, once `stopping` is the only reason left).',
    ).toBe(false);
    expect(
      codeOnly.includes('awaitAccountHolder('),
      'the no-holder branch no longer calls awaitAccountHolder — main() would idle once and ' +
        'return exactly like the pre-C-1 shape.',
    ).toBe(true);

    // The poll's own wait must not be `unref()`'d — an unref'd timer does not
    // keep the event loop alive, which is the entire mechanism G3-1 found: the
    // process exits once every *other* handle (the pool's idle connections)
    // closes, restart policy or not.
    const sleepFn = /function sleep\(ms: number\): Promise<void> \{([\s\S]*?)\n\}/u.exec(
      worker,
    )?.[1];
    expect(sleepFn, 'worker.ts has no sleep() helper to inspect').toBeDefined();
    expect(
      (sleepFn ?? '').includes('unref'),
      "awaitAccountHolder's sleep() must not unref() its timer — an unref'd timer is not a " +
        'reason for the event loop to keep running, which is exactly how the pre-fix idle ' +
        'heartbeat let the process exit while "idling".',
    ).toBe(false);
  });

  it('registers the SIGTERM/SIGINT shutdown handler before the account-holder poll, not after', () => {
    const worker = repoFile('apps/api/src/worker.ts');
    const registerIndex = worker.indexOf("process.once('SIGTERM'");
    const pollIndex = worker.indexOf('awaitAccountHolder({');
    expect(registerIndex, 'no SIGTERM handler registration found').toBeGreaterThan(-1);
    expect(pollIndex, 'no awaitAccountHolder call found').toBeGreaterThan(-1);
    expect(
      registerIndex,
      'the shutdown handlers must be registered before the account-holder poll, or a ' +
        'SIGTERM/SIGINT sent while a fresh install has never seen a holder would have no ' +
        'handler yet and fall back to the default (unclean) termination.',
    ).toBeLessThan(pollIndex);
  });
});
