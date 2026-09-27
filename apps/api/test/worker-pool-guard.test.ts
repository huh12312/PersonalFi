// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-6 (G3-5, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §2.7, §6): `assertPoolCoversLeases` and `WORKER_PINNED_CONNECTIONS` were
 * private to `apps/api/src/worker.ts`, and the only test that existed
 * (`regate-worker-boot.test.ts`) asserted that the *string*
 * `assertPoolCoversLeases` appears in the file — never that it evaluates
 * anything. The gate reproduced two sabotages that both left `api` 75/75
 * green:
 *
 *   - **S-P1**: `if (poolMax > pinned) return;` → `if (poolMax > pinned ||
 *     true) return;` (the check never speaks).
 *   - **S-P2**: the per-consumer term `MODULE_FLAGS.length` → `0 *
 *     MODULE_FLAGS.length` (reintroduces the wiring-batch deadlock
 *     arithmetic: 5 reserved for 5 leases + 7 pinned).
 *
 * Both are reproduced here, directly against the exported function and
 * constant — not against the source text — and both must go red. The
 * function is also now `throw`s rather than merely `logger.error`s (C-6:
 * "fail the boot rather than log"), so this file's own assertions are the
 * green half.
 *
 * No database is needed: both exports are pure. `test/*.test.ts` (the `api`
 * project).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PoolCannotCoverPinnedConnectionsError } from '@core/platform';
import { describe, expect, it } from 'vitest';
import { assertPoolCoversLeases, WORKER_PINNED_CONNECTIONS } from '../src/worker.ts';
import { MODULE_FLAGS } from '../src/platform.ts';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

/** `.env.example`'s own default — read, not hardcoded, so this drifts with it. */
function defaultDatabasePoolMax(): number {
  const match = /^DATABASE_POOL_MAX=(\d+)$/m.exec(repoFile('.env.example'));
  if (match?.[1] === undefined) throw new Error('.env.example has no DATABASE_POOL_MAX default');
  return Number(match[1]);
}

function fakeLogger() {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: {
      error: (...args: unknown[]) => {
        calls.push(args);
      },
    } as never,
  };
}

describe('assertPoolCoversLeases / WORKER_PINNED_CONNECTIONS (Phase 3 gate C-6)', () => {
  it('WORKER_PINNED_CONNECTIONS is 3 LISTEN + 2 leader leases + one per module flag', () => {
    expect(WORKER_PINNED_CONNECTIONS).toBe(3 + 2 + MODULE_FLAGS.length);
  });

  it('passes silently when the pool strictly exceeds the pinned floor', () => {
    const { logger, calls } = fakeLogger();
    expect(() => assertPoolCoversLeases(logger, 3 + 2 + 7 + 1, 7)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws — and logs first — the moment the pool does not strictly exceed it', () => {
    const { logger, calls } = fakeLogger();
    expect(() => assertPoolCoversLeases(logger, 3 + 2 + 7, 7)).toThrow(
      PoolCannotCoverPinnedConnectionsError,
    );
    expect(calls).toHaveLength(1);
    // Named, both sides, as the header promises: an operator reading the log
    // sees exactly what to raise and by how much.
    expect(calls[0]?.[0]).toMatchObject({ poolMax: 12, pinned: 12, consumerCount: 7 });
  });

  it('throws below the floor too — a pool that is short does not merely warn', () => {
    expect(() => assertPoolCoversLeases(fakeLogger().logger, 5, 7)).toThrow(
      PoolCannotCoverPinnedConnectionsError,
    );
  });

  it('SABOTAGE reproduced (S-P1): a check that never returns still throws here — this file is ' +
    'the direct arithmetic test the string-match test in regate-worker-boot.test.ts is not', () => {
    // This does not sabotage the source; it documents what S-P1 defeated. The
    // gate's S-P1 replaced `if (poolMax > pinned) return;` with `if (poolMax >
    // pinned || true) return;`, i.e. the function always returns before the
    // `throw`. Reproducing that shape here directly (rather than editing the
    // file) shows the *consequence* a string-match test cannot see: with S-P1
    // applied, a deadlocked pool would return normally instead of throwing —
    // which is exactly why this suite calls the real, unmodified function and
    // asserts the throw, not the source text.
    const { logger } = fakeLogger();
    expect(() => assertPoolCoversLeases(logger, 12, 7)).toThrow();
  });

  it('SABOTAGE reproduced (S-P2): zeroing WORKER_PINNED_CONNECTIONS\'s consumer term sizes a ' +
    'pool this check then (correctly) refuses to boot with, at the real numbers', () => {
    // S-P2 (`worker.ts`'s call site): `WORKER_PINNED_CONNECTIONS`'s per-consumer
    // term `MODULE_FLAGS.length` → `0 * MODULE_FLAGS.length`. That constant
    // feeds exactly one thing — `createPool({ max: DATABASE_POOL_MAX +
    // WORKER_PINNED_CONNECTIONS })` — and `assertPoolCoversLeases` re-derives
    // `pinned` from the real, post-resolve `consumerCount` independently, so
    // this test has to model the *call site's* relationship, not the function
    // in isolation, for the sabotage to have anything to bite on.
    //
    // At the real numbers (`.env.example`'s `DATABASE_POOL_MAX`, the real
    // `MODULE_FLAGS.length` — the worst-case consumer count, since
    // `modules.consumers.length` can be at most one per module by
    // `WORKER_PINNED_CONNECTIONS`'s own comment), this genuinely crosses the
    // line: S-P2's pool is sized as if the reservation covered only the 5
    // process-wide leases, no consumers at all.
    const databasePoolMax = defaultDatabasePoolMax();
    const consumerCount = MODULE_FLAGS.length; // worst case: every module enabled, one consumer each
    const sabotagedWorkerPinnedConnections = 3 + 2 + 0 * MODULE_FLAGS.length; // S-P2's arithmetic
    const sabotagedPoolMax = databasePoolMax + sabotagedWorkerPinnedConnections;

    expect(() => assertPoolCoversLeases(fakeLogger().logger, sabotagedPoolMax, consumerCount)).toThrow(
      PoolCannotCoverPinnedConnectionsError,
    );

    // The unsabotaged constant, at the same real numbers, does not.
    const correctPoolMax = databasePoolMax + WORKER_PINNED_CONNECTIONS;
    expect(() =>
      assertPoolCoversLeases(fakeLogger().logger, correctPoolMax, consumerCount),
    ).not.toThrow();
  });
});
