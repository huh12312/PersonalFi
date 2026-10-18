// SPDX-License-Identifier: MIT
/**
 * `health_score_snapshots` -- migration `0048_health_score_snapshots.sql` (WP 10.12).
 *
 * One row per (user, day): the health score `src/health/score.ts#computeHealthScore` computes (unchanged
 * from WP 5.8) and its six pillars, each scored with the inputs it was built from or withheld with the
 * reason and what would unlock it. Written once, never updated, never backfilled. The precise pillar shape
 * (`HealthPillar`) lives in `src/health/pillars.ts`; this file declares plain JSON, the same choice
 * `health.ts` makes for `health_scores`.
 */
import { createdAtColumn, dateColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { jsonb, numeric, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

export const healthScoreSnapshots = pgTable(
  'health_score_snapshots',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** The holder's calendar day, in their display time zone. */
    asOfDate: dateColumn('as_of_date').notNull(),
    /** 0-100, two decimals. NULL exactly when every pillar is withheld. */
    score: numeric('score', { precision: 5, scale: 2, mode: 'string' }),
    /** `HealthPillar[]`, six, in `HEALTH_COMPONENT_IDS` order. */
    pillars: jsonb('pillars').$type<readonly Record<string, unknown>[]>().notNull(),
    computedAt: instantColumn('computed_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('health_score_snapshots_user_date_idx').on(table.userId, table.asOfDate)],
);

export type HealthScoreSnapshotRow = typeof healthScoreSnapshots.$inferSelect;
export type NewHealthScoreSnapshotRow = typeof healthScoreSnapshots.$inferInsert;
