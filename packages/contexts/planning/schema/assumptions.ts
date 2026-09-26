// SPDX-License-Identifier: MIT
/**
 * `plan_assumptions` — a user's assumption overrides, as a delta against a
 * named assumptions-file version (WP 4.2, migration 0021).
 *
 * The type; `0021_plan_assumptions.sql` is the schema. The rules that carry the
 * load — one row per user, a well-formed `sha256:` version, and a `deltas`
 * column that can only hold a flat `path → decimal string` object — are CHECKs
 * and a UNIQUE index in the migration, because an ORM should not be inventing a
 * CHECK over an IMMUTABLE function on JSONB.
 *
 * Kept in its own file for Phase 4 Wave A so WP 4.1's edits to `index.ts` and
 * this one cannot collide; `index.ts` re-exports it.
 */
import { createdAtColumn, idColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const planAssumptions = pgTable('plan_assumptions', {
  id: idColumn(),
  userId: userIdColumn(),
  /** `sha256:<64 hex>` — the content hash of the file the deltas were computed against. */
  assumptionsVersion: text('assumptions_version').notNull(),
  /** `{ "capitalMarket.usEquity.expectedReturn": "0.055" }`. Only what differs from the default. */
  deltas: jsonb('deltas').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
