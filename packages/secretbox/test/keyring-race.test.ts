// SPDX-License-Identifier: MIT
/**
 * C-2 (G4-2) / `docs/evidence/phase-4/gate-security-review.md` §3.2, §6 row
 * **C-2**: "Key custody survives two processes initialising one keyring."
 *
 * The gate's cold walk found the real shape: `bootstrap-user` derives a KEK
 * and inserts generation 1 of `encryption_keys` (kind `kek`, scope `kek`);
 * C-1's worker, no longer exiting idle, polls every `JOB_POLL_INTERVAL_MS`
 * and finds the new account holder inside Argon2id's multi-second derivation
 * window, so it runs the same check-then-insert and loses the unique
 * violation on `encryption_keys_scope_version_key`. Before this fix the loser
 * threw and the process died — Compose restarted the worker, and C-1's own
 * exit criterion ("the worker shows `RestartCount=0` after `bootstrap-user`")
 * could never hold. This suite races two real `SecretBox.unlock()` calls
 * against a real, fresh Postgres database — no fake `SecretBoxQueryable`, for
 * `test/harness.ts`'s own reason: the property under test is what the
 * database's unique index actually does under concurrent commits, not what a
 * mock says it does.
 */
import { systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColumnRef } from '../src/envelope.ts';
import { SecretBox } from '../src/secret-box.ts';
import type { SecretBoxQueryable } from '../src/store.ts';
import { ADMIN_URL, createTestDatabase, TEST_KDF, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const PASSPHRASE = 'a passphrase two processes derive the same KEK from';

/**
 * Widens the window G4-2 relies on (Argon2id derivation outlasting a poll
 * interval) into something deterministic in a fast local test: every "is
 * there a KEK row?" read (`findActiveKeyByScope`'s query) pauses briefly
 * before it runs, so two `unlock()` calls started together are *both*
 * guaranteed to observe no row and *both* proceed to `INSERT` — the exact
 * interleaving the gate's cold walk hit by accident. Without this, two
 * `unlock()` calls in one fast test process can finish far enough apart that
 * the second simply finds the first's row already committed, which exercises
 * only the ordinary re-derive path and would let a broken race-recovery
 * branch hide behind timing luck.
 */
function raceWidened(db: SecretBoxQueryable): SecretBoxQueryable {
  return {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes('FROM encryption_keys') && text.includes('retired_at IS NULL')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return db.query(text, values);
    },
  };
}

describeWithDb('the keyring-initialisation race (carry-c2)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_carry_c2_keyring_race');
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  function boxFor(userId: string, db: SecretBoxQueryable = database.db): SecretBox {
    return new SecretBox({
      db,
      userId,
      clock: systemClock,
      kdfParams: TEST_KDF,
      kdfFloor: TEST_KDF,
    });
  }

  it(
    'two real unlock()s racing a fresh database both succeed and agree on the verifier',
    { timeout: 60_000 },
    async () => {
      const userId = await database.createUser();
      const boxA = boxFor(userId, raceWidened(database.db));
      const boxB = boxFor(userId, raceWidened(database.db));

      // Both find no KEK row, both derive under their own random salt, both
      // attempt to INSERT generation 1 — the exact race G4-2 observed, driven
      // here without a second process because the property is the database's
      // unique index, not process boundaries.
      const [stateA, stateB] = await Promise.all([
        boxA.unlock(PASSPHRASE),
        boxB.unlock(PASSPHRASE),
      ]);

      expect(stateA.state).toBe('unlocked');
      expect(stateB.state).toBe('unlocked');
      if (stateA.state !== 'unlocked' || stateB.state !== 'unlocked') return; // narrows for TS below

      // Both agree on the one generation that exists — never two.
      expect(stateA.kekVersion).toBe(1);
      expect(stateB.kekVersion).toBe(1);

      const keys = await database.db.query(
        `SELECT count(*)::int AS n FROM encryption_keys WHERE user_id = $1 AND kind = 'kek'`,
        [userId],
      );
      expect(keys.rows[0]?.['n']).toBe(1);

      // Not just "both report unlocked" — both hold the *same* key. Seal
      // under one, open under the other.
      const ref: ColumnRef = { table: 'plaid_items', column: 'access_token', rowId: userId };
      const sealed = await boxA.seal(ref, new TextEncoder().encode('same-verifier-proof'));
      const opened = await boxB.openText(ref, sealed);
      expect(opened).toBe('same-verifier-proof');

      // A fresh third box, on the same database, re-derives against whichever
      // row is now stored — the ordinary "next boot" path — and reads the
      // same generation.
      const boxC = boxFor(userId);
      const stateC = await boxC.unlock(PASSPHRASE);
      expect(stateC).toMatchObject({ state: 'unlocked', kekVersion: 1 });
    },
  );

  it(
    "a loser that passed the existence check before the winner's INSERT still joins generation 1, never starts generation 2",
    { timeout: 60_000 },
    async () => {
      // CI's Postgres timing (run 36713567024, 2026-09-30) found the
      // interleaving the first test does not pin: B's "is there an active KEK
      // row?" read says none, A inserts generation 1, and only then does B
      // continue. `#initialiseKeyring` used to read `max(version) + 1` at
      // that point — 2 — and insert it with no collision: two live keyrings.
      // Here B is held after its existence check until A has finished, so
      // whatever B does next happens with the winner's row already stored.
      const userId = await database.createUser();
      const boxA = boxFor(userId);
      let aFinished: Promise<unknown> = Promise.resolve();
      let bChecked = false;
      const boxB = boxFor(userId, {
        async query(text: string, values?: readonly unknown[]) {
          const touchesKeys = text.includes('encryption_keys');
          if (touchesKeys && !bChecked) {
            bChecked = true; // the existence check, answered before A inserts
          } else if (touchesKeys) {
            await aFinished; // everything after it sees A's row
          }
          return database.db.query(text, values);
        },
      });

      const bUnlock = boxB.unlock(PASSPHRASE);
      aFinished = boxA.unlock(PASSPHRASE);
      const [stateA, stateB] = await Promise.all([aFinished as Promise<unknown>, bUnlock]);

      expect(stateA).toMatchObject({ state: 'unlocked', kekVersion: 1 });
      expect(stateB).toMatchObject({ state: 'unlocked', kekVersion: 1 });
      const keys = await database.db.query(
        `SELECT count(*)::int AS n FROM encryption_keys WHERE user_id = $1 AND kind = 'kek'`,
        [userId],
      );
      expect(keys.rows[0]?.['n']).toBe(1);
    },
  );
});
