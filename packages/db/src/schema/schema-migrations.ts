// SPDX-License-Identifier: MIT
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { instantColumn } from '../columns.ts';

/**
 * Migration bookkeeping. Owned by `@core/db` (platform), not by any context.
 *
 * Not user-scoped, so it carries no `user_id`.
 */
export const schemaMigrations = pgTable('schema_migrations', {
  version: text('version').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 of the file as applied. A drifted checksum is a hard failure. */
  checksum: text('checksum').notNull(),
  appliedAt: instantColumn('applied_at').notNull().defaultNow(),
  executionMs: integer('execution_ms').notNull(),
});

export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;
