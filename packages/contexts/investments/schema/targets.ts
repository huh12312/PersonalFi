// SPDX-License-Identifier: MIT
/**
 * `allocation_targets` and `security_tags` — migration `0026_allocation_targets.sql`.
 *
 * See that file's header for the design: why both tables are owned by
 * `@ctx/investments` and not `@ctx/planning` (08 §1.6's arrows point down; drift
 * is an investments analytic), why an empty `allocation_targets` set means
 * "unset" rather than a default 60/40 (`wp3.9-routes.md` §8 Q9), and why
 * `security_tags`' `employer_stock` member has exactly one writer
 * (`src/tags.ts`'s `setSecurityTag`) — 07 I5 forbids inferring an employer.
 *
 * This file is the query surface, not the DDL. Indexes and CHECK constraints
 * live in the migration; the `unique()` markers below exist only because
 * Drizzle's `onConflictDoUpdate` needs a target expression.
 */
import { idColumn, instantColumn, userIdColumn } from '@core/db';
import { numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { AssetClass } from './securities.ts';

/**
 * A unit-interval ratio at `src/analytics/types.ts`'s `RATIO_SCALE` (10 places).
 * `NUMERIC(11,10)`: one digit for the integer part (0 or 1), ten after the point.
 */
function targetWeightColumn(name: string) {
  return numeric(name, { precision: 11, scale: 10, mode: 'string' });
}

/** Percentage points at `src/analytics/types.ts`'s `POINTS_SCALE` (4 places). */
function bandPointsColumn(name: string) {
  return numeric(name, { precision: 8, scale: 4, mode: 'string' });
}

/** 07 I1's absolute band, as the column default — `DRIFT_BAND_POINTS` in `drift.ts`. */
export const DEFAULT_BAND_PCT = '5.0000';

export const allocationTargets = pgTable(
  'allocation_targets',
  {
    id: idColumn(),
    userId: userIdColumn(),
    assetClass: text('asset_class').$type<AssetClass>().notNull(),
    targetWeight: targetWeightColumn('target_weight').notNull(),
    bandPct: bandPointsColumn('band_pct').notNull().default(DEFAULT_BAND_PCT),
    setAt: instantColumn('set_at').notNull().defaultNow(),
  },
  (table) => [
    unique('allocation_targets_user_asset_class_uniq').on(table.userId, table.assetClass),
  ],
);

export type AllocationTargetRow = typeof allocationTargets.$inferSelect;
export type NewAllocationTargetRow = typeof allocationTargets.$inferInsert;

/**
 * 07 I5's tag, plus `watchlist`. `employer_stock` is the holder's own claim
 * that a position is their employer's stock — "an employer is never
 * inferred" — so the only place this literal is written as a value is here
 * and in `src/tags.ts`'s explicit setter; `test/tags.test.ts` greps the whole
 * package for a second writer.
 */
export const SECURITY_TAGS = ['employer_stock', 'watchlist'] as const;
export type SecurityTagKind = (typeof SECURITY_TAGS)[number];

export const securityTags = pgTable(
  'security_tags',
  {
    id: idColumn(),
    userId: userIdColumn(),
    securityId: uuid('security_id').notNull(),
    tag: text('tag').$type<SecurityTagKind>().notNull(),
    setAt: instantColumn('set_at').notNull().defaultNow(),
  },
  (table) => [
    unique('security_tags_user_security_tag_uniq').on(table.userId, table.securityId, table.tag),
  ],
);

export type SecurityTagRow = typeof securityTags.$inferSelect;
export type NewSecurityTagRow = typeof securityTags.$inferInsert;
