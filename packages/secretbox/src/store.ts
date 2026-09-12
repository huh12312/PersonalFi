// SPDX-License-Identifier: MIT
/**
 * Persistence for `encryption_keys`, the keyring's only table.
 *
 * Raw parameterised SQL rather than Drizzle, deliberately: this table is read on
 * the hot path of every decrypt and its `bytea` round-trip is correctness
 * critical, so the three statements involved are better read as SQL than as a
 * query builder's output. The Drizzle definition in `schema/` still exists — it is
 * how the schema-ownership check sees the claim, and how a later migration tool
 * sees the shape.
 *
 * The interface is the narrow slice of `pg.Pool` we use, so this package does not
 * depend on `pg` and a test can pass a fake.
 */
import { SecretBoxError } from './errors.ts';

export interface SecretBoxQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type KeyKind = 'kek' | 'dek' | 'epoch';

export interface EncryptionKeyRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: KeyKind;
  /** `${table}:${rowId}` for a per-record DEK, `${table}.${column}` for an epoch DEK, `kek` for the KEK. */
  readonly scope: string;
  readonly version: number;
  /**
   * For `dek`/`epoch`: the DEK sealed under the KEK, as a storage envelope.
   * For `kek`: a sealed constant used only to prove the passphrase is the right one.
   */
  readonly wrappedKey: Uint8Array;
  /** Which KEK generation wrapped `wrapped_key`. Drives `rotateKek`. */
  readonly kekVersion: number;
  /** Argon2id salt. Present only on `kek` rows. */
  readonly salt: Uint8Array | null;
  /** Argon2id parameters used for this KEK generation. Present only on `kek` rows. */
  readonly params: { memoryKiB: number; timeCost: number; parallelism: number } | null;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

const COLUMNS = `id, user_id, kind, scope, version, wrapped_key, kek_version, salt, params, created_at, retired_at`;

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new SecretBoxError('envelope_malformed', 'expected bytea to arrive as a buffer');
}

function mapRow(row: Record<string, unknown>): EncryptionKeyRow {
  const params = row['params'] as Record<string, number> | null;
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    kind: row['kind'] as KeyKind,
    scope: String(row['scope']),
    version: Number(row['version']),
    wrappedKey: toBytes(row['wrapped_key']),
    kekVersion: Number(row['kek_version']),
    salt: row['salt'] === null ? null : toBytes(row['salt']),
    params:
      params === null
        ? null
        : {
            memoryKiB: Number(params['memoryKiB']),
            timeCost: Number(params['timeCost']),
            parallelism: Number(params['parallelism']),
          },
    createdAt: row['created_at'] as Date,
    retiredAt: (row['retired_at'] as Date | null) ?? null,
  };
}

export interface InsertKeyInput {
  readonly id: string;
  readonly userId: string;
  readonly kind: KeyKind;
  readonly scope: string;
  readonly version: number;
  readonly wrappedKey: Uint8Array;
  readonly kekVersion: number;
  readonly salt?: Uint8Array | undefined;
  readonly params?: { memoryKiB: number; timeCost: number; parallelism: number } | undefined;
}

export async function insertKey(
  db: SecretBoxQueryable,
  input: InsertKeyInput,
): Promise<EncryptionKeyRow> {
  const result = await db.query(
    `INSERT INTO encryption_keys (id, user_id, kind, scope, version, wrapped_key, kek_version, salt, params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.userId,
      input.kind,
      input.scope,
      input.version,
      Buffer.from(input.wrappedKey),
      input.kekVersion,
      input.salt === undefined ? null : Buffer.from(input.salt),
      input.params === undefined ? null : JSON.stringify(input.params),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new SecretBoxError('unknown_key', 'insert returned no row');
  return mapRow(row);
}

export async function findKeyById(
  db: SecretBoxQueryable,
  id: string,
): Promise<EncryptionKeyRow | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM encryption_keys WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** The live key for a scope: the highest version that has not been retired. */
export async function findActiveKeyByScope(
  db: SecretBoxQueryable,
  userId: string,
  kind: KeyKind,
  scope: string,
): Promise<EncryptionKeyRow | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM encryption_keys
     WHERE user_id = $1 AND kind = $2 AND scope = $3 AND retired_at IS NULL
     ORDER BY version DESC
     LIMIT 1`,
    [userId, kind, scope],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function listKeys(
  db: SecretBoxQueryable,
  userId: string,
): Promise<EncryptionKeyRow[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM encryption_keys WHERE user_id = $1 ORDER BY kind, scope, version`,
    [userId],
  );
  return result.rows.map(mapRow);
}

/** Every live DEK, whatever its policy. The unit of work for `rotateKek`. */
export async function listWrappedKeys(
  db: SecretBoxQueryable,
  userId: string,
): Promise<EncryptionKeyRow[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM encryption_keys
     WHERE user_id = $1 AND kind <> 'kek' AND retired_at IS NULL
     ORDER BY id`,
    [userId],
  );
  return result.rows.map(mapRow);
}

export async function updateWrappedKey(
  db: SecretBoxQueryable,
  id: string,
  wrappedKey: Uint8Array,
  kekVersion: number,
): Promise<void> {
  await db.query(`UPDATE encryption_keys SET wrapped_key = $2, kek_version = $3 WHERE id = $1`, [
    id,
    Buffer.from(wrappedKey),
    kekVersion,
  ]);
}

export async function retireKey(db: SecretBoxQueryable, id: string, at: Date): Promise<void> {
  await db.query(`UPDATE encryption_keys SET retired_at = $2 WHERE id = $1`, [id, at]);
}

export async function maxVersion(
  db: SecretBoxQueryable,
  userId: string,
  kind: KeyKind,
  scope: string,
): Promise<number> {
  const result = await db.query(
    `SELECT coalesce(max(version), 0) AS v FROM encryption_keys
     WHERE user_id = $1 AND kind = $2 AND scope = $3`,
    [userId, kind, scope],
  );
  return Number(result.rows[0]?.['v'] ?? 0);
}
