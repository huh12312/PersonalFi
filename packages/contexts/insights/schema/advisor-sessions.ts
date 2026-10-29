// SPDX-License-Identifier: MIT
/**
 * `advisor_sessions`, `advisor_session_steps`, `advisor_settings` --
 * migration `0061_advisor_sessions.sql` (WP 11.5d).
 *
 * Ask PersonalFi, advisor mode: one row per conversation, one step row per
 * model call (UNIQUE per session and step: one call per step), and the
 * advisor's own hosted consent (D31). The status machine is
 * `clarifying → gathering → options → tradeoffs → awaiting_pick → planning →
 * tracked → completed | refused | unanswerable | failed | cancelled`. Migration
 * `0062_advisor_sessions_origin.sql` (WP 11.5e) adds `completed` and the origin
 * columns. The CHECKs live in
 * the SQL only, as for every other table of this package.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { index, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const ADVISOR_SESSION_STATUSES = [
  'clarifying',
  'gathering',
  'options',
  'tradeoffs',
  'awaiting_pick',
  'planning',
  'tracked',
  // WP 11.5e (0062): a tracked plan whose watched figure reached its target; the watcher stops.
  'completed',
  'refused',
  'unanswerable',
  'failed',
  'cancelled',
] as const;
export type AdvisorSessionStatus = (typeof ADVISOR_SESSION_STATUSES)[number];

/** Statuses a worker pass moves on by itself (a model step is due). */
export const ADVISOR_SESSION_WORKING: readonly AdvisorSessionStatus[] = Object.freeze([
  'clarifying',
  'gathering',
  'options',
  'tradeoffs',
  'planning',
]);

/** Statuses a session is still open in (`finished_at` is null exactly then). */
export const ADVISOR_SESSION_OPEN: readonly AdvisorSessionStatus[] = Object.freeze([
  'clarifying',
  'gathering',
  'options',
  'tradeoffs',
  'awaiting_pick',
  'planning',
]);

export const ADVISOR_STEPS = [
  'clarify',
  'gather',
  'options',
  'tradeoffs',
  'plan',
  'judge',
] as const;
export type AdvisorStep = (typeof ADVISOR_STEPS)[number];

export const ADVISOR_STEP_OUTCOMES = ['accepted', 'refused', 'failed', 'cancelled'] as const;
export type AdvisorStepOutcome = (typeof ADVISOR_STEP_OUTCOMES)[number];

export const advisorSessions = pgTable(
  'advisor_sessions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    question: text('question').notNull(),
    status: text('status').$type<AdvisorSessionStatus>().notNull(),
    catalogueVersion: text('catalogue_version').notNull(),
    clarification: jsonb('clarification').$type<Record<string, unknown>>(),
    answers: jsonb('answers').$type<readonly string[]>(),
    gathered: jsonb('gathered').$type<Record<string, unknown>>(),
    contextDigest: text('context_digest'),
    options: jsonb('options').$type<readonly Record<string, unknown>[]>(),
    tradeoffs: jsonb('tradeoffs').$type<readonly Record<string, unknown>[]>(),
    pickedOption: text('picked_option'),
    plan: jsonb('plan').$type<readonly Record<string, unknown>[]>(),
    watcherId: uuid('watcher_id'),
    watcher: jsonb('watcher').$type<Record<string, unknown>>(),
    judgeScore: numeric('judge_score', { precision: 4, scale: 3 }),
    judgeRunId: uuid('judge_run_id'),
    judgeDetail: jsonb('judge_detail').$type<Record<string, unknown>>(),
    judgeError: text('judge_error'),
    refusal: text('refusal'),
    unanswerableReason: text('unanswerable_reason').$type<'out_of_scope' | 'not_computable'>(),
    unanswerableTopic: text('unanswerable_topic'),
    nearestScreen: text('nearest_screen'),
    errorCode: text('error_code'),
    tokenBudget: integer('token_budget').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    hostedWindowLeft: integer('hosted_window_left'),
    createdAt: createdAtColumn(),
    updatedAt: instantColumn('updated_at').notNull(),
    finishedAt: instantColumn('finished_at'),
    // WP 11.5e (0062): the finding a "Talk this through" session was opened from. The pair is set
    // together or not at all; the title rides with it; the Brief week only with a finding.
    originInsightRef: uuid('origin_insight_ref'),
    originRuleId: text('origin_rule_id'),
    originTitle: text('origin_title'),
    originBriefWeek: text('origin_brief_week'),
  },
  (table) => [
    index('advisor_sessions_user_created_idx').on(table.userId, table.createdAt, table.id),
  ],
);

export type AdvisorSessionRow = typeof advisorSessions.$inferSelect;
export type NewAdvisorSessionRow = typeof advisorSessions.$inferInsert;

export const advisorSessionSteps = pgTable(
  'advisor_session_steps',
  {
    id: idColumn(),
    userId: userIdColumn(),
    sessionId: uuid('session_id').notNull(),
    step: text('step').$type<AdvisorStep>().notNull(),
    runId: uuid('run_id').notNull(),
    inputDigest: text('input_digest').notNull(),
    llmProvider: text('llm_provider').notNull(),
    llmModel: text('llm_model').notNull(),
    egress: text('egress').$type<'local' | 'hosted'>().notNull(),
    outcome: text('outcome').$type<AdvisorStepOutcome>(),
    refusal: text('refusal'),
    errorCode: text('error_code'),
    knowledgeRead: jsonb('knowledge_read').$type<Record<string, unknown>>(),
    tokens: integer('tokens'),
    durationMs: integer('duration_ms'),
    createdAt: createdAtColumn(),
    finishedAt: instantColumn('finished_at'),
  },
  (table) => [index('advisor_session_steps_user_session_idx').on(table.userId, table.sessionId)],
);

export type AdvisorSessionStepRow = typeof advisorSessionSteps.$inferSelect;
export type NewAdvisorSessionStepRow = typeof advisorSessionSteps.$inferInsert;

export const advisorSettings = pgTable('advisor_settings', {
  userId: uuid('user_id').primaryKey(),
  hostedProvider: text('hosted_provider').$type<'openai' | 'openrouter' | 'anthropic'>(),
  hostedConsentedAt: instantColumn('hosted_consented_at'),
  hostedConsentTextHash: text('hosted_consent_text_hash'),
  updatedAt: instantColumn('updated_at').notNull(),
});

export type AdvisorSettingsRow = typeof advisorSettings.$inferSelect;
