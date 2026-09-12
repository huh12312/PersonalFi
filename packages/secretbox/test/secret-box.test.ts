// SPDX-License-Identifier: MIT
/**
 * `SecretBox` against a real database (decision D5, 03 §2, P0-1, P0-2).
 *
 * The four things worth proving, and why each is a separate test:
 *
 * - a sealed value round-trips, and **nothing readable reaches the column** — the
 *   literal evidence P0-1 asks for, gathered by reading the raw `bytea` back;
 * - a ciphertext lifted into another row, another column or another key
 *   generation does not open, which is the whole purpose of the AAD;
 * - one flipped bit does not open, which is the whole purpose of the AEAD tag;
 * - `destroy()` leaves the box unusable, which is what "the KEK is zeroed on
 *   SIGTERM" means in practice.
 */
import { newId, systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeEnvelope, ENVELOPE_VERSION, HEADER_BYTES, type ColumnRef } from '../src/envelope.ts';
import { isSecretBoxError } from '../src/errors.ts';
import { SecretBox } from '../src/secret-box.ts';
import { ADMIN_URL, createTestDatabase, TEST_KDF, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const PASSPHRASE = 'a passphrase that only the host filesystem knows';
const PLAID_TOKEN = 'access-sandbox-9f1c0b7a-6d2e-4f3a-9c10-11223344aabb';

describeWithDb('SecretBox', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp02_secretbox');
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  function boxFor(userId: string): SecretBox {
    return new SecretBox({
      db: database.db,
      userId,
      clock: systemClock,
      kdfParams: TEST_KDF,
      kdfFloor: TEST_KDF,
    });
  }

  /** A fresh user, so each test owns its own keyring generation counters. */
  async function unlockedBox(): Promise<{ box: SecretBox; userId: string; ref: ColumnRef }> {
    const userId = await database.createUser();
    const box = boxFor(userId);
    const state = await box.unlock(PASSPHRASE);
    expect(state.state).toBe('unlocked');
    return {
      box,
      userId,
      ref: { table: 'plaid_items', column: 'access_token', rowId: newId() },
    };
  }

  // ------------------------------------------------------------------ custody

  it('initialises a keyring on first unlock and re-derives on the next boot', async () => {
    const userId = await database.createUser();

    const first = await boxFor(userId).unlock(PASSPHRASE);
    expect(first).toMatchObject({ state: 'unlocked', kekVersion: 1, rotationRecommended: false });

    // A second process, a fresh object, the same database: the stored salt and
    // parameters must be enough to get back to the same key. Boot is unattended
    // (03 §2.2 Tier 1), so this is the normal path, not an edge case.
    const second = boxFor(userId);
    expect(await second.unlock(PASSPHRASE)).toMatchObject({ state: 'unlocked', kekVersion: 1 });

    const keys = await second.listKeyVersions();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kind: 'kek', scope: 'kek', version: 1, kekVersion: 1 });
  });

  it('reports a wrong passphrase as locked rather than throwing, and stays locked', async () => {
    const userId = await database.createUser();
    await boxFor(userId).unlock(PASSPHRASE);

    const wrong = boxFor(userId);
    // An operational condition an /unlock page has to render, not a crash.
    expect(await wrong.unlock('not the passphrase')).toEqual({
      state: 'locked',
      reason: 'passphrase_mismatch',
    });
    expect(wrong.isUnlocked).toBe(false);

    // And it did not damage the keyring: the right passphrase still works.
    expect(await boxFor(userId).unlock(PASSPHRASE)).toMatchObject({ state: 'unlocked' });
  });

  it('treats an empty passphrase as no passphrase', async () => {
    const box = boxFor(await database.createUser());
    expect(await box.unlock('')).toEqual({ state: 'locked', reason: 'no_passphrase' });
  });

  it('refuses to derive below the configured floor', async () => {
    const box = new SecretBox({
      db: database.db,
      userId: await database.createUser(),
      clock: systemClock,
      kdfParams: { memoryKiB: 4_096, timeCost: 1, parallelism: 1 },
      kdfFloor: TEST_KDF,
    });
    // Checked in `SecretBox` as well as in `loadConfig`, so a caller that skipped
    // config validation still cannot derive a weak KEK.
    await expect(box.unlock(PASSPHRASE)).rejects.toThrow(/below the floor/);
  });

  it('refuses every operation once destroyed — the SIGTERM path (P0-2)', async () => {
    const { box, ref, userId } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);

    box.destroy();

    expect(box.isUnlocked).toBe(false);
    expect(box.unlockState()).toEqual({ state: 'locked', reason: 'not_started' });
    // Sealing needs the KEK to wrap a new DEK; opening needs it to unwrap the
    // cached one — and `destroy` wiped the DEK cache too, so a cached key cannot
    // outlive the KEK that protects it.
    await expect(box.sealText(ref, 'x')).rejects.toThrow(/not available/);
    await expect(box.open(ref, sealed)).rejects.toThrow(/not available/);
    await expect(box.rotateKek('another')).rejects.toThrow(/cannot rotate the KEK while locked/);

    // The data is not lost, only unreachable: the next boot re-derives the KEK
    // from the same passphrase and reads the same ciphertext.
    const restarted = boxFor(userId);
    await restarted.unlock(PASSPHRASE);
    expect(await restarted.openText(ref, sealed)).toBe(PLAID_TOKEN);
  });

  // --------------------------------------------------------------- round trip

  it('round-trips bytes and text', async () => {
    const { box, ref } = await unlockedBox();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect([...(await box.open(ref, await box.seal(ref, bytes)))]).toEqual([...bytes]);
    expect(await box.openText(ref, await box.sealText(ref, PLAID_TOKEN))).toBe(PLAID_TOKEN);
  });

  it('round-trips an empty value and a multi-byte one', async () => {
    const { box, ref } = await unlockedBox();
    expect(await box.openText(ref, await box.sealText(ref, ''))).toBe('');
    const unicode = 'Å — 日本語 — 🔐';
    expect(await box.openText(ref, await box.sealText(ref, unicode))).toBe(unicode);
  });

  it('produces a different ciphertext every time, because the nonce is fresh', async () => {
    const { box, ref } = await unlockedBox();
    const a = await box.sealText(ref, PLAID_TOKEN);
    const b = await box.sealText(ref, PLAID_TOKEN);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    // Both still open: a nonce is not a key.
    expect(await box.openText(ref, a)).toBe(PLAID_TOKEN);
    expect(await box.openText(ref, b)).toBe(PLAID_TOKEN);
  });

  it('emits a self-describing envelope naming the key that made it', async () => {
    const { box, ref } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);
    const envelope = decodeEnvelope(sealed);

    expect(envelope.version).toBe(ENVELOPE_VERSION);
    expect(envelope.nonce).toHaveLength(24);
    expect(sealed.length).toBe(HEADER_BYTES + PLAID_TOKEN.length + 16);

    const key = (await box.listKeyVersions()).find(
      (candidate) => candidate.keyId === envelope.keyId,
    );
    expect(key).toMatchObject({ kind: 'dek', scope: `plaid_items:${ref.rowId}`, version: 1 });
  });

  it('refuses a plaintext above the 1 MiB ceiling', async () => {
    const { box, ref } = await unlockedBox();
    await expect(box.seal(ref, new Uint8Array(1_048_577))).rejects.toThrow(/exceeds 1 MiB/);
  });

  // --------------------------------------------------------- AAD and tamper

  it('refuses a ciphertext moved to another row, column or table', async () => {
    // The attack this forecloses: lift the bytes out of one row with `UPDATE` and
    // read them back through a row you are allowed to see.
    const { box, ref } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);

    for (const wrong of [
      { ...ref, rowId: newId() },
      { ...ref, column: 'item_id' },
      { ...ref, table: 'llm_credentials' },
    ]) {
      await expect(box.open(wrong, sealed)).rejects.toThrow(/did not authenticate/);
    }
    // The original still opens; nothing was consumed by the failures.
    expect(await box.openText(ref, sealed)).toBe(PLAID_TOKEN);
  });

  it('refuses a ciphertext whose key generation no longer matches', async () => {
    const { box, ref } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);
    const { keyId } = decodeEnvelope(sealed);

    // `key_version` is in the AAD precisely so a ciphertext cannot be replayed
    // against a different generation of the same key. Simulate that by bumping
    // the stored version out from under the envelope.
    await database.db.query(`UPDATE encryption_keys SET version = version + 1 WHERE id = $1`, [
      keyId,
    ]);

    const restarted = boxFor(await ownerOf(keyId));
    await restarted.unlock(PASSPHRASE);
    await expect(restarted.open(ref, sealed)).rejects.toThrow(/did not authenticate/);
  });

  it('refuses a tampered ciphertext, wherever the bit is flipped', async () => {
    const { box, ref } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);

    for (const index of [HEADER_BYTES, sealed.length - 1, sealed.length - 16]) {
      const tampered = Uint8Array.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      await expect(box.open(ref, tampered)).rejects.toThrow(/did not authenticate/);
    }

    // A flipped nonce byte fails the same way — no separate error, no oracle.
    const nonceTampered = Uint8Array.from(sealed);
    nonceTampered[20] = (nonceTampered[20] ?? 0) ^ 0x01;
    await expect(box.open(ref, nonceTampered)).rejects.toThrow(/did not authenticate/);

    // Truncation is caught by the parser before the AEAD sees it.
    await expect(box.open(ref, sealed.subarray(0, HEADER_BYTES + 4))).rejects.toThrow(
      /shorter than/,
    );
  });

  it('reports every decryption failure with the same code, so there is no oracle', async () => {
    const { box, ref } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

    const codes: string[] = [];
    for (const attempt of [
      () => box.open({ ...ref, rowId: newId() }, sealed),
      () => box.open(ref, tampered),
    ]) {
      try {
        await attempt();
        expect.unreachable('should have thrown');
      } catch (error) {
        codes.push(isSecretBoxError(error) ? error.code : 'other');
      }
    }
    expect(codes).toEqual(['decrypt_failed', 'decrypt_failed']);
  });

  it('refuses an envelope naming a key that belongs to somebody else', async () => {
    const alice = await unlockedBox();
    const sealed = await alice.box.sealText(alice.ref, PLAID_TOKEN);

    const bobId = await database.createUser('Bob');
    const bob = boxFor(bobId);
    await bob.unlock(PASSPHRASE);

    await expect(bob.open(alice.ref, sealed)).rejects.toThrow(/does not hold/);
  });

  // ------------------------------------------------------------------- P0-1

  it('leaves no plaintext in the column (P0-1 evidence)', async () => {
    const { box, userId } = await unlockedBox();
    const rowId = newId();
    const ref: ColumnRef = { table: 'totp_secrets', column: 'sealed_secret', rowId };
    const seed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    await database.db.query(
      `INSERT INTO totp_secrets (id, user_id, sealed_secret, created_at)
       VALUES ($1, $2, $3, now())`,
      [rowId, userId, Buffer.from(await box.sealText(ref, seed))],
    );

    // Read the raw column exactly as `psql` would. This is the assertion the
    // master plan's P0 item 1 names: "a test reads the raw column via psql and
    // asserts no plaintext".
    const result = await database.db.query(
      `SELECT sealed_secret, encode(sealed_secret, 'escape') AS as_text
       FROM totp_secrets WHERE id = $1`,
      [rowId],
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    const raw = row?.['sealed_secret'] as Uint8Array;

    expect(Buffer.from(raw).toString('utf8')).not.toContain(seed);
    expect(Buffer.from(raw).toString('latin1')).not.toContain(seed);
    expect(String(row?.['as_text'])).not.toContain(seed);
    // Nor any recognisable fragment of it: a substring check on the whole seed
    // would pass against a cipher that leaked half of it.
    for (let i = 0; i + 8 <= seed.length; i += 4) {
      expect(Buffer.from(raw).toString('latin1')).not.toContain(seed.slice(i, i + 8));
    }
    // And it is genuinely the sealed value, not an empty column.
    expect(await box.openText(ref, raw)).toBe(seed);
  });

  it('stores no readable form of what a KEK row seals', async () => {
    const { userId } = await unlockedBox();
    const result = await database.db.query(
      `SELECT wrapped_key FROM encryption_keys WHERE user_id = $1`,
      [userId],
    );
    for (const row of result.rows) {
      const bytes = Buffer.from(row['wrapped_key'] as Uint8Array);
      expect(bytes.toString('latin1')).not.toContain('personalfi/kek-verifier');
    }
  });

  // --------------------------------------------------------------- policies

  it('gives each row its own DEK under the record policy', async () => {
    const { box } = await unlockedBox();
    const a = await box.sealText(
      { table: 'plaid_items', column: 'access_token', rowId: newId() },
      'a',
    );
    const b = await box.sealText(
      { table: 'plaid_items', column: 'access_token', rowId: newId() },
      'b',
    );
    // Per-record DEKs are what make "remove this Plaid Item" a cryptographic
    // erasure rather than a DELETE the backup still contradicts (P1-9).
    expect(decodeEnvelope(a).keyId).not.toBe(decodeEnvelope(b).keyId);
  });

  it('shares one DEK per column generation under the epoch policy', async () => {
    const { box } = await unlockedBox();
    const column = { table: 'transactions', column: 'name' };
    const a = await box.sealText({ ...column, rowId: newId() }, 'Blue Bottle', {
      policy: 'epoch',
    });
    const b = await box.sealText({ ...column, rowId: newId() }, 'Whole Foods', {
      policy: 'epoch',
    });
    // A per-row DEK across 200k transactions is ceremony, not security.
    expect(decodeEnvelope(a).keyId).toBe(decodeEnvelope(b).keyId);

    const key = (await box.listKeyVersions()).find(
      (candidate) => candidate.keyId === decodeEnvelope(a).keyId,
    );
    expect(key).toMatchObject({ kind: 'epoch', scope: 'transactions.name' });
  });

  it('still binds an epoch ciphertext to its own row', async () => {
    const { box } = await unlockedBox();
    const column = { table: 'transactions', column: 'name' };
    const mine = { ...column, rowId: newId() };
    const yours = { ...column, rowId: newId() };
    const sealed = await box.sealText(mine, 'Blue Bottle', { policy: 'epoch' });
    // A shared DEK does not mean a portable ciphertext: the AAD still names the row.
    await expect(box.open(yours, sealed)).rejects.toThrow(/did not authenticate/);
  });

  // --------------------------------------------------------------- rotation

  it('rotates the KEK without re-encrypting any user data', async () => {
    const { box, ref, userId } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);
    const before = decodeEnvelope(sealed).keyId;

    const rotated = await box.rotateKek('a new passphrase, chosen after the old one leaked');
    expect(rotated).toMatchObject({ state: 'unlocked', kekVersion: 2 });

    // The DEK is unchanged — only its wrapping moved — so the ciphertext in every
    // column is untouched. A rotation that required downtime is one that never
    // happens (03 §2.4).
    expect(decodeEnvelope(sealed).keyId).toBe(before);
    expect(await box.openText(ref, sealed)).toBe(PLAID_TOKEN);

    // A fresh process with the new passphrase reads it; the old one no longer does.
    const restarted = boxFor(userId);
    expect(
      await restarted.unlock('a new passphrase, chosen after the old one leaked'),
    ).toMatchObject({ state: 'unlocked', kekVersion: 2 });
    expect(await restarted.openText(ref, sealed)).toBe(PLAID_TOKEN);
    expect(await boxFor(userId).unlock(PASSPHRASE)).toEqual({
      state: 'locked',
      reason: 'passphrase_mismatch',
    });
  });

  it('retires superseded KEK generations and re-stamps every wrapped DEK', async () => {
    const { box, ref, userId } = await unlockedBox();
    await box.sealText(ref, PLAID_TOKEN);
    await box.sealText({ table: 'transactions', column: 'name', rowId: newId() }, 'x', {
      policy: 'epoch',
    });

    await box.rotateKek('second passphrase');

    const keys = await box.listKeyVersions();
    const keks = keys.filter((key) => key.kind === 'kek');
    expect(keks).toHaveLength(2);
    expect(keks.find((key) => key.version === 1)?.retiredAt).not.toBeNull();
    expect(keks.find((key) => key.version === 2)?.retiredAt).toBeNull();

    for (const key of keys.filter((candidate) => candidate.kind !== 'kek')) {
      expect(key.kekVersion).toBe(2);
    }
    expect(keys.every((key) => key.keyId.length === 36)).toBe(true);
    expect(userId).toBeTruthy();
  });

  it('refuses to rotate to an empty passphrase', async () => {
    const { box } = await unlockedBox();
    await expect(box.rotateKek('')).rejects.toThrow(/must not be empty/);
  });

  // -------------------------------------------------------- crypto-erasure

  it('destroys a record key, making its ciphertext permanently unreadable (P1-9)', async () => {
    const { box, ref, userId } = await unlockedBox();
    const sealed = await box.sealText(ref, PLAID_TOKEN);
    expect(await box.openText(ref, sealed)).toBe(PLAID_TOKEN);

    expect(await box.destroyRecordKey(ref.table, ref.rowId)).toBe(true);

    // Not merely "the row was deleted": the bytes may already be in last night's
    // backup, and after this they are noise there too.
    const restarted = boxFor(userId);
    await restarted.unlock(PASSPHRASE);
    await expect(restarted.open(ref, sealed)).rejects.toThrow(/has been destroyed/);

    // A second destroy is a no-op rather than an error.
    expect(await box.destroyRecordKey(ref.table, ref.rowId)).toBe(false);

    // And a fresh seal for the same row gets a new generation rather than
    // resurrecting the retired one.
    const reSealed = await restarted.sealText(ref, 'a replacement token');
    expect(decodeEnvelope(reSealed).keyId).not.toBe(decodeEnvelope(sealed).keyId);
    expect(await restarted.openText(ref, reSealed)).toBe('a replacement token');
  });

  async function ownerOf(keyId: string): Promise<string> {
    const result = await database.db.query(`SELECT user_id FROM encryption_keys WHERE id = $1`, [
      keyId,
    ]);
    return String(result.rows[0]?.['user_id']);
  }
});
