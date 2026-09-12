// SPDX-License-Identifier: MIT
import {
  byteaColumn,
  createdAtColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db/columns';
import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The keyring (03 §2.4: "build the keyring on day one — retrofitting it is a
 * migration nightmare").
 *
 * One table holds three kinds of row, because the alternative — three tables that
 * must be joined to answer "which key opens this envelope?" — makes rotation a
 * distributed transaction over a single-user app's most fragile data.
 *
 * | `kind`  | `scope`              | `wrapped_key`                        | `salt`/`params` |
 * | ------- | -------------------- | ------------------------------------ | --------------- |
 * | `kek`   | `kek`                | a sealed constant, used to verify     | set             |
 * | `dek`   | `<table>:<row uuid>` | the record DEK, sealed under the KEK  | null            |
 * | `epoch` | `<table>.<column>`   | the epoch DEK, sealed under the KEK   | null            |
 *
 * The KEK itself is never stored in any form. What the `kek` row holds is a salt,
 * the Argon2id parameters, and a ciphertext whose tag proves the passphrase
 * re-derived the same key. Losing this row makes re-derivation impossible, which
 * is why it belongs in the backup and the passphrase does not (03 §6.2:
 * co-locating the key and the ciphertext converts two secrets into one).
 */
export const encryptionKeys = pgTable(
  'encryption_keys',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `kek` | `dek` | `epoch`. Constrained in SQL; Drizzle sees text. */
    kind: text('kind').notNull(),
    scope: text('scope').notNull(),
    version: integer('version').notNull(),
    wrappedKey: byteaColumn('wrapped_key').notNull(),
    kekVersion: integer('kek_version').notNull(),
    salt: byteaColumn('salt'),
    params: jsonb('params').$type<{ memoryKiB: number; timeCost: number; parallelism: number }>(),
    createdAt: createdAtColumn(),
    /** Set when the key is superseded or destroyed. A retired key never unwraps. */
    retiredAt: instantColumn('retired_at'),
  },
  (table) => [
    uniqueIndex('encryption_keys_scope_version_key').on(
      table.userId,
      table.kind,
      table.scope,
      table.version,
    ),
  ],
);

export type EncryptionKeyRecord = typeof encryptionKeys.$inferSelect;
export type NewEncryptionKeyRecord = typeof encryptionKeys.$inferInsert;
