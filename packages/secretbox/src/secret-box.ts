// SPDX-License-Identifier: MIT
/**
 * `SecretBox` — application-layer envelope encryption (decision D5, 03 §2, P0-1).
 *
 * ```
 *   passphrase --Argon2id--> KEK (32B, memory only, wiped on SIGTERM)
 *                              |
 *                              +-- XChaCha20-Poly1305 wrap --> DEK_1 --> plaid_items.access_token
 *                              +-- XChaCha20-Poly1305 wrap --> DEK_2 --> exchange_credentials.secret
 *                              +-- XChaCha20-Poly1305 wrap --> DEK_e --> transactions.name (epoch)
 * ```
 *
 * Two key policies, both supported from day one because retrofitting the second is
 * a migration nightmare (03 §2.4):
 *
 * - **`record`** (the default): one DEK per row. Correct for provider secrets —
 *   there are tens of them, each is individually catastrophic, and destroying one
 *   DEK is how "delete this Plaid Item" becomes cryptographic erasure (P1-9).
 * - **`epoch`**: one DEK per `(table, column)` generation, rotated by bumping the
 *   epoch. Correct for bulk PII columns — a per-row DEK across 200k transactions
 *   is ceremony, not security, and it would double the row count of the keyring.
 *
 * Not `pgcrypto`: with `pgcrypto` the key is supplied by the client and decryption
 * happens on the server, so the key transits the wire protocol, sits transiently in
 * server memory, and lands in `pg_stat_statements` and query logs. The database
 * must never see a key.
 */
import { newId, type Clock } from '@core/kernel';
import { SecretBoxError } from './errors.ts';
import {
  buildAad,
  decodeEnvelope,
  encodeEnvelope,
  ENVELOPE_VERSION,
  type ColumnRef,
} from './envelope.ts';
import {
  assertParamsAtOrAboveFloor,
  deriveKek,
  KekHolder,
  KEK_SALT_BYTES,
  type UnlockState,
} from './kek.ts';
import { aeadOpen, aeadSeal, randomBytes, randomKey, randomNonce, wipe, type Argon2Params } from './primitives.ts';
import {
  findActiveKeyByScope,
  findKeyById,
  insertKey,
  listKeys,
  listWrappedKeys,
  maxVersion,
  retireKey,
  updateWrappedKey,
  type EncryptionKeyRow,
  type SecretBoxQueryable,
} from './store.ts';

/** The table the keyring lives in. Named once so the AAD cannot drift from it. */
const KEYRING_TABLE = 'encryption_keys';
const KEYRING_COLUMN = 'wrapped_key';
const KEK_SCOPE = 'kek';

/**
 * The constant a KEK row seals so `unlock` can tell "right passphrase" from
 * "wrong passphrase" without touching a DEK. It is public; its confidentiality is
 * irrelevant, only the authenticity of its tag matters.
 */
const KEK_VERIFIER = new TextEncoder().encode('personalfi/kek-verifier/v1');

/** Refuse absurd inputs rather than allocating for them. 1 MiB is far above any credential. */
const MAX_PLAINTEXT_BYTES = 1_048_576;

export type KeyPolicy = 'record' | 'epoch';

export interface SealOptions {
  /** Defaults to `record`. Use `epoch` for high-volume columns. */
  readonly policy?: KeyPolicy;
}

export interface KeyVersionSummary {
  readonly keyId: string;
  readonly kind: 'kek' | 'dek' | 'epoch';
  readonly scope: string;
  readonly version: number;
  readonly kekVersion: number;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

export interface SecretBoxOptions {
  readonly db: SecretBoxQueryable;
  readonly userId: string;
  readonly clock: Clock;
  /** Argon2id parameters for *new* KEK generations. Validated against the floor by config. */
  readonly kdfParams: Argon2Params;
  /** Floor the parameters are checked against. `@core/config` supplies the right one. */
  readonly kdfFloor: Argon2Params;
}

export class SecretBox {
  readonly #db: SecretBoxQueryable;
  readonly #userId: string;
  readonly #clock: Clock;
  readonly #kdfParams: Argon2Params;
  readonly #kdfFloor: Argon2Params;
  readonly #kek = new KekHolder();
  /** Unwrapped DEKs, by key id. Wiped by `destroy()`. */
  readonly #dekCache = new Map<string, Uint8Array>();

