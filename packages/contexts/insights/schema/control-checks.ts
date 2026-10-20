// SPDX-License-Identifier: MIT
/**
 * `ops_control_checks` -- migration `0052_ops_control_checks.sql` (WP 10.16).
 *
 * One row per run of the GenAI controls self-test: the holder's narrator
 * provider and model at the start, the catalogue's per-check results (facts in
 * words, never a payload, a prompt, a key or a reply) and the overall verdict.
 * The CHECKs live in the SQL only, as for every other table of this package.
 * The per-check row shape is `src/control-checks/catalogue.ts`'s `CheckRow`.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const opsControlChecks = pgTable(
  'ops_control_checks',
  {
    id: idColumn(),
    userId: userIdColumn(),
    startedAt: instantColumn('started_at').notNull(),
    finishedAt: instantColumn('finished_at'),
    provider: text('provider').notNull(),
    model: text('model'),
    results: jsonb('results').$type<readonly Record<string, unknown>[]>().notNull(),
    overall: text('overall'),
    evidenceVersion: text('evidence_version').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [index('ops_control_checks_user_started_idx').on(table.userId, table.startedAt)],
);

export type OpsControlCheckRow = typeof opsControlChecks.$inferSelect;
