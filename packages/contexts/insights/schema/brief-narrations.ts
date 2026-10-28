// SPDX-License-Identifier: MIT
/**
 * `brief_narrations` -- migration `0059_brief_narrations.sql` (WP 11.4).
 *
 * The Brief's own narration and the weekly recap: one language-model call per
 * published Brief, claimed (`calling`) before the call and finished once
 * (`shown`, `refused`, `failed`, `cancelled`). UNIQUE on (user, brief): a
 * second job for the same Brief asks nothing. The CHECKs live in the SQL only,
 * as for every other table of this package.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const BRIEF_NARRATION_STATUSES = [
  'calling',
  'shown',
  'refused',
  'failed',
  'cancelled',
] as const;
export type BriefNarrationStatus = (typeof BRIEF_NARRATION_STATUSES)[number];

export const briefNarrations = pgTable(
  'brief_narrations',
  {
    id: idColumn(),
    userId: userIdColumn(),
    briefId: uuid('brief_id').notNull(),
    status: text('status').$type<BriefNarrationStatus>().notNull(),
    narrationText: text('narration_text'),
    recapText: text('recap_text'),
    refusal: text('refusal'),
    inputDigest: text('input_digest').notNull(),
    llmProvider: text('llm_provider').notNull(),
    llmModel: text('llm_model').notNull(),
    runId: uuid('run_id').notNull(),
    createdAt: createdAtColumn(),
    finishedAt: instantColumn('finished_at'),
  },
  (table) => [uniqueIndex('brief_narrations_brief_idx').on(table.userId, table.briefId)],
);

export type BriefNarrationRow = typeof briefNarrations.$inferSelect;
export type NewBriefNarrationRow = typeof briefNarrations.$inferInsert;
