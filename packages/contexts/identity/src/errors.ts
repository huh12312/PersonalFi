// SPDX-License-Identifier: MIT

/**
 * Authentication failure codes.
 *
 * Deliberately coarse. `invalid_credential` covers "no such credential", "bad
 * signature", "wrong TOTP code" and "already-used recovery code" as one answer,
 * because an error taxonomy that distinguishes them is an enumeration oracle. The
 * *security event log* records the precise reason; the response does not.
 */
export type AuthErrorCode =
  | 'invalid_credential'
  | 'rate_limited'
  | 'locked_out'
  | 'session_expired'
  | 'session_reuse_detected'
  | 'step_up_required'
  | 'not_bootstrapped'
  | 'already_bootstrapped'
  | 'challenge_expired'
  | 'credential_in_use'
  | 'last_credential'
  | 'locked';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Seconds until the caller may try again. Only set for `rate_limited`/`locked_out`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AuthErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
