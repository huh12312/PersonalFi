// SPDX-License-Identifier: MIT
/**
 * WP 9.11 (09 §6 Q9; WP 9.9's boot peak): KEK derivations are serialised
 * across processes, and the serialisation can never keep a process locked.
 *
 * Two independent `pg` pools stand in for the api and the worker (two
 * containers, one database). Each runs a "derivation" that records when it
 * started and ended; through `withKekDerivationLock` the two intervals never
 * overlap, and the second waited for the first. Without the lock they overlap
 * — which is what put two 1 GiB Argon2 blocks in memory at once on a cold
 * `up` (2.31–2.43 GiB, WP 9.9).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withKekDerivationLock, type DerivationLockPool } from '../src/kek-derivation-lock.ts';
import { ADMIN_URL } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;
const DATABASE = 'personalfi_wp911_kek_lock';

describeWithDb('the KEK derivation lock', () => {
  let api: ReturnType<typeof createPool>;
  let worker: ReturnType<typeof createPool>;

  beforeAll(async () => {
    const admin = createPool({ databaseUrl: ADMIN_URL as string, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.end();
    const url = new URL(ADMIN_URL as string);
    url.pathname = `/${DATABASE}`;
    api = createPool({ databaseUrl: url.toString(), max: 2 });
    worker = createPool({ databaseUrl: url.toString(), max: 2 });
  }, 30_000);

  afterAll(async () => {
    await api?.end();
    await worker?.end();
    const admin = createPool({ databaseUrl: ADMIN_URL as string, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  function derivation(log: Array<{ who: string; start: number; end: number }>, who: string) {
    return async () => {
      const start = Date.now();
      await sleep(400);
      log.push({ who, start, end: Date.now() });
      return who;
    };
  }

  it('two processes deriving at once take turns: the intervals never overlap', async () => {
    const log: Array<{ who: string; start: number; end: number }> = [];
    const [a, b] = await Promise.all([
      withKekDerivationLock(api, derivation(log, 'api')),
      withKekDerivationLock(worker, derivation(log, 'worker')),
    ]);
    expect([a.result, b.result].sort()).toEqual(['api', 'worker']);
    expect(a.lock.locked && b.lock.locked).toBe(true);
    const [first, second] = [...log].sort((x, y) => x.start - y.start);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The second began only after the first ended (1 ms of clock slack).
    expect(second!.start).toBeGreaterThanOrEqual(first!.end - 1);
    // And the one that waited says so.
    expect(Math.max(a.lock.waitedMs, b.lock.waitedMs)).toBeGreaterThanOrEqual(300);
  }, 30_000);

  it('the lock is released afterwards: a third derivation does not wait', async () => {
    const log: Array<{ who: string; start: number; end: number }> = [];
    const third = await withKekDerivationLock(api, derivation(log, 'bootstrap-user'));
    expect(third.lock.locked).toBe(true);
    expect(third.lock.waitedMs).toBeLessThan(300);
  }, 30_000);

  it('fails open: no connection means the derivation still runs, and says it was unlocked', async () => {
    const broken: DerivationLockPool = {
      connect: () => Promise.reject(new Error('connection refused')),
    };
    const outcome = await withKekDerivationLock(broken, async () => 'derived');
    expect(outcome.result).toBe('derived');
    expect(outcome.lock).toMatchObject({ locked: false, error: 'connection refused' });
  }, 30_000);

  it('a derivation that throws still releases the lock', async () => {
    await expect(
      withKekDerivationLock(api, async () => {
        throw new Error('wrong passphrase');
      }),
    ).rejects.toThrow('wrong passphrase');
    const next = await withKekDerivationLock(worker, async () => 'ok');
    expect(next.lock.waitedMs).toBeLessThan(300);
  }, 30_000);
});