  constructor(options: SecretBoxOptions) {
    this.#db = options.db;
    this.#userId = options.userId;
    this.#clock = options.clock;
    this.#kdfParams = options.kdfParams;
    this.#kdfFloor = options.kdfFloor;
  }

  // ---------------------------------------------------------------- custody

  /**
   * Derive the KEK from the passphrase and make the box usable.
   *
   * Idempotent and unattended: with the `master_key` secret present this runs at
   * boot with no interaction, which is the whole point of 03 §2.2 Tier 1. On a
   * database with no KEK row it initialises generation 1; on one that has a KEK row
   * it re-derives with the *stored* salt and parameters and verifies the tag.
   *
   * Returns the resulting state rather than throwing on a bad passphrase: a wrong
   * passphrase is an operational condition the `/unlock` page must be able to
   * render, not a crash.
   */
  async unlock(passphrase: string): Promise<UnlockState> {
    assertParamsAtOrAboveFloor(this.#kdfParams, this.#kdfFloor);
    if (passphrase.length === 0) {
      this.#kek.lock('no_passphrase');
      return this.#kek.state();
    }

    const existing = await findActiveKeyByScope(this.#db, this.#userId, 'kek', KEK_SCOPE);
    if (existing === null) {
      await this.#initialiseKeyring(passphrase);
      return this.#kek.state();
    }

    if (existing.salt === null || existing.params === null) {
      throw new SecretBoxError('envelope_malformed', 'KEK row is missing its salt or parameters');
    }

    const derived = await deriveKek(passphrase, existing.salt, existing.params, () =>
      this.#clock.nowMs(),
    );

    // Verify before installing: a wrong passphrase must leave the holder locked,
    // not unlocked-with-a-key-that-decrypts-nothing.
    const envelope = decodeEnvelope(existing.wrappedKey);
    const aad = buildAad(this.#keyringRef(existing.id), existing.version);
    const opened = aeadOpen(derived.key, envelope.nonce, envelope.ciphertext, aad);
    if (opened === null) {
      wipe(derived.key);
      this.#kek.lock('passphrase_mismatch');
      return this.#kek.state();
    }

    const belowFloor = !this.#meetsFloor(existing.params);
    this.#kek.install(
      derived.key,
      existing.version,
      { ...existing.params, durationMs: derived.durationMs },
      belowFloor,
    );
    return this.#kek.state();
  }

  unlockState(): UnlockState {
    return this.#kek.state();
  }

  get isUnlocked(): boolean {
    return this.#kek.isUnlocked;
  }

  /** Wipe the KEK and every cached DEK. Called from the `SIGTERM` handler. */
  destroy(): void {
    for (const dek of this.#dekCache.values()) wipe(dek);
    this.#dekCache.clear();
    this.#kek.destroy();
  }

  // ------------------------------------------------------------------ seal

  /** Seal bytes into a storage envelope for `ref`. The result goes in a `bytea`. */
  async seal(ref: ColumnRef, plaintext: Uint8Array, options: SealOptions = {}): Promise<Uint8Array> {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new SecretBoxError('plaintext_too_large', 'plaintext exceeds 1 MiB');
    }
    const policy = options.policy ?? 'record';
    const key = await this.#resolveKeyForWrite(ref, policy);
    const dek = await this.#unwrap(key);
    const nonce = randomNonce();
    const aad = buildAad(ref, key.version);
    const ciphertext = aeadSeal(dek, nonce, plaintext, aad);
    return encodeEnvelope({ version: ENVELOPE_VERSION, keyId: key.id, nonce, ciphertext });
  }

  async sealText(ref: ColumnRef, plaintext: string, options: SealOptions = {}): Promise<Uint8Array> {
    return this.seal(ref, new TextEncoder().encode(plaintext), options);
  }

  /**
   * Open a storage envelope.
   *
   * Every failure is `decrypt_failed`: a tampered ciphertext, a ciphertext moved
   * from another row, and a wrong key version are the same answer, because an API
   * that distinguishes them is an oracle.
   */
  async open(ref: ColumnRef, stored: Uint8Array): Promise<Uint8Array> {
    const envelope = decodeEnvelope(stored);
    const key = await findKeyById(this.#db, envelope.keyId);
    if (key === null || key.userId !== this.#userId) {
      throw new SecretBoxError('unknown_key', 'the envelope names a key this box does not hold');
    }
    const dek = await this.#unwrap(key);
    const aad = buildAad(ref, key.version);
    const plaintext = aeadOpen(dek, envelope.nonce, envelope.ciphertext, aad);
    if (plaintext === null) {
      throw new SecretBoxError('decrypt_failed', 'the ciphertext did not authenticate');
    }
    return plaintext;
  }

  async openText(ref: ColumnRef, stored: Uint8Array): Promise<string> {
    return new TextDecoder().decode(await this.open(ref, stored));
  }

  // -------------------------------------------------------------- rotation

  /**
   * Rotate the KEK: derive a new one and re-wrap every DEK under it.
   *
   * Cheap on purpose — **no user data is re-encrypted**, only the tens of bytes of
   * each wrapped DEK — because a rotation that requires downtime is a rotation that
   * never happens (03 §2.4). Run it inside a transaction by passing a client as the
   * queryable; a half-rotated keyring is unreadable.
   */
  async rotateKek(newPassphrase: string): Promise<UnlockState> {
    if (!this.#kek.isUnlocked) {
      throw new SecretBoxError('locked', 'cannot rotate the KEK while locked');
    }
    assertParamsAtOrAboveFloor(this.#kdfParams, this.#kdfFloor);
    if (newPassphrase.length === 0) {
      throw new SecretBoxError('passphrase_mismatch', 'the new passphrase must not be empty');
    }

    const nextVersion = (await maxVersion(this.#db, this.#userId, 'kek', KEK_SCOPE)) + 1;

    const salt = randomBytes(KEK_SALT_BYTES);
    const derived = await deriveKek(newPassphrase, salt, this.#kdfParams, () => this.#clock.nowMs());

    // Unwrap everything under the old KEK *before* the new one is installed. A row
    // wrapped under an even older generation cannot be unwrapped and will throw
    // here, which is correct: a keyring in that state is already broken and must
    // not be half-rotated on top.
    const wrapped = await listWrappedKeys(this.#db, this.#userId);
    const plainDeks = new Map<string, Uint8Array>();
    for (const row of wrapped) plainDeks.set(row.id, await this.#unwrap(row));

    const kekRowId = newId();
    const verifierEnvelope = this.#wrapUnder(
      derived.key,
      kekRowId,
      nextVersion,
      new Uint8Array(KEK_VERIFIER),
    );
    await insertKey(this.#db, {
      id: kekRowId,
      userId: this.#userId,
      kind: 'kek',
      scope: KEK_SCOPE,
      version: nextVersion,
      wrappedKey: verifierEnvelope,
      kekVersion: nextVersion,
      salt,
      params: this.#kdfParams,
    });

    for (const [id, dek] of plainDeks) {
      const row = wrapped.find((candidate) => candidate.id === id);
      if (row === undefined) continue;
      const rewrapped = this.#wrapUnder(derived.key, row.id, row.version, dek);
      await updateWrappedKey(this.#db, row.id, rewrapped, nextVersion);
    }

    // Retire superseded KEK generations. They are salt-and-verifier rows only, so
    // retiring them loses nothing that could still decrypt anything.
    for (const row of await listKeys(this.#db, this.#userId)) {
      if (row.kind === 'kek' && row.version < nextVersion && row.retiredAt === null) {
        await retireKey(this.#db, row.id, this.#clock.now());
      }
    }

    this.#kek.install(
      derived.key,
      nextVersion,
      { ...this.#kdfParams, durationMs: derived.durationMs },
      false,
    );
    // The cache still holds correct plaintext DEKs; only their wrapping changed.
    return this.#kek.state();
  }

  /**
   * Every key this box knows about, newest generation last. Powers the key-custody
   * panel and the rotation runbook; contains no key material.
   */
  async listKeyVersions(): Promise<KeyVersionSummary[]> {
    const rows = await listKeys(this.#db, this.#userId);
    return rows.map((row) => ({
      keyId: row.id,
      kind: row.kind,
      scope: row.scope,
      version: row.version,
      kekVersion: row.kekVersion,
      createdAt: row.createdAt,
      retiredAt: row.retiredAt,
    }));
  }

  /**
   * Retire the DEK for one row, making its ciphertext permanently unreadable.
   *
   * This is cryptographic erasure: the path behind "remove this Plaid Item"
   * (P1-9), where deleting the row is not enough because the bytes may already be
   * in last night's backup.
   */
  async destroyRecordKey(table: string, rowId: string): Promise<boolean> {
    const key = await findActiveKeyByScope(this.#db, this.#userId, 'dek', recordScope(table, rowId));
    if (key === null) return false;
    await retireKey(this.#db, key.id, this.#clock.now());
    const cached = this.#dekCache.get(key.id);
    if (cached !== undefined) {
      wipe(cached);
      this.#dekCache.delete(key.id);
    }
    await updateWrappedKey(this.#db, key.id, new Uint8Array(0), key.kekVersion);
    return true;
  }

  // ------------------------------------------------------------- internals

  async #initialiseKeyring(passphrase: string): Promise<void> {
    const salt = randomBytes(KEK_SALT_BYTES);
    const version = (await maxVersion(this.#db, this.#userId, 'kek', KEK_SCOPE)) + 1;
    const derived = await deriveKek(passphrase, salt, this.#kdfParams, () => this.#clock.nowMs());
    const id = newId();
    const verifier = this.#wrapUnder(derived.key, id, version, new Uint8Array(KEK_VERIFIER));
    await insertKey(this.#db, {
      id,
      userId: this.#userId,
      kind: 'kek',
      scope: KEK_SCOPE,
      version,
      wrappedKey: verifier,
      kekVersion: version,
      salt,
      params: this.#kdfParams,
    });
    this.#kek.install(
      derived.key,
      version,
      { ...this.#kdfParams, durationMs: derived.durationMs },
      false,
    );
  }

  #keyringRef(keyRowId: string): ColumnRef {
    return { table: KEYRING_TABLE, column: KEYRING_COLUMN, rowId: keyRowId };
  }

  /** Seal `material` under `kek`, bound to the keyring row that will hold it. */
  #wrapUnder(kek: Uint8Array, keyRowId: string, version: number, material: Uint8Array): Uint8Array {
    const nonce = randomNonce();
    const aad = buildAad(this.#keyringRef(keyRowId), version);
    const ciphertext = aeadSeal(kek, nonce, material, aad);
    return encodeEnvelope({ version: ENVELOPE_VERSION, keyId: keyRowId, nonce, ciphertext });
  }

  async #unwrap(row: EncryptionKeyRow): Promise<Uint8Array> {
    const cached = this.#dekCache.get(row.id);
    if (cached !== undefined) return cached;
    if (row.retiredAt !== null) {
      throw new SecretBoxError('key_retired', 'this key has been destroyed');
    }
    const envelope = decodeEnvelope(row.wrappedKey);
    const aad = buildAad(this.#keyringRef(row.id), row.version);
    const dek = this.#kek.use((kek) => aeadOpen(kek, envelope.nonce, envelope.ciphertext, aad));
    if (dek === null) {
      throw new SecretBoxError('decrypt_failed', 'a wrapped key did not authenticate');
    }
    this.#dekCache.set(row.id, dek);
    return dek;
  }

  async #resolveKeyForWrite(ref: ColumnRef, policy: KeyPolicy): Promise<EncryptionKeyRow> {
    const kind = policy === 'record' ? 'dek' : 'epoch';
    const scope = policy === 'record' ? recordScope(ref.table, ref.rowId) : epochScope(ref);
    const existing = await findActiveKeyByScope(this.#db, this.#userId, kind, scope);
    if (existing !== null) return existing;

    const version = (await maxVersion(this.#db, this.#userId, kind, scope)) + 1;
    const id = newId();
    const dek = randomKey();
    const wrapped = this.#kek.use((kek) => this.#wrapUnder(kek, id, version, dek));
    const row = await insertKey(this.#db, {
      id,
      userId: this.#userId,
      kind,
      scope,
      version,
      wrappedKey: wrapped,
      kekVersion: this.#kek.version,
    });
    this.#dekCache.set(row.id, dek);
    return row;
  }

  #meetsFloor(params: Argon2Params): boolean {
    return (
      params.memoryKiB >= this.#kdfFloor.memoryKiB &&
      params.timeCost >= this.#kdfFloor.timeCost &&
      params.parallelism >= this.#kdfFloor.parallelism
    );
  }
}

export function recordScope(table: string, rowId: string): string {
  return `${table}:${rowId}`;
}

export function epochScope(ref: Pick<ColumnRef, 'table' | 'column'>): string {
  return `${ref.table}.${ref.column}`;
}
