// SPDX-License-Identifier: MIT
import {
  byteaColumn,
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db/columns';
import { bigint, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Enrolled passkeys (03 §3.2).
 *
 * Nothing here is a secret: a WebAuthn credential is a public key plus metadata,
 * which is exactly why passkeys are the primary factor. The interesting column is
 * `signCount` — an authenticator whose counter goes *backwards* has been cloned,
 * and the assertion is refused and logged rather than quietly accepted.
 */
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: idColumn(),
  userId: userIdColumn(),
  credentialId: byteaColumn('credential_id').notNull(),
  publicKey: byteaColumn('public_key').notNull(),
  signCount: bigint('sign_count', { mode: 'bigint' }).notNull().default(0n),
  transports: text('transports').array().notNull().default([]),
  aaguid: text('aaguid'),
  backupEligible: flagColumn('backup_eligible').notNull().default(false),
  backedUp: flagColumn('backed_up').notNull().default(false),
  deviceType: text('device_type').notNull().default('singleDevice'),
  friendlyName: text('friendly_name').notNull(),
  createdAt: createdAtColumn(),
  lastUsedAt: instantColumn('last_used_at'),
});

/**
 * Pending WebAuthn challenges: server-side and single-use.
 *
 * `userId` is nullable because a discoverable-credential login begins before we
 * know who is logging in — which is the whole point of usernameless auth for a
 * one-user app.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: idColumn(),
  // Nullable: see above. Not `userIdColumn`, which is NOT NULL by construction.
  userId: uuid('user_id'),
  challenge: text('challenge').notNull(),
  /** `registration` | `authentication` | `step_up`. */
  purpose: text('purpose').notNull(),
  createdAt: createdAtColumn(),
  expiresAt: instantColumn('expires_at').notNull(),
  consumedAt: instantColumn('consumed_at'),
});

/**
 * The TOTP fallback (03 §3.3). Secondary, never co-equal with a passkey.
 *
 * `sealedSecret` is a `SecretBox` envelope: the seed is a credential and P0-1
 * applies to it exactly as it applies to a Plaid token. `lastUsedStep` prevents
 * replay of a code inside its own 30-second window.
 */
export const totpSecrets = pgTable('totp_secrets', {
  id: idColumn(),
  userId: userIdColumn(),
  sealedSecret: byteaColumn('sealed_secret').notNull(),
  digits: smallint('digits').notNull().default(6),
  periodSeconds: smallint('period_seconds').notNull().default(30),
  algorithm: text('algorithm').notNull().default('SHA1'),
  lastUsedStep: bigint('last_used_step', { mode: 'bigint' }),
  confirmedAt: instantColumn('confirmed_at'),
  createdAt: createdAtColumn(),
});

/** Ten single-use break-glass codes, Argon2id-hashed and shown exactly once. */
export const recoveryCodes = pgTable('recovery_codes', {
  id: idColumn(),
  userId: userIdColumn(),
  codeHash: text('code_hash').notNull(),
  /** Groups the ten codes minted together, so regenerating replaces a whole set. */
  batchId: uuid('batch_id').notNull(),
  usedAt: instantColumn('used_at'),
  createdAt: createdAtColumn(),
});

/**
 * One-time passkey-enrolment tokens, minted by `just bootstrap-user`.
 *
 * The only way to enrol a credential on a box that has none, so: single-use,
 * short-lived, and stored as a SHA-256 digest rather than the token itself.
 */
export const registrationTokens = pgTable(
  'registration_tokens',
  {
    id: idColumn(),
    userId: userIdColumn(),
    tokenHash: byteaColumn('token_hash').notNull(),
    createdAt: createdAtColumn(),
    expiresAt: instantColumn('expires_at').notNull(),
    usedAt: instantColumn('used_at'),
  },
  (table) => [uniqueIndex('registration_tokens_token_hash_key').on(table.tokenHash)],
);

export type WebauthnCredentialRow = typeof webauthnCredentials.$inferSelect;
export type WebauthnChallengeRow = typeof webauthnChallenges.$inferSelect;
export type TotpSecretRow = typeof totpSecrets.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;
export type RegistrationTokenRow = typeof registrationTokens.$inferSelect;
