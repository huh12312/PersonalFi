// SPDX-License-Identifier: MIT
import { instantColumn } from '@core/db/columns';
import { index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The non-secret effective configuration of each process role, recorded at boot.
 *
 * Deduplicated by hash rather than appended per boot: "what changed?" after a
 * behaviour shift is then a diff between two rows with timestamps, and a
 * container that restarts every five minutes does not fill a table.
 *
 * Global — this is the process's configuration, not the account holder's data,
 * and it is deliberately excluded from the user export. The payload comes from
 * `describeConfig()`, which omits every secret by construction; nothing here is
 * ever a credential.
 */
export const configSnapshots = pgTable(
  'config_snapshots',
  {
    id: uuid('id').primaryKey(),
    /** `api` | `worker` | `migrator` | `cli`. */
    role: text('role').notNull(),
    /** SHA-256 over the canonical JSON of `payload`. */
    hash: text('hash').notNull(),
    payload: jsonb('payload').notNull(),
    appVersion: text('app_version').notNull(),
    firstSeenAt: instantColumn('first_seen_at').notNull().defaultNow(),
    lastSeenAt: instantColumn('last_seen_at').notNull().defaultNow(),
    bootCount: integer('boot_count').notNull().default(1),
  },
  (table) => [
    unique('config_snapshots_role_hash_key').on(table.role, table.hash),
    index('config_snapshots_last_seen_idx').on(table.lastSeenAt),
  ],
);

export type ConfigSnapshotRow = typeof configSnapshots.$inferSelect;
