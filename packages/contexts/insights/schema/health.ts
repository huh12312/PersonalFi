// SPDX-License-Identifier: MIT
/**
 * `health_scores` -- migration `0033_health_scores.sql` (WP 5.8).
 *
 * One row per (user, ISO week): `src/health/score.ts#computeHealthScore`'s
 * result, stored whole and never re-derived on read -- the same posture
 * `advisory_brief_items.retirement_effect` takes toward
 * `RetirementImpactAnswer` (0032, WP 5.6's own header). Deliberately no
 * foreign key toward `advisory_briefs`/`advisory_brief_items`: the two
 * tables are computed together by the weekly job, not linked as parent and
 * child, and 05 §4's ordering rule forbids either of this wave's migrations
 * referencing the other's objects.
 *
 * `components` and `excluded` are typed here as plain JSON
 * (`readonly Record<string, unknown>[]`), the same choice
 * `advisory_brief_items.evidence`/`.scoreFactors` (0032) make: a
 * schema-definition file declares no dependency on `src/`'s runtime or its
 * types, matching every other table-definition file in this package. The
 * precise shape (`HealthComponentResult[]` / `HealthExcludedComponent[]`)
 * lives in `src/health/score.ts`, and `src/health/store.ts` is what reads
 * these columns back into those types.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { jsonb, numeric, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

/** 0-100, two decimal places -- `D.render(weightedSum, 2)`'s own scale. */
function overallScoreColumn(name: string) {
  return numeric(name, { precision: 5, scale: 2, mode: 'string' });
}

export const healthScores = pgTable(
  'health_scores',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `YYYY-Www`, e.g. `2026-W40`. The identity, with `userId`. */
    isoWeek: text('iso_week').notNull(),
    /** NULL exactly when every component is excluded -- never a score over zero components. */
    overall: overallScoreColumn('overall'),
    /** `HealthComponentResult[]` (`src/health/score.ts`), in `HEALTH_COMPONENT_IDS` order. */
    components: jsonb('components').$type<readonly Record<string, unknown>[]>().notNull(),
    /** `HealthExcludedComponent[]` -- a component with no data, named with its reason. */
    excluded: jsonb('excluded').$type<readonly Record<string, unknown>[]>().notNull(),
    computedAt: instantColumn('computed_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('health_scores_user_week_idx').on(table.userId, table.isoWeek)],
);

export type HealthScoreRow = typeof healthScores.$inferSelect;
export type NewHealthScoreRow = typeof healthScores.$inferInsert;
