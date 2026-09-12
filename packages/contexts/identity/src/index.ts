// SPDX-License-Identifier: MIT
/**
 * `@ctx/identity` — Identity & Security.
 *
 * Authentication (passkeys primary, TOTP fallback, ten single-use recovery codes),
 * opaque sessions with refresh rotation and reuse detection, step-up
 * re-authentication, Postgres-backed rate limiting and lockout, and the security
 * event log.
 *
 * Cryptography is *not* here. It lives in `@core/secretbox`, the single package
 * allowed to import a cipher; this context is its first consumer (the TOTP seed is
 * sealed with it) rather than its owner. See OWNERSHIP.md.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 */
import type { Clock } from '@core/kernel';
import type { SecretBox } from '@core/secretbox';
import { AuthFlows } from './auth-flows.ts';
import type { IdentityQueryable } from './db.ts';
import { RateLimiter, type RateLimitPolicy } from './rate-limit.ts';
import { RecoveryCodeService } from './recovery.ts';
import { DEFAULT_SESSION_TTLS, SessionService, type SessionTtls } from './sessions.ts';
import { TotpService } from './totp.ts';
import { UserService } from './users.ts';
import { WebAuthnService } from './webauthn.ts';

/** Stable identifier used by feature flags (`module.identity`) and event metadata. */
export const CONTEXT_ID = 'identity' as const;

export interface IdentityContextOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly secretBox: SecretBox;
  readonly rpId: string;
  readonly rpName: string;
  readonly allowedOrigins: readonly string[];
  readonly sessionTtls?: SessionTtls;
  readonly rateLimits?: Readonly<Record<string, RateLimitPolicy>>;
  readonly failureDelayMs?: number;
}

/**
 * Everything the composition root needs, constructed once.
 *
 * A bag of services rather than a single god-object: routes need `sessions` on
 * every request and `webauthn` on four, and forcing the latter through the former
 * would be indirection for its own sake.
 */
export interface IdentityContext {
  readonly users: UserService;
  readonly webauthn: WebAuthnService;
  readonly totp: TotpService;
  readonly recoveryCodes: RecoveryCodeService;
  readonly sessions: SessionService;
  readonly rateLimiter: RateLimiter;
  readonly flows: AuthFlows;
}

export function createIdentityContext(options: IdentityContextOptions): IdentityContext {
  const { db, clock } = options;

  const users = new UserService({ db, clock });
  const webauthn = new WebAuthnService({
    db,
    clock,
    rpId: options.rpId,
    rpName: options.rpName,
    allowedOrigins: options.allowedOrigins,
  });
  const totp = new TotpService({ db, clock, secretBox: options.secretBox });
  const recoveryCodes = new RecoveryCodeService({ db, clock });
  const sessions = new SessionService({
    db,
    clock,
    ttls: options.sessionTtls ?? DEFAULT_SESSION_TTLS,
  });
  const rateLimiter = new RateLimiter({
    db,
    clock,
    ...(options.rateLimits === undefined ? {} : { policies: options.rateLimits }),
  });

  const flows = new AuthFlows({
    db,
    clock,
    users,
    webauthn,
    totp,
    recoveryCodes,
    sessions,
    rateLimiter,
    failureDelayMs: options.failureDelayMs ?? 250,
  });

  return { users, webauthn, totp, recoveryCodes, sessions, rateLimiter, flows };
}

export { AuthError, isAuthError, type AuthErrorCode } from './errors.ts';
export type { IdentityQueryable } from './db.ts';
export { UserService, assertIanaZone, REGISTRATION_TOKEN_TTL_SECONDS } from './users.ts';
export type { UserRecord, RegistrationTokenIssue } from './users.ts';
export {
  SessionService,
  DEFAULT_SESSION_TTLS,
  hashToken,
  type AuthMethod,
  type IssuedSession,
  type SessionRecord,
  type SessionTtls,
} from './sessions.ts';
export {
  WebAuthnService,
  base64UrlToBytes,
  bytesToBase64Url,
  type CredentialSummary,
  type VerifiedAssertion,
} from './webauthn.ts';
export {
  TotpService,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_ALGORITHM,
  TOTP_WINDOW,
  type TotpEnrolment,
} from './totp.ts';
export {
  RecoveryCodeService,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_HASH_PARAMS,
  type GeneratedRecoveryCodes,
} from './recovery.ts';
export {
  RateLimiter,
  RATE_LIMITS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
  lockoutSecondsForLevel,
  type RateLimitPolicy,
} from './rate-limit.ts';
export {
  recordSecurityEvent,
  listSecurityEvents,
  hashUserAgent,
  type RequestContext,
  type SecurityEventKind,
  type SecurityEventOutcome,
  type SecurityEventSummary,
} from './security-events.ts';
export { AuthFlows } from './auth-flows.ts';
