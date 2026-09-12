// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/identity`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database.
 *
 * `encryption_keys` is deliberately not here: the keyring belongs to
 * `@core/secretbox`. See this package's OWNERSHIP.md for why.
 */
export { users, type UserRow, type NewUserRow } from './users.ts';
export {
  webauthnCredentials,
  webauthnChallenges,
  totpSecrets,
  recoveryCodes,
  registrationTokens,
  type WebauthnCredentialRow,
  type WebauthnChallengeRow,
  type TotpSecretRow,
  type RecoveryCodeRow,
  type RegistrationTokenRow,
} from './credentials.ts';
export { sessions, type SessionRow, type NewSessionRow } from './sessions.ts';
export {
  authAttempts,
  authLockouts,
  securityEvents,
  type AuthAttemptRow,
  type AuthLockoutRow,
  type SecurityEventRow,
} from './security.ts';
