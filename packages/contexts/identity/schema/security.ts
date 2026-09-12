// SPDX-License-Identifier: MIT
import { byteaColumn, idColumn, instantColumn, updatedAtColumn } from '@core/db/columns';
import { index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Persistent rate-limit counters (03 §3.4, P0-14).
 *
 * In Postgres, not in memory. An in-memory counter resets on restart, and
 * "restart the container" is a trivially exploitable bypass on a box the attacker
 * can already reach — which is precisely the scenario a self-hosted app is in.
 *
 * Fixed windows, one row per `(bucket, subject, window)`. A sliding-window log
 * would be more accurate and would also mean a row per request; for one user that
 * is the wrong trade.
 */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    /** The limit being applied, e.g. `webauthn`, `totp`, `recovery_code`, `refresh`. */
    bucket: text('bucket').notNull(),
    /** The subject: an IP, or `user:<uuid>`. Never a credential. */
    subject: text('subject').notNull(),
    windowStart: instantColumn('window_start').notNull(),
    attempts: integer('attempts').notNull().default(0),
    userId: uuid('user_id'),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.subject, table.windowStart] }),
    index('auth_attempts_window_idx').on(table.windowStart),
  ],
);

/**
 * Consecutive-failure lockout with exponential backoff.
 *
 * Ten failures → 15 minutes, doubling, **capped at 24 hours**. The cap is not
 * softness: a permanent lockout on a single-user self-hosted app is a
 * self-inflicted denial of service with no support desk to call, and the correct
 * response to sustained brute force is an alert, not a brick.
 */
export const authLockouts = pgTable(
  'auth_lockouts',
  {
    bucket: text('bucket').notNull(),
    subject: text('subject').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lockLevel: integer('lock_level').notNull().default(0),
    lockedUntil: instantColumn('locked_until'),
    userId: uuid('user_id'),
    firstFailureAt: instantColumn('first_failure_at'),
    updatedAt: updatedAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.bucket, table.subject] })],
);

/**
 * The security audit trail (P1-10).
 *
 * Written from exactly one helper (`recordSecurityEvent`) so that "was this
 * logged?" has a single answer and a single place to fix. `detail` is the one
 * column a future field could smuggle a credential into, so the writer strips
 * credential-shaped keys before the row lands.
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: idColumn(),
    /** Nullable and `ON DELETE SET NULL`: the trail outlives the account it describes. */
    userId: uuid('user_id'),
    occurredAt: instantColumn('occurred_at').notNull().defaultNow(),
    kind: text('kind').notNull(),
    /** `success` | `failure` | `blocked`. */
    outcome: text('outcome').notNull(),
    detail: jsonb('detail').notNull().default({}),
    ip: text('ip'),
    userAgentHash: byteaColumn('user_agent_hash'),
    correlationId: text('correlation_id'),
  },
  (table) => [index('security_events_occurred_idx').on(table.occurredAt)],
);

export type AuthAttemptRow = typeof authAttempts.$inferSelect;
export type AuthLockoutRow = typeof authLockouts.$inferSelect;
export type SecurityEventRow = typeof securityEvents.$inferSelect;
