// SPDX-License-Identifier: MIT
/**
 * `ask_sessions` -- migration `0060_ask_sessions.sql` (WP 11.5c).
 *
 * Ask PersonalFi, reporting mode: one row per question. The status machine is
 * `compiling → running → narrating → shown | refused | unanswerable | failed |
 * cancelled`; a question the deterministic pre-check refuses or rules out of
 * scope is written already finished. `compile_run_id` and `narrate_run_id`
 * are each claimed once, before their model call: one call per step. The
 * CHECKs live in the SQL only, as for every other table of this package.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const ASK_SESSION_STATUSES = [
  'compiling',
  'running',
  'narrating',
  'shown',
  'refused',
  'unanswerable',
  'failed',
  'cancelled',
] as const;
export type AskSessionStatus = (typeof ASK_SESSION_STATUSES)[number];

/** The statuses a session is still in flight in (`finished_at` is null exactly then). */
export const ASK_SESSION_IN_FLIGHT: readonly AskSessionStatus[] = Object.freeze([
  'compiling',
  'running',
  'narrating',
]);

export const ASK_UNANSWERABLE_REASONS = ['out_of_scope', 'not_computable'] as const;
export type AskUnanswerableReason = (typeof ASK_UNANSWERABLE_REASONS)[number];

export const askSessions = pgTable(
  'ask_sessions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    question: text('question').notNull(),
    status: text('status').$type<AskSessionStatus>().notNull(),
    catalogueVersion: text('catalogue_version').notNull(),
    compiledCalls: jsonb('compiled_calls').$type<readonly Record<string, unknown>[]>(),
    results: jsonb('results').$type<readonly Record<string, unknown>[]>(),
    narrationText: text('narration_text'),
    refusal: text('refusal'),
    unanswerableReason: text('unanswerable_reason').$type<AskUnanswerableReason>(),
    unanswerableTopic: text('unanswerable_topic'),
    nearestScreen: text('nearest_screen'),
    errorCode: text('error_code'),
    llmProvider: text('llm_provider'),
    llmModel: text('llm_model'),
    compileRunId: uuid('compile_run_id'),
    narrateRunId: uuid('narrate_run_id'),
    compileInputDigest: text('compile_input_digest'),
    narrateInputDigest: text('narrate_input_digest'),
    knowledgeRead: jsonb('knowledge_read').$type<Record<string, unknown>>(),
    compileMs: integer('compile_ms'),
    callsMs: integer('calls_ms'),
    narrateMs: integer('narrate_ms'),
    createdAt: createdAtColumn(),
    finishedAt: instantColumn('finished_at'),
  },
  (table) => [index('ask_sessions_user_created_idx').on(table.userId, table.createdAt, table.id)],
);

export type AskSessionRow = typeof askSessions.$inferSelect;
export type NewAskSessionRow = typeof askSessions.$inferInsert;
