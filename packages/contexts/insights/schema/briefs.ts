// SPDX-License-Identifier: MIT
/**
 * `advisory_briefs` and `advisory_brief_items` -- migration
 * `0032_advisory_briefs.sql` (WP 5.6).
 *
 * See that file's header for the design. One thing worth repeating at the
 * query surface: **every displayed field on `advisoryBriefItems` is a
 * snapshot, not a join.** `insights` rows are upserted on their identity, so a
 * Brief that read through to the live row would let this week's re-run answer
 * last week's "why did it say $720?" (07 §7.3). `insightId` exists only for
 * the "open the live insight" click-through and is `SET NULL` on delete for
 * exactly that reason: the Brief's own record must outlive the source row.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  flagColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const BRIEF_ITEM_SECTIONS = ['ranked', 'attention'] as const;
export type BriefItemSection = (typeof BRIEF_ITEM_SECTIONS)[number];

/** A unit-interval score as exact decimal. Floats are banned across this schema. */
function scoreColumn(name: string) {
  return numeric(name, { precision: 7, scale: 6, mode: 'string' });
}

export const advisoryBriefs = pgTable(
  'advisory_briefs',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `YYYY-Www`, e.g. `2026-W40`. The identity, with `userId`. */
    isoWeek: text('iso_week').notNull(),
    currency: currencyColumn('currency').notNull(),
    /** ADV-1, principle 3: the ranked section was empty, and the Brief says so. */
    nothingMaterial: flagColumn('nothing_material').notNull(),
    /** E11 cold start: under 30 days of advisor history. */
    coldStart: flagColumn('cold_start').notNull(),
    coldStartNote: text('cold_start_note'),
    /** sha256 over the canonical set of source insights this Brief stood on. */
    inputDigest: text('input_digest').notNull(),
    publishedAt: instantColumn('published_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('advisory_briefs_user_week_idx').on(table.userId, table.isoWeek),
    uniqueIndex('advisory_briefs_user_id_idx').on(table.userId, table.id),
  ],
);

export type AdvisoryBriefRow = typeof advisoryBriefs.$inferSelect;
export type NewAdvisoryBriefRow = typeof advisoryBriefs.$inferInsert;

export const advisoryBriefItems = pgTable(
  'advisory_brief_items',
  {
    id: idColumn(),
    userId: userIdColumn(),
    briefId: uuid('brief_id').notNull(),
    section: text('section').$type<BriefItemSection>().notNull(),
    /** Order within its section. Part of the identity with `briefId`/`section`. */
    position: integer('position').notNull(),
    /** The live insight, for the click-through only -- never the source of a displayed field. */
    insightId: uuid('insight_id'),
    advisorId: text('advisor_id').notNull(),
    insightKey: text('insight_key').notNull(),
    insightType: text('insight_type').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    summaryMd: text('summary_md').notNull(),
    confidence: scoreColumn('confidence').notNull(),
    horizon: text('horizon').notNull(),
    /** E11: still live from last week's Brief. */
    carried: flagColumn('carried').notNull(),

    impactAnnualizedMinor: amountMinorColumn('impact_annualized_minor'),
    impactOneTimeMinor: amountMinorColumn('impact_one_time_minor'),
    impactCurrency: currencyColumn('impact_currency'),

    /** Snapshotted `insight_evidence`, as `EvidenceView[]` (`src/read.ts`'s shape). */
    evidence: jsonb('evidence').$type<readonly Record<string, unknown>[]>().notNull(),
    /** 07 §3.2's score, without `rank()`'s severity term. NULL for an attention item. */
    score: numeric('score', { precision: 30, scale: 6, mode: 'string' }),
    /** The factors `score` was computed from. NULL exactly when `score` is. */
    scoreFactors: jsonb('score_factors').$type<Record<string, unknown> | null>(),
    /** `RetirementImpactAnswer`, whole. Never recomputed on read. */
    retirementEffect: jsonb('retirement_effect').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('advisory_brief_items_position_idx').on(
      table.briefId,
      table.section,
      table.position,
    ),
    index('advisory_brief_items_brief_idx').on(table.userId, table.briefId),
    index('advisory_brief_items_finding_idx').on(table.userId, table.advisorId, table.insightKey),
  ],
);

export type AdvisoryBriefItemRow = typeof advisoryBriefItems.$inferSelect;
export type NewAdvisoryBriefItemRow = typeof advisoryBriefItems.$inferInsert;
