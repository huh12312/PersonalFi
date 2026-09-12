// SPDX-License-Identifier: MIT
import {
  byteaColumn,
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db/columns';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Opaque server-side sessions (03 §3.4, P0-5).
 *
 * Not JWTs. A single-user app has zero need for stateless verification, and
 * server-side sessions buy instant revocation — which matters far more here,
 * because "log out everywhere right now" is the first thing Chris will want to do
 * if a device goes missing.
 *
 * **One row per refresh generation, not one row per session.** A refresh rotates:
 * the presented row is stamped `supersededBy` and a new row joins the same
 * `familyId`. Presenting a refresh token whose row is already superseded or
 * revoked is the cookie-theft signal and kills the entire family. An `UPDATE` in
 * place would be tidier and would also destroy the evidence detection depends on.
 *
 * Only SHA-256 digests are stored. The raw token exists in exactly one place: the
 * cookie in the browser.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    familyId: uuid('family_id').notNull(),
    accessTokenHash: byteaColumn('access_token_hash').notNull(),
    refreshTokenHash: byteaColumn('refresh_token_hash').notNull(),
    createdAt: createdAtColumn(),
    lastSeenAt: instantColumn('last_seen_at').notNull().defaultNow(),
    /** 15 minutes, bumped on every authenticated request. */
    idleExpiresAt: instantColumn('idle_expires_at').notNull(),
    /** 8 hours for this generation, never past `familyExpiresAt`. */
    absoluteExpiresAt: instantColumn('absolute_expires_at').notNull(),
    /** The family's hard stop: 8 hours, or 14 days for an explicitly trusted device. */
    familyExpiresAt: instantColumn('family_expires_at').notNull(),
    trustedDevice: flagColumn('trusted_device').notNull().default(false),
    /** Set by a fresh WebAuthn assertion. Five minutes of step-up privilege. */
    freshUntil: instantColumn('fresh_until'),
    /** `webauthn` | `totp` | `recovery_code` | `bootstrap`. */
    authMethod: text('auth_method').notNull(),
    supersededBy: uuid('superseded_by'),
    revokedAt: instantColumn('revoked_at'),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    /** Hashed: a user-agent string is a fingerprint and belongs in no log. */
    userAgentHash: byteaColumn('user_agent_hash'),
  },
  (table) => [
    uniqueIndex('sessions_access_token_hash_key').on(table.accessTokenHash),
    uniqueIndex('sessions_refresh_token_hash_key').on(table.refreshTokenHash),
    index('sessions_family_idx').on(table.familyId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
