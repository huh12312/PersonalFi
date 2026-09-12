// SPDX-License-Identifier: MIT

export type SecretBoxErrorCode =
  | 'locked'
  | 'envelope_malformed'
  | 'unknown_key'
  | 'key_retired'
  | 'decrypt_failed'
  | 'params_below_floor'
  | 'passphrase_mismatch'
  | 'plaintext_too_large';

/**
 * Every failure in this package is one of these, and none of them carries the
 * plaintext, the key, or a reason precise enough to act as an oracle.
 *
 * In particular `decrypt_failed` is deliberately indistinguishable between "wrong
 * key", "tampered ciphertext" and "AAD does not match the row": an attacker who
 * can tell those apart can use the API to confirm guesses about what is stored
 * where.
 */
export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode;

  constructor(code: SecretBoxErrorCode, message: string) {
    super(message);
    this.name = 'SecretBoxError';
    this.code = code;
  }
}

export function isSecretBoxError(value: unknown): value is SecretBoxError {
  return value instanceof SecretBoxError;
}
