// SPDX-License-Identifier: MIT
/**
 * `insight_explanations` -- migration `0057_insight_explanations.sql` (WP 11.3).
 *
 * "Explain this": one model explanation, or the validator's refusal class, per
 * holder, entity (an insight or a health pillar) and evidence digest. A new
 * digest is a new row; nothing is deleted on dismissal. The CHECKs live in the
 * SQL only, as for every other table of this package.
 */
import { createdAtColumn, idColumn, userIdColumn } from '@core/db';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const EXPLANATION_ENTITY_KINDS = ['insight', 'health_pillar'] as const;
export type ExplanationEntityKind = (typeof EXPLANATION_ENTITY_KINDS)[number];

export const insightExplanations = pgTable(
  'insight_explanations',
  {
    id: idColumn(),
    userId: userIdColumn(),
    entityKind: text('entity_kind').$type<ExplanationEntityKind>().notNull(),
    entityId: text('entity_id').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
    explanationText: text('explanation_text'),
    refusal: text('refusal'),
    llmProvider: text('llm_provider').notNull(),
    llmModel: text('llm_model').notNull(),
    runId: uuid('run_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('insight_explanations_digest_idx').on(
      table.userId,
      table.entityKind,
      table.entityId,
      table.evidenceDigest,
    ),
    index('insight_explanations_entity_idx').on(
      table.userId,
      table.entityKind,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export type InsightExplanationRow = typeof insightExplanations.$inferSelect;
export type NewInsightExplanationRow = typeof insightExplanations.$inferInsert;
